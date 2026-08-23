import { query, getClient } from '../config/database';
import { logger } from '../utils/logger';
import { validateCoupon } from './cart.service';
import socketService from './socket.service';
import { createNotification } from './notification.service';
import { requireCustomerPrices } from './priceList.service';
import { normaliseMobileOrNull } from './businessContact.service';

const DELIVERY_CHARGE = 40;
const FREE_DELIVERY_THRESHOLD = 399;
const CANCELLABLE_STATUSES = ['ORDER_PLACED', 'CONFIRMED', 'RECEIVED_AT_FACILITY'];

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
 * The order number is derived from the row's own AUTO_INCREMENT id, so it is
 * unique without a MAX()+1 read and safe under concurrency.
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
      `SELECT ci.service_id, s.name AS service_name, s.unit, ci.quantity
       FROM cart_items ci
       JOIN services s ON s.id = ci.service_id
       WHERE ci.cart_id = ?`,
      [cart.id]
    );
    if (cartItems.length === 0) throw new Error('Cart is empty');

    // 3) Prices, from the GLOBAL customer price list. Every customer
    //    pays the same figure for the same item; nothing here is
    //    per-customer, and business_price_list is never consulted.
    const customerPrices = await requireCustomerPrices(
      cartItems.map((item: any) => String(item.service_id))
    );
    for (const item of cartItems) {
      item.price = customerPrices.get(String(item.service_id))!;
    }

    const subtotal = cartItems.reduce(
      (sum: number, item: any) => sum + Number(item.price) * Number(item.quantity),
      0
    );
    const delivery_charge = subtotal >= FREE_DELIVERY_THRESHOLD ? 0 : DELIVERY_CHARGE;

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

    // 5) INSERT order, then stamp its number from the generated id.
    const [orderInsert]: any = await connection.execute(
      `INSERT INTO orders (
         user_id, address_id, placed_by_mobile, order_number, status, subtotal,
         delivery_charge, coupon_discount, coupon_id, total,
         payment_method, payment_status, special_notes
       )
       VALUES (?, ?, ?, '', 'ORDER_PLACED', ?, ?, ?, ?, ?, ?, 'PENDING', ?)`,
      // `placed_by_mobile` is written ONCE, here, and never updated: changing
      // the profile number later must not rewrite what an order already says.
      [
        userId,
        input.address_id,
        normaliseMobileOrNull(placedByMobile),
        subtotal,
        delivery_charge,
        discountAmount,
        couponId,
        totalAmount,
        input.payment_method,
        input.notes || null,
      ]
    );
    const orderId = String(orderInsert.insertId);

    await connection.execute(
      `UPDATE orders
          SET order_number = CONCAT('ORD#', DATE_FORMAT(created_at, '%d%m%Y'), LPAD(id, 6, '0'))
        WHERE id = ?`,
      [orderId]
    );

    const [numberRows]: any = await connection.execute(
      `SELECT order_number FROM orders WHERE id = ?`,
      [orderId]
    );
    const orderNumber = numberRows[0].order_number as string;

    // 6) INSERT order_items
    for (const item of cartItems) {
      await connection.execute(
        // `original_quantity` equals `quantity` at placement — nothing has been
        // found defective yet. Written explicitly so the pieces the order was
        // placed for are on the row from the start.
        `INSERT INTO order_items (order_id, service_id, service_name, unit, quantity, original_quantity, defective_quantity, unit_price, total_price)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        [
          orderId,
          item.service_id,
          item.service_name,
          item.unit,
          item.quantity,
          item.quantity,
          item.price,
          Number(item.price) * Number(item.quantity),
        ]
      );
    }

    // 7) INSERT order_status_history (ORDER_PLACED)
    await connection.execute(
      `INSERT INTO order_status_history (order_id, status, changed_by, notes)
       VALUES (?, 'ORDER_PLACED', ?, 'Order placed by customer')`,
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
      status: 'ORDER_PLACED',
      subtotal,
      delivery_charge,
      discount_amount: discountAmount,
      total_amount: totalAmount,
      payment_method: input.payment_method,
      payment_status: 'PENDING',
      notes: input.notes,
      created_at: new Date(),
    };

    // Fire notifications
    await createNotification(
      userId,
      order.id,
      'ORDER_PLACED',
      'Order Placed!',
      `Your order ${order.order_number} has been placed successfully.`
    );

    socketService.emitOrderStatusUpdate(order.id, {
      orderId: order.id,
      orderNumber: order.order_number,
      status: 'ORDER_PLACED',
    });

    logger.info(`[OrderService] Order created: ${order.order_number} for user ${userId}`);
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
  const conditions: string[] = ['o.user_id = $1'];
  const values: unknown[] = [userId];
  let paramIndex = 2;

  if (status) {
    conditions.push(`o.status = $${paramIndex++}`);
    values.push(status);
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM orders o ${whereClause}`,
    values
  );
  const total = parseInt(countResult.rows[0]?.count || '0', 10);

  const dataValues = [...values, limit, offset];
  const ordersResult = await query<OrderRow & { item_count: string }>(
    `SELECT o.*, COUNT(oi.id) AS item_count
     FROM orders o
     LEFT JOIN order_items oi ON oi.order_id = o.id
     ${whereClause}
     GROUP BY o.id
     ORDER BY o.created_at DESC
     LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    dataValues
  );

  return { orders: ordersResult.rows, total };
}

async function getOrderById(userId: string, orderId: string): Promise<OrderRow | null> {
  const result = await query<OrderRow>(
    `SELECT o.*,
            json_agg(
              json_build_object(
                'id', oi.id,
                'service_id', oi.service_id,
                'service_name', s.name,
                'quantity', oi.quantity,
                'unit_price', oi.unit_price,
                'total_price', oi.total_price,
                'unit', s.unit
              )
            ) FILTER (WHERE oi.id IS NOT NULL) AS items,
            row_to_json(pk.*) AS pickup,
            row_to_json(dl.*) AS delivery,
            row_to_json(a.*) AS address
     FROM orders o
     LEFT JOIN order_items oi ON oi.order_id = o.id
     LEFT JOIN services s ON s.id = oi.service_id
     LEFT JOIN pickups pk ON pk.order_id = o.id
     LEFT JOIN deliveries dl ON dl.order_id = o.id
     LEFT JOIN addresses a ON a.id = o.address_id
     WHERE o.id = $1 AND o.user_id = $2
     GROUP BY o.id, pk.id, dl.id, a.id`,
    [orderId, userId]
  );
  return result.rows[0] || null;
}

async function cancelOrder(
  userId: string,
  orderId: string,
  reason?: string
): Promise<OrderRow> {
  const orderResult = await query<{ id: string; status: string }>(
    `SELECT id, status FROM orders WHERE id = $1 AND user_id = $2`,
    [orderId, userId]
  );

  const order = orderResult.rows[0];
  if (!order) {
    throw new Error('Order not found');
  }
  if (!CANCELLABLE_STATUSES.includes(order.status)) {
    throw new Error(
      `Order cannot be cancelled in status: ${order.status}. Only orders in ${CANCELLABLE_STATUSES.join(', ')} can be cancelled.`
    );
  }

  const updatedResult = await query<OrderRow>(
    `UPDATE orders
     SET status = 'CANCELLED', updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [orderId]
  );

  await query(
    `INSERT INTO order_status_history (order_id, status, changed_by, notes)
     VALUES ($1, 'CANCELLED', $2, $3)`,
    [orderId, userId, reason || 'Cancelled by customer']
  );

  logger.info(`[OrderService] Order ${orderId} cancelled by user ${userId}`);
  return updatedResult.rows[0];
}

