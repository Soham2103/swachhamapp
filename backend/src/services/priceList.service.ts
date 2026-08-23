import { query } from '../config/database';
import { AppError } from '../utils/appError';
import { logger } from '../utils/logger';

/**
 * Price lists, and the one place a price is ever resolved.
 *
 * There are exactly two price lists, and they are independent:
 *
 *   customer_price_list   GLOBAL. One row per item. Every customer
 *                         pays the same price for the same item.
 *
 *   business_price_list   PER BUSINESS, PER LAUNDRY TYPE. One row
 *                         per (business_id, item_id, laundry_type).
 *                         A business pays one rate for its own linen
 *                         (Hotel Laundry) and another for its guests'
 *                         clothes (Guest Laundry), and two businesses
 *                         differ again -- all of that is the normal
 *                         case, not a conflict.
 *
 * Nothing here copies one into the other. Changing a customer price
 * cannot move a business price, and changing one business's price
 * cannot touch another's.
 *
 * Item identity is NOT duplicated: both tables reference the item rows
 * that already exist, `services` where kind = 'ITEM'.
 *
 * NO FALLBACK FOR BUSINESS PRICING. If a business has no price for an
 * item AT THE LAUNDRY TYPE BEING ORDERED, resolveBusinessPrices throws.
 * It does not fall back to the customer price, to the other laundry
 * type, or to the legacy `services.base_price` placeholder: any of
 * those would put a wrong number on a real invoice.
 */

/**
 * The two laundry types, spelled as the schema already spells them on
 * `orders` and `carts`. One vocabulary for the concept everywhere.
 */
export const LAUNDRY_TYPES = ['hotel', 'guest'] as const;
export type LaundryType = (typeof LAUNDRY_TYPES)[number];

/** How each type is written in the UI and in an error message. */
export const LAUNDRY_TYPE_LABELS: Record<LaundryType, string> = {
  hotel: 'Hotel Laundry',
  guest: 'Guest Laundry',
};

/**
 * Accepts a laundry type in any of the spellings a caller may send and
 * returns the stored one.
 *
 * The API contract names them HOTEL_LAUNDRY / GUEST_LAUNDRY while the
 * database has said 'hotel' / 'guest' since the ordering flow was
 * built. Both are accepted here so neither side had to be rewritten,
 * and anything else is refused rather than coerced.
 */
function parseLaundryType(value: unknown, label = 'Laundry type'): LaundryType {
  if (value === null || value === undefined || value === '') {
    throw new AppError(`${label} is required.`, 400);
  }
  const text = String(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
  const normalised = text.replace(/_laundry$/, '');
  if ((LAUNDRY_TYPES as readonly string[]).includes(normalised)) {
    return normalised as LaundryType;
  }
  throw new AppError(
    `${label} must be one of: HOTEL_LAUNDRY, GUEST_LAUNDRY.`,
    400
  );
}

/** Same, but the value may be omitted -- used by list filters. */
function parseOptionalLaundryType(value: unknown): LaundryType | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  return parseLaundryType(value);
}

/** Price columns are DECIMAL(10,2): two decimal places, and it must fit. */
const MAX_PRICE = 99999999.99;

export interface CustomerPriceRow {
  id: string;
  item_id: string;
  item_name: string;
  /** The item's own category — the SUB-category when the tree has two levels. */
  category_id: string | null;
  category_name: string | null;
  /** The top-level category. Null when the item's category is already top level. */
  parent_category_id: string | null;
  parent_category_name: string | null;
  /** The laundry services this item supports, e.g. ['wash_iron']. */
  service_types: string[];
  unit: string;
  customer_price: number;
  original_price: number | null;
  is_active: boolean;
  /** False when the underlying catalogue item is itself deactivated. */
  item_is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface BusinessPriceRow {
  /** Null for an item that has no business price configured yet. */
  id: string | null;
  business_id: string;
  item_id: string;
  parent_category_id: string | null;
  parent_category_name: string | null;
  /** Which rate this row is: 'hotel' or 'guest'. */
  laundry_type: LaundryType;
  /** "Hotel Laundry" / "Guest Laundry", for display. */
  laundry_type_label: string;
  item_name: string;
  category_id: string | null;
  category_name: string | null;
  service_types: string[];
  unit: string;
  /** The global customer price, shown to the super admin for reference. */
  customer_price: number | null;
  /** Null means: not configured for this business. */
  price: number | null;
  is_active: boolean;
  item_is_active: boolean;
  created_at: string | null;
  updated_at: string | null;
}

/* ===================================================================
 * VALIDATION
 * =================================================================== */

/**
 * Accepts a price from the request and returns it as a number, or
 * throws with the reason. Rejects anything that is not a non-negative
 * number with at most two decimal places -- the shape the DECIMAL(10,2)
 * column can hold without silently rounding.
 */
function parsePrice(value: unknown, label = 'Price'): number {
  if (value === null || value === undefined || value === '') {
    throw new AppError(`${label} is required.`, 400);
  }

  // A string is accepted because JSON bodies and form fields both send
  // one, but only if it reads as a plain decimal number. "1e3", "0x10"
  // and "12abc" are refused rather than coerced.
  const raw = typeof value === 'string' ? value.trim() : value;
  if (typeof raw === 'string') {
    // A negative is checked first so it is reported as negative rather
    // than as a malformed number -- the two need different corrections.
    if (/^-\d+(\.\d+)?$/.test(raw)) {
      throw new AppError(`${label} cannot be negative.`, 400);
    }
    if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
      throw new AppError(`${label} must be a number with at most 2 decimal places.`, 400);
    }
  }
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    throw new AppError(`${label} must be a number.`, 400);
  }

  const price = Number(raw);
  if (!Number.isFinite(price)) {
    throw new AppError(`${label} must be a number.`, 400);
  }
  if (price < 0) {
    throw new AppError(`${label} cannot be negative.`, 400);
  }
  if (Math.round(price * 100) !== Math.round(price * 100 * 1e6) / 1e6) {
    throw new AppError(`${label} must have at most 2 decimal places.`, 400);
  }
  if (price > MAX_PRICE) {
    throw new AppError(`${label} is too large.`, 400);
  }
  return price;
}

