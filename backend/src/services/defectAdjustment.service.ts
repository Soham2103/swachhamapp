import { getClient, query } from '../config/database';
import { AppError } from '../utils/appError';
import { logger } from '../utils/logger';
import { config } from '../config/env';
import { cycleForBusiness, periodFor } from './billingCycle.service';
import { invoiceNumberFor } from './gstInvoice.service';
import {
  sendAdjustmentTemplate,
  sendDefectTemplate,
  toWhatsAppNumber,
  isWhatsAppConfigured,
  uploadMedia,
} from './whatsapp.service';
import { absolutePathForUrl } from '../utils/fileStorage';

/**
 * ===================================================================
 * DEFECTIVE PIECE ADJUSTMENT
 * ===================================================================
 *
 * The Sorter finds damaged pieces while sorting an order. The order must bill
 * for what is usable; the figure it was placed for must stay readable; and
 * nothing already working may change meaning.
 *
 * WHAT MOVES, AND WHAT DOES NOT.
 *
 *   order_items.original_quantity   never touched by an adjustment. The
 *                                   pieces the order was placed for, and the
 *                                   PHYSICAL count -- a damaged towel is
 *                                   still on the shelf and still barcoded.
 *   order_items.defective_quantity  what this adjustment says.
 *   order_items.quantity            original - defective. The BILLABLE count,
 *                                   which is what `quantity` has always meant
 *                                   to every reader in the application.
 *
 * Because `quantity` keeps its meaning, the invoice, the order totals, the
 * weights and the Order Confirmation PDF all follow the adjustment without a
 * line of their own changing. There is no second pricing formula anywhere in
 * this file: the item amount is `unit_price x quantity - discount` and the
 * order total is `subtotal + delivery_charge + tax - coupon_discount`, which
 * is exactly what order creation already computes.
 *
 * WHAT AN ADJUSTMENT DELIBERATELY DOES NOT DO.
 *
 *   status         untouched. An adjustment is not a workflow transition: it
 *                  must not accept, complete, cancel or return an order, and
 *                  nothing here writes `orders.status` or
 *                  `order_status_history`.
 *   garments       untouched. Deleting barcodes for defective pieces would
 *                  invalidate labels already printed and break acceptance
 *                  scanning for pieces that are physically present.
 *   payments,
 *   receipts       untouched. A payment record is history and is never
 *                  rewritten to match a new total, and no row of
 *                  `business_payment_receipts` is read or written here. The
 *                  invoice for the period RECOMPUTES, as it always does when
 *                  the orders in that period change -- see invoicePositionFor
 *                  for why that is reported rather than refused.
 *   rider,
 *   assignment     untouched. Nothing here reads or writes either.
 */

/* ===================================================================
 * ELIGIBILITY
 * =================================================================== */

/**
 * The statuses an order can still be adjusted in.
 *
 * The Sorter's own stages, and only those. Once an order has left the
 * facility the pieces are no longer in hand to be judged, so
 * OUT_FOR_DELIVERY, DELIVERED and COMPLETED are refused -- as is CANCELLED,
 * which has no amount left to adjust.
 *
 * NOTE ON BATCHES. This project has no batch lifecycle: `production_orders`
 * tracks one row PER ORDER through RECEIVED -> ... -> READY_FOR_DELIVERY, and
 * there is no PROPOSED / CONFIRMED / IN_MACHINE batch entity anywhere in the
 * schema. The order's own status is therefore the only lifecycle there is to
 * respect, and it is what is checked here.
 */
const ADJUSTABLE_STATUSES = [
  'ORDER_PLACED',
  'RECEIVED_AT_FACILITY',
  'READY_FOR_DELIVERY',
  // Part of the order is still at the facility, so a damaged piece can still
  // be found in it. Pending and defective are separate things -- an item can
  // be held back without anything being wrong with it -- but an order being
  // partly finished is no reason to refuse an adjustment.
  'PARTIALLY_COMPLETED',
];

/* ===================================================================
 * THE SHAPES
 * =================================================================== */

export interface AdjustmentRecord {
  id: string;
  order_id: string;
  order_item_id: string;
  item_name: string;
  original_quantity: number;
  previous_defective_quantity: number;
  defective_quantity: number;
  final_quantity: number;
  unit_price: number;
  original_amount: number;
  adjusted_amount: number;
  reason: string | null;
  adjusted_by: string | null;
  adjusted_by_name: string | null;
  adjusted_at: Date;
}

