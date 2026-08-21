import { Router, Request, Response, NextFunction } from 'express';
import {
  getSalesSummary,
  getSalesTimeseries,
  listBusinessApprovals,
  listRiderApprovals,
  decideBusiness,
  decideRider,
  createBusiness,
  createRider,
  getBusinessDetail,
  listBusinessCompleteness,
  updateBusinessDetail,
} from '../services/superAdmin.service';
import {
  listMobiles,
  addMobile,
  removeMobile,
  setPrimary,
  setAllowance,
} from '../services/businessMobiles.service';
import { sendSuccess } from '../utils/response';
import { authenticate, authorize, AuthenticatedRequest } from '../middleware/auth';

const router = Router();

// Every route here is SUPER_ADMIN only. A plain ADMIN is deliberately
// not enough: this is where approvals and account creation live.
router.use(authenticate);
router.use(authorize('SUPER_ADMIN'));

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

/* ---- Sales ---- */

// GET /api/super-admin/sales/summary?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/sales/summary', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const summary = await getSalesSummary(asString(req.query.from), asString(req.query.to));
    sendSuccess(res, summary, 'Sales summary fetched successfully');
  } catch (error) {
    next(error);
  }
});

// GET /api/super-admin/sales/timeseries?from=&to=&granularity=day|month
router.get('/sales/timeseries', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const series = await getSalesTimeseries(
      asString(req.query.from),
      asString(req.query.to),
      asString(req.query.granularity) || 'day'
    );
    sendSuccess(res, series, 'Sales timeseries fetched successfully');
  } catch (error) {
    next(error);
  }
});

/* ---- Approval queue ---- */

// GET /api/super-admin/approvals/businesses?status=PENDING
router.get('/approvals/businesses', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await listBusinessApprovals(asString(req.query.status) || 'PENDING');
    sendSuccess(res, rows, 'Business approval requests fetched successfully');
  } catch (error) {
    next(error);
  }
});

// GET /api/super-admin/approvals/riders?status=PENDING
router.get('/approvals/riders', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await listRiderApprovals(asString(req.query.status) || 'PENDING');
    sendSuccess(res, rows, 'Rider approval requests fetched successfully');
  } catch (error) {
    next(error);
  }
});

// PATCH /api/super-admin/approvals/businesses/:id   { action: 'approve' | 'reject', note? }
router.patch(
  '/approvals/businesses/:id',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const result = await decideBusiness(
        authReq.user!.id,
        req.params.id,
        req.body?.action,
        req.body?.note
      );
      sendSuccess(res, result, `Business ${result.status.toLowerCase()}`);
    } catch (error) {
      next(error);
    }
  }
);

// PATCH /api/super-admin/approvals/riders/:id   { action: 'approve' | 'reject', note? }
router.patch('/approvals/riders/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const result = await decideRider(
      authReq.user!.id,
      req.params.id,
      req.body?.action,
      req.body?.note
    );
    sendSuccess(res, result, `Rider ${result.approval_status.toLowerCase()}`);
  } catch (error) {
    next(error);
  }
});

/* ---- Company / Establishment Details ---- */

// GET /api/super-admin/businesses?incomplete=true
// Every business with its completeness, so gaps are visible at a glance.
router.get('/businesses', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const onlyIncomplete = String(req.query.incomplete || '').toLowerCase() === 'true';
    const rows = await listBusinessCompleteness(onlyIncomplete);
    sendSuccess(res, rows, 'Businesses fetched successfully');
  } catch (error) {
    next(error);
  }
});

// GET /api/super-admin/businesses/:id
router.get('/businesses/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const detail = await getBusinessDetail(req.params.id);
    sendSuccess(res, detail, 'Establishment details fetched successfully');
  } catch (error) {
    next(error);
  }
});

// PUT /api/super-admin/businesses/:id
// Fills in whatever was missed during onboarding.
router.put('/businesses/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const detail = await updateBusinessDetail(req.params.id, req.body);
    sendSuccess(res, detail, 'Establishment details updated successfully');
  } catch (error) {
    next(error);
  }
});


/* ---- Mobile numbers on a business (one to many) ---- */

// GET /api/super-admin/businesses/:id/mobiles
router.get('/businesses/:id/mobiles', async (req: Request, res: Response, next: NextFunction) => {
  try {
    sendSuccess(res, await listMobiles(req.params.id), 'Mobile numbers fetched successfully');
  } catch (error) {
    next(error);
  }
});

// POST /api/super-admin/businesses/:id/mobiles   { mobile_number, label?, is_primary? }
router.post('/businesses/:id/mobiles', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const result = await addMobile(req.params.id, req.body, authReq.user!.id);
    // The warning rides along with a success: the number WAS added, and
    // the caller still needs to know it is now ambiguous.
    sendSuccess(res, result, result.warning || 'Mobile number added', 201);
  } catch (error) {
    next(error);
  }
});

// DELETE /api/super-admin/businesses/:id/mobiles/:mobileId
router.delete(
  '/businesses/:id/mobiles/:mobileId',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      sendSuccess(
        res,
        await removeMobile(req.params.id, req.params.mobileId),
        'Mobile number removed'
      );
    } catch (error) {
      next(error);
    }
  }
);

// PATCH /api/super-admin/businesses/:id/mobiles/primary   { mobile_number }
router.patch(
  '/businesses/:id/mobiles/primary',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      sendSuccess(
        res,
        await setPrimary(req.params.id, req.body?.mobile_number),
        'Primary mobile number updated'
      );
    } catch (error) {
      next(error);
    }
  }
);

// PUT /api/super-admin/businesses/:id/mobiles/allowance   { max_mobiles }
// How many numbers this business may hold. Super admin only.
router.put(
  '/businesses/:id/mobiles/allowance',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      sendSuccess(
        res,
        await setAllowance(req.params.id, req.body?.max_mobiles),
        'Mobile number limit updated'
      );
    } catch (error) {
      next(error);
    }
  }
);


/* ---- Direct entry creation ---- */

// POST /api/super-admin/businesses
router.post('/businesses', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const business = await createBusiness(authReq.user!.id, req.body);
    sendSuccess(res, business, 'Business created successfully', 201);
  } catch (error) {
    next(error);
  }
});

// POST /api/super-admin/riders
router.post('/riders', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const rider = await createRider(authReq.user!.id, req.body);
    sendSuccess(res, rider, 'Rider created successfully', 201);
  } catch (error) {
    next(error);
  }
});

export default router;