/** Same rules, but the value may be omitted entirely. */
function parseOptionalPrice(value: unknown, label: string): number | null {
  if (value === null || value === undefined || value === '') return null;
  return parsePrice(value, label);
}

function parseFlag(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'active'].includes(text)) return true;
  if (['false', '0', 'no', 'inactive'].includes(text)) return false;
  throw new AppError('Status must be true or false.', 400);
}

/** MySQL returns GROUP_CONCAT as a comma string; the API exposes an array. */
function toServiceTypes(value: string | null): string[] {
  return (value || '').split(',').filter(Boolean);
}

function toNullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/** The item must exist and be a catalogue item, not a service type. */
async function assertItemExists(itemId: unknown): Promise<string> {
  const id = String(itemId ?? '').trim();
  if (!/^\d+$/.test(id)) {
    throw new AppError('A valid item is required.', 400);
  }
  const result = await query<{ id: string }>(
    `SELECT id FROM services WHERE id = ? AND kind = 'ITEM'`,
    [id]
  );
  if (!result.rows[0]) {
    throw new AppError('Item not found.', 404);
  }
  return id;
}

async function assertBusinessExists(businessId: unknown): Promise<string> {
  const id = String(businessId ?? '').trim();
  if (!/^\d+$/.test(id)) {
    throw new AppError('A valid business is required.', 400);
  }
  const result = await query<{ id: string }>(`SELECT id FROM businesses WHERE id = ?`, [id]);
  if (!result.rows[0]) {
    throw new AppError('Business not found.', 404);
  }
  return id;
}

/* ===================================================================
 * PRICE RESOLUTION  — the only path an order or invoice takes
 * =================================================================== */

/**
 * The global customer price for a set of items.
 *
 * Returns a Map keyed by item id. An item with no active customer price
 * is simply absent from the map; the caller decides whether that is an
 * error, because the catalogue may legitimately show "price on request"
 * while an order may not.
 */
async function resolveCustomerPrices(itemIds: string[]): Promise<Map<string, number>> {
  const ids = Array.from(new Set(itemIds.map(String))).filter((id) => /^\d+$/.test(id));
  const prices = new Map<string, number>();
  if (ids.length === 0) return prices;

  const placeholders = ids.map(() => '?').join(', ');
  const result = await query<{ item_id: string; customer_price: string }>(
    `SELECT item_id, customer_price
       FROM customer_price_list
      WHERE is_active = true AND item_id IN (${placeholders})`,
    ids
  );
  for (const row of result.rows) {
    prices.set(String(row.item_id), Number(row.customer_price));
  }
  return prices;
}

/**
 * The customer prices for a set of items, with every item required.
 *
 * Used at order time, where an unpriced line cannot be billed.
 */
async function requireCustomerPrices(itemIds: string[]): Promise<Map<string, number>> {
  const ids = Array.from(new Set(itemIds.map(String)));
  const prices = await resolveCustomerPrices(ids);

  const missing = ids.filter((id) => !prices.has(id));
  if (missing.length > 0) {
    const names = await itemNames(missing);
    logger.warn(`[PriceList] no customer price for item(s): ${missing.join(', ')}`);
    throw new AppError(
      names.length > 0
        ? `No customer price configured for this item: ${names.join(', ')}.`
        : 'No customer price configured for this item.',
      400
    );
  }
  return prices;
}

/** One item's global customer price. Throws when it has none. */
async function resolveCustomerPrice(itemId: string): Promise<number> {
  const prices = await requireCustomerPrices([String(itemId)]);
  return prices.get(String(itemId))!;
}

/** Item names for an error message, so the reader knows what to configure. */
async function itemNames(ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const result = await query<{ name: string }>(
    `SELECT name FROM services WHERE id IN (${ids.map(() => '?').join(', ')}) ORDER BY name`,
    ids
  );
  return result.rows.map((row) => row.name);
}

/**
 * The business-specific prices for a set of items.
 *
 * Every requested item must have an active price for THIS business.
 * There is no fallback to the customer price and none to
 * `services.base_price`: an invoice built from a guessed number is
 * worse than an order that refuses to be placed, so a missing price is
 * a 400 naming the items.
 */
async function resolveBusinessPrices(
  businessId: string,
  itemIds: string[],
  laundryTypeInput: unknown
): Promise<Map<string, number>> {
  // The laundry type is not optional here: it is half of the key. An
  // order that has not said which rate it is being placed at cannot be
  // priced at all, so this throws rather than picking one.
  const laundryType = parseLaundryType(laundryTypeInput, 'Laundry type');

  const ids = Array.from(new Set(itemIds.map(String))).filter((id) => /^\d+$/.test(id));
  const prices = new Map<string, number>();
  if (ids.length === 0) return prices;

  const placeholders = ids.map(() => '?').join(', ');
  const result = await query<{ item_id: string; price: string }>(
    `SELECT item_id, price
       FROM business_price_list
      WHERE business_id = ? AND laundry_type = ? AND is_active = true
        AND item_id IN (${placeholders})`,
    [String(businessId), laundryType, ...ids]
  );
  for (const row of result.rows) {
    prices.set(String(row.item_id), Number(row.price));
  }

  const missing = ids.filter((id) => !prices.has(id));
  if (missing.length > 0) {
    const names = await itemNames(missing);
    const label = LAUNDRY_TYPE_LABELS[laundryType];
    logger.warn(
      `[PriceList] business ${businessId} has no ${laundryType} price for item(s): ${missing.join(', ')}`
    );
    // The message names the type as well as the items, because the same
    // item priced for the other type is the common near-miss.
    throw new AppError(
      names.length > 0
        ? `No business price configured for this item and laundry type: ${names.join(', ')} (${label}).`
        : 'No business price configured for this item and laundry type.',
      400
    );
  }

  return prices;
}

