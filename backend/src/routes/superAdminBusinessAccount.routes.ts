import { Router, Request, Response, NextFunction } from 'express';
import { query } from '../config/database';
import { AppError } from '../utils/appError';
import { sendSuccess } from '../utils/response';
import { AuthenticatedRequest } from '../middleware/auth';
import { logger } from '../utils/logger';
import { displayInvoiceNumber, invoiceNumberFor } from '../services/gstInvoice.service';
import { cycleForBusiness, periodFor } from '../services/billingCycle.service';
import { getOrderForBusiness } from '../services/businessOrder.service';
import { config } from '../config/env';
import {
  listReceipts,
  getReceipt,
  getPaymentContext,
  recordPayment,
  displayBusinessName,
  PAYMENT_TYPE_OPTIONS,
} from '../services/paymentReceipt.service';
import {
  buildBillingReceiptDocument,
  renderBillingReceiptPdf,
  billingReceiptFileName,
} from '../services/billingReceiptPdf.service';

/**
 * Super Admin -> Business Account.
 *
 *   /business-account/businesses               the list to choose from
 *   /business-account/:businessId/orders       Order Detail
 *   /business-account/:businessId/payments     Payment Receipt + history
 *   /business-account/:businessId/payments/:id/receipt.pdf
 *
 * Mounted INSIDE superAdmin.routes.ts, which already runs `authenticate` then
 * `authorize('SUPER_ADMIN')`, so every route here is Super Admin only by
 * construction. No second authentication system.
 *
 * DATA ISOLATION IS STRUCTURAL, not a filter applied afterwards. Every route
 * takes the business id from the PATH and every query is scoped by it in its
 * WHERE clause, so one business's orders, invoices, receipts or balances
 * cannot appear under another's — there is no code path that returns rows
 * without that predicate.
 *
 * GENERATE INVOICE IS NOT DUPLICATED HERE. The invoice endpoints already exist
 * on the Super Admin router (`/businesses/:id/invoice`, `.../invoice.pdf`,
 * `.../billing-periods`) and are unchanged; the Business Account screen calls
 * those. Only the BUTTON moved.
 */

const router = Router();

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

/* ===================================================================
 * THE BUSINESS PICKER
 * =================================================================== */

/**
 * GET /api/super-admin/business-account/businesses?search=
 *
 * Every registered business, under its ESTABLISHMENT NAME — which is the name
 * this section is navigated by. The legal name comes along for the ones whose
 * two differ, so a business can still be found by either.
 *
 * The search matches the establishment name, the legal name and the GSTIN,
 * which are the three things a Super Admin actually knows a business by.
 */
router.get('/business-account/businesses', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const search = asString(req.query.search);
    const values: unknown[] = [];
    let where = '';
    if (search) {
      where = `WHERE (COALESCE(NULLIF(TRIM(b.establishment_name), ''), b.name) LIKE ?
                   OR b.name LIKE ? OR b.legal_name LIKE ? OR b.gst_number LIKE ?)`;
      const like = `%${search}%`;
      values.push(like, like, like, like);
    }

    const result = await query<any>(
      `SELECT b.id,
              COALESCE(NULLIF(TRIM(b.establishment_name), ''), b.name) AS name,
              b.legal_name, b.gst_number, b.status, b.registration_type, b.billing_cycle,
              (SELECT COUNT(*) FROM orders o
                 JOIN business_users bu ON bu.id = o.business_user_id
                WHERE bu.business_id = b.id) AS order_count,
              (SELECT COUNT(*) FROM business_payment_receipts r
                WHERE r.business_id = b.id) AS receipt_count
         FROM businesses b
         ${where}
        ORDER BY name ASC
        LIMIT 500`,
      values
    );

    sendSuccess(
      res,
      result.rows.map((row: any) => ({
        ...row,
        id: String(row.id),
        order_count: Number(row.order_count || 0),
        receipt_count: Number(row.receipt_count || 0),
      })),
      'Businesses fetched successfully'
    );
  } catch (error) {
    next(error);
  }
});

/** Resolves the business in the path, or a 404. Every route below starts here. */
async function assertBusiness(businessId: string) {
  const result = await query<{ id: string; name: string; establishment_name: string | null }>(
    `SELECT id, name, establishment_name FROM businesses WHERE id = ?`,
    [businessId]
  );
  if (!result.rows[0]) throw new AppError('Business not found.', 404);
  return {
    id: String(result.rows[0].id),
    name: displayBusinessName(result.rows[0]),
  };
}

