import { Router, Request, Response, NextFunction } from 'express';
import { createOrder, getOrders, getOrderById, cancelOrder, getOrderTracking } from '../services/order.service';
import { sendSuccess } from '../utils/response';
import { authenticate, AuthenticatedRequest } from '../middleware/auth';
import { requireServiceArea } from '../middleware/serviceArea';

const router = Router();
router.use(authenticate);

// Same gate as the business flow: coordinates decide, not a claimed district.
router.post('/', requireServiceArea, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    // The number is taken from the SESSION -- whatever the body says about
    // `placed_by_mobile` is ignored, so an order cannot be stamped with a
    // number the caller did not prove by OTP.
    const order = await createOrder(authReq.user!.id, req.body, authReq.user!.mobile);
    sendSuccess(res, order, 'Order created successfully', 201);
  } catch (error) {
    next(error);
  }
});

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;
    const orders = await getOrders(authReq.user!.id, req.query.status as string, page, limit);
    sendSuccess(res, orders, 'Orders fetched successfully');
  } catch (error) {
    next(error);
  }
});

router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const order = await getOrderById(authReq.user!.id, req.params.id);
    sendSuccess(res, order, 'Order fetched successfully');
  } catch (error) {
    next(error);
  }
});

router.get('/:id/tracking', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tracking = await getOrderTracking(req.params.id);
    sendSuccess(res, tracking, 'Tracking info fetched successfully');
  } catch (error) {
    next(error);
  }
});

router.post('/:id/cancel', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const order = await cancelOrder(authReq.user!.id, req.params.id, req.body.reason);
    sendSuccess(res, order, 'Order cancelled successfully');
  } catch (error) {
    next(error);
  }
});

export default router;
