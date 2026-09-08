import express, { Router, Request, Response, NextFunction } from 'express';
import {
  listOrders,
  getOrderById,
  updateStatus,
  setItemPendingQuantity,
  getConfirmationPdf,
  savePendingItemCounts,
  PendingItemInput,
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
  statusOf,
  errorOf,
  ROLE_LABEL,
  DEFECT_RECIPIENT_ROLES,
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
import {
  getBatchEligibility,
  optimizeBatches,
  confirmBatches,
  listBatches,
  listMachines,
  getBatchById,
  updateBatchStatus,
  updateMachineStatus,
  getBatchScanStatus,
  scanBatchGarment,
  ConfirmBatchInput,
} from '../services/sorterBatch.service';
import { sendSuccess } from '../utils/response';
import { authenticate, authorize, AuthenticatedRequest } from '../middleware/auth';
import { AppError } from '../utils/appError';
import { logger } from '../utils/logger';

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

/**
 * PATCH /api/sorter/orders/:id/items/:itemId/cloth-counts
 *   { white?: number | null, color?: number | null, socked?: number | null }
 *
 * The cloth counts for ONE LINE of an order, written to `pending_item`. Each
 * line is counted on its own, so this is addressed by item and not by order.
 *
 * Only the fields PRESENT in the body are written, so saving one box leaves
 * the others as they were. Sending a field as null clears that count back to
 * "not counted", which is a different thing from 0.
 *
 * SORTER ONLY, by construction — `authorize('SORTER')` runs at the top of this
 * router, so any other token is refused with 403 before this handler runs.
 *
 * NOTHING FINANCIAL MOVES, and no status changes. Counting a line is a note
 * taken during sorting, not a step in the workflow.
 */
router.patch(
  '/orders/:id/items/:itemId/cloth-counts',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      /*
       * Only keys the client actually sent are forwarded. Building the input
       * this way is what keeps "left out" (don't touch) apart from "sent as
       * null" (clear it) — spreading the body would lose that distinction.
       */
      const body = (req.body ?? {}) as Record<string, unknown>;
      const input: PendingItemInput = {};
      if ('white' in body) input.white = body.white as number | null;
      if ('color' in body) input.color = body.color as number | null;
      if ('socked' in body) input.socked = body.socked as number | null;
      if ('whiteSocked' in body) input.whiteSocked = body.whiteSocked as number | null;
      if ('colorSocked' in body) input.colorSocked = body.colorSocked as number | null;

      const saved = await savePendingItemCounts(req.params.id, req.params.itemId, input);
      sendSuccess(res, saved, `${saved.item_name}: cloth counts saved`);
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
 * True only when Meta accepted every copy it was actually asked to deliver.
 *
 * Every recipient that EXISTS must be SENT. A partial delivery is not a
 * success: the HTTP status has to reflect that something did not reach its
 * recipient, and the per-copy detail in the body says which.
 *
 * A NULL status is not a failure — it means the order has no such recipient
 * (no Manager took it on, no Super Admin has a number on file), and a
 * deployment without one of those roles must not have every defect report
 * report itself as undelivered. The reason is still carried in that copy's
 * error column and shown in the app.
 */
function isFullyDelivered(defect: DefectRecord): boolean {
  return DEFECT_RECIPIENT_ROLES.every((role) => {
    const status = statusOf(defect, role);
    return status === 'SENT' || status === null;
  });
}

/** Names the copies that did not arrive, and why, for the error message. */
function undeliveredSummary(defect: DefectRecord): string {
  const parts: string[] = [];
  for (const role of DEFECT_RECIPIENT_ROLES) {
    const status = statusOf(defect, role);
    if (status === 'SENT' || status === null) continue;
    parts.push(`${ROLE_LABEL[role]}: ${errorOf(defect, role) || 'not sent'}`);
  }
  return parts.join(' | ');
}

/**
 * Records a defect against an order and notifies everyone who needs to know
 * on WhatsApp — the customer, the Manager, the Super Admin and the reporting
 * Sorter.
 *
 * `orderItemId` and `defectiveQuantity` are OPTIONAL and additive: a report
 * that names the line it is about gets that line's item, service type and
 * quantities into the message, and one that does not is still accepted and
 * described against the order as a whole, exactly as before.
 *
 * The photo is stored first, so a WhatsApp failure never loses it: the reply
 * still carries the saved record, with each copy's status telling the app what
 * actually happened.
 */
router.post(
  '/orders/:id/defect',
  defectPhotoBody,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const { photoBase64, mimeType, description, notify, orderItemId, defectiveQuantity } =
        req.body || {};

      if (typeof photoBase64 !== 'string' || photoBase64.length === 0) {
        return next(new AppError('A defect photo is required', 400));
      }

      // Coerced here rather than trusted: the service re-checks that the line
      // belongs to this order, and a non-numeric quantity becomes "not given"
      // instead of reaching the row.
      const quantity = Number(defectiveQuantity);

      const defect = await reportDefect({
        orderId: req.params.id,
        sorterUserId: authReq.user!.id,
        photoBase64,
        mimeType: typeof mimeType === 'string' && mimeType ? mimeType : 'image/jpeg',
        description: typeof description === 'string' ? description.slice(0, 500) : null,
        orderItemId:
          orderItemId === null || orderItemId === undefined || orderItemId === ''
            ? null
            : String(orderItemId),
        defectiveQuantity: Number.isInteger(quantity) && quantity > 0 ? quantity : null,
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
        // The white/colour split, forwarded only when the client sent it.
        // Passing `undefined` through is what keeps the old single-figure
        // body working unchanged — see the service.
        whiteDefectiveQuantity: req.body?.whiteDefectiveQuantity,
        colorDefectiveQuantity: req.body?.colorDefectiveQuantity,
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

/* ===================================================================
 * BATCH PROCESSING
 * ===================================================================
 *
 * ADDED, NOT WOVEN IN. Every route above is untouched: the queue, the
 * approval and rejection transitions, the order detail, the acceptance and
 * delivery scanners, quantity matching, defects and adjustments all behave
 * exactly as they did before this section existed.
 *
 * SORTER ONLY, and not because a button is hidden. `authenticate` and
 * `authorize('SORTER')` are applied once at the top of this router, so START
 * BATCH, REGENERATE and CONFIRM BATCH are closed to a customer, business,
 * rider, manager or super-admin token before any handler here is reached —
 * 401 without a token, 403 with the wrong role. The service then re-checks
 * the business rules (approved, eligible, unbatched, machine available) on
 * locked rows, so the permission check and the data check are independent.
 *
 * WHERE THE WORK HAPPENS. The optimiser runs in the backend and ONLY when
 * `POST /batches/optimize` is called — which is only when the Sorter presses
 * START BATCH or REGENERATE. Nothing here runs on a schedule, on a page load
 * or on a render.
 */

/**
 * GET /api/sorter/batch-eligible-orders
 *
 * What the Sorter sees before pressing START BATCH: how many approved orders
 * and lines are waiting, their total weight, and the three machines with
 * their current status.
 *
 * A READ. It does not optimise anything — opening the screen must not start a
 * calculation.
 */
router.get('/batch-eligible-orders', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await getBatchEligibility();
    sendSuccess(res, result, `${result.approved_orders_ready} approved order(s) ready for batching`);
  } catch (error) {
    next(error);
  }
});

/** The three machines and what each is currently doing. */
router.get('/machines', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const machines = await listMachines();
    sendSuccess(res, machines, 'Machines fetched successfully');
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/sorter/batches/optimize      <- START BATCH, and REGENERATE
 *
 * Runs the optimisation once and returns a PROPOSED distribution.
 *
 * WRITES NOTHING. No batch row, no machine reservation, no order or item
 * status. The Sorter reviews the proposal and either confirms it or does not;
 * a proposal that is never confirmed leaves no trace, which is what makes
 * REGENERATE free to press as often as they like.
 */
router.post('/batches/optimize', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const proposal = await optimizeBatches();
    logger.info(
      `[BatchOptimizer] START BATCH by user ${authReq.user!.id}: ` +
        `${proposal.batches.length} proposed batch(es) from ${proposal.eligible_items} eligible item(s)`
    );
    sendSuccess(
      res,
      proposal,
      proposal.batches.length
        ? `${proposal.batches.length} batch(es) proposed — ` +
            `${proposal.overall_utilization_percentage}% overall utilisation`
        : 'No batch could be proposed from the approved laundry currently waiting'
    );
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/sorter/batches/confirm       <- CONFIRM BATCH
 *   { batches: [{ machineId, orderItemIds: [...] }] }
 *
 * The only call that makes a distribution permanent.
 *
 * The body names machines and order lines and NOTHING ELSE. It cannot state a
 * weight, a washing group, an order status or whether a line is already
 * batched: all of that is re-read from the database inside the transaction,
 * on locked rows. A proposal that has gone stale — an order marked ready, a
 * machine put into maintenance, a line another Sorter batched first — is
 * refused with 409 and the message says to regenerate.
 */
router.post('/batches/confirm', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const raw = req.body?.batches;
    if (!Array.isArray(raw)) {
      return next(new AppError('batches must be an array of { machineId, orderItemIds }.', 400));
    }
    const input: ConfirmBatchInput[] = raw.map((entry: any) => {
      const ids = entry?.orderItemIds ?? entry?.order_item_ids;
      // `lines` carries a piece count per order line, which is what lets one
      // line be split across two drums. `orderItemIds` remains the whole-line
      // shorthand for a caller that is not splitting anything.
      const lines = entry?.lines;
      return {
        machineId: String(entry?.machineId ?? entry?.machine_id ?? ''),
        lines: Array.isArray(lines)
          ? lines.map((line: any) => ({
              orderItemId: String(line?.orderItemId ?? line?.order_item_id ?? ''),
              quantity: Number(line?.quantity),
            }))
          : undefined,
        orderItemIds: Array.isArray(ids) ? ids.map((id: any) => String(id)) : [],
      };
    });

    const result = await confirmBatches(input, authReq.user!.id);
    return sendSuccess(
      res,
      result,
      `${result.batches.length} batch(es) created — ${result.total_weight_kg} kg`,
      201
    );
  } catch (error) {
    return next(error);
  }
});

/** The batches currently on the floor. `?status=` narrows it. */
router.get('/batches', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const batches = await listBatches(status, limit);
    sendSuccess(res, batches, 'Batches fetched successfully');
  } catch (error) {
    next(error);
  }
});

/**
 * Every garment in the batch, with its batch-scan state and the counts.
 *
 * Declared before `/batches/:id` so the literal segment is matched first.
 */
router.get('/batches/:id/scan-status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = await getBatchScanStatus(req.params.id);
    sendSuccess(res, status, 'Batch scan status fetched successfully');
  } catch (error) {
    next(error);
  }
});