/** One item's price for one business at one laundry type. */
async function resolveBusinessPrice(
  businessId: string,
  itemId: string,
  laundryType: unknown
): Promise<number> {
  const prices = await resolveBusinessPrices(businessId, [String(itemId)], laundryType);
  return prices.get(String(itemId))!;
}

/**
 * The business price where one exists, and null where it does not.
 *
 * Used by the cart, which stages a line before anything is billed and
 * must not refuse to hold an item just because its price has not been
 * set yet. Order creation still goes through resolveBusinessPrices, so
 * nothing can be billed from a null.
 */
async function lookupBusinessPrice(
  businessId: string,
  itemId: string,
  laundryTypeInput: unknown
): Promise<number | null> {
  // Unlike the resolver, this one tolerates a missing type: the cart may
  // not have had Hotel/Guest chosen yet.
  const laundryType = parseOptionalLaundryType(laundryTypeInput);
  if (!laundryType) return null;

  const result = await query<{ price: string }>(
    `SELECT price FROM business_price_list
      WHERE business_id = ? AND item_id = ? AND laundry_type = ? AND is_active = true`,
    [String(businessId), String(itemId), laundryType]
  );
  return result.rows[0] ? Number(result.rows[0].price) : null;
}

/* ===================================================================
 * CUSTOMER PRICE LIST  — super admin CRUD
 * =================================================================== */

const SERVICE_TYPES_SELECT = `
            (SELECT GROUP_CONCAT(st.code ORDER BY st.display_order ASC, st.name ASC)
               FROM item_service_types m
               JOIN services st ON st.id = m.service_id
              WHERE m.item_id = i.id AND st.kind = 'SERVICE_TYPE' AND st.is_active = true
            ) AS service_types`;

/**
 * ===================================================================
 * WHICH CATALOGUE ITEMS BELONG ON A PRICE LIST
 * ===================================================================
 *
 * An item counts only when the category it is filed under is LIVE -- and,
 * for an item in a sub-category, when that sub-category's parent is live
 * too. Anything else is a leftover of the old flat catalogue.
 *
 * WHY THIS IS THE RIGHT TEST, and not a row count.
 *
 * The catalogue was reorganised from a flat list of top-level categories
 * (Bath Linen, Bed Linen, Room Furnishing, Living Room, Dining and Kitchen,
 * Carpet and Rugs, Staff Uniform, F&B Banquets, Spa Linen, Special Services,
 * Blanket and Heavy Linens, Floor and Upholstery, Housekeeping Utility,
 * Industrial) into the two-level tree the app uses now. The old categories
 * were switched OFF -- `is_active = 0` -- rather than deleted, which is the
 * application's own way of saying "obsolete", and `listItemCategories`
 * already honours it: none of them appear in the Category dropdown.
 *
 * The price listings, however, never applied the same test, so their items
 * kept turning up in the price tables as rows whose category could not be
 * chosen anywhere else. That is the flat, confusing list, and this is the
 * one-line reason for it.
 *
 * NOTHING IS DELETED AND NOTHING IS HIDDEN BY POSITION. The rows stay in
 * `services`, keep their ids, and keep every reference pointing at them; a
 * category being switched back on brings its items straight back. Reactivating
 * is the supported way to undo this, which is why the flag is the test.
 */
/**
 * The order every price listing comes back in.
 *
 * MAIN CATEGORY, then SUB-CATEGORY, then item -- so the rows arrive already
 * in the shape the screen groups them into, and two items from the same
 * sub-category can never be separated by one from another category.
 *
 * The old ordering keyed on the item's own category first, which interleaved
 * sub-categories from different parents whenever their display_order happened
 * to collide -- and it collided constantly, because the old flat categories
 * and the new sub-categories were numbered from 1 independently.
 *
 * `COALESCE(pc.…, c.…)` is the top-level key: the parent's for an item in a
 * sub-category, the category's own for one filed directly at the top.
 */
const PRICE_LIST_ORDER = `
  ORDER BY COALESCE(pc.display_order, c.display_order) ASC,
           COALESCE(pc.name, c.name) ASC,
           c.parent_id IS NULL DESC,
           c.display_order ASC, c.name ASC,
           i.display_order ASC, i.name ASC`;

const LIVE_CATEGORY_PREDICATE = `
  c.id IS NOT NULL
  AND c.is_active = true
  AND (c.parent_id IS NULL OR pc.is_active = true)`;

const CUSTOMER_PRICE_SELECT = `
     SELECT p.id, p.item_id, i.name AS item_name, i.category_id, c.name AS category_name,
            c.parent_id AS parent_category_id, pc.name AS parent_category_name,
            i.unit, p.customer_price, p.original_price, p.is_active,
            i.is_active AS item_is_active,
            ${SERVICE_TYPES_SELECT},
            p.created_at, p.updated_at
       FROM customer_price_list p
       JOIN services i ON i.id = p.item_id
       LEFT JOIN service_categories c ON c.id = i.category_id
       -- The item hangs off the SUB-category; its parent is the top-level
       -- one. A flat category has no parent and is itself the category.
       LEFT JOIN service_categories pc ON pc.id = c.parent_id`;

interface CustomerPriceQueryRow extends Omit<CustomerPriceRow, 'service_types'> {
  service_types: string | null;
}

function toCustomerPriceRow(row: CustomerPriceQueryRow): CustomerPriceRow {
  return {
    ...row,
    customer_price: Number(row.customer_price),
    original_price: toNullableNumber(row.original_price),
    is_active: Boolean(row.is_active),
    item_is_active: Boolean(row.item_is_active),
    service_types: toServiceTypes(row.service_types),
  };
}

/**
 * Every customer price.
 *
 * Deactivated rows are included by default so the super admin can see
 * and re-enable them: a disabled price is a state to manage, not a row
 * to hide.
 */