/* ===================================================================
 * ORDER DETAIL
 * =================================================================== */

/**
 * GET /api/super-admin/business-account/:businessId/orders
 *
 * This business's orders, newest first — the list the Order Detail tab draws,
 * each row being an order whose Order Details PDF can be opened.
 *
 * SCOPED BY THE JOIN, not by a filter: orders reach a business only through
 * `business_users`, so the join itself is what makes another business's order
 * unreachable here.
 */
router.get(
  '/business-account/:businessId/orders',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const business = await assertBusiness(req.params.businessId);
      const search = asString(req.query.search);

      const values: unknown[] = [business.id];
      let extra = '';
      if (search) {
        extra = ' AND o.order_number LIKE ?';
        values.push(`%${search}%`);
      }

      const result = await query<any>(
        `SELECT o.id, o.order_number, o.status, o.created_at,
                o.laundry_type, o.order_type,
                o.subtotal, o.total, o.total_weight_kg,
                -- The number the order was placed on, read straight. The
                -- account's own number is deliberately not coalesced in: see
                -- the note on the same column in businessOrder.service.
                o.placed_by_mobile,
                bu.name AS placed_by_name,
                -- The order's own date in the BUSINESS's timezone, which is
                -- the date the billing period is decided on. Taken here, from
                -- the same CONVERT_TZ the invoice builder uses, so an order
                -- near midnight cannot land in one period on this screen and
                -- another on the invoice.
                DATE_FORMAT(DATE(CONVERT_TZ(o.created_at, '+00:00', ?)), '%Y-%m-%d') AS order_date,
                (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_count,
                (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi
                  WHERE oi.order_id = o.id) AS total_quantity
           FROM orders o
           JOIN business_users bu ON bu.id = o.business_user_id
          WHERE bu.business_id = ?${extra}
          ORDER BY o.created_at DESC, o.id DESC
          LIMIT 300`,
        [config.BUSINESS_TZ_OFFSET, ...values]
      );

      /*
       * THE INVOICE EACH ORDER FALLS UNDER.
       *
       * Invoices are COMPUTED, not stored -- there is no invoices table and no
       * column on the order pointing at one -- but an invoice number is a pure
       * function of the business and the billing period, so the invoice an
       * order belongs to is derivable from the order's own date.
       *
       * That is what is done here: the business's cycle is read ONCE, the
       * period containing each order's date comes from the existing
       * `periodFor`, and the number from the existing `invoiceNumberFor` --
       * the very function `buildInvoice` names its invoices with. Nothing is
       * generated, nothing is stored, and no second numbering scheme exists.
       *
       * CANCELLED ORDERS GET NONE. Nothing is billed for an order that never
       * happened, so it belongs to no invoice, and `buildInvoice` leaves it
       * out for the same reason.
       */
      const cycle = await cycleForBusiness(business.id);
      const invoiceNumberOf = (row: any): string | null => {
        if (row.status === 'CANCELLED' || !row.order_date) return null;
        const period = periodFor(cycle, String(row.order_date));
        return invoiceNumberFor(business.id, period.from, period.to);
      };

      sendSuccess(
        res,
        {
          business,
          orders: result.rows.map((row: any) => {
            const invoiceNumber = invoiceNumberOf(row);
            return {
              ...row,
              id: String(row.id),
              item_count: Number(row.item_count || 0),
              total_quantity: Number(row.total_quantity || 0),
              invoice_number: invoiceNumber,
              // The short form the rest of the app shows. Same function as the
              // invoice screen and the receipt, so one invoice reads the same
              // everywhere.
              invoice_number_display: invoiceNumber
                ? displayInvoiceNumber(invoiceNumber)
                : null,
            };
          }),
        },
        'Orders fetched successfully'
      );
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/super-admin/business-account/:businessId/orders/:orderId
 *
 * ONE order of this business, in full -- the data the Order Confirmation PDF
 * is built from.
 *
 * NO SECOND DOCUMENT SYSTEM. This returns the SAME `BusinessOrderDetail` the
 * business app's own order endpoint returns, produced by the same query, so
 * the PDF the Super Admin opens is generated by the existing generator from
 * the existing order record. No order is created, nothing is written, and
 * there is no Super Admin copy of the layout to drift from the original.
 *
 * SCOPED BY THE BUSINESS IN THE PATH. `getOrderForBusiness` puts the business
 * id in the WHERE clause, so an order id belonging to a different business is
 * simply not found -- one business's order can never be opened under another.
 */
router.get(
  '/business-account/:businessId/orders/:orderId',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const business = await assertBusiness(req.params.businessId);
      const order = await getOrderForBusiness(business.id, req.params.orderId);
      sendSuccess(res, { business, order }, 'Order fetched successfully');
    } catch (error) {
      next(error);
    }
  }
);