/** One batch, with the order lines it contains. */
router.get('/batches/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const batch = await getBatchById(req.params.id);
    sendSuccess(res, batch, 'Batch fetched successfully');
  } catch (error) {
    next(error);
  }
});

/**
 * PATCH /api/sorter/batches/:id/status
 *   { status: 'IN_MACHINE' | 'WASHING' | 'COMPLETED' | 'CANCELLED' }
 *
 * The transition is validated in the service inside a locked transaction, so
 * a crafted request cannot skip a stage or restart a finished batch.
 * COMPLETED and CANCELLED both release the machine; CANCELLED also returns
 * the order lines to the eligible pool.
 */
router.patch('/batches/:id/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const batch = await updateBatchStatus(req.params.id, req.body?.status, authReq.user!.id);
    sendSuccess(res, batch, `Batch ${batch.batch_number} is now ${batch.status}`);
  } catch (error) {
    next(error);
  }
});

/**
 * One barcode against one batch.
 *
 * THE EXISTING SCANNER IS NOT TOUCHED. `/orders/:id/scan/acceptance` and
 * `/orders/:id/scan/delivery` above keep their own counts and their own
 * rules; this adds the batch stage in the SAME `garment_scans` table, with
 * the same one-scan-per-garment-per-stage unique key.
 *
 * Answers ACCEPTED, WRONG BATCH or ALREADY SCANNED, and returns the running
 * counts so the screen never has to add up anything itself.
 */
router.post('/batches/:id/scan', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const result = await scanBatchGarment(req.params.id, req.body?.barcode, authReq.user!.id);
    sendSuccess(res, result, result.message);
  } catch (error) {
    next(error);
  }
});

/**
 * PATCH /api/sorter/machines/:id/status
 *   { status: 'AVAILABLE' | 'IN_USE' | 'MAINTENANCE' | 'OFFLINE' | 'COMPLETED' }
 *
 * A machine still holding a live batch cannot be declared AVAILABLE by hand —
 * that batch has to be completed or cancelled, which frees it properly.
 */
router.patch('/machines/:id/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const machine = await updateMachineStatus(req.params.id, req.body?.status, authReq.user!.id);
    sendSuccess(res, machine, `${machine.name} is now ${machine.status}`);
  } catch (error) {
    next(error);
  }
});

export default router;
