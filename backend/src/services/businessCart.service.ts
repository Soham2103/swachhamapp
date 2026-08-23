import { query } from '../config/database';
import { AppError } from '../utils/appError';
import { lookupBusinessPrice } from './priceList.service';

export type LaundryType = 'hotel' | 'guest';
export type OrderType = 'standard' | 'quick';
export type ServiceType = 'wash_iron' | 'dry_clean';

export interface BusinessCartItem {
  id: string;
  item_id: string;
  item_name: string;
  category_id: string;
  category_name: string;
  image_url?: string;
  unit: string;
  quantity: number;
  /** Standard weight per piece, in `weight_unit`. */
  weight_kg: number | null;
  weight_unit: string;
  /** weight_kg x quantity. */
  total_weight_kg: number;
  /** The service this line was added for, e.g. 'wash_iron'. */
  service_type: ServiceType | null;
  service_name: string | null;
  /** The services this item supports, so the line can be switched. */
  available_service_types: string[];
}

export interface BusinessCart {
  id: string;
  laundry_type: LaundryType | null;
  order_type: OrderType | null;
  service_type: ServiceType | null;
  items: BusinessCartItem[];
  /** SUM(item weight x quantity) across the cart, in kg. */
  total_weight_kg: number;
}

const LAUNDRY_TYPES = ['hotel', 'guest'];
const ORDER_TYPES = ['standard', 'quick'];
const SERVICE_TYPES = ['wash_iron', 'dry_clean'];

type CartItemRow = Omit<BusinessCartItem, 'available_service_types'> & {
  available_service_codes: string | null;
};

function toCartItem(row: CartItemRow): BusinessCartItem {
  const { available_service_codes, ...item } = row;
  return {
    ...item,
    available_service_types: available_service_codes ? available_service_codes.split(',') : [],
  };
}

async function getOrCreateCartId(businessUserId: string): Promise<string> {
  const existing = await query<{ id: string }>(
    `SELECT id FROM carts WHERE business_user_id = ?`,
    [businessUserId]
  );
  if (existing.rows[0]) return existing.rows[0].id;

  const inserted = await query(
    `INSERT INTO carts (business_user_id) VALUES (?)`,
    [businessUserId]
  );
  return inserted.insertId!;
}

async function getCart(businessUserId: string): Promise<BusinessCart> {
  const cartResult = await query<{
    id: string;
    laundry_type: LaundryType | null;
    order_type: OrderType | null;
    service_type: ServiceType | null;
  }>(
    `SELECT id, laundry_type, order_type, service_type FROM carts WHERE business_user_id = ?`,
    [businessUserId]
  );

  if (!cartResult.rows[0]) {
    return { id: '', laundry_type: null, order_type: null, service_type: null, items: [], total_weight_kg: 0 };
  }
  const cart = cartResult.rows[0];

  // Unit weight is always read from the catalogue row, never from the cart
  // line, so a line can never carry a stale or invented weight.
  const itemsResult = await query<CartItemRow>(
    `SELECT ci.id, ci.service_id AS item_id, s.name AS item_name,
            s.category_id, c.name AS category_name, s.image_url, s.unit, ci.quantity,
            s.weight_kg, s.weight_unit,
            ROUND(COALESCE(s.weight_kg, 0) * ci.quantity, 3) AS total_weight_kg,
            st.code AS service_type, st.name AS service_name,
            (SELECT GROUP_CONCAT(a.code ORDER BY a.display_order ASC, a.name ASC)
               FROM item_service_types m
               JOIN services a ON a.id = m.service_id
              WHERE m.item_id = s.id AND a.kind = 'SERVICE_TYPE' AND a.is_active = true
            ) AS available_service_codes
     FROM cart_items ci
     JOIN services s ON s.id = ci.service_id
     JOIN service_categories c ON c.id = s.category_id
     LEFT JOIN services st ON st.id = ci.laundry_service_id AND st.kind = 'SERVICE_TYPE'
     WHERE ci.cart_id = ?
     ORDER BY ci.created_at ASC`,
    [cart.id]
  );

  const items = itemsResult.rows.map(toCartItem);
  // Total order weight = SUM(item weight x quantity).
  const totalWeight = items.reduce((sum, item) => sum + Number(item.total_weight_kg || 0), 0);

  return { ...cart, items, total_weight_kg: Number(totalWeight.toFixed(3)) };
}

