import { query } from '../config/database';
import { logger } from '../utils/logger';

const DELIVERY_CHARGE = 40;
const FREE_DELIVERY_THRESHOLD = 399;

export interface CartItem {
  id: string;
  cart_id: string;
  service_id: string;
  service_name: string;
  price: number;
  unit: string;
  image_url?: string;
  quantity: number;
  item_total: number;
}

export interface Cart {
  id: string;
  user_id: string;
  items: CartItem[];
  subtotal: number;
  delivery_charge: number;
  total: number;
}

export interface CouponResult {
  id: string;
  code: string;
  discount_type: 'PERCENTAGE' | 'FIXED';
  discount_value: number;
  discount_amount: number;
  final_total: number;
}

async function getCart(userId: string): Promise<Cart> {
  const cartResult = await query<{ id: string; user_id: string }>(
    `SELECT id, user_id FROM carts WHERE user_id = $1`,
    [userId]
  );

  let cart = cartResult.rows[0];
  if (!cart) {
    const newCart = await query<{ id: string; user_id: string }>(
      `INSERT INTO carts (user_id) VALUES ($1) RETURNING id, user_id`,
      [userId]
    );
    cart = newCart.rows[0];
  }

  // Price comes from the global customer price list, never from
  // `ci.price_at_add` (a staging value) and never from a column on
  // `services` (there is no price column there -- base_price holds
  // legacy placeholders). Every customer sees the same figure.
  const itemsResult = await query<CartItem>(
    `SELECT ci.id, ci.cart_id, ci.service_id, s.name AS service_name,
            cp.customer_price AS price, s.unit, s.image_url, ci.quantity,
            (cp.customer_price * ci.quantity) AS item_total
     FROM cart_items ci
     JOIN services s ON s.id = ci.service_id
     LEFT JOIN customer_price_list cp ON cp.item_id = s.id AND cp.is_active = true
     WHERE ci.cart_id = $1
     ORDER BY ci.created_at ASC`,
    [cart.id]
  );

  const items = itemsResult.rows;
  const subtotal = items.reduce((sum, item) => sum + Number(item.item_total), 0);
  const delivery_charge = subtotal >= FREE_DELIVERY_THRESHOLD ? 0 : subtotal > 0 ? DELIVERY_CHARGE : 0;
  const total = subtotal + delivery_charge;

  return {
    id: cart.id,
    user_id: cart.user_id,
    items,
    subtotal,
    delivery_charge,
    total,
  };
}

async function addItem(
  userId: string,
  serviceId: string,
  quantity: number
): Promise<Cart> {
  logger.debug(`[CartService] Adding item ${serviceId} (qty: ${quantity}) for user ${userId}`);

  const serviceResult = await query<{ id: string; is_active: boolean }>(
    `SELECT id, is_active FROM services WHERE id = $1`,
    [serviceId]
  );
  const service = serviceResult.rows[0];
  if (!service || !service.is_active) {
    throw new Error('Service not found or unavailable');
  }

  const cartResult = await query<{ id: string }>(
    `SELECT id FROM carts WHERE user_id = $1`,
    [userId]
  );
  let cartId = cartResult.rows[0]?.id;
  if (!cartId) {
    const newCart = await query<{ id: string }>(
      `INSERT INTO carts (user_id) VALUES ($1) RETURNING id`,
      [userId]
    );
    cartId = newCart.rows[0].id;
  }

  await query(
    `INSERT INTO cart_items (cart_id, service_id, quantity)
     VALUES ($1, $2, $3)
     ON CONFLICT (cart_id, service_id)
     DO UPDATE SET quantity = cart_items.quantity + EXCLUDED.quantity, updated_at = NOW()`,
    [cartId, serviceId, quantity]
  );

  return getCart(userId);
}

async function updateItem(
  userId: string,
  cartItemId: string,
  quantity: number
): Promise<Cart> {
  const ownerCheck = await query<{ id: string }>(
    `SELECT ci.id FROM cart_items ci
     JOIN carts c ON c.id = ci.cart_id
     WHERE ci.id = $1 AND c.user_id = $2`,
    [cartItemId, userId]
  );

  if (ownerCheck.rows.length === 0) {
    throw new Error('Cart item not found or access denied');
  }

  await query(
    `UPDATE cart_items SET quantity = $1, updated_at = NOW() WHERE id = $2`,
    [quantity, cartItemId]
  );

  return getCart(userId);
}

async function removeItem(userId: string, cartItemId: string): Promise<Cart> {
  const ownerCheck = await query<{ id: string }>(
    `SELECT ci.id FROM cart_items ci
     JOIN carts c ON c.id = ci.cart_id
     WHERE ci.id = $1 AND c.user_id = $2`,
    [cartItemId, userId]
  );

  if (ownerCheck.rows.length === 0) {
    throw new Error('Cart item not found or access denied');
  }

  await query(`DELETE FROM cart_items WHERE id = $1`, [cartItemId]);

  return getCart(userId);
}

async function clearCart(userId: string): Promise<void> {
  await query(
    `DELETE FROM cart_items
     WHERE cart_id = (SELECT id FROM carts WHERE user_id = $1)`,
    [userId]
  );
  logger.debug(`[CartService] Cart cleared for user ${userId}`);
}

async function validateCoupon(
  code: string,
  subtotal: number
): Promise<CouponResult> {
  const result = await query<{
    id: string;
    code: string;
    discount_type: 'PERCENTAGE' | 'FIXED';
    discount_value: number;
    min_order_amount: number;
    max_discount_amount?: number;
    is_active: boolean;
    valid_from: Date;
    valid_until?: Date;
    usage_limit?: number;
    used_count: number;
  }>(
    `SELECT id, code, discount_type, discount_value, min_order_amount,
            max_discount_amount, is_active, valid_from, valid_until,
            usage_limit, used_count
     FROM coupons
     WHERE code = $1`,
    [code.toUpperCase()]
  );

  const coupon = result.rows[0];
  if (!coupon) {
    throw new Error('Invalid coupon code');
  }
  if (!coupon.is_active) {
    throw new Error('This coupon is no longer active');
  }

  const now = new Date();
  if (coupon.valid_from > now) {
    throw new Error('This coupon is not yet valid');
  }
  if (coupon.valid_until && coupon.valid_until < now) {
    throw new Error('This coupon has expired');
  }
  if (coupon.usage_limit != null && coupon.used_count >= coupon.usage_limit) {
    throw new Error('This coupon has reached its usage limit');
  }
  if (subtotal < Number(coupon.min_order_amount)) {
    throw new Error(
      `Minimum order amount of ₹${coupon.min_order_amount} required for this coupon`
    );
  }

  let discountAmount: number;
  if (coupon.discount_type === 'PERCENTAGE') {
    discountAmount = (subtotal * Number(coupon.discount_value)) / 100;
    if (coupon.max_discount_amount) {
      discountAmount = Math.min(discountAmount, Number(coupon.max_discount_amount));
    }
  } else {
    discountAmount = Number(coupon.discount_value);
  }

  discountAmount = Math.min(discountAmount, subtotal);
  const finalTotal = subtotal - discountAmount;

  return {
    id: coupon.id,
    code: coupon.code,
    discount_type: coupon.discount_type,
    discount_value: Number(coupon.discount_value),
    discount_amount: parseFloat(discountAmount.toFixed(2)),
    final_total: parseFloat(finalTotal.toFixed(2)),
  };
}

export { getCart, addItem, updateItem, removeItem, clearCart, validateCoupon };
