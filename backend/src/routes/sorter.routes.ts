import express, { Router, Request, Response, NextFunction } from 'express';
import {
  listOrders,
  getOrderById,
  updateStatus,
  setItemPendingQuantity,
  getConfirmationPdf,
} from '../services/sorter.service';
import {
  generateGarmentsForOrder,
  getScanStatus,
  scanGarment,
} from '../services/garment.service';
import {
  reportDefect,
  retryWhatsApp,
  listDefectsForOrder,
  DefectRecord,
} from '../services/defect.service';
import {
  adjustDefectiveQuantity,
  listAdjustmentsForOrder,
  listNotificationsForOrder,
  sendAdjustmentNotification,
  AdjustmentRecord,
  AdjustResult,
} from '../services/defectAdjustment.service';
import { sendSuccess } from '../utils/response';
import { authenticate, authorize, AuthenticatedRequest } from '../middleware/auth';
import { AppError } from '../utils/appError';

/**
 * Sorter endpoints.
 *
 * Every route below sits behind the project's existing authentication and role
 * middleware, applied once at router level: a request without a token is
 * rejected with 401, and a token for any other role — customer, business,
 * admin — with 403. There is no frontend-only check anywhere in this module.
 */
const router = Router();
router.use(authenticate);
router.use(authorize('SORTER'));

// The Sorter queue, plus the counts behind the dashboard cards.
// Optional ?stage=confirmed|accepted|ready narrows the list.
router.get('/orders', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const stage = typeof req.query.stage === 'string' ? req.query.stage : undefined;
    // Two ways to narrow to a single day, both filtered in SQL:
    //   ?scope=today        -> the server resolves the business day itself
    //   ?date=YYYY-MM-DD    -> Request History, for the day the sorter picked
    // scope=today wins if both are sent, so "today" can never be spoofed by
    // a stale or wrongly-set device clock.
    const today = req.query.scope === 'today';
    const date = typeof req.query.date === 'string' && req.query.date ? req.query.date : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const result = await listOrders(stage, { date, today, limit });
    sendSuccess(res, result, 'Sorter orders fetched successfully');
  } catch (error) {
    next(error);
  }
});

router.get('/orders/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const order = await getOrderById(req.params.id);
    sendSuccess(res, order, 'Order fetched successfully');
  } catch (error) {
    next(error);
  }
});

/**
 * Moves the order one step. The transition itself is validated in the
 * service, inside a locked transaction, so a crafted request cannot skip a
 * stage or walk the workflow backwards.
 *
 * THE PENDING ANSWER travels with the `ready` step, and it is a list of
 * QUANTITIES, not a list of items:
 *
 *   { status: 'ready' }
 *       the question was not asked. No quantity is touched and the order
 *       completes exactly as it always has. Every existing caller sends this
 *       and is unaffected.
 *
 *   { status: 'ready', pendingItems: [] }
 *       "No" -- nothing is held and every piece goes out.
 *
 *   { status: 'ready',
 *     pendingItems: [{ orderItemId: 181, pendingQuantity: 2 }],
 *     pendingReason: 'Needs re-wash' }
 *       "Yes" -- TWO PIECES of line 181 stay. The other three pieces of that
 *       line, and every piece of every other line, go out.
 *
 * A LINE NOT MENTIONED HOLDS NOTHING. Saying two bedsheets are pending says
 * nothing about the towels, so all the towels go. Marking the whole order
 * pending because the Sorter answered "yes" is the fault this shape fixes.
 *
 * `deliveryQuantity` is NOT accepted from the client. The server computes it
 * as `ordered - pending` from the locked row, so a request cannot decide how
 * much of an order ships.
 */
router.patch('/orders/:id/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;

    // `undefined` and `[]` mean different things -- see above -- so the
    // absence of the field is preserved rather than defaulted to an empty
    // array.
    const raw = req.body?.pendingItems;
    if (raw !== undefined && !Array.isArray(raw)) {
      return next(new AppError(
        'pendingItems must be an array of { orderItemId, pendingQuantity }.', 400));
    }
    const pending =
      raw === undefined
        ? undefined
        : {
            items: raw.map((entry: any) => ({
              orderItemId: String(entry?.orderItemId ?? entry?.order_item_id ?? ''),
              // Passed through as-is: the service validates it against the
              // quantity it reads from the locked row, never against anything
              // stated in the request.
              pendingQuantity: entry?.pendingQuantity ?? entry?.pending_quantity,
            })),
            reason:
              typeof req.body?.pendingReason === 'string'
                ? req.body.pendingReason.slice(0, 500)
                : null,
          };

    const result = await updateStatus(
      req.params.id, req.body?.status, authReq.user!.id, pending
    );
    return sendSuccess(
      res,
      result,
      result.pending_quantity > 0
        ? `${result.delivery_quantity} piece(s) out for delivery, ` +
          `${result.pending_quantity} held pending`
        : `Order marked ${result.stage}`
    );
  } catch (error) {
    return next(error);
  }
});