async function listCustomerPrices(
  options: { includeInactive?: boolean; search?: string } = {}
): Promise<CustomerPriceRow[]> {
  // Only items under a live category. See LIVE_CATEGORY_PREDICATE.
  const conditions: string[] = [LIVE_CATEGORY_PREDICATE];
  const values: unknown[] = [];

  if (options.includeInactive === false) {
    conditions.push('p.is_active = true');
  }
  if (options.search) {
    conditions.push('i.name LIKE ?');
    values.push(`%${options.search}%`);
  }
  const where = `WHERE ${conditions.join(' AND ')}`;

  const result = await query<CustomerPriceQueryRow>(
    `${CUSTOMER_PRICE_SELECT}
     ${where}
     ${PRICE_LIST_ORDER}`,
    values
  );
  return result.rows.map(toCustomerPriceRow);
}

async function getCustomerPriceById(id: string): Promise<CustomerPriceRow> {
  const result = await query<CustomerPriceQueryRow>(`${CUSTOMER_PRICE_SELECT} WHERE p.id = ?`, [
    id,
  ]);
  const row = result.rows[0];
  if (!row) {
    throw new AppError('Customer price not found.', 404);
  }
  return toCustomerPriceRow(row);
}

export interface CustomerPriceInput {
  item_id?: unknown;
  customer_price?: unknown;
  original_price?: unknown;
  is_active?: unknown;
}

/**
 * Adds a customer price for an existing catalogue item.
 *
 * The UNIQUE(item_id) key is what "global customer price" means in the
 * schema: an item can only be priced once. Asking twice is a 409
 * pointing at the existing row, never a second price.
 */
async function createCustomerPrice(input: CustomerPriceInput): Promise<CustomerPriceRow> {
  const itemId = await assertItemExists(input.item_id);
  const price = parsePrice(input.customer_price, 'Customer price');
  const original = parseOptionalPrice(input.original_price, 'Original price');
  const isActive = parseFlag(input.is_active, true);

  const existing = await query<{ id: string }>(
    `SELECT id FROM customer_price_list WHERE item_id = ?`,
    [itemId]
  );
  if (existing.rows[0]) {
    throw new AppError(
      'This item already has a customer price. Edit the existing one instead.',
      409
    );
  }

  const inserted = await query(
    `INSERT INTO customer_price_list (item_id, customer_price, original_price, is_active)
     VALUES (?, ?, ?, ?)`,
    [itemId, price, original, isActive]
  );

  logger.info(`[PriceList] customer price created for item ${itemId} at ${price}`);
  return getCustomerPriceById(inserted.insertId!);
}

/**
 * Updates a customer price. Only the fields present in the body are
 * touched, so toggling the status never resets the price.
 */
async function updateCustomerPrice(
  id: string,
  input: CustomerPriceInput
): Promise<CustomerPriceRow> {
  const current = await getCustomerPriceById(id);

  const fields: string[] = [];
  const values: unknown[] = [];

  if (input.customer_price !== undefined) {
    fields.push('customer_price = ?');
    values.push(parsePrice(input.customer_price, 'Customer price'));
  }
  if (input.original_price !== undefined) {
    fields.push('original_price = ?');
    values.push(parseOptionalPrice(input.original_price, 'Original price'));
  }
  if (input.is_active !== undefined) {
    fields.push('is_active = ?');
    values.push(parseFlag(input.is_active, current.is_active));
  }

  if (fields.length === 0) {
    return current;
  }

  await query(
    `UPDATE customer_price_list SET ${fields.join(', ')}, updated_at = NOW() WHERE id = ?`,
    [...values, id]
  );

  logger.info(`[PriceList] customer price ${id} updated`);
  return getCustomerPriceById(id);
}

/**
 * Deactivates a customer price -- a soft delete, matching the pattern
 * the rest of the schema already uses.
 *
 * The row is kept because `order_items` carries a snapshot pointing back
 * at the item, and a historical invoice must stay readable after a price
 * is withdrawn. `hard` is offered for a row created by mistake, and is
 * refused as soon as any order line names the item.
 */
