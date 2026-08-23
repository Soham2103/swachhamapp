import { Router, Request, Response, NextFunction } from 'express';
import {
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
  listItemCategories,
  listServiceTypes,
  listLaundryTypes,
  createCatalogueItem,
  createItemWithCustomerPrice,
} from '../services/priceList.service';
import { sendSuccess } from '../utils/response';

/**
 * Price List, under the super admin router.
 *
 * This router is mounted INSIDE superAdmin.routes.ts, which already runs
 * `authenticate` then `authorize('SUPER_ADMIN')` on everything below it.
 * That is deliberate: there is one authentication system in this app and
 * this section does not add a second one. Every route here is therefore
 * SUPER_ADMIN only, and no customer or business token can reach it.
 *
 *   /prices/customers            the global customer price list
 *   /prices/businesses/:id       one business's own price list
 *   /prices/items                catalogue items, for the pickers
 */

const router = Router();

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

const asBool = (value: unknown): boolean => String(value ?? '').toLowerCase() === 'true';

/* ===================================================================
 * CATALOGUE  — what can be priced
 * =================================================================== */

// GET /api/super-admin/prices/items?search=&unpriced=true&category_id=&subcategory_id=
router.get('/items', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const items = await listPriceableItems({
      search: asString(req.query.search),
      unpricedOnly: asBool(req.query.unpriced),
      // The dependent pickers: a top-level category matches everything
      // beneath it; a sub-category narrows to exactly its own items.
      categoryId: asString(req.query.category_id),
      subcategoryId: asString(req.query.subcategory_id),
    });
    sendSuccess(res, items, 'Items fetched successfully');
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/super-admin/prices/items
 *   { item_name, category_id, subcategory_id?, unit?, service_types?, is_active? }
 *
 * "+ Create New Item", from EITHER price list. It creates the catalogue row
 * and nothing else: no price is implied, because the Customer Price List and
 * the Business Price List price the same item differently and neither may be
 * guessed from the other.
 *
 * The item is filed under the sub-category, by id, through the existing
 * `service_categories` tree. A duplicate name inside one sub-category is
 * refused here with 409 -- the rule lives in the service, not in the form.
 *
 * The same handler is also mounted as POST /api/super-admin/items.
 */
router.post('/items', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const item = await createCatalogueItem(req.body ?? {});
    sendSuccess(res, item, 'Item created successfully', 201);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/super-admin/prices/categories
 *
 * The whole two-level tree in one call: rows with `parent_id: null` are
 * Categories, the rest are Sub-categories pointing at them. Categories with
 * no items are omitted.
 */
router.get('/categories', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    sendSuccess(res, await listItemCategories(), 'Categories fetched successfully');
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/super-admin/prices/laundry-types
 *
 * Hotel Laundry / Guest Laundry, for the Business Price List selector. Fixed
 * by the schema's ENUM, so the UI cannot offer a type the backend would
 * refuse and a client cannot invent one.
 */
router.get('/laundry-types', (_req: Request, res: Response, next: NextFunction) => {
  try {
    sendSuccess(res, listLaundryTypes(), 'Laundry types fetched successfully');
  } catch (error) {
    next(error);
  }
});

// GET /api/super-admin/prices/service-types
router.get('/service-types', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    sendSuccess(res, await listServiceTypes(), 'Services fetched successfully');
  } catch (error) {
    next(error);
  }
});

/* ===================================================================
 * CUSTOMER PRICE LIST  — one global price per item
 * =================================================================== */

// GET /api/super-admin/prices/customers?search=&active_only=true
router.get('/customers', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await listCustomerPrices({
      search: asString(req.query.search),
      // Disabled rows are listed by default so they can be re-enabled.
      includeInactive: !asBool(req.query.active_only),
    });
    sendSuccess(res, rows, 'Customer price list fetched successfully');
  } catch (error) {
    next(error);
  }
});