/**
 * PATCH /api/sorter/orders/:id/items/:itemId/pending
 *   { pendingQuantity: 0, reason?: string }
 *
 * How many pieces of ONE line are being held. The later half of the workflow
 * is `pendingQuantity: 0` -- the Sorter has finished the held pieces, so the
 * whole line goes with the next dispatch and the order returns to
 * READY_FOR_DELIVERY once nothing anywhere on it is held.
 *
 * It REPLACES rather than accumulates: sending 2 after 3 leaves 2 held.
 *
 * SORTER ONLY, by construction -- `authorize('SORTER')` runs at the top of
 * this router, so a customer or business token is refused with 403 before
 * this handler is reached. Nothing here is hidden by the UI alone.
 *
 * NOTHING FINANCIAL MOVES. Holding pieces back or releasing them does not
 * touch price, billed quantity, invoice or payment: that is what separates
 * PENDING from a defective adjustment.
 */
router.patch(
  '/orders/:id/items/:itemId/pending',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const result = await setItemPendingQuantity(
        req.params.id,
        req.params.itemId,
        req.body?.pendingQuantity,
        authReq.user!.id,
        typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 500) : null
      );
      sendSuccess(
        res,
        result,
        result.item.pending_quantity > 0
          ? `${result.item.item_name}: ${result.item.pending_quantity} of ` +
            `${result.item.ordered_quantity} held pending`
          : `${result.item.item_name} is ready — all ${result.item.ordered_quantity} piece(s)`
      );
    } catch (error) {
      next(error);
    }
  }
);

// The order's confirmation document: the stored reference when there is one,
// otherwise the order detail the shared PDF template renders from.
router.get('/orders/:id/pdf', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await getConfirmationPdf(req.params.id);
    sendSuccess(res, result, 'Confirmation document fetched successfully');
  } catch (error) {
    next(error);
  }
});

// ---- Garment barcodes and scan verification ----

/**
 * The garment list for an order, with each piece's scan state and the counts
 * for both stages. This is what the scanner screen polls.
 */
router.get('/orders/:id/scan-status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = await getScanStatus(req.params.id);
    sendSuccess(res, status, 'Scan status fetched successfully');
  } catch (error) {
    next(error);
  }
});

router.get('/orders/:id/garments', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = await getScanStatus(req.params.id);
    sendSuccess(res, status.garments, 'Garments fetched successfully');
  } catch (error) {
    next(error);
  }
});

/**
 * Issues one barcode per physical piece. Idempotent — an order that already
 * has garments keeps the barcodes it was given, so labels stay valid.
 */
router.post('/orders/:id/garments/generate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const created = await generateGarmentsForOrder(req.params.id);
    const status = await getScanStatus(req.params.id);
    sendSuccess(res, { created, ...status }, created ? `${created} garment barcode(s) generated` : 'Garments already generated');
  } catch (error) {
    next(error);
  }
});

/**
 * Acceptance and delivery scanning. Both validate the barcode against the
 * order, reject duplicates, and return the running counts — the counting is a
 * COUNT over the scan table, never an increment the client can inflate.
 */
router.post('/orders/:id/scan/acceptance', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const result = await scanGarment(req.params.id, req.body?.barcode, 'ACCEPTANCE', authReq.user!.id);
    sendSuccess(res, result, result.message);
  } catch (error) {
    next(error);
  }
});

router.post('/orders/:id/scan/delivery', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const result = await scanGarment(req.params.id, req.body?.barcode, 'DELIVERY', authReq.user!.id);
    sendSuccess(res, result, result.message);
  } catch (error) {
    next(error);
  }
});

