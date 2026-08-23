import { Router, Request, Response, NextFunction } from 'express';
import {
  getSalesSummary,
  getSalesTimeseries,
  listBusinessApprovals,
  listRiderApprovals,
  decideBusiness,
  decideRider,
  getBusinessDetail,
  listBusinessCompleteness,
  updateBusinessDetail,
} from '../services/superAdmin.service';
import { sendSuccess } from '../utils/response';
import { authenticate, authorize, AuthenticatedRequest } from '../middleware/auth';
import { logger } from '../utils/logger';
import { AppError } from '../utils/appError';
import { verifyGstin, verifyGSTIN } from '../services/gstVerification.service';
import { buildInvoice } from '../services/gstInvoice.service';
import { recentPeriodsForBusiness } from '../services/billingCycle.service';
import { panFromGstin } from '../services/creationRequest.service';
import { renderInvoicePdf } from '../services/invoicePdf.service';
import { createCatalogueItem } from '../services/priceList.service';
import priceRoutes from './superAdminPrice.routes';
import requestRoutes from './superAdminRequest.routes';
import accountRoutes from './superAdminAccounts.routes';
import businessAccountRoutes from './superAdminBusinessAccount.routes';

const router = Router();

// Every route here is SUPER_ADMIN only. A plain ADMIN is deliberately
// not enough: this is where approvals and account creation live.
router.use(authenticate);
router.use(authorize('SUPER_ADMIN'));

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

/* ---- Price List ----
 *
 * Mounted here rather than on its own top-level path so it inherits the
 * two lines above: one authentication system, one authorization rule.
 * Everything under /api/super-admin/prices is SUPER_ADMIN only.
 */
router.use('/prices', priceRoutes);

/**
 * POST /api/super-admin/items
 *
 * The catalogue-item creation endpoint named in the API contract. It is the
 * SAME handler as POST /api/super-admin/prices/items -- one implementation,
 * two paths -- so "+ Create New Item" behaves identically wherever it is
 * reached from. SUPER_ADMIN only, like everything on this router.
 */
router.post('/items', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const item = await createCatalogueItem(req.body ?? {});
    sendSuccess(res, item, 'Item created successfully', 201);
  } catch (error) {
    next(error);
  }
});

/* ---- Creation requests + manager accounts ----
 *
 * Mounted here for the same reason as the price list: it inherits the
 * `authenticate` + `authorize('SUPER_ADMIN')` pair above, so approving a
 * request and creating a manager are Super Admin only by construction.
 */
router.use('/', requestRoutes);

/* ---- Full account management: businesses, managers, riders, sorters ----
 *
 * Same reasoning as above: mounted here so it inherits the
 * `authenticate` + `authorize('SUPER_ADMIN')` pair, which is what makes
 * disabling a user or editing a business master record Super Admin only.
 */
router.use('/', accountRoutes);

/* ---- Business Account: one business's orders, invoices and payments ----
 *
 * Mounted here for the same reason as the others: it inherits the
 * `authenticate` + `authorize('SUPER_ADMIN')` pair, so a business's ledger is
 * Super Admin only by construction.
 *
 * The invoice endpoints it drives are the EXISTING ones further down this
 * file -- /businesses/:id/invoice, .../invoice.pdf and .../billing-periods.
 * Generate Invoice was not reimplemented; only the button moved.
 */
router.use('/', businessAccountRoutes);

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


/* ---- Direct entry creation: REMOVED ----
 *
 * POST /api/super-admin/businesses and POST /api/super-admin/riders are
 * gone, along with the service functions behind them. A Super Admin does not
 * create a business or a rider; a MANAGER raises a creation request and the
 * Super Admin APPROVES it, which is the /requests routes mounted above.
 *
 * The endpoints are removed rather than merely hidden in the app, so the
 * capability is actually absent: a client calling either path gets a 404
 * from the router, not a business.
 *
 * Nothing else moved. Listing, viewing, editing, approving, disabling and
 * deleting businesses and riders are all still here, and rider login,
 * assignment and every rider API are untouched.
 */

/* ===================================================================
 * GST VERIFICATION  (used by the business registration form)
 * =================================================================== */

/**
 * Verifies one GSTIN with the configured provider and returns the taxpayer
 * details.
 *
 * The whole point of this endpoint is that the credentials stay here: the
 * form sends a number and gets back what the provider said. Nothing about the
 * upstream call — which provider, its URL, its key — is exposed, so the
 * provider can be swapped without the app changing.
 *
 * SUPER_ADMIN only, like every route on this router.
 */
