import { getClient, query } from '../config/database';
import { AppError } from '../utils/appError';
import { logger } from '../utils/logger';
import { config } from '../config/env';
import { getCart, BusinessCart } from './businessCart.service';
import { assertComplete } from './businessCompleteness';
import { generateGarmentsForOrder } from './garment.service';
import { OrderSchedule } from './pickupSlot.service';

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

export interface BusinessOrderResult {
  id: string;
  order_number: string;
  laundry_type: string;
  order_type: string;
  service_type: string;
  status: string;
  subtotal: number;
  total: number;
  /** SUM(item weight x quantity) for the whole order, in kg. */
  total_weight_kg: number;
  /** The pickup booked with the order, from the `pickups` row. */
  pickup: { date: string; slot_label: string; slot_start: string; slot_end: string };
  /** The delivery booked with it, from the `deliveries` row. */
  delivery: { date: string; slot_label: string; slot_start: string; slot_end: string };
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
  schedule: OrderSchedule
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
  await assertComplete(ownerResult.rows[0].business_id);
  if (!cart.laundry_type) {
    throw new AppError('Laundry type has not been selected', 400);
  }
  if (!cart.order_type) {
    throw new AppError('Order type has not been selected', 400);
  }

  // The service belongs to each line, not to the order, so the cart-level
  // service is no longer required — every line having one is.
  const itemsResult = await query<{
    service_id: string;
    name: string;
    category_id: string;
    unit: string;
    base_price: number;
    weight_kg: number | null;
    is_active: boolean;
    quantity: number;
    laundry_service_id: string | null;
    laundry_service_code: string | null;
  }>(
    `SELECT s.id AS service_id, s.name, s.category_id, s.unit, s.base_price,
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

  const subtotal = cartItems.reduce((sum, item) => sum + Number(item.base_price) * item.quantity, 0);

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
      `INSERT INTO orders (order_number, business_user_id, laundry_type, order_type, service_type, service_id, status, subtotal, total_weight_kg, total, special_notes)
       VALUES (?, ?, ?, ?, ?, ?, 'ORDER_PLACED', ?, ?, ?, ?)`,
      [orderNumber, businessUserId, cart.laundry_type, cart.order_type, orderServiceType, orderServiceId, subtotal, totalWeightKg, subtotal, schedule.serviceNotes || null]
    );
    const orderId = orderInsert.insertId;

    for (const item of cartItems) {
      const totalPrice = Number(item.base_price) * item.quantity;
      // Weight is snapshotted on the line so a later catalogue change cannot
      // rewrite the weight of an order that was already placed.
      await connection.execute(
        `INSERT INTO order_items (order_id, service_id, category_id, service_name, unit, weight_kg, total_weight_kg, quantity, unit_price, total_price)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [orderId, item.service_id, item.category_id, item.name, item.unit, item.weight_kg, lineWeight(item), item.quantity, item.base_price, totalPrice]
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
      [orderId, schedule.date, schedule.pickup.start, schedule.pickup.end, pickupNotes]
    );
    await connection.execute(
      `INSERT INTO deliveries (order_id, scheduled_date, time_slot_start, time_slot_end, status, notes)
       VALUES (?, ?, ?, ?, 'SCHEDULED', ?)`,
      [orderId, schedule.date, schedule.delivery.start, schedule.delivery.end, pickupNotes]
    );

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
      subtotal,
      total: subtotal,
      total_weight_kg: totalWeightKg,
      pickup: {
        date: schedule.date,
        slot_label: schedule.pickup.label,
        slot_start: schedule.pickup.start,
        slot_end: schedule.pickup.end,
      },
      delivery: {
        date: schedule.date,
        slot_label: schedule.delivery.label,
        slot_start: schedule.delivery.start,
        slot_end: schedule.delivery.end,
      },
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
  total: number;
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
            s.name AS service_name, o.status, o.total, o.created_at,
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
  business_mobile: string | null;
  business_email: string | null;
  business_address: string | null;
  subtotal: number;
  delivery_charge: number;
  tax: number;
  coupon_discount: number;
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
    quantity: number;
    unit: string;
    /** Standard weight per piece as it was when the order was placed. */
    weight_kg: number | null;
    /** weight_kg x quantity. */
    total_weight_kg: number;
    unit_price: number;
    total_price: number;
  }>;
}

/**
 * Full order for the owning business. The business_user_id predicate is what
 * stops one business reading another's order.
 */
async function getOrderById(
  businessUserId: string,
  orderId: string
): Promise<BusinessOrderDetail> {
  const orderResult = await query<BusinessOrderDetail>(
    `SELECT o.id, o.order_number, o.laundry_type, o.order_type, o.service_type,
            s.name AS service_name, o.status, o.created_at,
            o.subtotal, o.delivery_charge, o.tax, o.coupon_discount, o.total,
            b.name AS business_name, b.contact_person_name,
            COALESCE(bu.mobile_number, b.mobile_number) AS business_mobile,
            COALESCE(b.email_id, bu.email) AS business_email,
            COALESCE(b.establishment_address, b.address) AS business_address
     FROM orders o
     JOIN business_users bu ON bu.id = o.business_user_id
     JOIN businesses b ON b.id = bu.business_id
     LEFT JOIN services s ON s.id = o.service_id
     WHERE o.id = ? AND o.business_user_id = ?`,
    [orderId, businessUserId]
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
            oi.quantity, oi.unit,
            COALESCE(oi.weight_kg, s.weight_kg) AS weight_kg,
            COALESCE(oi.total_weight_kg, ROUND(s.weight_kg * oi.quantity, 3), 0) AS total_weight_kg,
            oi.unit_price, oi.total_price,
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
    laundry_service_name: order.service_name || sole_service_name || null,
  }));

  return {
    ...order,
    items,
    item_count: items.length,
    total_quantity: items.reduce((sum, item) => sum + Number(item.quantity), 0),
    // Total order weight = SUM(item weight x quantity), summed from the lines
    // so it always agrees with the itemised list shown on screen and in the PDF.
    total_weight_kg: Number(
      items.reduce((sum, item) => sum + Number(item.total_weight_kg || 0), 0).toFixed(3)
    ),
  };
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
  { key: 'ready', label: 'Ready', statuses: ['READY_FOR_DELIVERY'] },
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
        `INSERT INTO cart_items (cart_id, service_id, laundry_service_id, quantity, price_at_add)
         VALUES (?, ?, ?, ?, (SELECT base_price FROM services WHERE id = ?))
         ON DUPLICATE KEY UPDATE
           quantity = quantity + VALUES(quantity),
           laundry_service_id = COALESCE(VALUES(laundry_service_id), laundry_service_id),
           updated_at = NOW()`,
        [cartId, item.service_id, lineServiceFor(item.service_id!), item.quantity, item.service_id]
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

export {
  createOrder,
  getOrders,
  getOrderById,
  getOrderTracking,
  repeatOrder,
  cancelOrder,
  CANCELLABLE_STATUSES,
};