/* ===================================================================
 * NO PRICE LEAVES A SORTER ENDPOINT
 * ===================================================================
 *
 * The service still calculates everything — the line amount before and after,
 * the order subtotal and total, the weights, the payment position — and still
 * stores it. Section 22 of the requirement is explicit that the billing logic
 * stays; what changes is only who gets to SEE it.
 *
 * The stripping happens HERE, in the payload, and not in the app. A field
 * hidden by React is still in the JSON for anyone who opens a network tab, so
 * these two functions build the object that is actually sent and the
 * financial fields are simply never in it.
 *
 * The Sorter cannot change a price either: `adjustDefectiveQuantity` reads
 * `unit_price` off the locked order row and ignores anything the request says
 * about money, so removing it from the response removes information and no
 * capability.
 */

/** An adjustment record with its money removed. */
function stripAdjustmentMoney(a: AdjustmentRecord) {
  return {
    id: a.id,
    order_id: a.order_id,
    order_item_id: a.order_item_id,
    item_name: a.item_name,
    original_quantity: a.original_quantity,
    previous_defective_quantity: a.previous_defective_quantity,
    defective_quantity: a.defective_quantity,
    final_quantity: a.final_quantity,
    reason: a.reason,
    adjusted_by: a.adjusted_by,
    adjusted_by_name: a.adjusted_by_name,
    adjusted_at: a.adjusted_at,
  };
}

/**
 * What the Sorter gets back after saving a defective quantity: the pieces,
 * and nothing about what they are worth. No unit_price, no amounts, no order
 * totals and no payment position.
 */
function toSorterView(result: AdjustResult) {
  return {
    order_id: result.order_id,
    order_number: result.order_number,
    item: {
      id: result.item.id,
      item_name: result.item.item_name,
      original_quantity: result.item.original_quantity,
      defective_quantity: result.item.defective_quantity,
      final_quantity: result.item.final_quantity,
      weight_kg: result.item.weight_kg,
      total_weight_kg: result.item.total_weight_kg,
    },
    adjustment: stripAdjustmentMoney(result.adjustment),
  };
}

// ---- Defective-piece reporting ----

/**
 * A photo is JSON base64 rather than multipart, so no upload dependency is
 * added. The body limit is raised on this route alone — every other route
 * keeps the app-wide default.
 */
const defectPhotoBody = express.json({ limit: '12mb' });

/**
 * True only when Meta accepted every copy of the notification.
 *
 * Both recipients must be SENT. A partial delivery is not a success: the
 * HTTP status has to reflect that something did not reach its recipient,
 * and the per-copy detail in the body says which.
 */
function isFullyDelivered(defect: DefectRecord): boolean {
  return defect.whatsapp_status === 'SENT' && defect.sorter_whatsapp_status === 'SENT';
}

/** Names the copies that did not arrive, and why, for the error message. */
function undeliveredSummary(defect: DefectRecord): string {
  const parts: string[] = [];
  if (defect.whatsapp_status !== 'SENT') {
    parts.push(`Customer: ${defect.whatsapp_error || 'not sent'}`);
  }
  if (defect.sorter_whatsapp_status !== 'SENT') {
    parts.push(`Sorter: ${defect.sorter_whatsapp_error || 'not sent'}`);
  }
  return parts.join(' | ');
}

/**
 * Records a defect against an order and notifies the customer on WhatsApp.
 *
 * The photo is stored first, so a WhatsApp failure never loses it: the reply
 * still carries the saved record, with whatsapp_status telling the app what
 * actually happened.
 */
router.post(
  '/orders/:id/defect',
  defectPhotoBody,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const { photoBase64, mimeType, description, notify } = req.body || {};

      if (typeof photoBase64 !== 'string' || photoBase64.length === 0) {
        return next(new AppError('A defect photo is required', 400));
      }

      const defect = await reportDefect({
        orderId: req.params.id,
        sorterUserId: authReq.user!.id,
        photoBase64,
        mimeType: typeof mimeType === 'string' && mimeType ? mimeType : 'image/jpeg',
        description: typeof description === 'string' ? description.slice(0, 500) : null,
        notify: notify !== false,
      });

      if (isFullyDelivered(defect)) {
        return sendSuccess(res, defect, 'Defect reported and sent on WhatsApp', 201);
      }

      // Meta did not accept every copy, so this must not read as a success.
      // The saved record still comes back in `data`: the photo is stored and
      // the client's next step is the retry endpoint, never a second POST
      // here — repeating this call would file a duplicate defect.
      return res.status(502).json({
        success: false,
        message: `Defect photo saved, but WhatsApp did not go through. ${undeliveredSummary(defect)}`,
        data: defect,
      });
    } catch (error) {
      return next(error);
    }
  }
);

