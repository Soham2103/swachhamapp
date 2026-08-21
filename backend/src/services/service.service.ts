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
  /** Null when the catalogue has no price yet, so the client can say
   *  "price on request" instead of showing a confident zero. */
  price: number | null;
  discounted_price: number | null;
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

/** `base_price` is 0 across the whole catalogue today, which is not the
 *  same as "free"; it is unpriced. NULLIF keeps that distinction. */
const PRICE_SELECT = `NULLIF(s.base_price, 0) AS price,
                      NULLIF(s.discounted_price, 0) AS discounted_price`;

/** Item categories that actually have something live in them. */
async function getCategories(scope?: string): Promise<Category[]> {
  const resolved = resolveScope(scope);
  logger.debug(`[ServiceService] Categories for scope ${resolved}`);

  const result = await query<Category>(
    `SELECT c.id, c.name, c.slug, c.description, c.icon_name, c.image_url,
            c.display_order,
            COUNT(s.id) AS item_count
       FROM service_categories c
       LEFT JOIN services s
              ON s.category_id = c.id AND s.is_active = true AND s.kind = 'ITEM'
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

  const conditions = [`s.is_active = true`, `s.kind = 'ITEM'`, `s.scope = ?`];
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

  const countResult = await query<{ total: number }>(
    `SELECT COUNT(*) AS total FROM services s ${where}`,
    values
  );
  const total = Number(countResult.rows[0]?.total || 0);

  const result = await query<Service>(
    `SELECT s.id, s.category_id, c.name AS category_name, s.name, s.description,
            ${PRICE_SELECT},
            s.unit, s.image_url, s.icon_name, s.weight_kg, s.is_popular, s.is_active
       FROM services s
       LEFT JOIN service_categories c ON c.id = s.category_id
       ${where}
      ORDER BY s.is_popular DESC, s.display_order ASC, s.name ASC
      LIMIT ${limit} OFFSET ${offset}`,
    values
  );

  return { services: result.rows, total, page, limit };
}

async function getServiceById(id: string, scope?: string): Promise<Service> {
  const resolved = resolveScope(scope);
  const result = await query<Service>(
    `SELECT s.id, s.category_id, c.name AS category_name, s.name, s.description,
            ${PRICE_SELECT},
            s.unit, s.image_url, s.icon_name, s.weight_kg, s.is_popular, s.is_active
       FROM services s
       LEFT JOIN service_categories c ON c.id = s.category_id
      WHERE s.id = ? AND s.is_active = true AND s.kind = 'ITEM' AND s.scope = ?`,
    [id, resolved]
  );

  const service = result.rows[0];
  // A missing row is a 404, not a null the route has to remember to
  // check -- the old version returned null and the route sent 200.
  if (!service) {
    throw new AppError('Service not found', 404);
  }
  return service;
}

async function getPopularServices(scope?: string): Promise<Service[]> {
  const resolved = resolveScope(scope);
  const result = await query<Service>(
    `SELECT s.id, s.category_id, c.name AS category_name, s.name, s.description,
            ${PRICE_SELECT},
            s.unit, s.image_url, s.icon_name, s.weight_kg, s.is_popular, s.is_active
       FROM services s
       LEFT JOIN service_categories c ON c.id = s.category_id
      WHERE s.is_active = true AND s.kind = 'ITEM'
        AND s.is_popular = true AND s.scope = ?
      ORDER BY s.display_order ASC, s.name ASC
      LIMIT 10`,
    [resolved]
  );
  return result.rows;
}

export { getCategories, getServices, getServiceById, getPopularServices };
