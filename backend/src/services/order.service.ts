import { query, getClient } from '../config/database';
import { logger } from '../utils/logger';
import { validateCoupon } from './cart.service';
import socketService from './socket.service';
import { createNotification } from './notification.service';
import { notifyNearbyRidersOfNewOrder } from './dispatch.service';
import { requireCustomerPrices, priceKey } from './priceList.service';
import { normaliseMobileOrNull } from './businessContact.service';
import { config } from '../config/env';
import { quoteForAddress } from './deliveryFee.service';
import { AppError } from '../utils/appError';

/* Delivery is quoted by distance -- see `deliveryFee.service`. The flat
   40.00-above-399.00 rule that used to live here is gone. */

/**
 * A DATE column as the plain YYYY-MM-DD key the app expects.
 *
 * A MySQL DATE read through `SELECT *` arrives as a JavaScript Date, and
 * serialising that to JSON produces a UTC timestamp a device then reads in
 * its own timezone -- enough to show a pickup assigned for the 10th as the
 * 9th. Every other reader of these columns formats them in SQL; this is the
 * one query that cannot, because `*` is what the caller spreads.
 *
 * THE LOCAL FIELDS, NOT THE UTC ONES. mysql2 builds a DATE as local midnight,
 * so on a server anywhere east of UTC the UTC date is the day BEFORE. Reading
 * the same fields the driver wrote round-trips exactly, whatever the server's
 * timezone -- which reading `getUTC*` does not.
 */
function dateKeyOf(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date) {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  return null;
}

/**
 * WHEN A CUSTOMER MAY STILL CANCEL. Unchanged -- this is the existing rule,
 * now exported so the app can ask rather than keep its own copy of it.
 *
 * A second, drifting definition of "cancellable" in the client is how a
 * Cancel button ends up offered on an order the server then refuses.
 */
export const CANCELLABLE_STATUSES = [
  /*
   * A booking still waiting on a Manager is the MOST cancellable state there
   * is -- nobody has started on it. It heads the list for that reason.
   */
  'PENDING_APPROVAL',
  'ORDER_PLACED',
  'CONFIRMED',
  'RECEIVED_AT_FACILITY',
];

/**
 * WHAT A NEW BOOKING IS, BEFORE A MANAGER HAS SEEN IT.
 *
 * Orders used to be created as ORDER_PLACED, and that status is exactly what
 * puts an order in front of the Sorter -- `sorter.service`'s queue is
 * `status IN (ORDER_PLACED, ...)`. A booking therefore reached the shop floor
 * the moment it was made, with nobody having agreed to take it on.
 *
 * PENDING_APPROVAL is not in that queue, so a pending booking is invisible to
 * the Sorter without the Sorter query being touched at all. See migration 053.
 */
export const PENDING_APPROVAL_STATUS = 'PENDING_APPROVAL';

/** Whether THIS status may be cancelled by the customer. */
export function canCancelStatus(status: unknown): boolean {
  return CANCELLABLE_STATUSES.includes(String(status ?? ''));
}

/**
 * CUSTOMER ORDER NUMBER: SWC#DDMMYYYY + a 6-digit daily sequence,
 * e.g. SWC#29082026000001.
 *
 * THE SAME SHAPE AS A BUSINESS ORDER, with C where a business number carries
 * H (hotel) or G (guest) -- see `generateBusinessOrderNumber`. SW is always
 * uppercase.
 *
 * The sequence restarts at 000001 every calendar day, and the day comes from
 * the DATABASE clock shifted into the business timezone, never from the
 * device: a phone with the wrong date must not be able to file an order under
 * the wrong day.
 *
 * ITS OWN COUNTER, not the business one. Hotel and Guest share
 * `business_order_daily_sequence` so that the first BUSINESS order of a day
 * ends in 000001; drawing customer orders from it too would make a day's
 * first business order 000007 because six customers ordered first. See
 * migration 050.
 *
 * Concurrency: one atomic upsert on a table keyed by the date. The primary
 * key serialises concurrent inserts and LAST_INSERT_ID(expr) publishes the new
 * value on THIS connection only, so two orders placed in the same instant can
 * never read the same number. No MAX()+1, no randomness.
 */