/** Every defect recorded against one order. */
router.get('/orders/:id/defects', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const defects = await listDefectsForOrder(req.params.id);
    sendSuccess(res, defects, 'Defects fetched successfully');
  } catch (error) {
    next(error);
  }
});

/**
 * Retries a notification that failed.
 *
 * A defect Meta already accepted is refused with 409 unless ?force=true, so a
 * stray tap cannot message the customer a second time.
 */
router.post(
  '/orders/:id/defects/:defectId/whatsapp',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const force = req.query.force === 'true' || req.body?.force === true;
      const defect = await retryWhatsApp(req.params.defectId, { force });

      if (isFullyDelivered(defect)) {
        return sendSuccess(res, defect, 'Sent on WhatsApp');
      }

      // Sending is the only job of this endpoint, so a copy Meta refused is a
      // failed request — 200 here would be a lie to every log and monitor.
      return res.status(502).json({
        success: false,
        message: `WhatsApp notification failed. ${undeliveredSummary(defect)}`,
        data: defect,
      });
    } catch (error) {
      return next(error);
    }
  }
);

/* ===================================================================
 * DEFECTIVE PIECE ADJUSTMENT
 *
 * SORTER ONLY, and enforced HERE. `authorize('SORTER')` is applied once at
 * the top of this router, so every route below is closed to customers,
 * businesses and riders by construction — a customer's token cannot reach
 * these endpoints whatever the app chooses to render. Super Admin reads the
 * adjustment through its own Business Account routes and has no write path
 * to it at all.
 * =================================================================== */

/**
 * PATCH /api/sorter/orders/:id/items/:itemId/defective
 *   { defectiveQuantity: 2, reason?: "Damaged" }
 *
 * Records the defective quantity for ONE line and re-prices the order. The
 * new quantity REPLACES the previous one rather than adding to it, so a
 * correction from 2 to 3 leaves 3 defective — see the service.
 *
 * The body carries a quantity and a reason and nothing else. The price is
 * read from the order line inside the transaction, so no request can change
 * what an item costs.
 */
router.patch(
  '/orders/:id/items/:itemId/defective',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const result = await adjustDefectiveQuantity({
        orderId: req.params.id,
        orderItemId: req.params.itemId,
        defectiveQuantity: req.body?.defectiveQuantity,
        reason: typeof req.body?.reason === 'string' ? req.body.reason : null,
        sorterUserId: authReq.user!.id,
      });
      // The service computed the amounts, the order total and the payment
      // position, and stored them — see below for why none of that comes back.
      sendSuccess(res, toSorterView(result), 'Defective quantity saved');
    } catch (error) {
      next(error);
    }
  }
);

/** Every adjustment recorded against one order, newest first. */
router.get('/orders/:id/adjustments', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const [adjustments, notifications] = await Promise.all([
      listAdjustmentsForOrder(req.params.id),
      listNotificationsForOrder(req.params.id),
    ]);
    // No payment position and no amounts: see toSorterView.
    sendSuccess(
      res,
      { adjustments: adjustments.map(stripAdjustmentMoney), notifications },
      'Adjustments fetched successfully'
    );
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/sorter/orders/:id/defective-notification
 *
 * Tells the customer or business about the adjustment, as a SEPARATE action:
 * saving a defective quantity never sends anything, so correcting a figure
 * three times does not send three messages.
 *
 * A second send for the SAME adjustment is refused with 409. Recording a new
 * defective quantity supersedes it and makes a fresh notification allowed
 * again — which is exactly the case where the customer does need telling.
 */
router.post(
  '/orders/:id/defective-notification',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const notification = await sendAdjustmentNotification({
        orderId: req.params.id,
        sorterUserId: authReq.user!.id,
        force: req.query.force === 'true' || req.body?.force === true,
      });

      if (notification.status === 'SENT') {
        return sendSuccess(res, notification, 'Sent on WhatsApp');
      }

      // Sending is this endpoint's only job, so a message Meta refused is a
      // failed request — 200 here would be a lie to every log and monitor.
      // The record still comes back so the app can show the real reason.
      return res.status(502).json({
        success: false,
        message: `WhatsApp notification failed. ${notification.error || 'not sent'}`,
        data: notification,
      });
    } catch (error) {
      return next(error);
    }
  }
);

export default router;