/* ===================================================================
 * PAYMENT RECEIPT
 * =================================================================== */

/** GET /api/super-admin/business-account/payment-types */
router.get('/business-account/payment-types', (_req: Request, res: Response, next: NextFunction) => {
  try {
    sendSuccess(res, PAYMENT_TYPE_OPTIONS, 'Payment types fetched successfully');
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/super-admin/business-account/:businessId/payments
 *   ?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Everything the Payment Receipt tab opens with: the LATEST invoice for this
 * business, its total, the previous balance carried forward from the ledger,
 * the total due, and the receipts already recorded.
 *
 * `from`/`to` select an older invoice instead, for a payment against one.
 *
 * NOTHING HERE IS TYPED BY THE OPERATOR. The invoice is found, its total is
 * computed, and the previous balance is read from the last stored receipt.
 */
router.get(
  '/business-account/:businessId/payments',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const context = await getPaymentContext(req.params.businessId, {
        from: req.query.from,
        to: req.query.to,
      });
      const receipts = await listReceipts(req.params.businessId);
      sendSuccess(res, { ...context, receipts }, context.message || 'Payment context fetched');
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /api/super-admin/business-account/:businessId/payments
 *   { invoice_period_from, invoice_period_to, payment_date, payment_type,
 *     payment_reference?, payment_received, notes? }
 *
 * Records one payment. The service recomputes the invoice total, the previous
 * balance, the total due and the remaining balance server-side — the request
 * supplies the date, the type, the reference and the amount, and nothing else
 * about the arithmetic is read from it.
 *
 * No order and no invoice is modified: a receipt is a separate record ABOUT an
 * invoice, and an invoice keeps stating what was charged.
 */
router.post(
  '/business-account/:businessId/payments',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const receipt = await recordPayment(
        req.params.businessId,
        req.body ?? {},
        authReq.user!.id
      );
      sendSuccess(res, receipt, 'Payment receipt recorded successfully', 201);
    } catch (error) {
      next(error);
    }
  }
);

/** GET /api/super-admin/business-account/:businessId/payments/:receiptId */
router.get(
  '/business-account/:businessId/payments/:receiptId',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const receipt = await getReceipt(req.params.businessId, req.params.receiptId);
      sendSuccess(res, receipt, 'Receipt fetched successfully');
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/super-admin/business-account/:businessId/payments/:receiptId/receipt.pdf
 *
 * The Billing Receipt. Built on the server from the STORED receipt, so a
 * reprint states the figures as they were when the payment was taken.
 *
 * The file name is `EstablishmentName_InvoiceId.pdf`, with the invoice id
 * shortened to its first 12 characters and the name sanitised for a
 * filesystem — see `billingReceiptFileName`.
 */
router.get(
  '/business-account/:businessId/payments/:receiptId/receipt.pdf',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const document = await buildBillingReceiptDocument(
        req.params.businessId,
        req.params.receiptId
      );
      const pdf = await renderBillingReceiptPdf(document);
      const fileName = billingReceiptFileName(document);

      logger.info(
        `[BillingReceipt] ${document.receipt_number} downloaded by super admin ${authReq.user!.id}`
      );

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      res.setHeader('Content-Length', String(pdf.length));
      res.end(pdf);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/super-admin/business-account/:businessId/invoice-number?from=&to=
 *
 * The shown invoice number for a period, without building the whole invoice.
 * Used where a screen needs the label alone.
 */
router.get(
  '/business-account/:businessId/invoice-number',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const business = await assertBusiness(req.params.businessId);
      const from = asString(req.query.from);
      const to = asString(req.query.to);
      if (!from || !to) throw new AppError('A period is required.', 400);

      const full = `SWC/INV/${String(business.id).padStart(4, '0')}/${from.replace(/-/g, '')}-${to.replace(/-/g, '')}`;
      sendSuccess(
        res,
        { invoice_number: full, invoice_number_display: displayInvoiceNumber(full) },
        'Invoice number fetched'
      );
    } catch (error) {
      next(error);
    }
  }
);

export default router;
