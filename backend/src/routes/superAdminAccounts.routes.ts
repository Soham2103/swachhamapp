import { Router, Request, Response, NextFunction } from 'express';
import {
  listStaff,
  getStaff,
  createStaff,
  updateStaff,
  setStaffActive,
  setStaffPassword,
  deleteStaff,
  listBusinesses,
  getBusiness,
  updateBusiness,
  setBusinessActive,
  setBusinessPassword,
  deleteBusiness,
} from '../services/accountAdmin.service';
import {
  buildBusinessProfileDocument,
  renderBusinessProfilePdf,
  businessProfileFileName,
} from '../services/businessProfilePdf.service';
import { REGISTRATION_TYPE_OPTIONS } from '../services/registrationType.service';
import { logger } from '../utils/logger';
import {
  listContacts,
  setContactLoginEnabled,
  replaceAlternatives,
  addAlternative,
  updateContact,
  deleteAlternative,
} from '../services/businessContact.service';
import { listBillingCycles } from '../services/billingCycle.service';
import { sendSuccess } from '../utils/response';
import { AuthenticatedRequest } from '../middleware/auth';

/**
 * Super Admin account management.
 *
 * Mounted INSIDE superAdmin.routes.ts, which already runs `authenticate` then
 * `authorize('SUPER_ADMIN')`. Every route here is therefore Super Admin only
 * — a Manager or a Business token is refused before any handler runs.
 *
 *   /accounts/:role                managers, riders, sorters (one shape)
 *   /manage/businesses             the business master records
 *   /manage/businesses/:id/contacts
 *
 * The staff routes are mounted under a role parameter rather than three
 * near-identical route trees, because create/edit/enable/delete is the same
 * operation on all three.
 */

const router = Router();

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

/* ---- Reference data ---- */

// GET /api/super-admin/billing-cycles
router.get('/billing-cycles', (_req: Request, res: Response, next: NextFunction) => {
  try {
    sendSuccess(res, listBillingCycles(), 'Billing cycles fetched successfully');
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/super-admin/registration-types
 *
 * B2B and B2C, from the same constant the validators read, so the chips the
 * form renders and the values the server will accept cannot drift apart.
 */
router.get('/registration-types', (_req: Request, res: Response, next: NextFunction) => {
  try {
    sendSuccess(res, REGISTRATION_TYPE_OPTIONS, 'Registration types fetched successfully');
  } catch (error) {
    next(error);
  }
});

/* ===================================================================
 * STAFF  — /accounts/managers | /accounts/riders | /accounts/sorters
 * =================================================================== */

/** URL segment to the role it means. An unknown segment simply does not match. */
const ROLE_BY_PATH: Record<string, 'MANAGER' | 'RIDER' | 'SORTER'> = {
  managers: 'MANAGER',
  riders: 'RIDER',
  sorters: 'SORTER',
};

/**
 * Roles a Super Admin may create DIRECTLY here.
 *
 * RIDER is deliberately absent. A rider comes into existence one way — a
 * Manager raises a rider request and the Super Admin approves it — and the
 * approval path in `creationRequest.service` is untouched, so nothing about
 * riders is lost: they are still listed, edited, enabled, disabled, deleted,
 * given passwords, assigned to orders and able to sign in. Only the "create
 * a rider from the Super Admin panel" door is closed, and it is closed on
 * the SERVER rather than by hiding a button, so POSTing to
 * /api/super-admin/accounts/riders is a 404.
 */
const CREATABLE_ROLES = new Set(['managers', 'sorters']);

for (const [segment, role] of Object.entries(ROLE_BY_PATH)) {
  // GET /api/super-admin/accounts/<segment>
  router.get(`/accounts/${segment}`, async (_req: Request, res: Response, next: NextFunction) => {
    try {
      sendSuccess(res, await listStaff(role), `${role} accounts fetched successfully`);
    } catch (error) {
      next(error);
    }
  });

  /**
   * POST /api/super-admin/accounts/<segment>
   *   { name, email, mobile_number, password, confirm_password, is_active? }
   *
   * The role comes from the ROUTE, not the body, so a "create rider" call
   * cannot mint a manager.
   */
  if (!CREATABLE_ROLES.has(segment)) continue;

  router.post(`/accounts/${segment}`, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const result = await createStaff(authReq.user!.id, role, {
        ...(req.body ?? {}),
        confirm_password: req.body?.confirm_password ?? req.body?.confirmPassword,
      });
      sendSuccess(
        res,
        result,
        result.email.sent
          ? `${role} created and credentials emailed.`
          : `${role} created, but the credentials email could not be sent. Use Set password once email is working.`,
        201
      );
    } catch (error) {
      next(error);
    }
  });
}

// GET /api/super-admin/accounts/:id
router.get('/accounts/detail/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    sendSuccess(res, await getStaff(req.params.id), 'Account fetched successfully');
  } catch (error) {
    next(error);
  }
});