router.post('/gst/verify', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Format and check digit are validated inside, so an obviously wrong
    // number is refused with a 400 before the provider is ever called.
    const details = await verifyGstin(req.body?.gstin ?? req.body?.gst_number);

    sendSuccess(
      res,
      details,
      details.active
        ? 'GST verified.'
        : `This GST registration is ${details.status || 'not active'}.`
    );
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/super-admin/gst/lookup   { gstin }
 *
 * The SAME response shape as POST /api/manager/gst/verify, on purpose: the
 * Business form is one component shared by registration and editing, so it
 * must get one answer shape whichever role is using it. The PAN is derived
 * here from characters 3-12 of the GSTIN so the form can show it read-only;
 * it is derived AGAIN on save and that copy is the one stored.
 *
 * The provider, its URL and its key never leave the server.
 */
router.post('/gst/lookup', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const submitted = req.body?.gstin ?? req.body?.gst_number;
    if (typeof submitted !== 'string' || !submitted.trim()) {
      throw new AppError('Please enter a GST number.', 400);
    }

    // The richer of the two lookups: it carries the registered ADDRESS,
    // which is what fills the Legal Address field.
    const details = await verifyGstin(submitted);

    return sendSuccess(
      res,
      {
        verified: details.active,
        data: {
          gstin: details.gstin,
          pan_number: panFromGstin(details.gstin),
          legalName: details.legalName,
          tradeName: details.tradeName,
          registrationStatus: details.status,
          state: details.address.state,
          address: details.address.full,
          city: details.address.city,
          pincode: details.address.pincode,
        },
      },
      details.active
        ? 'GST verified.'
        : `This GST registration is ${details.status || 'not active'}.`
    );
  } catch (error) {
    return next(error);
  }
});

/**
 * Verifies a GSTIN and answers in the normalised shape.
 *
 * `verified` is the verdict: true when the provider confirmed an active
 * registration, false when it was reached and said otherwise. Both are a 200,
 * because the request itself succeeded — only our own faults (no key, quota
 * gone, provider down) become 5xx, so the UI can tell "this GSTIN is no good"
 * apart from "we could not check".
 *
 * SUPER_ADMIN only, like every route on this router. The provider, its URL and
 * its key are never part of the response.
 */
router.post('/verify-gstin', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const submitted = req.body?.gstin ?? req.body?.gst_number;

    // Nothing to verify is an incomplete request, not a verdict about a
    // GSTIN, so it answers 400 rather than "verified: false".
    if (typeof submitted !== 'string' || !submitted.trim()) {
      throw new AppError('Please enter a GST number.', 400);
    }

    const result = await verifyGSTIN(submitted);

    if (!result.valid) {
      return sendSuccess(
        res,
        { verified: false, gstin: result.gstin },
        result.message || 'GSTIN could not be verified'
      );
    }

    return sendSuccess(
      res,
      {
        verified: true,
        data: {
          gstin: result.gstin,
          legalName: result.legalName,
          tradeName: result.tradeName,
          registrationStatus: result.registrationStatus,
          businessType: result.businessType,
          state: result.state,
          registrationDate: result.registrationDate,
        },
      },
      'GSTIN verified'
    );
  } catch (error) {
    // Missing key, exhausted quota or a provider outage — never reported as
    // an invalid GSTIN.
    return next(error);
  }
});

/* ===================================================================
 * GST INVOICE  (business-wise, for a chosen period)
 * =================================================================== */

/**
 * The invoice as data — the same figures the PDF is drawn from.
 *
 * Useful for showing a preview before the download, and it keeps the two
 * from ever disagreeing: both come from buildInvoice.
 */
/**
 * GET /api/super-admin/businesses/:id/billing-periods?count=6
 *
 * The last few invoice windows for this business, computed from ITS OWN
 * billing cycle. Lets the operator choose "August 2026" or "1-14 Aug 2026"
 * rather than typing two dates and hoping they line up with a billing period.
 */
router.get(
  '/businesses/:id/billing-periods',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const count = Number(req.query.count) || 6;
      const periods = await recentPeriodsForBusiness(req.params.id, count);
      sendSuccess(res, periods, 'Billing periods fetched successfully');
    } catch (error) {
      next(error);
    }
  }
);

router.get('/businesses/:id/invoice', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const invoice = await buildInvoice(req.params.id, req.query.from, req.query.to);
    sendSuccess(res, invoice, 'Invoice generated');
  } catch (error) {
    next(error);
  }
});

/**
 * The invoice as a PDF.
 *
 * Every amount is computed on the server from the orders in the window; the
 * client receives finished bytes, so there is nothing left for it to alter.
 */
router.get('/businesses/:id/invoice.pdf', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const invoice = await buildInvoice(req.params.id, req.query.from, req.query.to);
    const pdf = await renderInvoicePdf(invoice);

    const fileName = `${invoice.invoice_number.replace(/[^A-Za-z0-9._-]/g, '-')}.pdf`;
    logger.info(
      `[Invoice] ${invoice.invoice_number} downloaded by super admin ${authReq.user!.id}`
    );

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Length', String(pdf.length));
    res.end(pdf);
  } catch (error) {
    next(error);
  }
});

export default router;