export interface AdjustedOrderTotals {
  subtotal: number;
  delivery_charge: number;
  coupon_discount: number;
  tax: number;
  total: number;
  total_weight_kg: number;
}

/**
 * Where the money stands after an adjustment, WITHOUT touching a payment.
 *
 * Three separate figures, never collapsed into one:
 *
 *   order_total     what the order now comes to
 *   amount_paid     what was actually received. History. Never rewritten.
 *   difference      order_total - amount_paid
 *
 * A negative difference is an OVERPAYMENT -- the customer paid for pieces
 * that turned out to be damaged. It is reported and nothing more: no refund
 * is issued, no payment row is edited and `payment_status` is not moved to
 * REFUNDED, because this application has no refund execution path and
 * inventing one silently would be the worst possible way to acquire it. The
 * figure is surfaced so the billing workflow can act on it deliberately.
 */
export interface PaymentPosition {
  payment_status: string;
  order_total: number;
  amount_paid: number;
  /** Positive: still owed. Negative: owed back to the customer. */
  difference: number;
  requires_billing_attention: boolean;
  note: string | null;
  /**
   * For a BUSINESS order: the invoice it falls under and what has been
   * received against that invoice. Null for a customer order, which is not
   * invoiced. See invoicePositionFor for why this reports rather than blocks.
   */
  invoice: InvoicePosition | null;
}

export interface NotificationRecord {
  id: string;
  order_id: string;
  last_adjustment_id: string | null;
  status: 'PENDING' | 'SENT' | 'FAILED';
  sent_to: string | null;
  message_id: string | null;
  error: string | null;
  template_name: string | null;
  sent_by: string | null;
  sent_at: Date | null;
  created_at: Date;
}

const money = (value: unknown) => Math.round(Number(value || 0) * 100) / 100;

/* ===================================================================
 * VALIDATION
 * =================================================================== */

/**
 * The defective quantity, or a 400 that says exactly what was wrong.
 *
 * Integers only. `order_items.quantity` is an INT column and a garment is a
 * physical object -- half a towel is not a quantity -- so `2.5` is refused
 * rather than silently truncated to 2, which would bill a figure nobody
 * asked for.
 */
function parseDefectiveQuantity(value: unknown, originalQuantity: number): number {
  if (value === null || value === undefined || value === '') {
    throw new AppError('A defective quantity is required.', 400);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new AppError('The defective quantity must be a number.', 400);
  }
  if (!Number.isInteger(n)) {
    throw new AppError('The defective quantity must be a whole number of pieces.', 400);
  }
  if (n < 0) {
    throw new AppError('The defective quantity cannot be negative.', 400);
  }
  if (n > originalQuantity) {
    throw new AppError(
      `The defective quantity cannot be more than the ${originalQuantity} piece(s) ordered.`,
      400
    );
  }
  return n;
}

/* ===================================================================
 * THE BILLING POSITION
 * =================================================================== */

export interface InvoicePosition {
  /** The invoice this order falls under, derived from the billing period. */
  invoice_number: string;
  period_from: string;
  period_to: string;
  /** How many payment receipts have been issued against that invoice. */
  receipt_count: number;
  /** The newest of them, for the billing workflow to find. */
  last_receipt_number: string | null;
  /** What has already been received against that invoice. */
  received_against_invoice: number;
}

/**
 * The invoice an order falls under, and what has been paid against it.
 *
 * WHY THIS REPORTS RATHER THAN REFUSES.
 *
 * This application stores no invoices. `gstInvoice.service` COMPUTES one on
 * demand from the orders in a billing period, every time it is asked, so
 * there is no finalised invoice row to protect and no revision to raise.
 * What that means in practice is that an invoice total ALREADY moves after a
 * payment has been recorded against it -- placing one more order into a
 * part-paid period does exactly that -- and the application handles it:
 * `getPaymentContext` recomputes `current_invoice_amount` from the orders and
 * subtracts `already_received`, so the outstanding figure stays correct.
 *
 * A defective adjustment is the same kind of movement in the opposite
 * direction, and refusing it while allowing a new order into the same period
 * would be inconsistent -- and, since a billing period is usually the CURRENT
 * open month, it would block every order a business places for as long as
 * that month lasts.
 *
 * WHAT IS ACTUALLY PROTECTED. The stored receipt. `business_payment_receipts`
 * holds the four figures a printed receipt states, frozen as at the moment
 * the payment was taken, and NOTHING in this service reads or writes that
 * table. The receipt keeps saying what it said; the invoice recomputes, as it
 * always has; and the difference between them surfaces in the payment context
 * the billing screen already draws.
 *
 * So this function throws nothing. It returns what the billing workflow needs
 * to KNOW, and the caller attaches it to the result.
 */