// PUT /api/super-admin/accounts/detail/:id   { name?, email?, mobile_number?, is_active? }
router.put('/accounts/detail/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    sendSuccess(res, await updateStaff(req.params.id, req.body ?? {}), 'Account updated successfully');
  } catch (error) {
    next(error);
  }
});

// PATCH /api/super-admin/accounts/detail/:id/status   { is_active }
router.patch('/accounts/detail/:id/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const row = await setStaffActive(req.params.id, req.body?.is_active);
    sendSuccess(res, row, row.is_active ? 'Account enabled' : 'Account disabled');
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/super-admin/accounts/detail/:id/password   { password, confirm_password }
 *
 * Sets a new password and emails it. Nothing is generated and the existing
 * password cannot be shown — only its hash was ever stored.
 */
router.post('/accounts/detail/:id/password', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await setStaffPassword(req.params.id, {
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

/**
 * DELETE /api/super-admin/accounts/detail/:id
 *
 * Deletes the account, or disables it when records depend on it. The response
 * says which happened rather than reporting a delete that did not occur.
 */
router.delete('/accounts/detail/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await deleteStaff(req.params.id);
    sendSuccess(res, result, result.deleted ? 'Account deleted' : result.reason || 'Account disabled');
  } catch (error) {
    next(error);
  }
});

/* ===================================================================
 * BUSINESSES
 * =================================================================== */

// GET /api/super-admin/manage/businesses?search=&status=
router.get('/manage/businesses', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await listBusinesses({
      search: asString(req.query.search),
      status: asString(req.query.status),
    });
    sendSuccess(res, rows, 'Businesses fetched successfully');
  } catch (error) {
    next(error);
  }
});

// GET /api/super-admin/manage/businesses/:id
router.get('/manage/businesses/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    sendSuccess(res, await getBusiness(req.params.id), 'Business fetched successfully');
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/super-admin/manage/businesses/:id
 *
 * The full master record: names, both addresses, billing cycle, status, the
 * business head, and the alternative contacts. The GSTIN is not editable —
 * it is the business's identity and it determines the PAN.
 */
router.put('/manage/businesses/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    sendSuccess(res, await updateBusiness(req.params.id, req.body ?? {}), 'Business updated successfully');
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/super-admin/manage/businesses/:id/password
 *   { password, confirm_password }
 *
 * Sets a new password on the business's login account and emails it. The
 * SAME hashing and the SAME `business_users.password_hash` column the
 * existing business sign-in reads, so the business logs in afterwards
 * through the path it always used.
 *
 * The existing password cannot be shown — only its hash was ever stored —
 * and the response carries the username and whether the mail went out, never
 * the password.
 */
router.post('/manage/businesses/:id/password', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await setBusinessPassword(req.params.id, {
      password: req.body?.password,
      confirm_password: req.body?.confirm_password ?? req.body?.confirmPassword,
    });
    sendSuccess(
      res,
      result,
      result.email.sent
        ? 'Password updated and emailed to the business.'
        : 'Password updated, but the notification email could not be sent.'
    );
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/super-admin/manage/businesses/:id/profile.pdf
 *
 * The business profile as a filed document. Built on the server from this
 * ONE business's row, so the file records what is stored rather than what a
 * screen was showing, and it carries no password, no OTP and no secret —
 * see businessProfilePdf.service for what is deliberately left off it.
 */
router.get(
  '/manage/businesses/:id/profile.pdf',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const document = await buildBusinessProfileDocument(req.params.id);
      const pdf = await renderBusinessProfilePdf(document);

      logger.info(
        `[BusinessProfile] PDF for business ${document.id} downloaded by super admin ${authReq.user!.id}`
      );

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${businessProfileFileName(document)}"`
      );
      res.setHeader('Content-Length', String(pdf.length));
      res.end(pdf);
    } catch (error) {
      next(error);
    }
  }
);