async function deleteCustomerPrice(id: string, hard = false) {
  const current = await getCustomerPriceById(id);

  if (!hard) {
    await query(
      `UPDATE customer_price_list SET is_active = false, updated_at = NOW() WHERE id = ?`,
      [id]
    );
    logger.info(`[PriceList] customer price ${id} deactivated`);
    return { id: current.id, item_id: current.item_id, deleted: false, is_active: false };
  }

  const used = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM order_items WHERE service_id = ?`,
    [current.item_id]
  );
  if (Number(used.rows[0]?.n || 0) > 0) {
    throw new AppError(
      'This item appears on existing orders, so its price cannot be removed. Disable it instead.',
      409
    );
  }

  await query(`DELETE FROM customer_price_list WHERE id = ?`, [id]);
  logger.info(`[PriceList] customer price ${id} deleted`);
  return { id: current.id, item_id: current.item_id, deleted: true, is_active: false };
}

/* ===================================================================
 * BUSINESS PRICE LIST  — super admin CRUD
 * =================================================================== */

interface BusinessPriceQueryRow extends Omit<BusinessPriceRow, 'service_types'> {
  service_types: string | null;
}

function toBusinessPriceRow(
  row: BusinessPriceQueryRow,
  businessId: string,
  laundryType: LaundryType
): BusinessPriceRow {
  return {
    ...row,
    parent_category_id:
      row.parent_category_id === null || row.parent_category_id === undefined
        ? null
        : String(row.parent_category_id),
    id: row.id === null || row.id === undefined ? null : String(row.id),
    business_id: String(businessId),
    item_id: String(row.item_id),
    laundry_type: laundryType,
    laundry_type_label: LAUNDRY_TYPE_LABELS[laundryType],
    customer_price: toNullableNumber(row.customer_price),
    price: toNullableNumber(row.price),
    is_active: Boolean(row.is_active),
    item_is_active: Boolean(row.item_is_active),
    service_types: toServiceTypes(row.service_types),
  };
}

/**
 * The price list for one business.
 *
 * A LEFT JOIN from the catalogue, not from the price table, so items
 * that have no business price yet come back with `price: null` instead
 * of vanishing. That is what makes "which items are not configured yet"
 * answerable from the same call the table is drawn from.
 *
 * The customer price rides along as a reference column, for the super
 * admin's eyes only. It is never a fallback, and no business-facing
 * endpoint returns either column.
 */
async function listBusinessPrices(
  businessIdInput: string,
  options: {
    laundryType?: unknown;
    includeInactiveItems?: boolean;
    onlyConfigured?: boolean;
    search?: string;
  } = {}
): Promise<BusinessPriceRow[]> {
  const businessId = await assertBusinessExists(businessIdInput);
  // One laundry type per listing: the table shows "the Hotel Laundry
  // rates for this business", which is the question the screen asks.
  // Defaults to hotel so a caller that omits it still gets a coherent
  // list rather than two rows per item.
  const laundryType = parseOptionalLaundryType(options.laundryType) ?? 'hotel';

  // Only items under a live category. See LIVE_CATEGORY_PREDICATE.
  const conditions: string[] = [`i.kind = 'ITEM'`, LIVE_CATEGORY_PREDICATE];
  // Placeholder order: the projected business_id, then the two join
  // predicates, then WHERE.
  const values: unknown[] = [businessId, businessId, laundryType];

  if (!options.includeInactiveItems) {
    conditions.push('i.is_active = true');
  }
  if (options.onlyConfigured) {
    conditions.push('p.id IS NOT NULL');
  }
  if (options.search) {
    conditions.push('i.name LIKE ?');
    values.push(`%${options.search}%`);
  }

  const result = await query<BusinessPriceQueryRow>(
    `SELECT p.id, ? AS business_id, i.id AS item_id, i.name AS item_name,
            i.category_id, c.name AS category_name,
            c.parent_id AS parent_category_id, pc.name AS parent_category_name,
            i.unit,
            cp.customer_price,
            p.price, p.is_active,
            i.is_active AS item_is_active,
            ${SERVICE_TYPES_SELECT},
            p.created_at, p.updated_at
       FROM services i
       LEFT JOIN service_categories c ON c.id = i.category_id
       LEFT JOIN service_categories pc ON pc.id = c.parent_id
       LEFT JOIN business_price_list p
              ON p.item_id = i.id AND p.business_id = ? AND p.laundry_type = ?
       LEFT JOIN customer_price_list cp ON cp.item_id = i.id AND cp.is_active = true
      WHERE ${conditions.join(' AND ')}
      ${PRICE_LIST_ORDER}`,
    values
  );

  return result.rows.map((row) => toBusinessPriceRow(row, businessId, laundryType));
}

const BUSINESS_PRICE_SELECT = `
     SELECT p.id, p.business_id, p.item_id, p.laundry_type, i.name AS item_name,
            i.category_id, c.name AS category_name,
            c.parent_id AS parent_category_id, pc.name AS parent_category_name,
            i.unit,
            cp.customer_price,
            p.price, p.is_active, i.is_active AS item_is_active,
            ${SERVICE_TYPES_SELECT},
            p.created_at, p.updated_at
       FROM business_price_list p
       JOIN services i ON i.id = p.item_id
       LEFT JOIN service_categories c ON c.id = i.category_id
       LEFT JOIN service_categories pc ON pc.id = c.parent_id
       LEFT JOIN customer_price_list cp ON cp.item_id = i.id AND cp.is_active = true`;

async function getBusinessPriceById(
  businessId: string,
  priceId: string
): Promise<BusinessPriceRow> {
  // Scoped by business_id as well as id, so business A's row can never
  // be read or edited through business B's URL.
  const result = await query<BusinessPriceQueryRow>(
    `${BUSINESS_PRICE_SELECT} WHERE p.id = ? AND p.business_id = ?`,
    [priceId, businessId]
  );
  const row = result.rows[0];
  if (!row) {
    throw new AppError('Business price not found for this business.', 404);
  }
  return toBusinessPriceRow(row, businessId, row.laundry_type as LaundryType);
}

export interface BusinessPriceInput {
  item_id?: unknown;
  /** HOTEL_LAUNDRY / GUEST_LAUNDRY, or the stored 'hotel' / 'guest'. */
  laundry_type?: unknown;
  price?: unknown;
  is_active?: unknown;
}

/**
 * Sets this business's price for an item.
 *
 * Only this business is touched. Two businesses holding different prices
 * for the same item is the point of the table, so nothing here reads,
 * writes or compares another business's row.
 */
async function createBusinessPrice(
  businessIdInput: string,
  input: BusinessPriceInput
): Promise<BusinessPriceRow> {
  const businessId = await assertBusinessExists(businessIdInput);
  const itemId = await assertItemExists(input.item_id);
  const laundryType = parseLaundryType(input.laundry_type);
  const price = parsePrice(input.price, 'Price');
  const isActive = parseFlag(input.is_active, true);

  // The key is (business, item, laundry type). The SAME item at the OTHER
  // type is a different row and is perfectly allowed -- that is the point
  // of the type being part of the key.
  const existing = await query<{ id: string }>(
    `SELECT id FROM business_price_list
      WHERE business_id = ? AND item_id = ? AND laundry_type = ?`,
    [businessId, itemId, laundryType]
  );
  if (existing.rows[0]) {
    throw new AppError(
      `This business already has a ${LAUNDRY_TYPE_LABELS[laundryType]} price for this item. Edit the existing one instead.`,
      409
    );
  }

  const inserted = await query(
    `INSERT INTO business_price_list (business_id, item_id, laundry_type, price, is_active)
     VALUES (?, ?, ?, ?, ?)`,
    [businessId, itemId, laundryType, price, isActive]
  );

  logger.info(
    `[PriceList] business ${businessId} ${laundryType} price created for item ${itemId} at ${price}`
  );
  return getBusinessPriceById(businessId, inserted.insertId!);
}

async function updateBusinessPrice(
  businessIdInput: string,
  priceId: string,
  input: BusinessPriceInput
): Promise<BusinessPriceRow> {
  const businessId = await assertBusinessExists(businessIdInput);
  const current = await getBusinessPriceById(businessId, priceId);

  const fields: string[] = [];
  const values: unknown[] = [];

  if (input.price !== undefined) {
    fields.push('price = ?');
    values.push(parsePrice(input.price, 'Price'));
  }
  if (input.is_active !== undefined) {
    fields.push('is_active = ?');
    values.push(parseFlag(input.is_active, current.is_active));
  }
  // The laundry type identifies the row rather than describing it, so it
  // is not editable: changing it would silently collide with the row that
  // already holds the other type. Delete and add instead.
  if (
    input.laundry_type !== undefined &&
    parseLaundryType(input.laundry_type) !== current.laundry_type
  ) {
    throw new AppError(
      'The laundry type of an existing price cannot be changed. Add a separate entry for the other laundry type instead.',
      400
    );
  }

  if (fields.length === 0) {
    return current;
  }

  await query(
    `UPDATE business_price_list SET ${fields.join(', ')}, updated_at = NOW()
      WHERE id = ? AND business_id = ?`,
    [...values, priceId, businessId]
  );

  logger.info(`[PriceList] business ${businessId} price ${priceId} updated`);
  return getBusinessPriceById(businessId, priceId);
}

/**
 * Deactivates one business price. Same soft-delete reasoning as the
 * customer list, and a deactivated price is refused at order time by
 * resolveBusinessPrices exactly as an absent one is.
 */
async function deleteBusinessPrice(businessIdInput: string, priceId: string, hard = false) {
  const businessId = await assertBusinessExists(businessIdInput);
  const current = await getBusinessPriceById(businessId, priceId);

  if (!hard) {
    await query(
      `UPDATE business_price_list SET is_active = false, updated_at = NOW()
        WHERE id = ? AND business_id = ?`,
      [priceId, businessId]
    );
    logger.info(`[PriceList] business ${businessId} price ${priceId} deactivated`);
    return { id: current.id, item_id: current.item_id, deleted: false, is_active: false };
  }

  // Only orders belonging to THIS business can pin this row.
  const used = await query<{ n: number }>(
    `SELECT COUNT(*) AS n
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       JOIN business_users bu ON bu.id = o.business_user_id
      WHERE oi.service_id = ? AND bu.business_id = ?`,
    [current.item_id, businessId]
  );
  if (Number(used.rows[0]?.n || 0) > 0) {
    throw new AppError(
      'This item appears on existing orders for this business, so its price cannot be removed. Disable it instead.',
      409
    );
  }

  await query(`DELETE FROM business_price_list WHERE id = ? AND business_id = ?`, [
    priceId,
    businessId,
  ]);
  logger.info(`[PriceList] business ${businessId} price ${priceId} deleted`);
  return { id: current.id, item_id: current.item_id, deleted: true, is_active: false };
}

/* ===================================================================
 * CATALOGUE ITEMS  — for the "add a price" pickers
 * =================================================================== */

export interface PriceableItem {
  id: string;
  name: string;
  /** The item's own category — the sub-category in a two-level tree. */
  category_id: string | null;
  category_name: string | null;
  /** The top-level category it sits under. */
  parent_category_id: string | null;
  parent_category_name: string | null;
  unit: string;
  scope: string;
  is_active: boolean;
  service_types: string[];
  /** True when a customer price already exists for this item. */
  has_customer_price: boolean;
}

/**
 * ONE projection of an item, used by the list and by the single-row lookup,
 * so a newly created item comes back in exactly the shape the picker already
 * renders.
 */
const PRICEABLE_ITEM_SELECT = `
  SELECT i.id, i.name, i.category_id, c.name AS category_name,
         c.parent_id AS parent_category_id, pc.name AS parent_category_name,
         i.unit, i.scope,
         i.is_active, (cp.id IS NOT NULL) AS has_customer_price,
         ${SERVICE_TYPES_SELECT}
    FROM services i
    LEFT JOIN service_categories c ON c.id = i.category_id
    LEFT JOIN service_categories pc ON pc.id = c.parent_id
    LEFT JOIN customer_price_list cp ON cp.item_id = i.id`;

function toPriceableItem(row: any): PriceableItem {
  return {
    ...row,
    id: String(row.id),
    category_id: row.category_id === null ? null : String(row.category_id),
    parent_category_id:
      row.parent_category_id === null ? null : String(row.parent_category_id),
    is_active: Boolean(row.is_active),
    has_customer_price: Boolean(row.has_customer_price),
    service_types: toServiceTypes(row.service_types),
  };
}

/**
 * Catalogue items the super admin can attach a price to.
 *
 * `unpricedOnly` answers "which items still need a customer price",
 * which is the question the Add Item picker is really asking.
 */
async function listPriceableItems(
  options: {
    search?: string;
    unpricedOnly?: boolean;
    /** Top-level category id. Matches items in it AND in its sub-categories. */
    categoryId?: string;
    /** Sub-category id. Narrower than `categoryId`. */
    subcategoryId?: string;
  } = {}
): Promise<PriceableItem[]> {
  // Only items under a live category, so the picker cannot offer an item
  // that the price tables no longer list. See LIVE_CATEGORY_PREDICATE.
  const conditions: string[] = [`i.kind = 'ITEM'`, LIVE_CATEGORY_PREDICATE];
  const values: unknown[] = [];

  // Category matches the item's own category OR its parent, so choosing a
  // top-level category returns everything beneath it.
  if (options.categoryId) {
    conditions.push('(i.category_id = ? OR c.parent_id = ?)');
    values.push(options.categoryId, options.categoryId);
  }
  if (options.subcategoryId) {
    conditions.push('i.category_id = ?');
    values.push(options.subcategoryId);
  }

  if (options.search) {
    conditions.push('i.name LIKE ?');
    values.push(`%${options.search}%`);
  }
  if (options.unpricedOnly) {
    conditions.push('cp.id IS NULL');
  }

  const result = await query<
    Omit<PriceableItem, 'service_types'> & { service_types: string | null }
  >(
    `${PRICEABLE_ITEM_SELECT}
      WHERE ${conditions.join(' AND ')}
      ${PRICE_LIST_ORDER}
      LIMIT 500`,
    values
  );

  return result.rows.map(toPriceableItem);
}

/** One catalogue item in the same shape the pickers already read. */
async function getPriceableItemById(itemId: string | number): Promise<PriceableItem> {
  const result = await query<any>(`${PRICEABLE_ITEM_SELECT} WHERE i.id = ?`, [itemId]);
  const row = result.rows[0];
  if (!row) throw new AppError('Item not found.', 404);
  return toPriceableItem(row);
}

export interface CategoryNode {
  id: string;
  name: string;
  scope: string;
  parent_id: string | null;
  /** True when this is a top-level category. */
  is_top_level: boolean;
  /** How many priceable items sit at or beneath it. */
  item_count: number;
}

/**
 * The category tree, for the dependent Category -> Sub-category -> Item
 * dropdowns.
 *
 * The existing `service_categories.parent_id` already models exactly two
 * levels, so nothing new was created: a row with `parent_id IS NULL` is a
 * Category and one with a parent is a Sub-category. Both come back in one
 * call and the client groups them, which avoids a round trip per selection.
 *
 * EVERY active category is returned, including ones that hold no items yet.
 * An empty sub-category used to be filtered out, but "+ Create New Item" has
 * to be able to file the FIRST item under one, and a category that cannot be
 * chosen cannot be filled. `item_count` is still reported so the picker can
 * say how full each one is.
 */
async function listItemCategories(): Promise<CategoryNode[]> {
  const result = await query<any>(
    `SELECT c.id, c.name, c.scope, c.parent_id,
            (SELECT COUNT(*) FROM services i
               JOIN service_categories ic ON ic.id = i.category_id
              WHERE i.kind = 'ITEM' AND i.is_active = true
                AND (i.category_id = c.id OR ic.parent_id = c.id)) AS item_count
       FROM service_categories c
      WHERE c.kind = 'ITEM_CATEGORY' AND c.is_active = true
      ORDER BY c.parent_id IS NULL DESC, c.display_order ASC, c.name ASC`
  );
  return result.rows.map((row) => ({
    ...row,
    id: String(row.id),
    parent_id: row.parent_id === null ? null : String(row.parent_id),
    is_top_level: row.parent_id === null,
    item_count: Number(row.item_count),
  }));
}

/**
 * The laundry types a business price can be set for, for the UI selector.
 * Fixed by the schema's ENUM -- a client cannot introduce a new one.
 */
function listLaundryTypes(): Array<{ value: LaundryType; label: string }> {
  return LAUNDRY_TYPES.map((value) => ({ value, label: LAUNDRY_TYPE_LABELS[value] }));
}

/** Wash & Iron / Dry Clean, so an added item can be mapped to them. */
async function listServiceTypes(): Promise<Array<{ id: string; name: string; code: string }>> {
  const result = await query<{ id: string; name: string; code: string }>(
    `SELECT id, name, code FROM services
      WHERE kind = 'SERVICE_TYPE' AND is_active = true
      ORDER BY display_order ASC, name ASC`
  );
  return result.rows;
}

/* ===================================================================
 * CREATING A CATALOGUE ITEM
 * =================================================================== */

export interface CatalogueItemInput {
  item_name?: unknown;
  /** Accepted as an alias, because "name" is what a form field is called. */
  name?: unknown;
  /** Top-level category. Optional when `subcategory_id` is given. */
  category_id?: unknown;
  /** The sub-category the item is filed under. */
  subcategory_id?: unknown;
  service_types?: unknown;
  unit?: unknown;
  is_active?: unknown;
}

/**
 * Which category row an item is being filed under, and whether the
 * Category -> Sub-category pair the client sent actually exists.
 *
 * ITEMS HANG OFF THE SUB-CATEGORY. `service_categories.parent_id` already
 * models exactly two levels, so an item's `category_id` IS its sub-category
 * and the top level is reached through the parent. Nothing stores a category
 * NAME on the item: the relationship is by id, as the rest of the schema
 * already does it.
 *
 * A top-level category is accepted on its own only when it is FLAT -- it has
 * no children -- because otherwise the item would sit beside the
 * sub-categories rather than in one, and no sub-category dropdown would ever
 * show it again.
 */
async function resolveItemCategory(input: CatalogueItemInput): Promise<{
  id: string;
  scope: string;
  parent_id: string | null;
}> {
  const categoryId = String(input.category_id ?? '').trim();
  const subcategoryId = String(input.subcategory_id ?? '').trim();

  const targetId = subcategoryId || categoryId;
  if (!/^\d+$/.test(targetId)) {
    throw new AppError('A category is required.', 400);
  }

  const found = await query<{ id: string; scope: string; parent_id: string | null }>(
    `SELECT id, scope, parent_id FROM service_categories
      WHERE id = ? AND kind = 'ITEM_CATEGORY' AND is_active = true`,
    [targetId]
  );
  const category = found.rows[0];
  if (!category) {
    throw new AppError(subcategoryId ? 'Sub-category not found.' : 'Category not found.', 404);
  }

  // Both levels sent: the sub-category must really belong to the category,
  // so a mismatched pair cannot file an item under the wrong tree.
  if (subcategoryId && categoryId && String(category.parent_id ?? '') !== categoryId) {
    throw new AppError('That sub-category does not belong to the selected category.', 400);
  }

  if (!subcategoryId) {
    const children = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM service_categories
        WHERE parent_id = ? AND kind = 'ITEM_CATEGORY' AND is_active = true`,
      [targetId]
    );
    if (Number(children.rows[0]?.n || 0) > 0) {
      throw new AppError(
        'Please choose a sub-category. Items in this category are filed under one of its sub-categories.',
        400
      );
    }
  }

  return {
    id: String(category.id),
    scope: category.scope,
    parent_id: category.parent_id === null ? null : String(category.parent_id),
  };
}

