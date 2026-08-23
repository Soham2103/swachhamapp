import { getClient, query } from '../config/database';
import { AppError } from '../utils/appError';
import { logger } from '../utils/logger';
import { config } from '../config/env';
import { getCart, BusinessCart } from './businessCart.service';
import { assertComplete } from './businessCompleteness';
import { generateGarmentsForOrder } from './garment.service';
import { OrderSchedule, resolveDeliverySchedule } from './pickupSlot.service';
import { resolveBusinessPrices } from './priceList.service';
import { normaliseMobileOrNull } from './businessContact.service';

const LAUNDRY_TYPE_CODE: Record<string, string> = { hotel: 'H', guest: 'G' };

/** Exactly two Business services. Wash + Iron is one combined service. */
const VALID_SERVICE_TYPES = ['wash_iron', 'dry_clean'];

/**
 * Business order number: SW + H|G + '#' + DDMMYYYY + 6-digit daily sequence
 * e.g. SWH#16082026000001
 *
 * SW is always uppercase.
 *
 * The sequence is per calendar day and shared between Hotel and Guest, so the
 * first Business order of every new day ends in 000001.
 *
 * Concurrency: the counter is bumped with a single atomic upsert on a table
 * keyed by the date. The PK serialises concurrent inserts, and
 * LAST_INSERT_ID(expr) publishes the new value on this connection only — so
 * two simultaneous orders can never read the same number. No MAX()+1, no
 * randomness, no timestamps as the sequence.
 *
 * The calendar day comes from the database clock shifted into the configured
 * business timezone (the DB server runs UTC), never from the device.
 */
async function generateBusinessOrderNumber(
  connection: any,
  laundryType: string
): Promise<string> {
  const code = LAUNDRY_TYPE_CODE[laundryType];
  if (!code) {
    throw new AppError('Invalid laundry type', 400);
  }

  const tz = config.BUSINESS_TZ_OFFSET;

  // One source of truth for the day: the same instant formats both the
  // counter key and the printed DDMMYYYY, so they can never disagree.
  const [dateRows]: any = await connection.execute(
    `SELECT DATE(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', ?)) AS ymd,
            DATE_FORMAT(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', ?), '%d%m%Y') AS ddmmyyyy`,
    [tz, tz]
  );
  const { ymd, ddmmyyyy } = dateRows[0];

  await connection.execute(
    `INSERT INTO business_order_daily_sequence (sequence_date, last_number)
     VALUES (?, LAST_INSERT_ID(1))
     ON DUPLICATE KEY UPDATE last_number = LAST_INSERT_ID(last_number + 1)`,
    [ymd]
  );

  const [seqRows]: any = await connection.execute(`SELECT LAST_INSERT_ID() AS seq`);
  const sequence = String(seqRows[0].seq).padStart(6, '0');

  return `SW${code}#${ddmmyyyy}${sequence}`;
}

/**
 * What a business gets back after placing an order.
 *
 * NO MONEY. The business app never shows a price, so no amount is put
 * on the wire for it to show. The order is priced and totalled on the
 * server, and those figures are read back by the super admin invoice.
 */
export interface BusinessOrderResult {
  id: string;
  order_number: string;
  laundry_type: string;
  order_type: string;
  service_type: string;
  status: string;
  /** SUM(item weight x quantity) for the whole order, in kg. */
  total_weight_kg: number;
  /** The pickup booked with the order, from the `pickups` row. */
  pickup: { date: string; slot_label: string; slot_start: string; slot_end: string };
  /**
   * The delivery, when one was booked. Null when the order was placed with
   * the pickup alone — the delivery can be arranged afterwards.
   */
  delivery: { date: string; slot_label: string; slot_start: string; slot_end: string } | null;
  items: Array<{
    item_id: string;
    item_name: string;
    category_id: string;
    quantity: number;
    unit: string;
    weight_kg: number | null;
    total_weight_kg: number;
  }>;
}

/**
 * Creates the order and books its pickup and delivery.
 *
 * `schedule` has already been validated by resolveSchedule, so by the time it
 * reaches here the day and both slots are known-good; both rows are written
 * inside the same transaction as the order, so an order can never exist
 * without the slots the customer chose.
 */