function validateContext(laundryType?: string, orderType?: string) {
  if (laundryType !== undefined && !LAUNDRY_TYPES.includes(laundryType)) {
    throw new AppError('Invalid laundry type', 400);
  }
  if (orderType !== undefined && !ORDER_TYPES.includes(orderType)) {
    throw new AppError('Invalid order type', 400);
  }
}

/** The services an item can be given, in catalogue order. */
async function getSupportedServices(itemId: string): Promise<Array<{ id: string; code: string }>> {
  const result = await query<{ id: string; code: string }>(
    `SELECT st.id, st.code
     FROM item_service_types m
     JOIN services st ON st.id = m.service_id
     WHERE m.item_id = ? AND st.kind = 'SERVICE_TYPE' AND st.is_active = true
     ORDER BY st.display_order ASC, st.name ASC`,
    [itemId]
  );
  return result.rows;
}

/**
 * Resolves the service a cart line carries from the code the user chose for
 * that item.
 *
 * The choice must be one the item actually supports — a Dry Clean only carpet
 * can never end up on a Wash & Iron line. There is no fallback: a service is
 * always chosen explicitly, per item.
 */
async function resolveItemServiceId(itemId: string, requestedCode: string): Promise<string> {
  const supported = await getSupportedServices(itemId);
  const match = supported.find((service) => service.code === requestedCode);
  if (!match) {
    throw new AppError('This item is not available for the selected service', 400);
  }
  return match.id;
}

/**
 * Adds one line to the cart.
 *
 * The service is per line and compulsory: the same rule the Items page
 * enforces, repeated here so a direct API call cannot create a line without
 * one. Order Type and Laundry Type are not accepted here at all — both are
 * chosen in the Cart, through setCartContext.
 */
async function addItem(
  businessUserId: string,
  itemId: string,
  quantity: number,
  itemServiceType: string
): Promise<BusinessCart> {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new AppError('Quantity must be a positive whole number', 400);
  }
  if (!itemServiceType) {
    throw new AppError('Please select at least one laundry service for this item.', 400);
  }
  if (!SERVICE_TYPES.includes(itemServiceType)) {
    throw new AppError('Invalid service type', 400);
  }

  const itemResult = await query<{ id: string; is_active: boolean }>(
    `SELECT id, is_active FROM services WHERE id = ? AND scope = 'BUSINESS' AND kind = 'ITEM'`,
    [itemId]
  );
  const item = itemResult.rows[0];
  if (!item || !item.is_active) {
    throw new AppError('Item not found or unavailable', 404);
  }

  const cartId = await getOrCreateCartId(businessUserId);

  // The line keeps its own service. Adding the same item again tops up the
  // quantity and re-states the service that was asked for.
  const lineServiceId = await resolveItemServiceId(itemId, itemServiceType);

  // price_at_add is a staging value only. It is filled from this
  // business's own price list at the cart's laundry type where one
  // exists, and left at 0 otherwise -- an item can still be put in the
  // cart before Hotel/Guest is chosen or before its price is configured.
  // Nothing bills from it: createOrder resolves the price again from
  // business_price_list for the type the order is placed at, and refuses
  // the order if it is missing. The business app never sees this column.
  const owner = await query<{ business_id: string }>(
    `SELECT business_id FROM business_users WHERE id = ?`,
    [businessUserId]
  );
  const cartType = await query<{ laundry_type: string | null }>(
    `SELECT laundry_type FROM carts WHERE id = ?`,
    [cartId]
  );
  const stagedPrice = owner.rows[0]
    ? await lookupBusinessPrice(
        owner.rows[0].business_id,
        itemId,
        cartType.rows[0]?.laundry_type ?? null
      )
    : null;

  await query(
    `INSERT INTO cart_items (cart_id, service_id, laundry_service_id, quantity, price_at_add)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       quantity = quantity + VALUES(quantity),
       laundry_service_id = COALESCE(VALUES(laundry_service_id), laundry_service_id),
       price_at_add = VALUES(price_at_add),
       updated_at = NOW()`,
    [cartId, itemId, lineServiceId, quantity, stagedPrice ?? 0]
  );

  return getCart(businessUserId);
}