async function invoicePositionFor(orderId: string): Promise<InvoicePosition | null> {
  const context = await query<{ business_id: string; order_date: string }>(
    `SELECT bu.business_id,
            DATE_FORMAT(DATE(CONVERT_TZ(o.created_at, '+00:00', ?)), '%Y-%m-%d') AS order_date
       FROM orders o
       JOIN business_users bu ON bu.id = o.business_user_id
      WHERE o.id = ?`,
    [config.BUSINESS_TZ_OFFSET, orderId]
  );
  const row = context.rows[0];
  // Not a business order: customer orders are not invoiced at all.
  if (!row) return null;

  const cycle = await cycleForBusiness(String(row.business_id));
  const period = periodFor(cycle, String(row.order_date));
  const invoiceNumber = invoiceNumberFor(String(row.business_id), period.from, period.to);

  const receipts = await query<any>(
    `SELECT COUNT(*) AS n,
            COALESCE(SUM(payment_received), 0) AS received,
            (SELECT receipt_number FROM business_payment_receipts
              WHERE business_id = ? AND invoice_number = ?
              ORDER BY created_at DESC, id DESC LIMIT 1) AS last_receipt
       FROM business_payment_receipts
      WHERE business_id = ? AND invoice_number = ?`,
    [row.business_id, invoiceNumber, row.business_id, invoiceNumber]
  );
  const r = receipts.rows[0];

  return {
    invoice_number: invoiceNumber,
    period_from: period.from,
    period_to: period.to,
    receipt_count: Number(r?.n || 0),
    last_receipt_number: r?.last_receipt || null,
    received_against_invoice: money(r?.received),
  };
}

/* ===================================================================
 * RECALCULATION
 * =================================================================== */

/**
 * Re-derives the order's stored totals from its lines, inside the caller's
 * transaction.
 *
 * THE EXISTING FORMULA, and only it:
 *
 *   subtotal         SUM(order_items.total_price)
 *   total_weight_kg  SUM(order_items.total_weight_kg)
 *   total            subtotal + delivery_charge + tax - coupon_discount
 *
 * which is what customer order creation computes
 * (`subtotal + delivery_charge - discount`, with tax defaulting to 0) and
 * what business order creation computes (`total = subtotal`, its other
 * columns all being 0). One expression covers both because the columns a
 * business order does not use are zero in the row.
 *
 * THE DELIVERY CHARGE IS NOT RE-DERIVED. Customer order creation waives it
 * above a spend threshold, so recomputing it here would let a defect that
 * pushed the subtotal back under that threshold ADD a delivery charge -- the
 * customer paying more because we damaged their laundry. The charge that was
 * agreed when the order was placed stays as it is, and so do the coupon
 * discount and the tax, all of which are snapshots of that moment.
 */
async function recalculateOrderTotals(
  connection: any,
  orderId: string
): Promise<AdjustedOrderTotals> {
  const [lines]: any = await connection.execute(
    `SELECT COALESCE(SUM(total_price), 0) AS subtotal,
            COALESCE(SUM(total_weight_kg), 0) AS weight
       FROM order_items WHERE order_id = ?`,
    [orderId]
  );
  const subtotal = money(lines[0].subtotal);
  const weight = Math.round(Number(lines[0].weight || 0) * 1000) / 1000;

  const [orderRows]: any = await connection.execute(
    `SELECT delivery_charge, coupon_discount, tax FROM orders WHERE id = ?`,
    [orderId]
  );
  const order = orderRows[0];
  const deliveryCharge = money(order.delivery_charge);
  const couponDiscount = money(order.coupon_discount);
  const tax = money(order.tax);

  // Clamped at zero: a coupon larger than what is left after an adjustment
  // must not produce a negative payable amount.
  const total = Math.max(0, money(subtotal + deliveryCharge + tax - couponDiscount));

  await connection.execute(
    `UPDATE orders SET subtotal = ?, total = ?, total_weight_kg = ?, updated_at = NOW()
      WHERE id = ?`,
    [subtotal, total, weight, orderId]
  );

  return {
    subtotal,
    delivery_charge: deliveryCharge,
    coupon_discount: couponDiscount,
    tax,
    total,
    total_weight_kg: weight,
  };
}

