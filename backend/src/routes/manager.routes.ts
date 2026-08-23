import { Router, Request, Response, NextFunction } from 'express';
import {
  submitRequest,
  listOwnRequests,
  getOwnRequest,
  requestCounts,
  panFromGstin,
  BILLING_CYCLES,
} from '../services/creationRequest.service';
import { verifyGstin } from '../services/gstVerification.service';
import { sendSuccess } from '../utils/response';
import { authenticate, authorize, AuthenticatedRequest } from '../middleware/auth';
import { AppError } from '../utils/appError';

/**
 * The Manager section.
 *
 * A Manager PROPOSES; it never creates. Nothing on this router writes to
 * `businesses`, `business_users` or `users`, and nothing here can set a
 * request's status to anything but PENDING — approval lives on the Super
 * Admin router and nowhere else.
 *
 * The guard is the app's existing one: `authenticate` then `authorize`, the
 * same pair the Super Admin router uses. No second authentication system.
 *
 * OWNERSHIP. Every read is scoped to the authenticated manager's own id,
 * taken from the verified token — never from a query parameter — so one
 * Manager cannot see or touch another's requests.
 */

const router = Router();

router.use(authenticate);
router.use(authorize('MANAGER'));

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

/* ---- Dashboard ---- */

// GET /api/manager/summary
router.get('/summary', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const counts = await requestCounts(authReq.user!.id);
    sendSuccess(res, { counts, billing_cycles: BILLING_CYCLES }, 'Summary fetched successfully');
  } catch (error) {
    next(error);
  }
});

/* ---- GST verification (for the New Business form) ---- */

/**
 * POST /api/manager/gst/verify   { gstin }
 *
 * The same provider abstraction the Super Admin form uses. The key stays on
 * the server: the app sends a number and renders what comes back.
 *
 * The PAN is returned alongside, derived here from characters 3-12 of the
 * GSTIN, so the form can fill it in without the user typing it. It is
 * derived AGAIN at approval — this copy is a convenience for the UI and is
 * never what gets stored.
 */
router.post('/gst/verify', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const submitted = req.body?.gstin ?? req.body?.gst_number;
    if (typeof submitted !== 'string' || !submitted.trim()) {
      throw new AppError('Please enter a GST number.', 400);
    }

    // `verifyGstin` is the richer of the two lookups: it carries the
    // registered ADDRESS, which is what fills the Legal Address field.
    const details = await verifyGstin(submitted);

    return sendSuccess(
      res,
      {
        verified: details.active,
        data: {
          gstin: details.gstin,
          // Server-derived from characters 3-12. The form shows it read-only.
          pan_number: panFromGstin(details.gstin),
          legalName: details.legalName,
          tradeName: details.tradeName,
          registrationStatus: details.status,
          state: details.address.state,
          // Pre-fills Legal Address; the Manager may still edit it.
          address: details.address.full,
          city: details.address.city,
          pincode: details.address.pincode,
        },
      },
      details.active ? 'GST verified.' : `This GST registration is ${details.status || 'not active'}.`
    );
  } catch (error) {
    return next(error);
  }
});

/* ---- Requests ---- */

/**
 * POST /api/manager/requests/business
 * POST /api/manager/requests/rider
 * POST /api/manager/requests/sorter
 *
 * All three land in PENDING. The body is validated server-side in the
 * service; anything the form did not check is checked there.
 */
for (const [path, type] of [
  ['business', 'BUSINESS'],
  ['rider', 'RIDER'],
  ['sorter', 'SORTER'],
] as const) {
  router.post(`/requests/${path}`, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const request = await submitRequest(authReq.user!.id, type, req.body ?? {});
      sendSuccess(res, request, 'Request submitted for approval', 201);
    } catch (error) {
      next(error);
    }
  });
}

// GET /api/manager/requests?type=BUSINESS&status=PENDING
router.get('/requests', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    // Scoped to the token's manager id. A manager_id in the query is ignored.
    const rows = await listOwnRequests(authReq.user!.id, {
      type: asString(req.query.type),
      status: asString(req.query.status),
    });
    sendSuccess(res, rows, 'Requests fetched successfully');
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/manager/requests/:id
 *
 * Another manager's id is a 404, not a 403: the response does not confirm
 * that the request exists.
 */
router.get('/requests/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    sendSuccess(res, await getOwnRequest(authReq.user!.id, req.params.id), 'Request fetched');
  } catch (error) {
    next(error);
  }
});

export default router;