/**
 * Creates a catalogue item under a Category -> Sub-category, and nothing else.
 *
 * This is the ONE place an item is created for the price lists, so the
 * Customer Price List and the Business Price List cannot drift apart on what
 * an item is or where it may live. It writes a normal `services` row -- the
 * same table the catalogue, the cart and order_items already point at -- so
 * no parallel item record exists.
 *
 * DUPLICATES ARE REFUSED BY THE BACKEND, not merely hidden by the form:
 * (category_id, name) is UNIQUE on `services`, and the check here turns that
 * constraint into the message the API contract asks for.
 *
 * `base_price` is written as 0: the column is NOT NULL and legacy, and the
 * real price lives in customer_price_list / business_price_list.
 */
async function createCatalogueItem(input: CatalogueItemInput): Promise<PriceableItem> {
  const name = String(input.item_name ?? input.name ?? '').trim();
  if (!name) {
    throw new AppError('Item name is required.', 400);
  }
  if (name.length > 255) {
    throw new AppError('Item name is too long.', 400);
  }

  const category = await resolveItemCategory(input);
  const isActive = parseFlag(input.is_active, true);
  const unit = String(input.unit ?? '').trim() || 'Piece';

  // The comparison is case-insensitive because the column's collation is:
  // "Shirt" and "shirt" in one sub-category are the same item.
  const duplicate = await query<{ id: string }>(
    `SELECT id FROM services WHERE category_id = ? AND name = ? AND kind = 'ITEM'`,
    [category.id, name]
  );
  if (duplicate.rows[0]) {
    throw new AppError('Item already exists in this subcategory.', 409);
  }

  // The item inherits its category's scope, so it cannot end up filed
  // under a category it does not belong to.
  const inserted = await query(
    `INSERT INTO services (category_id, scope, kind, name, unit, base_price, is_active)
     VALUES (?, ?, 'ITEM', ?, ?, 0, ?)`,
    [category.id, category.scope, name, unit, isActive]
  );
  const itemId = inserted.insertId!;

  /*
   * Which laundry services the item can be given, through the join table the
   * catalogue and the cart already read.
   *
   * WITH NONE SPECIFIED, THE ITEM IS MAPPED TO EVERY ACTIVE SERVICE. This is
   * not a convenience: the business catalogue filters items by the service
   * being ordered (Wash & Iron / Dry Clean), so an item with no mapping at
   * all is priced, active, and still invisible at order time. "+ Create New
   * Item" asks for a name and a category only, so the default has to be the
   * one that leaves the item orderable; narrowing it afterwards is an edit.
   */
  const requested = Array.isArray(input.service_types)
    ? input.service_types.map((value) => String(value).trim()).filter(Boolean)
    : [];
  const available = await listServiceTypes();

  if (requested.length > 0) {
    for (const code of requested) {
      const match = available.find(
        (service) => service.code === code || String(service.id) === code
      );
      if (!match) {
        throw new AppError(`Unknown service: ${code}`, 400);
      }
      await query(`INSERT IGNORE INTO item_service_types (item_id, service_id) VALUES (?, ?)`, [
        itemId,
        match.id,
      ]);
    }
  } else {
    for (const service of available) {
      await query(`INSERT IGNORE INTO item_service_types (item_id, service_id) VALUES (?, ?)`, [
        itemId,
        service.id,
      ]);
    }
  }

  logger.info(`[PriceList] item "${name}" created (${itemId}) under category ${category.id}`);
  return getPriceableItemById(itemId);
}