/* ===================================================================
 * THE ADJUSTMENT
 * =================================================================== */

export interface AdjustResult {
  order_id: string;
  order_number: string;
  item: {
    id: string;
    item_name: string;
    original_quantity: number;
    defective_quantity: number;
    final_quantity: number;
    unit_price: number;
    original_amount: number;
    amount: number;
    weight_kg: number | null;
    total_weight_kg: number | null;
  };
  totals: AdjustedOrderTotals;
  payment: PaymentPosition;
  adjustment: AdjustmentRecord;
}

/**
 * Records a defective quantity against one order line and re-prices the order.
 *
 * ATOMIC. Everything below happens in one transaction: the line, the order
 * totals and the audit row are written together or not at all, so the
 * application can never be left with a reduced quantity beside an unchanged
 * price, or a price nothing explains.
 *
 * CONCURRENCY. The order row and the item row are taken with SELECT ... FOR
 * UPDATE at the start, so a second Sorter editing the same order blocks until
 * this one commits and then reads the COMMITTED figures rather than the ones
 * their screen was showing. The original quantity and the current defective
 * quantity are both re-read inside that lock and the validation runs against
 * what was read, never against anything the client sent -- which is what
 * makes a stale screen unable to overwrite a newer adjustment.
 *
 * IDEMPOTENT IN EFFECT. The new defective quantity REPLACES the old one; it
 * is not added to it. Sending 3 after 2 leaves 3 defective and 7 billable,
 * not 5 defective -- and the audit row records that it moved from 2 to 3.
 */