/**
 * Order Type + Laundry Type, both chosen in the Cart. Either can be sent on
 * its own, so selecting one never clears the other.
 */
async function setCartContext(
  businessUserId: string,
  laundryType?: string,
  orderType?: string
): Promise<BusinessCart> {
  validateContext(laundryType, orderType);

  const fields: string[] = [];
  const values: unknown[] = [];
  if (laundryType !== undefined) { fields.push('laundry_type = ?'); values.push(laundryType); }
  if (orderType !== undefined) { fields.push('order_type = ?'); values.push(orderType); }
  if (fields.length === 0) {
    return getCart(businessUserId);
  }

  const cartId = await getOrCreateCartId(businessUserId);
  await query(`UPDATE carts SET ${fields.join(', ')}, updated_at = NOW() WHERE id = ?`, [...values, cartId]);
  return getCart(businessUserId);
}

/**
 * Updates one cart line: its quantity, its service, or both. The same
 * endpoint covers both so the cart keeps a single update call.
 *
 * The line weight is not stored, so changing the quantity here is all it
 * takes for the line total and the cart total to come back correct.
 */
async function updateItemQuantity(
  businessUserId: string,
  itemId: string,
  quantity?: number,
  itemServiceType?: string
): Promise<BusinessCart> {
  if (quantity === undefined && itemServiceType === undefined) {
    throw new AppError('Nothing to update', 400);
  }
  if (quantity !== undefined && (!Number.isInteger(quantity) || quantity <= 0)) {
    throw new AppError('Quantity must be a positive whole number', 400);
  }
  if (itemServiceType !== undefined && !SERVICE_TYPES.includes(itemServiceType)) {
    throw new AppError('Invalid service type', 400);
  }

  const fields: string[] = [];
  const values: unknown[] = [];
  if (quantity !== undefined) {
    fields.push('ci.quantity = ?');
    values.push(quantity);
  }
  if (itemServiceType !== undefined) {
    // Rejects a service the item does not support.
    fields.push('ci.laundry_service_id = ?');
    values.push(await resolveItemServiceId(itemId, itemServiceType));
  }

  const result = await query(
    `UPDATE cart_items ci
     JOIN carts c ON c.id = ci.cart_id
     SET ${fields.join(', ')}, ci.updated_at = NOW()
     WHERE c.business_user_id = ? AND ci.service_id = ?`,
    [...values, businessUserId, itemId]
  );
  if (result.rowCount === 0) {
    throw new AppError('Cart item not found', 404);
  }

  return getCart(businessUserId);
}

async function removeItem(businessUserId: string, itemId: string): Promise<BusinessCart> {
  const result = await query(
    `DELETE ci FROM cart_items ci
     JOIN carts c ON c.id = ci.cart_id
     WHERE c.business_user_id = ? AND ci.service_id = ?`,
    [businessUserId, itemId]
  );
  if (result.rowCount === 0) {
    throw new AppError('Cart item not found', 404);
  }

  return getCart(businessUserId);
}

async function clearCart(businessUserId: string): Promise<void> {
  await query(
    `DELETE ci FROM cart_items ci
     JOIN carts c ON c.id = ci.cart_id
     WHERE c.business_user_id = ?`,
    [businessUserId]
  );
}

export {
  getCart,
  addItem,
  setCartContext,
  updateItemQuantity,
  removeItem,
  clearCart,
  getOrCreateCartId,
};
