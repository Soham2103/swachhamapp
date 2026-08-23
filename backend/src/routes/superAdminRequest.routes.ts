import { Router, Request, Response, NextFunction } from 'express';
import {
  listAllRequests,
  getRequestById,
  approveRequest,
  rejectRequest,
  resendCredentials,
  requestCounts,
} from '../services/creationRequest.service';
import {
  listManagers,
  createManager,
  setManagerActive,
  resetManagerPassword,
} from '../services/managerAccount.service';
import { sendSuccess } from '../utils/response';
import { AuthenticatedRequest } from '../middleware/auth';

/**
 * Creation requests and manager accounts, for the Super Admin.
 *
 * Mounted INSIDE superAdmin.routes.ts, which already runs `authenticate` then
 * `authorize('SUPER_ADMIN')`. Approving, rejecting and issuing credentials are
 * therefore reachable by a Super Admin and by nobody else — a Manager token
 * gets a 403 before any handler here runs.
 *
 *   /requests                  the three queues
 *   /requests/:id/approve      creates the entity + credentials + email
 *   /requests/:id/reject
 *   /requests/:id/resend       re-issues credentials after a failed email
 *   /managers                  manager accounts, created here only
 */

const router = Router();

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

/* ---- Queues ---- */

// GET /api/super-admin/requests?type=BUSINESS&status=PENDING
router.get('/requests', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await listAllRequests({
      type: asString(req.query.type),
      status: asString(req.query.status),
    });
    sendSuccess(res, rows, 'Requests fetched successfully');
  } catch (error) {
    next(error);
  }
});

// GET /api/super-admin/requests/summary
router.get('/requests/summary', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    sendSuccess(res, await requestCounts(), 'Request counts fetched successfully');
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/super-admin/requests/:id
 *
 * The full submission, so everything can be read before a decision is made.
 */
router.get('/requests/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    sendSuccess(res, await getRequestById(req.params.id), 'Request fetched successfully');
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/super-admin/requests/:id/approve
 *   { password, confirm_password }
 *
 * The Super Admin sets the initial password here — it is required, and
 * nothing is generated if it is missing. The handler creates the entity,
 * hashes the password and emails the credentials, in that order.
 *
 * A failed email does NOT undo the account: the response carries
 * `email.sent: false` and the reason, and the queue offers Resend, which
 * takes a fresh password.
 */
router.post('/requests/:id/approve', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    // The Super Admin's own password, straight from the body to the
    // validator. It is not logged here and not echoed back.
    const result = await approveRequest(authReq.user!.id, req.params.id, {
      password: req.body?.password,
      confirm_password: req.body?.confirm_password ?? req.body?.confirmPassword,
    });
    sendSuccess(
      res,
      result,
      result.email.sent
        ? 'Request approved and credentials emailed.'
        : 'Request approved, but the credentials email could not be sent. Use Resend once email is working.'
    );
  } catch (error) {
    next(error);
  }
});

// POST /api/super-admin/requests/:id/reject   { reason? }
router.post('/requests/:id/reject', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const result = await rejectRequest(authReq.user!.id, req.params.id, req.body?.reason);
    sendSuccess(res, result, 'Request rejected');
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/super-admin/requests/:id/resend   { password, confirm_password }
 *
 * Sets a NEW password and emails it. The original cannot be resent because it
 * was never stored, only hashed — so this is a reset, which is the secure way
 * to recover from a failed delivery.
 */
router.post('/requests/:id/resend', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const result = await resendCredentials(authReq.user!.id, req.params.id, {
      password: req.body?.password,
      confirm_password: req.body?.confirm_password ?? req.body?.confirmPassword,
    });
    sendSuccess(
      res,
      result,
      result.email.sent
        ? 'New credentials emailed.'
        : 'The credentials email still could not be sent.'
    );
  } catch (error) {
    next(error);
  }
});

/* ---- Manager accounts ---- */

// GET /api/super-admin/managers
router.get('/managers', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    sendSuccess(res, await listManagers(), 'Managers fetched successfully');
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/super-admin/managers
 *   { name, email, mobile_number, password, confirm_password }
 *
 * The ONLY way a manager account comes into existence. The Super Admin sets
 * the password; it is validated, hashed and emailed, and is never returned in
 * the response.
 */
router.post('/managers', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    // `confirmPassword` is accepted alongside `confirm_password` here for
    // the same reason as on the approval routes: one spelling should not
    // work on three endpoints and fail on the fourth.
    const result = await createManager(authReq.user!.id, {
      ...(req.body ?? {}),
      confirm_password: req.body?.confirm_password ?? req.body?.confirmPassword,
    });
    sendSuccess(
      res,
      result,
      result.email.sent
        ? 'Manager created and credentials emailed.'
        : 'Manager created, but the credentials email could not be sent. Use Reset password once email is working.',
      201
    );
  } catch (error) {
    next(error);
  }
});

// PATCH /api/super-admin/managers/:id   { is_active }
router.patch('/managers/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await setManagerActive(req.params.id, Boolean(req.body?.is_active));
    sendSuccess(res, result, result.is_active ? 'Manager enabled' : 'Manager disabled');
  } catch (error) {
    next(error);
  }
});

// POST /api/super-admin/managers/:id/reset-password   { password, confirm_password }
router.post('/managers/:id/reset-password', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await resetManagerPassword(req.params.id, {
      password: req.body?.password,
      confirm_password: req.body?.confirm_password ?? req.body?.confirmPassword,
    });
    sendSuccess(
      res,
      result,
      result.email.sent ? 'New password emailed.' : 'The password email could not be sent.'
    );
  } catch (error) {
    next(error);
  }
});

export default router;
