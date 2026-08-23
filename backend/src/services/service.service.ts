import { query } from '../config/database';
import { logger } from '../utils/logger';
import { AppError } from '../utils/appError';

/**
 * Customer-facing catalogue.
 *
 * This file was still unported Postgres: `$1` placeholders, ILIKE, a
 * `categories` table that does not exist (it is `service_categories`),
 * and columns that were never in this schema -- `price` (it is
 * `base_price`), `icon_url` (it is `icon_name`), `min_quantity` and
 * `max_quantity` (neither exists). Every call threw. It is rewritten
 * here against the schema as it actually is.
 *
 * SCOPE. The catalogue holds both the customer list and the hotel/B2B
 * list in one table, separated by `services.scope`. A customer endpoint
 * must never leak the B2B list, so scope is applied to every query and
 * defaults to CUSTOMER. At the time of writing there are no
 * CUSTOMER-scope rows at all, so these endpoints correctly return an
 * empty catalogue rather than quietly serving hotel items -- pool
 * towels and banquet linen -- to a retail customer.
 *
 * PRICE. Every price here comes from `customer_price_list`, the global
 * customer price list: one row per item, the same figure for every
 * customer. `services.base_price` is no longer read -- it holds 0.00 /
 * 1.00 placeholders and was never a price list.
 *
 * `business_price_list` is deliberately absent from this file. A
 * customer endpoint must never see a business's price, so the table is
 * not joined, not selected and not exposed on any shape below.
 */

const VALID_SCOPES = ['CUSTOMER', 'BUSINESS'];

function resolveScope(scope?: string): string {
  const value = String(scope || 'CUSTOMER').trim().toUpperCase();
  if (!VALID_SCOPES.includes(value)) {
    throw new AppError(`scope must be one of: ${VALID_SCOPES.join(', ')}`, 400);
  }
  return value;
}

/** LIMIT/OFFSET cannot be bound as parameters here, so they are forced
 *  to safe integers and interpolated -- the same approach the public
 *  business listing already uses. */
function safePaging(page: number, limit: number) {
  const safeLimit = Math.min(Math.max(Number.isFinite(limit) ? Math.trunc(limit) : 20, 1), 100);
  const safePage = Math.max(Number.isFinite(page) ? Math.trunc(page) : 1, 1);
  return { limit: safeLimit, offset: (safePage - 1) * safeLimit, page: safePage };
}

export interface Category {
  id: string;
  name: string;
  slug: string | null;
  description: string | null;
  icon_name: string | null;
  image_url: string | null;
  display_order: number;
  item_count: number;
}

export interface Service {
  id: string;
  category_id: string | null;
  category_name: string | null;
  name: string;
  description: string | null;
  /** The global customer price. Always greater than zero: an item without a
   *  positive price is not returned by these endpoints at all. */
  price: number | null;
  /** The same figure under its explicit name. */
  customer_price: number | null;
  /** The struck-through "was" price, when the item has one. */
  original_price: number | null;
  /** The laundry services this item supports, e.g. ['wash_iron']. */
  service_types: string[];
  unit: string;
  image_url: string | null;
  icon_name: string | null;
  weight_kg: number | null;
  is_popular: boolean;
  is_active: boolean;
}

export interface ServiceQueryParams {
  categoryId?: string;
  search?: string;
  page: number;
  limit: number;
  scope?: string;
}

/** The global customer price, joined in from the customer price list.
 *  An item with no active row there stays NULL, which the client reads
 *  as "price on request" rather than as free. */
const PRICE_SELECT = `cp.customer_price AS price,
                      cp.customer_price,
                      cp.original_price`;

/** Joined onto every catalogue query, so one item can never carry two
 *  different prices depending on which endpoint asked.
 *
 *  An INNER JOIN, not a LEFT one: an item with no active customer price is
 *  not in the catalogue at all. See PRICED_ONLY below. */
const PRICE_JOIN = `JOIN customer_price_list cp
                         ON cp.item_id = s.id AND cp.is_active = true`;

/**
 * ZERO AND MISSING PRICES ARE NOT SHOWN.
 *
 * An item a customer cannot be charged for is an item they must not be
 * offered — a 0 in the price list means "not on sale", not "free". Enforced
 * HERE, in the query, so the item never reaches the client at all; hiding it
 * in the UI would still ship the row and still let it be ordered directly.
 *
 * The order path enforces the same rule independently, so the two cannot
 * disagree about what is buyable.
 */
const PRICED_ONLY = `cp.customer_price > 0`;

const SERVICE_TYPES_SELECT = `
            (SELECT GROUP_CONCAT(st.code ORDER BY st.display_order ASC, st.name ASC)
               FROM item_service_types m
               JOIN services st ON st.id = m.service_id
              WHERE m.item_id = s.id AND st.kind = 'SERVICE_TYPE' AND st.is_active = true
            ) AS service_types`;

interface ServiceQueryRow extends Omit<Service, 'service_types'> {
  service_types: string | null;
}