// GET /api/super-admin/prices/customers/:id
router.get('/customers/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    sendSuccess(res, await getCustomerPriceById(req.params.id), 'Customer price fetched');
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/super-admin/prices/customers
 *
 * Two shapes, because the form has two jobs:
 *
 *   { item_id, customer_price, ... }        price an item that exists
 *   { item_name, category_id, ... }         add the item AND price it
 *
 * The second creates a normal `services` row, not a parallel item
 * record, so the catalogue keeps one identity per item.
 */
router.post('/customers', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body ?? {};
    const row = body.item_id
      ? await createCustomerPrice(body)
      : await createItemWithCustomerPrice(body);
    sendSuccess(res, row, 'Customer price added successfully', 201);
  } catch (error) {
    next(error);
  }
});

// PUT /api/super-admin/prices/customers/:id   { customer_price?, original_price?, is_active? }
router.put('/customers/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const row = await updateCustomerPrice(req.params.id, req.body ?? {});
    sendSuccess(res, row, 'Customer price updated successfully');
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/super-admin/prices/customers/:id?hard=true
 *
 * Soft by default: the row is disabled, not removed, because historical
 * order lines reference the item and their invoices must stay readable.
 * `hard=true` is refused as soon as any order names the item.
 */
router.delete('/customers/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await deleteCustomerPrice(req.params.id, asBool(req.query.hard));
    sendSuccess(
      res,
      result,
      result.deleted ? 'Customer price deleted' : 'Customer price disabled'
    );
  } catch (error) {
    next(error);
  }
});

/* ===================================================================
 * BUSINESS PRICE LIST  — a separate price per business
 * =================================================================== */

/**
 * GET /api/super-admin/prices/businesses/:businessId?laundry_type=HOTEL_LAUNDRY
 *
 * Every catalogue item for this business AT ONE LAUNDRY TYPE, including the
 * ones that have no price configured yet (`price: null`) — that list is what
 * the UI needs to show "not set" rows rather than pretending they do not
 * exist.
 *
 * `configured=true` narrows it to the rows that do have a price.
 */
router.get('/businesses/:businessId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await listBusinessPrices(req.params.businessId, {
      // One laundry type per listing — Hotel and Guest are priced
      // separately, so a single table mixing them would be ambiguous.
      // Defaults to Hotel Laundry when not specified.
      laundryType: asString(req.query.laundry_type),
      search: asString(req.query.search),
      onlyConfigured: asBool(req.query.configured),
      includeInactiveItems: asBool(req.query.include_inactive_items),
    });
    sendSuccess(res, rows, 'Business price list fetched successfully');
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/super-admin/prices/businesses/:businessId
 *   { item_id, laundry_type, price, is_active? }
 *
 * `laundry_type` is HOTEL_LAUNDRY or GUEST_LAUNDRY. The same item at the
 * other type is a separate entry and is allowed; the same item at the SAME
 * type twice is refused with 409.
 */
router.post('/businesses/:businessId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const row = await createBusinessPrice(req.params.businessId, req.body ?? {});
    sendSuccess(res, row, 'Business price added successfully', 201);
  } catch (error) {
    next(error);
  }
});

// GET /api/super-admin/prices/businesses/:businessId/:priceId
router.get(
  '/businesses/:businessId/:priceId',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const row = await getBusinessPriceById(req.params.businessId, req.params.priceId);
      sendSuccess(res, row, 'Business price fetched');
    } catch (error) {
      next(error);
    }
  }
);

// PUT /api/super-admin/prices/businesses/:businessId/:priceId   { price?, is_active? }
router.put(
  '/businesses/:businessId/:priceId',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const row = await updateBusinessPrice(
        req.params.businessId,
        req.params.priceId,
        req.body ?? {}
      );
      sendSuccess(res, row, 'Business price updated successfully');
    } catch (error) {
      next(error);
    }
  }
);

// DELETE /api/super-admin/prices/businesses/:businessId/:priceId?hard=true
router.delete(
  '/businesses/:businessId/:priceId',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await deleteBusinessPrice(
        req.params.businessId,
        req.params.priceId,
        asBool(req.query.hard)
      );
      sendSuccess(
        res,
        result,
        result.deleted ? 'Business price deleted' : 'Business price disabled'
      );
    } catch (error) {
      next(error);
    }
  }
);

export default router;