async function getOrderTracking(orderId: string): Promise<object | null> {
  const orderResult = await query(
    `SELECT o.id, o.order_number, o.status, o.total_amount, o.created_at,
            row_to_json(pk.*) AS pickup,
            row_to_json(dl.*) AS delivery
     FROM orders o
     LEFT JOIN pickups pk ON pk.order_id = o.id
     LEFT JOIN deliveries dl ON dl.order_id = o.id
     WHERE o.id = $1
     GROUP BY o.id, pk.id, dl.id`,
    [orderId]
  );

  const order = orderResult.rows[0];
  if (!order) return null;

  const statusHistoryResult = await query(
    `SELECT status, notes, changed_by, created_at
     FROM order_status_history
     WHERE order_id = $1
     ORDER BY created_at ASC`,
    [orderId]
  );

  const productionResult = await query(
    `SELECT po.id, po.current_status,
            json_agg(
              json_build_object(
                'status', psh.status,
                'notes', psh.notes,
                'created_at', psh.created_at
              ) ORDER BY psh.created_at ASC
            ) FILTER (WHERE psh.id IS NOT NULL) AS history
     FROM production_orders po
     LEFT JOIN production_status_history psh ON psh.production_order_id = po.id
     WHERE po.order_id = $1
     GROUP BY po.id`,
    [orderId]
  );

  return {
    ...order,
    status_history: statusHistoryResult.rows,
    production: productionResult.rows[0] || null,
  };
}

export { createOrder, getOrders, getOrderById, cancelOrder, getOrderTracking };