export interface NewItemInput extends CatalogueItemInput {
  customer_price?: unknown;
  original_price?: unknown;
}

/**
 * Creates a catalogue item AND its customer price in one call, which is what
 * "+ Create New Item" followed by a price on the Customer Price List does.
 *
 * The item itself is created by `createCatalogueItem`, so the category rules
 * and the duplicate rule are the same ones the standalone endpoint enforces.
 */
async function createItemWithCustomerPrice(input: NewItemInput): Promise<CustomerPriceRow> {
  const price = parsePrice(input.customer_price, 'Customer price');
  const original = parseOptionalPrice(input.original_price, 'Original price');
  const isActive = parseFlag(input.is_active, true);

  // Validated before the item row is written, so a rejected price leaves no
  // orphan item behind.
  const item = await createCatalogueItem(input);

  const priceInsert = await query(
    `INSERT INTO customer_price_list (item_id, customer_price, original_price, is_active)
     VALUES (?, ?, ?, ?)`,
    [item.id, price, original, isActive]
  );

  logger.info(`[PriceList] item "${item.name}" (${item.id}) priced at ${price}`);
  return getCustomerPriceById(priceInsert.insertId!);
}

export {
  parsePrice,
  parseOptionalPrice,
  parseLaundryType,
  parseOptionalLaundryType,
  listLaundryTypes,
  resolveCustomerPrice,
  resolveCustomerPrices,
  requireCustomerPrices,
  resolveBusinessPrice,
  resolveBusinessPrices,
  lookupBusinessPrice,
  listCustomerPrices,
  getCustomerPriceById,
  createCustomerPrice,
  updateCustomerPrice,
  deleteCustomerPrice,
  listBusinessPrices,
  getBusinessPriceById,
  createBusinessPrice,
  updateBusinessPrice,
  deleteBusinessPrice,
  listPriceableItems,
  getPriceableItemById,
  createCatalogueItem,
  listItemCategories,
  listServiceTypes,
  createItemWithCustomerPrice,
};
