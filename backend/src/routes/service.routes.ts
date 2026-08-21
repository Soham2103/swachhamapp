import { Router, Request, Response, NextFunction } from 'express';
import {
  getServices,
  getServiceById,
  getCategories,
  getPopularServices,
} from '../services/service.service';
import { sendSuccess, sendPaginated } from '../utils/response';

const router = Router();

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

/**
 * ORDER MATTERS. '/categories' and '/popular' are declared before
 * '/:id', otherwise Express matches them as an id and the customer
 * catalogue answers "Service not found" for both. The README has
 * documented these two endpoints all along; they were never registered.
 */

// GET /api/services/categories?scope=CUSTOMER
router.get('/categories', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const categories = await getCategories(asString(req.query.scope));
    sendSuccess(res, categories, 'Categories fetched successfully');
  } catch (error) {
    next(error);
  }
});

// GET /api/services/popular?scope=CUSTOMER
router.get('/popular', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const services = await getPopularServices(asString(req.query.scope));
    sendSuccess(res, services, 'Popular services fetched successfully');
  } catch (error) {
    next(error);
  }
});

// GET /api/services?page=&limit=&search=&category_id=&scope=
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await getServices({
      page: parseInt(req.query.page as string, 10) || 1,
      limit: parseInt(req.query.limit as string, 10) || 20,
      search: asString(req.query.search),
      categoryId: asString(req.query.category_id),
      scope: asString(req.query.scope),
    });

    // Paginated shape, so a client can tell "page 1 of many" from
    // "that is everything" instead of guessing from the array length.
    sendPaginated(
      res,
      result.services,
      result.total,
      result.page,
      result.limit,
      'Services fetched successfully'
    );
  } catch (error) {
    next(error);
  }
});

// GET /api/services/:id
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const service = await getServiceById(req.params.id, asString(req.query.scope));
    sendSuccess(res, service, 'Service fetched successfully');
  } catch (error) {
    next(error);
  }
});

export default router;