// PATCH /api/super-admin/manage/businesses/:id/status   { is_active }
router.patch('/manage/businesses/:id/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const row = await setBusinessActive(req.params.id, req.body?.is_active);
    sendSuccess(res, row, row.status === 'ACTIVE' ? 'Business enabled' : 'Business disabled');
  } catch (error) {
    next(error);
  }
});

// DELETE /api/super-admin/manage/businesses/:id
router.delete('/manage/businesses/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await deleteBusiness(req.params.id);
    sendSuccess(res, result, result.deleted ? 'Business deleted' : result.reason || 'Business disabled');
  } catch (error) {
    next(error);
  }
});

/* ---- Contacts ---- */

// GET /api/super-admin/manage/businesses/:id/contacts
router.get('/manage/businesses/:id/contacts', async (req: Request, res: Response, next: NextFunction) => {
  try {
    sendSuccess(res, await listContacts(req.params.id), 'Contacts fetched successfully');
  } catch (error) {
    next(error);
  }
});

// PUT /api/super-admin/manage/businesses/:id/contacts   { alternative_contacts: [...] }
router.put('/manage/businesses/:id/contacts', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await replaceAlternatives(req.params.id, req.body?.alternative_contacts);
    sendSuccess(res, rows, 'Alternative contacts updated successfully');
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/super-admin/manage/businesses/:id/contacts
 *   { name, designation, mobile, login_enabled? }
 *
 * Adds ONE alternative contact. The maximum of three is enforced in the
 * service, so a client that posts a fourth is refused with 409 rather than
 * relying on the button being hidden.
 */
router.post('/manage/businesses/:id/contacts', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const row = await addAlternative(req.params.id, req.body ?? {});
    sendSuccess(res, row, 'Alternative contact added successfully', 201);
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/super-admin/manage/businesses/:id/contacts/:contactId
 *   { name, designation, mobile, login_enabled? }
 *
 * Edits one contact in place. The contact TYPE cannot be changed here --
 * promoting an alternative to the business head would move the login
 * username, which is a different operation.
 */
router.put(
  '/manage/businesses/:id/contacts/:contactId',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const row = await updateContact(req.params.id, req.params.contactId, req.body ?? {});
      sendSuccess(res, row, 'Contact updated successfully');
    } catch (error) {
      next(error);
    }
  }
);

/**
 * DELETE /api/super-admin/manage/businesses/:id/contacts/:contactId
 *
 * Removes one alternative contact. Refused when it is the last one -- the
 * minimum is one, so a replacement has to be added first -- and refused
 * outright for the business head.
 */
router.delete(
  '/manage/businesses/:id/contacts/:contactId',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await deleteAlternative(req.params.id, req.params.contactId);
      sendSuccess(res, result, 'Alternative contact deleted');
    } catch (error) {
      next(error);
    }
  }
);

/**
 * PATCH /api/super-admin/manage/businesses/:id/contacts/:contactId/login
 *   { login_enabled }
 *
 * Whether this number may be used to reach the business login page. Enforced
 * server-side in `resolveLoginRoute`; turning it off is not a UI nicety.
 */
router.patch(
  '/manage/businesses/:id/contacts/:contactId/login',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const row = await setContactLoginEnabled(
        req.params.id,
        req.params.contactId,
        req.body?.login_enabled
      );
      sendSuccess(res, row, row.login_enabled ? 'Login access enabled' : 'Login access disabled');
    } catch (error) {
      next(error);
    }
  }
);

export default router;