async function createOrder(
  businessUserId: string,
  schedule: OrderSchedule,
  /**
   * The mobile number this session was PROVEN on, from the token.
   *
   * Recorded on the order so its documents can say which number the person
   * actually placed it from. A business answers on several -- its primary
   * contact's and up to three alternatives' -- and any of them may sign in,
   * so the account's own number is not the answer.
   *
   * Optional: a session minted before the token carried this has none, and the
   * order simply keeps NULL rather than being stamped with a guess.
   */
  placedByMobile?: string
): Promise<BusinessOrderResult> {
  const cartResult = await query<{
    id: string;
    laundry_type: string | null;
    order_type: string | null;
    service_type: string | null;
    service_id: string | null;
  }>(
    `SELECT id, laundry_type, order_type, service_type, service_id FROM carts WHERE business_user_id = ?`,
    [businessUserId]
  );
  const cart = cartResult.rows[0];
  if (!cart) {
    throw new AppError('Cart not found', 404);
  }

  // A business must have its mandatory establishment details on file
  // before it can order. Checked here rather than in the UI so a direct
  // API call is refused too, and checked before any of the cart work so
  // an incomplete account fails fast.
  const ownerResult = await query<{ business_id: string }>(
    `SELECT business_id FROM business_users WHERE id = ?`,
    [businessUserId]
  );
  if (!ownerResult.rows[0]) {
    throw new AppError('Business account not found', 404);
  }
  // Which business this order belongs to. Every price below is resolved
  // against THIS id, so one business's rates can never be billed to
  // another's order.
  const businessId = String(ownerResult.rows[0].business_id);
  await assertComplete(businessId);
  if (!cart.laundry_type) {
    throw new AppError('Laundry type has not been selected', 400);
  }
  if (!cart.order_type) {
    throw new AppError('Order type has not been selected', 400);
  }

  // The service belongs to each line, not to the order, so the cart-level
  // service is no longer required — every line having one is.
  //
  // No price column is read here. `services.base_price` holds 0.00 /
  // 1.00 placeholders and is not a price list, and `price_at_add` on the
  // cart line is a staging value the client can influence. The amount
  // billed comes from business_price_list, resolved below.
  const itemsResult = await query<{
    service_id: string;
    name: string;
    category_id: string;
    unit: string;
    weight_kg: number | null;
    is_active: boolean;
    quantity: number;
    laundry_service_id: string | null;
    laundry_service_code: string | null;
  }>(
    `SELECT s.id AS service_id, s.name, s.category_id, s.unit,
            s.weight_kg, s.is_active, ci.quantity,
            ci.laundry_service_id, st.code AS laundry_service_code
     FROM cart_items ci
     JOIN services s ON s.id = ci.service_id
     LEFT JOIN services st ON st.id = ci.laundry_service_id AND st.kind = 'SERVICE_TYPE'
     WHERE ci.cart_id = ? AND s.kind = 'ITEM'`,
    [cart.id]
  );
  const cartItems = itemsResult.rows;
  if (cartItems.length === 0) {
    throw new AppError('Cart is empty', 400);
  }
  const inactiveItem = cartItems.find((item) => !item.is_active);
  if (inactiveItem) {
    throw new AppError(`Item "${inactiveItem.name}" is no longer available. Please remove it from the cart.`, 400);
  }

  // Enforced here so a direct API call is rejected too, not only the UI.
  const itemWithoutService = cartItems.find(
    (item) => !item.laundry_service_code || !VALID_SERVICE_TYPES.includes(item.laundry_service_code)
  );
  if (itemWithoutService) {
    throw new AppError(
      `Please select at least one laundry service for "${itemWithoutService.name}".`,
      400
    );
  }

  // The order records a service only when every line shares the same one;
  // with a mix of services it stays null and each line speaks for itself.
  const distinctServices = Array.from(
    new Set(cartItems.map((item) => item.laundry_service_code as string))
  );
  const orderServiceType = distinctServices.length === 1 ? distinctServices[0] : null;
  const orderServiceId =
    orderServiceType !== null ? cartItems[0].laundry_service_id : null;

  // THE price step. Every line's unit price comes from this business's
  // own row in business_price_list FOR THE LAUNDRY TYPE THIS ORDER IS
  // BEING PLACED AT -- Hotel and Guest are separately priced. There is no
  // fallback: an item this business has no price for at that type throws
  // "No business price configured for this item and laundry type", which
  // stops the order rather than inventing a figure or borrowing the
  // other type's rate.
  const unitPrices = await resolveBusinessPrices(
    businessId,
    cartItems.map((item) => String(item.service_id)),
    cart.laundry_type
  );
  const unitPriceOf = (item: { service_id: string }) =>
    unitPrices.get(String(item.service_id))!;

  const subtotal = cartItems.reduce(
    (sum, item) => sum + unitPriceOf(item) * item.quantity,
    0
  );

  // Total order weight = SUM(item weight x quantity). Rounded to 3 decimals
  // per line first, so the stored order total is the exact sum of the lines.
  const lineWeight = (item: { weight_kg: number | null; quantity: number }) =>
    Number((Number(item.weight_kg ?? 0) * item.quantity).toFixed(3));
  const totalWeightKg = Number(
    cartItems.reduce((sum, item) => sum + lineWeight(item), 0).toFixed(3)
  );

  const connection = await getClient();
  try {
    await connection.beginTransaction();

    const orderNumber = await generateBusinessOrderNumber(connection, cart.laundry_type);

    // `special_notes` is the column the orders table already has for notes
    // about the laundry itself — no new field was added for it.
    const [orderInsert]: any = await connection.execute(
      `INSERT INTO orders (order_number, business_user_id, placed_by_mobile, laundry_type, order_type, service_type, service_id, status, subtotal, total_weight_kg, total, special_notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'ORDER_PLACED', ?, ?, ?, ?)`,
      // `placed_by_mobile` is written ONCE, here, and never updated: editing a
      // contact later must not rewrite what an order already says.
      [orderNumber, businessUserId, normaliseMobileOrNull(placedByMobile), cart.laundry_type, cart.order_type, orderServiceType, orderServiceId, subtotal, totalWeightKg, subtotal, schedule.serviceNotes || null]
    );
    const orderId = orderInsert.insertId;

    for (const item of cartItems) {
      const unitPrice = unitPriceOf(item);
      const totalPrice = unitPrice * item.quantity;
      // Price, laundry type and weight are all snapshotted on the line. A
      // later change to this business's price list cannot rewrite what an
      // order that was already placed cost: the invoice reads
      // oi.unit_price and oi.laundry_type, never the live price list.
      await connection.execute(
        // `original_quantity` is written EQUAL to `quantity` here, because at
        // the moment an order is placed they are the same thing: nothing has
        // been found defective yet. Writing it explicitly rather than leaving
        // it NULL means the pieces the order was placed for are recorded on
        // the row from the start, not inferred later.
        `INSERT INTO order_items (order_id, service_id, category_id, service_name, laundry_type, unit, weight_kg, total_weight_kg, quantity, original_quantity, defective_quantity, unit_price, total_price)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        [orderId, item.service_id, item.category_id, item.name, cart.laundry_type, item.unit, item.weight_kg, lineWeight(item), item.quantity, item.quantity, unitPrice, totalPrice]
      );
    }

    // One barcode per physical piece, inside the same transaction as the
    // order: an order can never exist without its garment labels, and a
    // failure here rolls the whole order back rather than half-creating it.
    await generateGarmentsForOrder(String(orderId), connection);

    // Seed the tracking history so progression is real data, not a stub.
    await connection.execute(
      `INSERT INTO order_status_history (order_id, status, notes)
       VALUES (?, 'ORDER_PLACED', 'Order placed by business')`,
      [orderId]
    );

    // The chosen slots, into the tables the schema already has for them, each
    // with the pickup-and-drop note in its own `notes` column — the same
    // instruction reaches whoever handles that leg.
    // Same transaction as the order: if either fails, no order is created.
    const pickupNotes = schedule.pickupNotes || null;
    await connection.execute(
      `INSERT INTO pickups (order_id, scheduled_date, time_slot_start, time_slot_end, status, notes)
       VALUES (?, ?, ?, ?, 'SCHEDULED', ?)`,
      [orderId, schedule.pickupDate, schedule.pickup.start, schedule.pickup.end, pickupNotes]
    );
    // Only when a delivery was actually booked. "Not scheduled yet" is the
    // absence of the row, which is what the `deliveries` table already
    // means — a row with nothing in it would say less, not more.
    if (schedule.deliveryDate && schedule.delivery) {
      await connection.execute(
        `INSERT INTO deliveries (order_id, scheduled_date, time_slot_start, time_slot_end, status, notes)
         VALUES (?, ?, ?, ?, 'SCHEDULED', ?)`,
        [orderId, schedule.deliveryDate, schedule.delivery.start, schedule.delivery.end, pickupNotes]
      );
    }

    await connection.execute(`DELETE FROM cart_items WHERE cart_id = ?`, [cart.id]);
    await connection.execute(
      `UPDATE carts SET laundry_type = NULL, order_type = NULL, service_type = NULL, service_id = NULL, updated_at = NOW() WHERE id = ?`,
      [cart.id]
    );

    await connection.commit();

    logger.info(`[BusinessOrderService] Order created: ${orderNumber} for business user ${businessUserId}`);

    return {
      id: String(orderId),
      order_number: orderNumber,
      laundry_type: cart.laundry_type,
      order_type: cart.order_type,
      service_type: orderServiceType || '',
      status: 'ORDER_PLACED',
      total_weight_kg: totalWeightKg,
      pickup: {
        date: schedule.pickupDate,
        slot_label: schedule.pickup.label,
        slot_start: schedule.pickup.start,
        slot_end: schedule.pickup.end,
      },
      // Its own date, always a later day than the pickup. Null until one
      // is booked.
      delivery:
        schedule.deliveryDate && schedule.delivery
          ? {
              date: schedule.deliveryDate,
              slot_label: schedule.delivery.label,
              slot_start: schedule.delivery.start,
              slot_end: schedule.delivery.end,
            }
          : null,
      items: cartItems.map((item) => ({
        item_id: item.service_id,
        item_name: item.name,
        category_id: item.category_id,
        quantity: item.quantity,
        unit: item.unit,
        weight_kg: item.weight_kg,
        total_weight_kg: lineWeight(item),
      })),
    };
  } catch (error) {
    await connection.rollback();
    logger.error('[BusinessOrderService] createOrder transaction failed:', error);
    throw error;
  } finally {
    connection.release();
  }
}

export interface BusinessOrderSummary {
  id: string;
  order_number: string;
  laundry_type: string | null;
  order_type: string | null;
  service_type: string | null;
  service_name: string | null;
  status: string;
  item_count: number;
  total_quantity: number;
  /** SUM(item weight x quantity) for the order, in kg. */
  total_weight_kg: number;
  created_at: Date;
}

/** Orders belonging to the authenticated business only, newest first. */
async function getOrders(businessUserId: string): Promise<BusinessOrderSummary[]> {
  const result = await query<BusinessOrderSummary>(
    `SELECT o.id, o.order_number, o.laundry_type, o.order_type, o.service_type,
            s.name AS service_name, o.status, o.created_at,
            COUNT(oi.id) AS item_count,
            COALESCE(SUM(oi.quantity), 0) AS total_quantity,
            COALESCE(ROUND(SUM(oi.total_weight_kg), 3), 0) AS total_weight_kg
     FROM orders o
     LEFT JOIN order_items oi ON oi.order_id = o.id
     LEFT JOIN services s ON s.id = o.service_id
     WHERE o.business_user_id = ?
     GROUP BY o.id, s.name
     ORDER BY o.created_at DESC, o.id DESC
     LIMIT 100`,
    [businessUserId]
  );
  return result.rows;
}

export interface BusinessOrderDetail extends BusinessOrderSummary {
  business_name: string;
  contact_person_name: string | null;
  /**
   * The number this order was PLACED ON, or null.
   *
   * `orders.placed_by_mobile` and nothing else. It is not the business's
   * number and it is not the account's -- it is what the person who placed
   * this order proved by OTP for the session that placed it.
   *
   * NULL for orders placed before the column existed. It stays null; the
   * account's number is deliberately NOT substituted, because for a business
   * reached on several numbers that substitution is a guess, and a document
   * stating the wrong number is worse than one stating none. Readers print
   * "N/A".
   */
  placed_by_mobile: string | null;
  business_email: string | null;
  business_address: string | null;
  items: Array<{
    id: string;
    service_id: string | null;
    /** The item's own name — legacy column name, not the laundry service. */
    service_name: string;
    /** The laundry service for this line; null when it cannot be resolved. */
    laundry_service_name: string | null;
    category_id: string | null;
    category_name: string | null;
    image_url: string | null;
    /** The BILLABLE quantity: original_quantity - defective_quantity. */
    quantity: number;
    /**
     * The pieces the order was placed for. Equal to `quantity` until a Sorter
     * records a defective piece against the line.
     */
    original_quantity: number;
    /** Pieces the Sorter found damaged. 0 on a line never adjusted. */
    defective_quantity: number;
    /**
     * Where this line stands on its own.
     *
     *   PROCESSING  with Swachham, being worked on
     *   READY       finished, and free to leave with the next dispatch
     *   PENDING     held back because it needs more time, while the rest of
     *               the order goes out
     *
     * READ-ONLY on this side. Only a Sorter can change it, and only through
     * the Sorter router — a business token cannot reach that endpoint.
     */
    item_status: 'PROCESSING' | 'READY' | 'PARTIALLY_PENDING' | 'PENDING';
    /** Pieces still being processed at Swachham. */
    pending_quantity: number;
    /** ordered - pending: the pieces going out with the next dispatch. */
    delivery_quantity: number;
    /** Why they are being held, when they are. */
    pending_reason: string | null;
    unit: string;
    /** Standard weight per piece as it was when the order was placed. */
    weight_kg: number | null;
    /** weight_kg x quantity. */
    total_weight_kg: number;
  }>;
  /**
   * True when any line on this order carries a defective adjustment.
   *
   * Lets a document decide whether to print the Ordered / Defective / Final
   * columns at all: an order nobody has adjusted reads exactly as it always
   * did, with no empty columns explaining nothing.
   */
  has_adjustment: boolean;
  /**
   * True when some of this order is finished and some is still being worked
   * on, so a document or screen can say "partially completed" rather than
   * implying the whole order is in one state.
   */
  has_pending_items: boolean;
}

/**
 * WHO IS ASKING FOR THIS ORDER, and what that entitles them to see.
 *
 * Two readers, one query. The predicate differs and nothing else does, so the
 * order a Super Admin opens is the same order the business itself opens --
 * and the document built from it is the same document, not a second one that
 * can drift.
 *
 *   ACCOUNT   the business app. Scoped to the ACCOUNT that placed the order,
 *             which is the predicate that stops one business reading
 *             another's.
 *
 *   BUSINESS  Super Admin -> Business Account -> Order Detail. Scoped to the
 *             BUSINESS, reached only through `business_users`, which is what
 *             keeps the selected business's orders -- and no other's --
 *             underneath it.
 *
 * The kind is a literal and the predicate is chosen from it here; no caller
 * supplies a column, so there is no way to pass SQL in.
 */
type OrderScope =
  | { kind: 'ACCOUNT'; businessUserId: string }
  | { kind: 'BUSINESS'; businessId: string };

/** Full order, for whichever reader the scope names. */
async function fetchOrderDetail(
  scope: OrderScope,
  orderId: string
): Promise<BusinessOrderDetail> {
  const scoped =
    scope.kind === 'ACCOUNT'
      ? { predicate: 'o.business_user_id = ?', value: scope.businessUserId }
      : { predicate: 'bu.business_id = ?', value: scope.businessId };

  const orderResult = await query<BusinessOrderDetail>(
    `SELECT o.id, o.order_number, o.laundry_type, o.order_type, o.service_type,
            s.name AS service_name, o.status, o.created_at,
            COALESCE(NULLIF(TRIM(b.establishment_name), ''), b.name) AS business_name,
            bu.name AS contact_person_name,
            /*
             * THE NUMBER THIS ORDER WAS PLACED ON. Read straight, with no
             * fallback.
             *
             * orders.placed_by_mobile is what the person proved by OTP for
             * the session that placed it -- the primary contact's number, or
             * an alternative contact's, whichever was used. It is a snapshot
             * and is never updated.
             *
             * bu.mobile_number is NOT coalesced in. A business is reached on
             * several numbers and any of its contacts may sign in, so the
             * account's own number answers a different question; substituting
             * it would make an order placed by an alternative contact print
             * the primary contact's number, which is precisely the confusion
             * this column exists to end. Orders from before it existed stay
             * NULL and print "N/A".
             */
            o.placed_by_mobile,
            COALESCE(bu.email, b.email) AS business_email,
            COALESCE(b.establishment_address, b.address) AS business_address
     FROM orders o
     JOIN business_users bu ON bu.id = o.business_user_id
     JOIN businesses b ON b.id = bu.business_id
     LEFT JOIN services s ON s.id = o.service_id
     WHERE o.id = ? AND ${scoped.predicate}`,
    [orderId, scoped.value]
  );

  const order = orderResult.rows[0];
  if (!order) {
    throw new AppError('Order not found', 404);
  }

  const itemsResult = await query<
    BusinessOrderDetail['items'][number] & { sole_service_name: string | null }
  >(
    `SELECT oi.id, oi.service_id, oi.service_name, oi.category_id,
            c.name AS category_name, s.image_url,
            -- quantity is the BILLABLE figure and always has been; the two
            -- columns beside it say what it was reduced from and why it moved.
            -- COALESCE for lines written before migration 033, where the
            -- current quantity IS the original.
            oi.quantity,
            COALESCE(oi.original_quantity, oi.quantity) AS original_quantity,
            COALESCE(oi.defective_quantity, 0) AS defective_quantity,
            COALESCE(oi.item_status, 'PROCESSING') AS item_status,
            COALESCE(oi.pending_quantity, 0) AS pending_quantity,
            oi.pending_reason,
            oi.unit,
            COALESCE(oi.weight_kg, s.weight_kg) AS weight_kg,
            COALESCE(oi.total_weight_kg, ROUND(s.weight_kg * oi.quantity, 3), 0) AS total_weight_kg,
            -- The item's service, when the catalogue leaves no doubt: an item
            -- mapped to exactly one service can only have been ordered for
            -- that service. HAVING COUNT(*) = 1 is what makes it definite.
            (SELECT MIN(st.name)
               FROM item_service_types m
               JOIN services st ON st.id = m.service_id
              WHERE m.item_id = oi.service_id
                AND st.kind = 'SERVICE_TYPE' AND st.is_active = true
             HAVING COUNT(*) = 1) AS sole_service_name
     FROM order_items oi
     LEFT JOIN service_categories c ON c.id = oi.category_id
     LEFT JOIN services s ON s.id = oi.service_id
     WHERE oi.order_id = ?
     ORDER BY oi.id ASC`,
    [orderId]
  );

  // Per-line service: the order's own service when it has one (it is only set
  // when every line shared it), otherwise the item's single supported service.
  // Anything still unresolved stays null rather than being guessed at.
  const items = itemsResult.rows.map(({ sole_service_name, ...item }) => ({
    ...item,
    quantity: Number(item.quantity),
    original_quantity: Number(item.original_quantity),
    defective_quantity: Number(item.defective_quantity),
    item_status: String(item.item_status) as
      'PROCESSING' | 'READY' | 'PARTIALLY_PENDING' | 'PENDING',
    pending_quantity: Number(item.pending_quantity || 0),
    // ordered - pending, computed here as it is everywhere: one definition.
    delivery_quantity: Math.max(
      0, Number(item.original_quantity) - Number(item.pending_quantity || 0)
    ),
    pending_reason: item.pending_reason || null,
    laundry_service_name: order.service_name || sole_service_name || null,
  }));

  return {
    ...order,
    items,
    item_count: items.length,
    // The BILLABLE pieces, which is what `quantity` holds. The ordered and
    // defective figures stay on the lines, where the adjustment they describe
    // is visible beside the item it applies to.
    total_quantity: items.reduce((sum, item) => sum + Number(item.quantity), 0),
    has_adjustment: items.some((item) => Number(item.defective_quantity) > 0),
    has_pending_items: items.some((item) => item.pending_quantity > 0),
    // Total order weight = SUM(item weight x quantity), summed from the lines
    // so it always agrees with the itemised list shown on screen and in the PDF.
    total_weight_kg: Number(
      items.reduce((sum, item) => sum + Number(item.total_weight_kg || 0), 0).toFixed(3)
    ),
  };
}

/**
 * The business app's reader: this ACCOUNT's order, or a 404.
 *
 * Unchanged in behaviour and in signature -- the scope predicate is exactly
 * the `business_user_id` check it always applied.
 */
async function getOrderById(
  businessUserId: string,
  orderId: string
): Promise<BusinessOrderDetail> {
  return fetchOrderDetail({ kind: 'ACCOUNT', businessUserId }, orderId);
}

/**
 * Super Admin's reader: one order of the NAMED BUSINESS, or a 404.
 *
 * The business id comes from the path and is part of the predicate, so asking
 * for another business's order under this business simply does not find it --
 * the isolation is the query, not a check that could be forgotten.
 *
 * Authorisation itself is the Super Admin router's, which already runs
 * `authenticate` then `authorize('SUPER_ADMIN')` before anything here; there
 * is no second authorisation system, and this function grants nothing on its
 * own.
 *
 * SAME SHAPE, deliberately. It returns the identical `BusinessOrderDetail`
 * the business app gets, so the Order Confirmation PDF is generated from the
 * same data by the same generator -- there is no Super Admin copy of the
 * document to fall out of step.
 */
async function getOrderForBusiness(
  businessId: string,
  orderId: string
): Promise<BusinessOrderDetail> {
  return fetchOrderDetail({ kind: 'BUSINESS', businessId }, orderId);
}

/**
 * Cancellation is only allowed while the order is still in the confirmation
 * phase (ORDER_PLACED). Enforced here, not in the UI, so a direct API call
 * after that point is rejected too.
 */
const CANCELLABLE_STATUSES = ['ORDER_PLACED'];

/** UI progression, mapped onto the statuses the orders table already uses. */
const TRACKING_STAGES: Array<{ key: string; label: string; statuses: string[] }> = [
  { key: 'placed', label: 'Order Placed', statuses: ['ORDER_PLACED'] },
  {
    key: 'confirmed',
    label: 'Confirmed',
    statuses: ['PICKUP_SCHEDULED', 'PICKUP_ASSIGNED', 'PICKED_UP', 'RECEIVED_AT_FACILITY'],
  },
  {
    key: 'processing',
    label: 'Processing',
    statuses: ['SORTING', 'WASHING', 'DRYING', 'IRONING', 'QUALITY_CHECK'],
  },
  /*
   * PARTIALLY_COMPLETED sits at the SAME step as Ready, because that is what
   * it is: the shop floor has finished its pass and some of the order is
   * ready to go. Giving it a step of its own would add a box to everyone's
   * timeline for a case most orders never reach — and would make the
   * progression look like it had gone backwards for the ones that do.
   *
   * WHICH items are still being worked on is on the items themselves, where a
   * reader can see it against the item it concerns.
   */
  {
    key: 'ready',
    label: 'Ready',
    statuses: ['READY_FOR_DELIVERY', 'PARTIALLY_COMPLETED'],
  },
  {
    key: 'out_for_delivery',
    label: 'Out for Delivery',
    statuses: ['DELIVERY_ASSIGNED', 'OUT_FOR_DELIVERY'],
  },
  { key: 'completed', label: 'Completed', statuses: ['DELIVERED', 'COMPLETED'] },
];

export interface BusinessOrderTracking {
  order_id: string;
  order_number: string;
  status: string;
  is_cancelled: boolean;
  can_cancel: boolean;
  current_stage: string | null;
  stages: Array<{ key: string; label: string; completed: boolean; current: boolean; at: Date | null }>;
  history: Array<{ status: string; notes: string | null; created_at: Date }>;
}

async function getOrderTracking(
  businessUserId: string,
  orderId: string
): Promise<BusinessOrderTracking> {
  const orderResult = await query<{
    id: string;
    order_number: string;
    status: string;
    created_at: Date;
  }>(
    `SELECT id, order_number, status, created_at
     FROM orders
     WHERE id = ? AND business_user_id = ?`,
    [orderId, businessUserId]
  );

  const order = orderResult.rows[0];
  if (!order) {
    throw new AppError('Order not found', 404);
  }

  const historyResult = await query<{ status: string; notes: string | null; created_at: Date }>(
    `SELECT status, notes, created_at
     FROM order_status_history
     WHERE order_id = ?
     ORDER BY created_at ASC, id ASC`,
    [orderId]
  );
  const history = historyResult.rows;

  const isCancelled = order.status === 'CANCELLED';
  const currentIndex = TRACKING_STAGES.findIndex((stage) =>
    stage.statuses.includes(order.status)
  );

  const stages = TRACKING_STAGES.map((stage, index) => {
    const reached = history.find((entry) => stage.statuses.includes(entry.status));
    return {
      key: stage.key,
      label: stage.label,
      completed: !isCancelled && currentIndex >= 0 && index < currentIndex,
      current: !isCancelled && index === currentIndex,
      at:
        reached?.created_at ??
        (stage.key === 'placed' ? order.created_at : null),
    };
  });

  return {
    order_id: order.id,
    order_number: order.order_number,
    status: order.status,
    is_cancelled: isCancelled,
    can_cancel: CANCELLABLE_STATUSES.includes(order.status),
    current_stage: currentIndex >= 0 ? TRACKING_STAGES[currentIndex].key : null,
    stages,
    history,
  };
}

/**
 * Copies a past order's items and selections into the business's cart so the
 * order can be reviewed and then placed through the normal validated
 * create-order flow. Nothing about the old order is copied forward: the new
 * order gets its own id, number, status and timestamps.
 */
async function repeatOrder(
  businessUserId: string,
  orderId: string
): Promise<{ item_count: number; cart: BusinessCart }> {
  const order = await getOrderById(businessUserId, orderId);

  if (!order.laundry_type || !order.order_type) {
    throw new AppError('This order is missing selections and cannot be repeated', 400);
  }

  // Re-validate every item against the catalogue; skip anything retired.
  const itemIds = order.items.map((item) => item.service_id).filter(Boolean) as string[];
  if (itemIds.length === 0) {
    throw new AppError('This order has no items to repeat', 400);
  }

  const placeholders = itemIds.map(() => '?').join(', ');
  const validResult = await query<{ id: string }>(
    `SELECT id FROM services
     WHERE id IN (${placeholders}) AND scope = 'BUSINESS' AND kind = 'ITEM' AND is_active = true`,
    itemIds
  );
  const validIds = new Set(validResult.rows.map((row) => String(row.id)));
  const usableItems = order.items.filter(
    (item) => item.service_id && validIds.has(String(item.service_id))
  );
  if (usableItems.length === 0) {
    throw new AppError('None of the items in this order are available anymore', 400);
  }

  // Carry the previous service forward only when it is still one of the two
  // valid services and still active; otherwise the cart asks for it again.
  let serviceType: string | null = null;
  let serviceId: string | null = null;
  if (order.service_type && VALID_SERVICE_TYPES.includes(order.service_type)) {
    const serviceResult = await query<{ id: string }>(
      `SELECT s.id FROM services s
       JOIN service_categories c ON c.id = s.category_id
       WHERE s.code = ? AND s.kind = 'SERVICE_TYPE' AND s.is_active = true AND c.kind = 'SERVICE_CATEGORY'`,
      [order.service_type]
    );
    if (serviceResult.rows[0]) {
      serviceType = order.service_type;
      serviceId = serviceResult.rows[0].id;
    }
  }

  // Each repeated line needs its own service, since the Cart requires one per
  // item. The order's service is reused where the item supports it; failing
  // that an item with a single service takes it, and anything else is left
  // for the user to choose in the Cart.
  const repeatIds = usableItems.map((item) => String(item.service_id));
  const supportedResult = await query<{ item_id: string; service_id: string }>(
    `SELECT m.item_id, m.service_id
     FROM item_service_types m
     JOIN services st ON st.id = m.service_id
     WHERE m.item_id IN (${repeatIds.map(() => '?').join(', ')})
       AND st.kind = 'SERVICE_TYPE' AND st.is_active = true
     ORDER BY st.display_order ASC, st.name ASC`,
    repeatIds
  );
  const supportedByItem = new Map<string, string[]>();
  for (const row of supportedResult.rows) {
    const list = supportedByItem.get(String(row.item_id)) || [];
    list.push(String(row.service_id));
    supportedByItem.set(String(row.item_id), list);
  }
  const lineServiceFor = (itemId: string): string | null => {
    const supported = supportedByItem.get(String(itemId)) || [];
    if (supported.length === 0) return null;
    if (serviceId && supported.includes(String(serviceId))) return String(serviceId);
    return supported.length === 1 ? supported[0] : null;
  };

  const connection = await getClient();
  try {
    await connection.beginTransaction();

    const [cartRows]: any = await connection.execute(
      `SELECT id FROM carts WHERE business_user_id = ?`,
      [businessUserId]
    );
    let cartId = cartRows[0]?.id;
    if (!cartId) {
      const [inserted]: any = await connection.execute(
        `INSERT INTO carts (business_user_id) VALUES (?)`,
        [businessUserId]
      );
      cartId = inserted.insertId;
    }

    // Start from a clean cart so the repeat reflects the original order.
    await connection.execute(`DELETE FROM cart_items WHERE cart_id = ?`, [cartId]);
    await connection.execute(
      `UPDATE carts SET laundry_type = ?, order_type = ?, service_type = ?, service_id = ?, updated_at = NOW()
       WHERE id = ?`,
      [order.laundry_type, order.order_type, serviceType, serviceId, cartId]
    );

    for (const item of usableItems) {
      await connection.execute(
        // price_at_add is staging only -- the order is priced from
        // business_price_list when it is placed, so a line that has no
        // configured price yet is held at 0 rather than refused here.
        `INSERT INTO cart_items (cart_id, service_id, laundry_service_id, quantity, price_at_add)
         VALUES (?, ?, ?, ?, COALESCE(
           (SELECT bpl.price FROM business_price_list bpl
             WHERE bpl.item_id = ? AND bpl.is_active = true
               AND bpl.business_id = (SELECT business_id FROM business_users WHERE id = ?)), 0))
         ON DUPLICATE KEY UPDATE
           quantity = quantity + VALUES(quantity),
           laundry_service_id = COALESCE(VALUES(laundry_service_id), laundry_service_id),
           updated_at = NOW()`,
        /*
         * REPEATING ORDERS WHAT WAS ASKED FOR, not what survived.
         *
         * `original_quantity`, deliberately. If ten towels were sent and two
         * came back damaged, the line now BILLS eight -- but the business
         * still wanted ten, and "order this again" means ten. Repeating the
         * billable figure would quietly shrink every repeat of an order that
         * ever had a defective piece, and shrink it again on each repeat.
         *
         * Identical to `item.quantity` for any order with no adjustment,
         * which is almost all of them.
         */
        [cartId, item.service_id, lineServiceFor(item.service_id!), item.original_quantity, item.service_id, businessUserId]
      );
    }

    await connection.commit();
    logger.info(
      `[BusinessOrderService] Order ${order.order_number} repeated into cart for business user ${businessUserId}`
    );
    // The cart is returned so the client can show the repeated items straight
    // away instead of relying on a follow-up fetch.
    return { item_count: usableItems.length, cart: await getCart(businessUserId) };
  } catch (error) {
    await connection.rollback();
    logger.error('[BusinessOrderService] repeatOrder transaction failed:', error);
    throw error;
  } finally {
    connection.release();
  }
}

/** Matches the reason list in the cancellation window. */
const MAX_CANCEL_REASON_LENGTH = 300;

function normaliseCancelReason(reason?: unknown): string {
  const text = String(reason ?? '').trim();
  if (!text) return 'Cancelled by business';
  return text.slice(0, MAX_CANCEL_REASON_LENGTH);
}

async function cancelOrder(
  businessUserId: string,
  orderId: string,
  reason?: string
): Promise<{ id: string; order_number: string; status: string }> {
  const cancelReason = normaliseCancelReason(reason);
  const connection = await getClient();
  try {
    await connection.beginTransaction();

    // Lock the row so a concurrent status change cannot race the check.
    const [rows]: any = await connection.execute(
      `SELECT id, order_number, status FROM orders
       WHERE id = ? AND business_user_id = ?
       FOR UPDATE`,
      [orderId, businessUserId]
    );

    const order = rows[0];
    if (!order) {
      await connection.rollback();
      throw new AppError('Order not found', 404);
    }

    if (order.status === 'CANCELLED') {
      await connection.rollback();
      throw new AppError('This order has already been cancelled', 409);
    }

    if (!CANCELLABLE_STATUSES.includes(order.status)) {
      await connection.rollback();
      throw new AppError(
        'This order can no longer be cancelled because it has moved past the confirmation phase.',
        409
      );
    }

    await connection.execute(
      `UPDATE orders
       SET status = 'CANCELLED', cancelled_at = NOW(), cancelled_reason = ?, updated_at = NOW()
       WHERE id = ?`,
      [cancelReason, orderId]
    );

    await connection.execute(
      `INSERT INTO order_status_history (order_id, status, notes)
       VALUES (?, 'CANCELLED', ?)`,
      [orderId, cancelReason]
    );

    await connection.commit();
    logger.info(`[BusinessOrderService] Order ${order.order_number} cancelled by business user ${businessUserId}`);

    return { id: String(order.id), order_number: order.order_number, status: 'CANCELLED' };
  } catch (error) {
    if (!(error instanceof AppError)) {
      await connection.rollback();
    }
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * Books the delivery for an order that was placed without one.
 *
 * The order must belong to the calling business — the `business_user_id`
 * predicate is what stops one business scheduling another's delivery — and
 * must not already have a delivery, so this can never quietly overwrite a
 * booking someone else made.
 *
 * The pickup it is validated against is the one stored on the order, not
 * anything the caller sends, so "after the pickup" means after the real
 * pickup.
 */
async function scheduleDelivery(
  businessUserId: string,
  orderId: string,
  input: { deliveryDate?: unknown; deliverySlot?: unknown }
): Promise<{
  order_id: string;
  order_number: string;
  delivery: { date: string; slot_label: string; slot_start: string; slot_end: string };
}> {
  const orderResult = await query<{
    id: string;
    order_number: string;
    status: string;
    pickup_date: string | null;
    pickup_start: string | null;
    pickup_notes: string | null;
    delivery_id: string | null;
  }>(
    `SELECT o.id, o.order_number, o.status,
            DATE_FORMAT(p.scheduled_date, '%Y-%m-%d') AS pickup_date,
            p.time_slot_start AS pickup_start,
            p.notes AS pickup_notes,
            d.id AS delivery_id
       FROM orders o
       LEFT JOIN pickups p ON p.order_id = o.id
       LEFT JOIN deliveries d ON d.order_id = o.id
      WHERE o.id = ? AND o.business_user_id = ?`,
    [orderId, businessUserId]
  );

  const order = orderResult.rows[0];
  if (!order) {
    throw new AppError('Order not found', 404);
  }
  if (order.status === 'CANCELLED') {
    throw new AppError('This order has been cancelled.', 400);
  }
  if (order.delivery_id) {
    throw new AppError('A delivery is already scheduled for this order.', 409);
  }
  if (!order.pickup_date || !order.pickup_start) {
    throw new AppError('This order has no pickup to schedule a delivery against.', 400);
  }

  const { deliveryDate, delivery } = await resolveDeliverySchedule(
    order.pickup_date,
    order.pickup_start,
    input
  );

  await query(
    `INSERT INTO deliveries (order_id, scheduled_date, time_slot_start, time_slot_end, status, notes)
     VALUES (?, ?, ?, ?, 'SCHEDULED', ?)`,
    [orderId, deliveryDate, delivery.start, delivery.end, order.pickup_notes || null]
  );

  logger.info(
    `[BusinessOrderService] delivery scheduled for ${order.order_number}: ${deliveryDate} ${delivery.label}`
  );

  return {
    order_id: String(order.id),
    order_number: order.order_number,
    delivery: {
      date: deliveryDate,
      slot_label: delivery.label,
      slot_start: delivery.start,
      slot_end: delivery.end,
    },
  };
}

export {
  createOrder,
  scheduleDelivery,
  getOrders,
  getOrderById,
  getOrderForBusiness,
  getOrderTracking,
  repeatOrder,
  cancelOrder,
  CANCELLABLE_STATUSES,
};