export async function adjustDefectiveQuantity(params: {
  orderId: string;
  orderItemId: string;
  defectiveQuantity: unknown;
  reason?: string | null;
  sorterUserId: string;
}): Promise<AdjustResult> {
  const connection = await getClient();
  try {
    await connection.beginTransaction();

    // The order first, then the line: always the same order of locks, so two
    // concurrent adjustments on one order queue instead of deadlocking.
    const [orderRows]: any = await connection.execute(
      `SELECT id, order_number, status FROM orders WHERE id = ? FOR UPDATE`,
      [params.orderId]
    );
    const order = orderRows[0];
    if (!order) throw new AppError('Order not found', 404);

    if (!ADJUSTABLE_STATUSES.includes(String(order.status))) {
      throw new AppError(
        `This order is ${String(order.status).replace(/_/g, ' ')} and can no longer be ` +
          'adjusted. Defective pieces can only be recorded while the order is still at the facility.',
        409
      );
    }

    const [itemRows]: any = await connection.execute(
      `SELECT id, service_name, quantity, original_quantity, defective_quantity,
              unit_price, discount, weight_kg
         FROM order_items
        WHERE id = ? AND order_id = ? FOR UPDATE`,
      [params.orderItemId, params.orderId]
    );
    const item = itemRows[0];
    if (!item) throw new AppError('That item is not part of this order.', 404);

    /*
     * THE ORIGINAL QUANTITY, from the row and never from the request.
     *
     * COALESCE because a line written before migration 033 has no
     * `original_quantity` yet; for such a row the current quantity IS the
     * original, since nothing has ever adjusted it.
     */
    const originalQuantity = Number(item.original_quantity ?? item.quantity);
    const previousDefective = Number(item.defective_quantity || 0);
    const defectiveQuantity = parseDefectiveQuantity(params.defectiveQuantity, originalQuantity);
    const finalQuantity = originalQuantity - defectiveQuantity;

    // Belt and braces: the arithmetic above cannot produce this, and if it
    // ever did the order must not be written with a negative quantity.
    if (finalQuantity < 0) {
      throw new AppError('The adjustment would leave a negative quantity.', 400);
    }

    /*
     * THE PRICE COMES FROM THE ORDER LINE. Nothing the Sorter sends can move
     * it: the request carries a quantity and a reason, and this function
     * reads `unit_price` and `discount` off the row that was locked above.
     * An adjustment changes how many pieces are billed, never the rate.
     */
    const unitPrice = money(item.unit_price);
    const lineDiscount = money(item.discount);
    const originalAmount = Math.max(0, money(unitPrice * originalQuantity - lineDiscount));
    const adjustedAmount = Math.max(0, money(unitPrice * finalQuantity - lineDiscount));

    /*
     * WEIGHT FOLLOWS QUANTITY, through the existing rule.
     *
     * Order creation stores `total_weight_kg = ROUND(weight_kg x quantity, 3)`
     * per line, so the same expression is applied to the billable quantity --
     * there is no second weight calculation. A line with no standard weight
     * (customer orders record none) keeps its NULL rather than being given a
     * fabricated zero.
     */
    const perPieceWeight = item.weight_kg === null ? null : Number(item.weight_kg);
    const lineWeight =
      perPieceWeight === null ? null : Math.round(perPieceWeight * finalQuantity * 1000) / 1000;

    await connection.execute(
      `UPDATE order_items
          SET original_quantity = ?, defective_quantity = ?, quantity = ?,
              total_price = ?, total_weight_kg = ?
        WHERE id = ?`,
      [originalQuantity, defectiveQuantity, finalQuantity, adjustedAmount, lineWeight, item.id]
    );

    // The audit row: one per adjustment EVENT. A correction adds a row, it
    // never edits the one before it.
    const [audit]: any = await connection.execute(
      `INSERT INTO order_item_adjustments
         (order_id, order_item_id, original_quantity, previous_defective_quantity,
          defective_quantity, final_quantity, unit_price, original_amount,
          adjusted_amount, reason, adjusted_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        params.orderId, item.id, originalQuantity, previousDefective, defectiveQuantity,
        finalQuantity, unitPrice, originalAmount, adjustedAmount,
        params.reason ? String(params.reason).slice(0, 500) : null,
        params.sorterUserId,
      ]
    );

    const totals = await recalculateOrderTotals(connection, params.orderId);

    await connection.commit();

    logger.info(
      `[DefectAdjustment] order ${order.order_number} line ${item.id} (${item.service_name}): ` +
        `${originalQuantity} ordered, ${defectiveQuantity} defective, ${finalQuantity} billable ` +
        `— line ${originalAmount} -> ${adjustedAmount}, order total ${totals.total} ` +
        `(by user ${params.sorterUserId})`
    );

    const payment = await paymentPositionFor(params.orderId);

    /*
     * SAY SO IN THE LOG when the invoice this order sits on has already been
     * paid against. The adjustment is legitimate and the recomputed invoice
     * will be correct, but somebody's outstanding balance just moved after a
     * receipt was printed, and that should be findable afterwards.
     */
    if (payment.invoice && payment.invoice.receipt_count > 0) {
      logger.warn(
        `[DefectAdjustment] order ${order.order_number} is on invoice ` +
          `${payment.invoice.invoice_number}, which already has ` +
          `${payment.invoice.receipt_count} receipt(s) against it ` +
          `(latest ${payment.invoice.last_receipt_number}). The stored receipts are ` +
          'unchanged; the invoice recomputes, so the outstanding balance has moved.'
      );
    }

    // Read back the row that was just written, so the caller gets the stored
    // record -- including the server-set timestamp and the resolved Sorter
    // name -- rather than a reconstruction of it. The list is newest-first
    // and this is the newest, so the fallback is the right row too.
    const written = await listAdjustmentsForOrder(params.orderId);
    const adjustment =
      written.find((a) => String(a.id) === String(audit.insertId)) || written[0];
    if (!adjustment) {
      throw new AppError('The adjustment was saved but could not be read back.', 500);
    }

    return {
      order_id: String(params.orderId),
      order_number: order.order_number,
      item: {
        id: String(item.id),
        item_name: item.service_name,
        original_quantity: originalQuantity,
        defective_quantity: defectiveQuantity,
        final_quantity: finalQuantity,
        unit_price: unitPrice,
        original_amount: originalAmount,
        amount: adjustedAmount,
        weight_kg: perPieceWeight,
        total_weight_kg: lineWeight,
      },
      totals,
      payment,
      adjustment,
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/* ===================================================================
 * READING BACK
 * =================================================================== */

/** Every adjustment recorded against an order, newest first. */
export async function listAdjustmentsForOrder(orderId: string): Promise<AdjustmentRecord[]> {
  const result = await query<any>(
    `SELECT a.*, oi.service_name AS item_name, u.name AS adjusted_by_name
       FROM order_item_adjustments a
       JOIN order_items oi ON oi.id = a.order_item_id
       LEFT JOIN users u ON u.id = a.adjusted_by
      WHERE a.order_id = ?
      ORDER BY a.adjusted_at DESC, a.id DESC`,
    [orderId]
  );
  return result.rows.map((row: any) => ({
    id: String(row.id),
    order_id: String(row.order_id),
    order_item_id: String(row.order_item_id),
    item_name: row.item_name,
    original_quantity: Number(row.original_quantity),
    previous_defective_quantity: Number(row.previous_defective_quantity),
    defective_quantity: Number(row.defective_quantity),
    final_quantity: Number(row.final_quantity),
    unit_price: money(row.unit_price),
    original_amount: money(row.original_amount),
    adjusted_amount: money(row.adjusted_amount),
    reason: row.reason || null,
    adjusted_by: row.adjusted_by === null ? null : String(row.adjusted_by),
    adjusted_by_name: row.adjusted_by_name || null,
    adjusted_at: row.adjusted_at,
  }));
}

/**
 * Where the money stands, computed and never written.
 *
 * NO PAYMENT RECORD IS TOUCHED HERE OR ANYWHERE IN THIS FILE. `payment_status`
 * keeps saying what actually happened, and the amount received keeps saying
 * what was actually received; only the DIFFERENCE between that and the new
 * order total is reported, for a human to act on.
 */
export async function paymentPositionFor(orderId: string): Promise<PaymentPosition> {
  const result = await query<any>(
    `SELECT o.total, o.payment_status, o.business_user_id FROM orders o WHERE o.id = ?`,
    [orderId]
  );
  const order = result.rows[0];
  if (!order) throw new AppError('Order not found', 404);

  const total = money(order.total);
  const status = String(order.payment_status);

  /*
   * WHAT "PAID" MEANS FOR EACH KIND OF ORDER.
   *
   * A customer order records only a status -- there is no per-order payment
   * ledger -- so PAID is taken at its word: the original total was received.
   * A business order is not paid per order at all; it is invoiced monthly and
   * settled through `business_payment_receipts`, so nothing is "paid" against
   * the order itself and the adjustment simply lands in the next invoice.
   */
  if (order.business_user_id) {
    const invoice = await invoicePositionFor(orderId);
    const paidAgainstInvoice = invoice ? invoice.receipt_count > 0 : false;

    return {
      payment_status: status,
      order_total: total,
      // A business order is not paid individually, so nothing has been paid
      // against THIS order. What has been received sits against the invoice,
      // and is reported there rather than being attributed to one order.
      amount_paid: 0,
      difference: total,
      /*
       * Flagged when the period has already been paid against. The adjustment
       * is allowed and the recomputed invoice is correct -- but a balance
       * moved after a receipt was printed, and that is worth a human seeing.
       */
      requires_billing_attention: paidAgainstInvoice,
      note: paidAgainstInvoice
        ? `This order is on invoice ${invoice!.invoice_number}, which already has ` +
          `${invoice!.receipt_count} payment receipt(s) against it ` +
          `(latest ${invoice!.last_receipt_number}, ${invoice!.received_against_invoice.toFixed(2)} ` +
          'received). Those receipts are unchanged and still state what was paid; the ' +
          'invoice recomputes from the orders, so the outstanding balance has changed. ' +
          'Review it on the Payment Receipt screen.'
        : 'Business orders are settled by invoice, not per order. This adjustment is picked ' +
          'up by the invoice for the period, which is computed from the orders in it.',
      invoice,
    };
  }

  if (status !== 'PAID') {
    return {
      payment_status: status,
      order_total: total,
      amount_paid: 0,
      difference: total,
      requires_billing_attention: false,
      note: null,
      invoice: null,
    };
  }

  /*
   * ALREADY PAID, and the total has moved.
   *
   * The amount received is what the order came to BEFORE this adjustment --
   * the sum of every line's pre-adjustment amount, taken from the audit rows,
   * plus the charges. It is reported beside the new total and the difference
   * between them, and that is all: no refund is issued, no payment row is
   * edited, and `payment_status` is left saying PAID, because it is true.
   */
  const paidResult = await query<any>(
    `SELECT o.delivery_charge, o.coupon_discount, o.tax,
            COALESCE(SUM(
              CASE WHEN first_adj.id IS NULL
                   THEN oi.total_price
                   ELSE first_adj.original_amount END
            ), 0) AS original_subtotal
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
       LEFT JOIN order_item_adjustments first_adj
              ON first_adj.id = (SELECT MIN(a.id) FROM order_item_adjustments a
                                  WHERE a.order_item_id = oi.id)
      WHERE o.id = ?
      GROUP BY o.id, o.delivery_charge, o.coupon_discount, o.tax`,
    [orderId]
  );
  const paidRow = paidResult.rows[0];
  const amountPaid = paidRow
    ? Math.max(
        0,
        money(
          Number(paidRow.original_subtotal) +
            money(paidRow.delivery_charge) +
            money(paidRow.tax) -
            money(paidRow.coupon_discount)
        )
      )
    : total;

  const difference = money(total - amountPaid);
  return {
    payment_status: status,
    order_total: total,
    amount_paid: amountPaid,
    difference,
    requires_billing_attention: difference !== 0,
    note:
      difference < 0
        ? `This order was paid in full before the adjustment. ${Math.abs(difference).toFixed(2)} ` +
          'is now owed back to the customer. No refund has been issued and no payment record ' +
          'has been changed — this needs the billing workflow.'
        : difference > 0
          ? `${difference.toFixed(2)} is still outstanding on this order.`
          : null,
    invoice: null,
  };
}

/* ===================================================================
 * THE WHATSAPP NOTIFICATION
 * =================================================================== */

/** The newest adjustment on an order, or null when there is none. */
async function latestAdjustment(orderId: string): Promise<AdjustmentRecord | null> {
  const all = await listAdjustmentsForOrder(orderId);
  return all[0] || null;
}

function toNotification(row: any): NotificationRecord {
  return {
    id: String(row.id),
    order_id: String(row.order_id),
    last_adjustment_id: row.last_adjustment_id === null ? null : String(row.last_adjustment_id),
    status: row.status,
    sent_to: row.sent_to || null,
    message_id: row.message_id || null,
    error: row.error || null,
    template_name: row.template_name || null,
    sent_by: row.sent_by === null ? null : String(row.sent_by),
    sent_at: row.sent_at || null,
    created_at: row.created_at,
  };
}

/** Every adjustment notification attempted for an order, newest first. */
export async function listNotificationsForOrder(orderId: string): Promise<NotificationRecord[]> {
  const result = await query<any>(
    `SELECT * FROM order_adjustment_notifications
      WHERE order_id = ? ORDER BY created_at DESC, id DESC`,
    [orderId]
  );
  return result.rows.map(toNotification);
}

/**
 * WHO THE MESSAGE GOES TO.
 *
 * For a business order the answer is `orders.placed_by_mobile` -- the number
 * whoever placed the order proved by OTP for that session. A business is
 * reached on several numbers, and if an alternative contact placed the order
 * it is that contact who is waiting to hear about it; sending to the
 * business's primary contact instead would tell the wrong person.
 *
 * The account's own number is used only when the order carries none, which is
 * true exactly of orders placed before that field existed -- for those it is
 * the only number the order has ever been associated with, so it is not a
 * substitution but the same answer arrived at the only way available.
 *
 * For a customer order it is the customer's own number, which is also the
 * number they verified by OTP.
 */
async function resolveRecipient(orderId: string) {
  const result = await query<any>(
    `SELECT o.id, o.order_number, o.total, o.placed_by_mobile,
            COALESCE(NULLIF(TRIM(b.establishment_name), ''), b.name, u.name, 'Customer') AS customer_name,
            COALESCE(o.placed_by_mobile, bu.mobile_number, u.mobile_number) AS contact
       FROM orders o
       LEFT JOIN business_users bu ON bu.id = o.business_user_id
       LEFT JOIN businesses b ON b.id = bu.business_id
       LEFT JOIN users u ON u.id = o.user_id
      WHERE o.id = ?`,
    [orderId]
  );
  const row = result.rows[0];
  if (!row) throw new AppError('Order not found', 404);
  return row;
}

/**
 * Tells the customer or business about the adjustment, over the existing
 * WhatsApp integration.
 *
 * WHICH TEMPLATE, AND WHY IT IS NOT HARDCODED. Meta will only deliver an
 * APPROVED template, and a template's body parameters are fixed at approval
 * time. The one this account has for defects,
 * `defective_piece_notification`, is `Hello {{1}}, we found a defective or
 * damaged piece in your laundry order {{2}}` behind a REQUIRED image header;
 * there is no room in it for quantities or an amount, and no approved
 * template on the account has such fields.
 *
 * So there are two paths, and the configuration decides which:
 *
 *   WHATSAPP_ADJUSTMENT_TEMPLATE set   the full message -- order, item,
 *                                      ordered, defective, final, amount --
 *                                      sent through that template. Configure
 *                                      it once the template is approved.
 *
 *   not set                            the approved defect template, using a
 *                                      defect photo already on file for this
 *                                      order as its header image. The
 *                                      customer is told a damaged piece was
 *                                      found; the figures reach them through
 *                                      the updated order and its documents.
 *
 * When neither is possible the attempt FAILS and says so. It does not invent
 * a template name, and it does not report success for a message Meta never
 * accepted.
 *
 * NO DUPLICATES. A send is refused when a SENT notification already exists
 * for the same latest adjustment, so tapping Send twice cannot message the
 * customer twice. Recording a new defective quantity creates a new adjustment
 * and immediately makes a fresh notification allowed again.
 */
export async function sendAdjustmentNotification(params: {
  orderId: string;
  sorterUserId: string;
  force?: boolean;
}): Promise<NotificationRecord> {
  const adjustment = await latestAdjustment(params.orderId);
  if (!adjustment) {
    throw new AppError(
      'This order has no defective adjustment to notify anyone about.',
      409
    );
  }

  if (!params.force) {
    const already = await query<any>(
      `SELECT id FROM order_adjustment_notifications
        WHERE order_id = ? AND last_adjustment_id = ? AND status = 'SENT' LIMIT 1`,
      [params.orderId, adjustment.id]
    );
    if (already.rows[0]) {
      throw new AppError(
        'The customer has already been notified about this adjustment. Record a new defective ' +
          'quantity if something has changed.',
        409
      );
    }
  }

  const order = await resolveRecipient(params.orderId);
  const to = toWhatsAppNumber(order.contact);

  const record = async (
    result: { ok: boolean; messageId: string | null; error: string | null },
    templateName: string | null
  ) => {
    const inserted = await query<any>(
      `INSERT INTO order_adjustment_notifications
         (order_id, last_adjustment_id, status, sent_to, message_id, error, template_name,
          sent_by, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        params.orderId, adjustment.id, result.ok ? 'SENT' : 'FAILED', to,
        result.messageId, result.error ? String(result.error).slice(0, 500) : null,
        templateName, params.sorterUserId, result.ok ? new Date() : null,
      ]
    );
    const row = await query<any>(
      `SELECT * FROM order_adjustment_notifications WHERE id = ?`,
      [inserted.insertId]
    );
    return toNotification(row.rows[0]);
  };

  if (!to) {
    return record(
      { ok: false, messageId: null, error: 'This order has no valid mobile number to notify.' },
      null
    );
  }
  if (!isWhatsAppConfigured()) {
    return record(
      {
        ok: false,
        messageId: null,
        error:
          'WhatsApp is not configured on the server (WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN).',
      },
      null
    );
  }

  // ---- Path 1: a template built for this message ----
  const adjustmentTemplate = String(config.WHATSAPP_ADJUSTMENT_TEMPLATE || '').trim();
  if (adjustmentTemplate) {
    const result = await sendAdjustmentTemplate({
      to,
      templateName: adjustmentTemplate,
      customerName: order.customer_name,
      orderNumber: order.order_number,
      itemName: adjustment.item_name,
      orderedQuantity: adjustment.original_quantity,
      defectiveQuantity: adjustment.defective_quantity,
      finalQuantity: adjustment.final_quantity,
      updatedAmount: money(order.total),
    });
    return record(result, adjustmentTemplate);
  }

  // ---- Path 2: the approved defect template, with a photo already on file ----
  const photo = await query<any>(
    `SELECT photo_url FROM order_defects
      WHERE order_id = ? ORDER BY reported_at DESC, id DESC LIMIT 1`,
    [params.orderId]
  );
  const photoUrl = photo.rows[0]?.photo_url || null;
  const absolutePath = photoUrl ? absolutePathForUrl(photoUrl) : null;

  if (!absolutePath) {
    return record(
      {
        ok: false,
        messageId: null,
        error:
          'No WhatsApp template is configured for adjustments, and this order has no defect ' +
          'photo to send the approved defect template with. Either report a defect photo for ' +
          'this order, or set WHATSAPP_ADJUSTMENT_TEMPLATE to an approved template.',
      },
      null
    );
  }

  try {
    const mediaId = await uploadMedia(absolutePath, 'image/jpeg');
    const result = await sendDefectTemplate({
      to,
      customerName: order.customer_name,
      orderNumber: order.order_number,
      mediaId,
    });
    return record(result, config.WHATSAPP_DEFECT_TEMPLATE);
  } catch (error: any) {
    return record(
      { ok: false, messageId: null, error: String(error?.message || 'Photo upload failed') },
      config.WHATSAPP_DEFECT_TEMPLATE
    );
  }
}