export async function generateCustomerOrderNumber(connection: any): Promise<string> {
  const tz = config.BUSINESS_TZ_OFFSET;

  // One instant formats both the counter key and the printed DDMMYYYY, so
  // they cannot disagree across midnight.
  const [dateRows]: any = await connection.execute(
    `SELECT DATE(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', ?)) AS ymd,
            DATE_FORMAT(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', ?), '%d%m%Y') AS ddmmyyyy`,
    [tz, tz]
  );
  const { ymd, ddmmyyyy } = dateRows[0];

  await connection.execute(
    `INSERT INTO customer_order_daily_sequence (sequence_date, last_number)
     VALUES (?, LAST_INSERT_ID(1))
     ON DUPLICATE KEY UPDATE last_number = LAST_INSERT_ID(last_number + 1)`,
    [ymd]
  );

  const [seqRows]: any = await connection.execute(`SELECT LAST_INSERT_ID() AS seq`);
  const sequence = String(seqRows[0].seq).padStart(6, '0');

  return `SWC#${ddmmyyyy}${sequence}`;
}

export interface CreateOrderInput {
  address_id: string;
  pickup_date: string;
  pickup_slot_start: string;
  pickup_slot_end: string;
  delivery_date?: string;
  delivery_slot_start?: string;
  delivery_slot_end?: string;
  payment_method: string;
  coupon_code?: string;
  notes?: string;
  /*
   * THE DEVICE'S OWN FIX, as `requireServiceArea` already required and
   * checked. It is the FALLBACK the delivery charge is measured from when
   * the chosen address has no coordinates of its own -- every address saved
   * before the app began capturing them.
   *
   * It is never preferred over the address: the charge is about where the
   * laundry is collected, which is the address, not where the phone happened
   * to be when the order was placed.
   */
  latitude?: unknown;
  longitude?: unknown;
}

/**
 * The payment methods a customer order may carry.
 *
 * These are exactly the values `orders.payment_method` accepts — the column
 * is an ENUM, so anything else is either rejected or silently truncated to ''
 * depending on the server's strict mode. Validating here turns that into a
 * clear 400 instead.
 *
 * The customer-facing subset is narrower than the column: CASH_ON_DELIVERY
 * and UPI are what the app offers, because those are the two the business
 * actually settles in. The rest stay accepted so an order created by another
 * path is not rejected by this one.
 */
export const CUSTOMER_PAYMENT_METHODS = [
  'CASH_ON_DELIVERY', 'UPI', 'CARD', 'NET_BANKING', 'WALLET', 'ONLINE',
] as const;

export type CustomerPaymentMethod = (typeof CUSTOMER_PAYMENT_METHODS)[number];