function toService(row: ServiceQueryRow): Service {
  return {
    ...row,
    price: row.price === null ? null : Number(row.price),
    customer_price: row.customer_price === null ? null : Number(row.customer_price),
    original_price: row.original_price === null ? null : Number(row.original_price),
    service_types: (row.service_types || '').split(',').filter(Boolean),
  };
}

/** Item categories that actually have something live in them. */
async function getCategories(scope?: string): Promise<Category[]> {
  const resolved = resolveScope(scope);
  logger.debug(`[ServiceService] Categories for scope ${resolved}`);

  const result = await query<Category>(
    `SELECT c.id, c.name, c.slug, c.description, c.icon_name, c.image_url,
            c.display_order,
            COUNT(cp.id) AS item_count
       FROM service_categories c
       LEFT JOIN services s
              ON s.category_id = c.id AND s.is_active = true AND s.kind = 'ITEM'
       -- Same rule as the item list: a category whose items are all unpriced
       -- reports zero and is not offered.
       LEFT JOIN customer_price_list cp
              ON cp.item_id = s.id AND cp.is_active = true AND cp.customer_price > 0
      WHERE c.is_active = true
        AND c.kind = 'ITEM_CATEGORY'
        AND c.scope = ?
      GROUP BY c.id
      ORDER BY c.display_order ASC, c.name ASC`,
    [resolved]
  );
  return result.rows;
}

async function getServices(
  params: ServiceQueryParams
): Promise<{ services: Service[]; total: number; page: number; limit: number }> {
  const resolved = resolveScope(params.scope);
  const { limit, offset, page } = safePaging(params.page, params.limit);

  const conditions = [`s.is_active = true`, `s.kind = 'ITEM'`, `s.scope = ?`, PRICED_ONLY];
  const values: unknown[] = [resolved];

  if (params.categoryId) {
    conditions.push(`s.category_id = ?`);
    values.push(params.categoryId);
  }
  if (params.search) {
    // LIKE, not ILIKE: the collation is already case-insensitive.
    conditions.push(`(s.name LIKE ? OR s.description LIKE ?)`);
    values.push(`%${params.search}%`, `%${params.search}%`);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  // The same join and the same predicate as the listing below: a total that
  // counted unpriced rows would page over items the caller never receives.
  const countResult = await query<{ total: number }>(
    `SELECT COUNT(*) AS total FROM services s ${PRICE_JOIN} ${where}`,
    values
  );
  const total = Number(countResult.rows[0]?.total || 0);

  const result = await query<ServiceQueryRow>(
    `SELECT s.id, s.category_id, c.name AS category_name, s.name, s.description,
            ${PRICE_SELECT},
            ${SERVICE_TYPES_SELECT},
            s.unit, s.image_url, s.icon_name, s.weight_kg, s.is_popular, s.is_active
       FROM services s
       LEFT JOIN service_categories c ON c.id = s.category_id
       ${PRICE_JOIN}
       ${where}
      ORDER BY s.is_popular DESC, s.display_order ASC, s.name ASC
      LIMIT ${limit} OFFSET ${offset}`,
    values
  );

  return { services: result.rows.map(toService), total, page, limit };
}

async function getServiceById(id: string, scope?: string): Promise<Service> {
  const resolved = resolveScope(scope);
  const result = await query<ServiceQueryRow>(
    `SELECT s.id, s.category_id, c.name AS category_name, s.name, s.description,
            ${PRICE_SELECT},
            ${SERVICE_TYPES_SELECT},
            s.unit, s.image_url, s.icon_name, s.weight_kg, s.is_popular, s.is_active
       FROM services s
       LEFT JOIN service_categories c ON c.id = s.category_id
       ${PRICE_JOIN}
      WHERE s.id = ? AND s.is_active = true AND s.kind = 'ITEM' AND s.scope = ?
        AND ${PRICED_ONLY}`,
    [id, resolved]
  );

  const service = result.rows[0];
  // A missing row is a 404, not a null the route has to remember to
  // check -- the old version returned null and the route sent 200.
  if (!service) {
    throw new AppError('Service not found', 404);
  }
  return toService(service);
}

async function getPopularServices(scope?: string): Promise<Service[]> {
  const resolved = resolveScope(scope);
  const result = await query<ServiceQueryRow>(
    `SELECT s.id, s.category_id, c.name AS category_name, s.name, s.description,
            ${PRICE_SELECT},
            ${SERVICE_TYPES_SELECT},
            s.unit, s.image_url, s.icon_name, s.weight_kg, s.is_popular, s.is_active
       FROM services s
       LEFT JOIN service_categories c ON c.id = s.category_id
       ${PRICE_JOIN}
      WHERE s.is_active = true AND s.kind = 'ITEM'
        AND s.is_popular = true AND s.scope = ?
        AND ${PRICED_ONLY}
      ORDER BY s.display_order ASC, s.name ASC
      LIMIT 10`,
    [resolved]
  );
  return result.rows.map(toService);
}

export { getCategories, getServices, getServiceById, getPopularServices };