/** Normalises and checks a payment method, or throws. */
export function parsePaymentMethod(value: unknown): CustomerPaymentMethod {
  const raw = String(value ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  if ((CUSTOMER_PAYMENT_METHODS as readonly string[]).includes(raw)) {
    return raw as CustomerPaymentMethod;
  }
  throw new Error(
    `Payment method must be one of: ${CUSTOMER_PAYMENT_METHODS.join(', ')}.`
  );
}

export interface OrderRow {
  id: string;
  order_number: string;
  user_id: string;
  status: string;
  subtotal: number;
  delivery_charge: number;
  discount_amount: number;
  total_amount: number;
  payment_method: string;
  payment_status: string;
  notes?: string;
  created_at: Date;
}

/**
 * Customer order creation, against the MySQL schema the rest of the app uses
 * (the original body was unported Postgres — `$n` placeholders, RETURNING and
 * a generate_order_number() function that does not exist on MySQL).
 *
 * The order number is SWC#DDMMYYYY###### -- the business format with C in
 * place of H/G. See `generateCustomerOrderNumber`.
 */
async function createOrder(
  userId: string,
  input: CreateOrderInput,
  /**
   * The mobile number this session was PROVEN on, from the token.
   *
   * A customer signs in by OTP and nothing else, so this is the number they
   * verified to get here. It is stamped on the order so the order's documents
   * can state the number the order was actually placed from, rather than
   * whatever the profile happens to say today.
   *
   * It comes from the SESSION, never from the request body: a caller cannot
   * put someone else's number on their order by sending one.
   *
   * Optional -- a session minted before the token carried this has none, and
   * the order keeps NULL rather than being stamped with a guess.
   */
  placedByMobile?: string
): Promise<OrderRow> {
  /*
   * The payment method is checked BEFORE the transaction opens: it needs no
   * database access, and failing here means nothing has to be rolled back.
   */
  const paymentMethod = parsePaymentMethod(input.payment_method);

  const connection = await getClient();
  try {
    await connection.beginTransaction();

    // 1) Get cart
    const [cartRows]: any = await connection.execute(
      `SELECT id FROM carts WHERE user_id = ?`,
      [userId]
    );
    const cart = cartRows[0];
    if (!cart) throw new Error('Cart not found');

    // 2) Get cart items.
    //
    // No price is selected here. `price_at_add` on the cart line and
    // anything the client sent are both ignored: the amount billed is
    // resolved from the price list below, so a tampered request cannot
    // change what the order costs.
    const [cartItems]: any = await connection.execute(
      `SELECT ci.service_id, s.name AS service_name, s.unit, ci.quantity,
              ci.laundry_service_id,
              -- The item's own weight, for the order total below. It is the
              -- SAME column the business order reads; nothing new is stored.
              s.weight_kg
       FROM cart_items ci
       JOIN services s ON s.id = ci.service_id
       WHERE ci.cart_id = ?`,
      [cart.id]
    );
    if (cartItems.length === 0) throw new Error('Cart is empty');

    /*
     * THE ORDER'S TOTAL WEIGHT: Σ(item weight × quantity).
     *
     * A customer order never wrote this column at all, so every one of them
     * stored 0.000 and the Manager's Customer Requests tab had nothing to
     * show. The business order has always computed it; this is the SAME
     * formula, line-rounded to 3dp first so the stored total is the exact sum
     * of its lines rather than a re-rounding of them.
     *
     * `weight_kg` IS NULL FOR AN ITEM NOBODY HAS WEIGHED, and null contributes
     * nothing rather than guessing. An order made entirely of such items
     * totals 0 -- which is a fact about the catalogue, not about this
     * calculation: no CUSTOMER-scope item currently carries a weight.
     */
    const lineWeight = (item: { weight_kg: number | null; quantity: number }) =>
      Number((Number(item.weight_kg ?? 0) * Number(item.quantity)).toFixed(3));
    const totalWeightKg = Number(
      (cartItems as Array<{ weight_kg: number | null; quantity: number }>)
        .reduce((sum, item) => sum + lineWeight(item), 0)
        .toFixed(3)
    );

    /*
     * 3) Prices, from the GLOBAL customer price list, PER ITEM AND SERVICE.
     *
     * Every customer pays the same figure for the same item at the same
     * service; nothing here is per-customer and `business_price_list` is
     * never consulted.
     *
     * The service comes from the CART LINE, so a basket holding both
     * Shirt/Wash & Iron and Shirt/Dry Clean bills each at its own rate.
     * `requireCustomerPrices` throws if any pair has no price, which is what
     * stops an unpriced line being billed at zero.
     */
    const priceLines = cartItems.map((item: any) => ({
      itemId: String(item.service_id),
      serviceId: item.laundry_service_id === null || item.laundry_service_id === undefined
        ? null
        : String(item.laundry_service_id),
    }));
    const customerPrices = await requireCustomerPrices(priceLines);
    for (const item of cartItems) {
      const serviceId = item.laundry_service_id === null || item.laundry_service_id === undefined
        ? null
        : String(item.laundry_service_id);
      item.price = customerPrices.get(priceKey(String(item.service_id), serviceId))!;
    }

    const subtotal = cartItems.reduce(
      (sum: number, item: any) => sum + Number(item.price) * Number(item.quantity),
      0
    );
    /*
     * DELIVERY, MEASURED FROM THE ADDRESS THE ORDER IS FOR.
     *
     * Recomputed here rather than trusted from the client, exactly as the
     * item prices are: a request that named its own delivery charge could
     * otherwise set it to zero.
     */
    const deliveryQuote = await quoteForAddress(userId, input.address_id, {
      latitude: input.latitude,
      longitude: input.longitude,
    });
    const delivery_charge = deliveryQuote.charge;

    // 4) Validate coupon if provided
    let discountAmount = 0;
    let couponId: string | null = null;
    if (input.coupon_code) {
      const coupon = await validateCoupon(input.coupon_code, subtotal);
      discountAmount = coupon.discount_amount;
      couponId = coupon.id;
      await connection.execute(
        `UPDATE coupons SET used_count = used_count + 1 WHERE id = ?`,
        [couponId]
      );
    }

    const totalAmount = subtotal + delivery_charge - discountAmount;

    /*
     * 5) INSERT the order, WITH its number.
     *
     * The number is generated first rather than stamped by an UPDATE
     * afterwards. `orders.order_number` is UNIQUE and NOT NULL, so the old
     * approach -- insert '' and rewrite it -- meant two orders placed in the
     * same instant both inserted '' and one died on the unique key, reporting
     * a duplicate order number for an order that had none yet.
     */
    const orderNumber = await generateCustomerOrderNumber(connection);

    const [orderInsert]: any = await connection.execute(
      `INSERT INTO orders (
         user_id, address_id, placed_by_mobile, order_number, status, subtotal,
         delivery_charge, delivery_distance_km, delivery_store_id,
         coupon_discount, coupon_id, total, total_weight_kg,
         payment_method, payment_status, special_notes
       )
       VALUES (?, ?, ?, ?, 'PENDING_APPROVAL', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)`,
      // `placed_by_mobile` is written ONCE, here, and never updated: changing
      // the profile number later must not rewrite what an order already says.
      [
        userId,
        input.address_id,
        normaliseMobileOrNull(placedByMobile),
        orderNumber,
        subtotal,
        delivery_charge,
        // NULL, not 0, when nothing was measured: 0 would read as "measured,
        // and it was zero km away".
        deliveryQuote.distance_km,
        deliveryQuote.store_id,
        discountAmount,
        couponId,
        totalAmount,
        totalWeightKg,
        paymentMethod,
        input.notes || null,
      ]
    );
    const orderId = String(orderInsert.insertId);

    // 6) INSERT order_items
    for (const item of cartItems) {
      await connection.execute(
        // `original_quantity` equals `quantity` at placement — nothing has been
        // found defective yet. Written explicitly so the pieces the order was
        // placed for are on the row from the start.
        /* `laundry_service_id` is carried onto the order line, so the
           invoice, the PDF and the sorter all know which service was
           bought — and the line's price is explained by it. */
        `INSERT INTO order_items (order_id, service_id, laundry_service_id, service_name, unit, quantity, original_quantity, defective_quantity, unit_price, total_price)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        [
          orderId,
          item.service_id,
          item.laundry_service_id ?? null,
          item.service_name,
          item.unit,
          item.quantity,
          item.quantity,
          item.price,
          Number(item.price) * Number(item.quantity),
        ]
      );
    }

    /*
     * 7) INSERT order_status_history (PENDING_APPROVAL)
     *
     * The history starts where the order starts. It reaches ORDER_PLACED when
     * a Manager accepts it, and `acceptOrder` writes that second row -- so the
     * trail shows the booking and the decision as two separate events, which
     * is what they are.
     */
    await connection.execute(
      `INSERT INTO order_status_history (order_id, status, changed_by, notes)
       VALUES (?, 'PENDING_APPROVAL', ?, 'Booked by customer, awaiting manager approval')`,
      [orderId, userId]
    );

    // 8) INSERT production_orders
    await connection.execute(
      `INSERT INTO production_orders (order_id, current_status) VALUES (?, 'RECEIVED')`,
      [orderId]
    );

    // 9) INSERT production_status_history
    await connection.execute(
      `INSERT INTO production_status_history (order_id, status, changed_by, notes)
       VALUES (?, 'RECEIVED', ?, 'Order received for processing')`,
      [orderId, userId]
    );

    // 10) INSERT pickup
    await connection.execute(
      `INSERT INTO pickups (order_id, scheduled_date, time_slot_start, time_slot_end, status)
       VALUES (?, ?, ?, ?, 'SCHEDULED')`,
      [orderId, input.pickup_date, input.pickup_slot_start, input.pickup_slot_end]
    );

    // 11) INSERT delivery (if delivery date provided)
    if (input.delivery_date && input.delivery_slot_start && input.delivery_slot_end) {
      await connection.execute(
        `INSERT INTO deliveries (order_id, scheduled_date, time_slot_start, time_slot_end, status)
         VALUES (?, ?, ?, ?, 'SCHEDULED')`,
        [orderId, input.delivery_date, input.delivery_slot_start, input.delivery_slot_end]
      );
    }

    // 12) Clear cart
    await connection.execute(`DELETE FROM cart_items WHERE cart_id = ?`, [cart.id]);

    await connection.commit();

    const order: OrderRow = {
      id: orderId,
      order_number: orderNumber,
      user_id: userId,
      status: PENDING_APPROVAL_STATUS,
      subtotal,
      delivery_charge,
      discount_amount: discountAmount,
      total_amount: totalAmount,
      payment_method: paymentMethod,
      payment_status: 'PENDING',
      notes: input.notes,
      created_at: new Date(),
    };

    /*
     * The booking is ACKNOWLEDGED, not confirmed.
     *
     * "Order Placed!" would be untrue here now -- a Manager has not accepted
     * it yet, and telling the customer it is placed and then showing them a
     * pending tracker is the contradiction this wording avoids. The
     * confirmation is sent by `acceptOrder`.
     */
    await createNotification(
      userId,
      order.id,
      'PENDING_APPROVAL',
      'Booking received',
      `We have your booking ${order.order_number}. You will hear from us once it is confirmed.`
    );

    socketService.emitOrderStatusUpdate(order.id, {
      orderId: order.id,
      orderNumber: order.order_number,
      status: PENDING_APPROVAL_STATUS,
    });

    /*
     * NO RIDER ADVISORY HERE ANY MORE.
     *
     * It used to fire on creation, which now means riders would be told about
     * a booking no Manager has agreed to take. `acceptOrder` raises it at the
     * moment the order becomes ORDER_PLACED instead -- the same call, moved,
     * not a second one.
     */

    logger.info(
      `[OrderService] Booking created: ${order.order_number} for user ${userId}, `
      + 'awaiting manager approval'
    );
    return order;
  } catch (error) {
    await connection.rollback();
    logger.error('[OrderService] createOrder transaction failed:', error);
    throw error;
  } finally {
    connection.release();
  }
}

async function getOrders(
  userId: string,
  status?: string,
  page: number = 1,
  limit: number = 10
): Promise<{ orders: OrderRow[]; total: number }> {
  const offset = (page - 1) * limit;
  // MySQL placeholders are positional `?`, so there is no index to track:
  // the order of `values` is the order they bind in.
  const conditions: string[] = ['o.user_id = ?'];
  const values: unknown[] = [userId];

  if (status) {
    conditions.push('o.status = ?');
    values.push(status);
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM orders o ${whereClause}`,
    values
  );
  const total = parseInt(countResult.rows[0]?.count || '0', 10);

  /*
   * LIMIT/OFFSET are interpolated, not bound: this MySQL driver refuses
   * placeholders there. Both are clamped integers derived from the caller's
   * page numbers, never strings, so nothing from the request reaches the SQL
   * text.
   */
  const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 100);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const ordersResult = await query<OrderRow & { item_count: string }>(
    `SELECT o.*, COUNT(oi.id) AS item_count
     FROM orders o
     LEFT JOIN order_items oi ON oi.order_id = o.id
     ${whereClause}
     GROUP BY o.id
     ORDER BY o.created_at DESC
     LIMIT ${safeLimit} OFFSET ${safeOffset}`,
    values
  );

  return { orders: ordersResult.rows, total };
}

/**
 * One order, in full, for the customer who placed it.
 *
 * ASSEMBLED IN JS, NOT IN SQL. The original built the whole thing with
 * `json_agg` / `json_build_object` / `row_to_json` / `FILTER (WHERE ...)` —
 * all PostgreSQL, none of which MySQL has, so it could never have run here.
 *
 * Four plain queries are also easier to read than one nested aggregation,
 * and they avoid the GROUP BY over every joined table that the single
 * statement needed. `user_id` is in the WHERE clause of the first, so another
 * customer's order is a null rather than a disclosure.
 */
async function getOrderById(userId: string, orderId: string): Promise<OrderRow | null> {
  const orderResult = await query<OrderRow>(
    `SELECT * FROM orders WHERE id = ? AND user_id = ?`,
    [orderId, userId]
  );
  const order = orderResult.rows[0];
  if (!order) return null;

  /*
   * The assigned pickup DATE as a plain YYYY-MM-DD string.
   *
   * `SELECT *` brings the column back as a DATE, which serialises to a
   * timestamp the device then reads in its own timezone — enough to shift a
   * collection into the previous day for anyone west of IST. Normalised here
   * so this endpoint agrees with the tracking one, which formats it in SQL.
   */
  (order as any).assigned_pickup_date = dateKeyOf((order as any).assigned_pickup_date);

  const items = await query<any>(
    `SELECT oi.id, oi.service_id, s.name AS service_name, oi.quantity,
            oi.unit_price, oi.total_price, s.unit
       FROM order_items oi
       LEFT JOIN services s ON s.id = oi.service_id
      WHERE oi.order_id = ?
      ORDER BY oi.id ASC`,
    [orderId]
  );
  const pickup = await query<any>(
    `SELECT * FROM pickups WHERE order_id = ? LIMIT 1`, [orderId]
  );
  const delivery = await query<any>(
    `SELECT * FROM deliveries WHERE order_id = ? LIMIT 1`, [orderId]
  );
  const addressId = (order as any).address_id;
  const address = addressId
    ? await query<any>(
      `SELECT * FROM customer_addresses WHERE id = ? LIMIT 1`, [addressId]
    )
    : { rows: [] as any[] };

  return {
    ...order,
    items: items.rows,
    pickup: pickup.rows[0] ?? null,
    delivery: delivery.rows[0] ?? null,
    address: address.rows[0] ?? null,
  } as OrderRow;
}


async function cancelOrder(
  userId: string,
  orderId: string,
  reason?: string
): Promise<OrderRow> {
  const orderResult = await query<{ id: string; status: string }>(
    `SELECT id, status FROM orders WHERE id = ? AND user_id = ?`,
    [orderId, userId]
  );

  const order = orderResult.rows[0];
  /*
   * BOTH REFUSALS CARRY A STATUS CODE.
   *
   * They were plain `Error`s, which `errorHandler` answers as 500 "Internal
   * server error" -- so a customer cancelling an order already picked up was
   * told the server had broken rather than why it would not cancel. The
   * reason is the whole point of the message.
   */
  if (!order) {
    throw new AppError('Order not found.', 404);
  }
  if (!canCancelStatus(order.status)) {
    throw new AppError(
      `This order can no longer be cancelled — it is already ${String(order.status)
        .replace(/_/g, ' ')
        .toLowerCase()}. Please contact us if you need to change it.`,
      409
    );
  }

  await query(
    `UPDATE orders SET status = 'CANCELLED', updated_at = NOW() WHERE id = ?`,
    [orderId]
  );

  await query(
    `INSERT INTO order_status_history (order_id, status, changed_by, notes)
     VALUES (?, 'CANCELLED', ?, ?)`,
    [orderId, userId, reason || 'Cancelled by customer']
  );

  // MySQL has no RETURNING, so the cancelled row is read back after the
  // update rather than returned by it.
  const updatedResult = await query<OrderRow>(
    `SELECT * FROM orders WHERE id = ?`,
    [orderId]
  );

  logger.info(`[OrderService] Order ${orderId} cancelled by user ${userId}`);
  return updatedResult.rows[0];
}

/**
 * The tracking view of one order, for the customer who placed it.
 *
 * ASSEMBLED IN JS, NOT IN SQL — the same treatment, and for the same reason,
 * as `getOrderById` above. This function was still the original PostgreSQL:
 * `row_to_json(pk.*)`, `json_agg(...) FILTER (WHERE ...)` and
 * `json_build_object`, none of which MySQL has. It could never have run here,
 * and every call to it answered 500 with a SQL syntax error — which is what
 * "Track my order does not work" was.
 *
 * Three other faults went with it, all of which would still have broken the
 * query after the JSON functions were replaced:
 *
 *   `o.total_amount` DOES NOT EXIST. The column is `orders.total`; the API
 *   exposes it under the `total_amount` name, which is why the wrong one
 *   looks plausible. It is aliased here so the response keeps that name.
 *
 *   `production_status_history` HAS NO `production_order_id`. It is keyed by
 *   `order_id`, so the join could not have matched a row.
 *
 *   IT WAS NOT SCOPED TO A USER. Any signed-in account could track any
 *   order by guessing an id, reading its number, status and schedule. It now
 *   takes `userId` and filters on it, exactly as `getOrderById` does — a null
 *   for someone else's order rather than a disclosure.
 */
async function getOrderTracking(userId: string, orderId: string): Promise<object | null> {
  const orderResult = await query<any>(
    `SELECT o.id, o.order_number, o.status, o.total AS total_amount, o.created_at,
            /*
             * THE PICKUP A MANAGER ASSIGNED, read from the order itself.
             *
             * NULL until a Manager has actually chosen one, which is what
             * lets the tracker show a collection only when there is one to
             * show. It is not the same as the pickups row below: that
             * always exists (both order flows write one at creation, and on
             * the Business side it is a placeholder), so it can never answer
             * "has a pickup been assigned yet".
             *
             * DATE_FORMAT because a bare DATE arrives as a timestamp the
             * device would then read in its own timezone — and shift a
             * collection into the previous day for anyone west of IST.
             */
            DATE_FORMAT(o.assigned_pickup_date, '%Y-%m-%d') AS assigned_pickup_date,
            o.assigned_pickup_time
       FROM orders o
      WHERE o.id = ? AND o.user_id = ?`,
    [orderId, userId]
  );

  const order = orderResult.rows[0];
  if (!order) return null;

  const pickup = await query<any>(
    `SELECT * FROM pickups WHERE order_id = ? LIMIT 1`,
    [orderId]
  );
  const delivery = await query<any>(
    `SELECT * FROM deliveries WHERE order_id = ? LIMIT 1`,
    [orderId]
  );

  const statusHistoryResult = await query<any>(
    `SELECT status, notes, changed_by, created_at
       FROM order_status_history
      WHERE order_id = ?
      ORDER BY created_at ASC`,
    [orderId]
  );

  const productionResult = await query<any>(
    `SELECT id, current_status FROM production_orders WHERE order_id = ? LIMIT 1`,
    [orderId]
  );
  const production = productionResult.rows[0] ?? null;
  // The production steps, in their own query rather than an aggregate — the
  // one row per order means there is nothing to group.
  if (production) {
    const history = await query<any>(
      `SELECT status, notes, created_at
         FROM production_status_history
        WHERE order_id = ?
        ORDER BY created_at ASC`,
      [orderId]
    );
    production.history = history.rows;
  }

  return {
    ...order,
    pickup: pickup.rows[0] ?? null,
    delivery: delivery.rows[0] ?? null,
    status_history: statusHistoryResult.rows,
    production,
    /*
     * WHETHER CANCEL MAY BE OFFERED, decided HERE by the same rule that
     * enforces it. The app shows the button on this flag rather than on a
     * status list of its own, so it cannot offer a cancellation the server
     * would refuse. Same arrangement `businessOrder.service` already uses.
     */
    can_cancel: canCancelStatus(order.status),
  };
}

export { createOrder, getOrders, getOrderById, cancelOrder, getOrderTracking };
