import { query, getClient } from '../config/database';
import { AppError } from '../utils/appError';
import { logger } from '../utils/logger';
import { buildInvoice, displayInvoiceNumber } from './gstInvoice.service';
import { recentPeriodsForBusiness } from './billingCycle.service';

/**
 * ===================================================================
 * PAYMENT RECEIPTS — money received from a business
 * ===================================================================
 *
 * THE FOUR FIGURES, and the one rule that ties them together:
 *
 *   Previous Balance        what was still outstanding before this invoice
 *   Current Invoice Amount  what this invoice itself came to
 *   Total Amount Due        Previous Balance + Current Invoice Amount
 *   Remaining Balance       Total Amount Due - Payment Received
 *
 * The remaining balance of the LAST receipt is the previous balance of the
 * NEXT one, which is how an unpaid amount carries forward. Paying an invoice
 * in full leaves zero and the next invoice starts clean; paying part of it
 * leaves the difference, and it follows the business until it is paid.
 *
 * THE BALANCE IS READ FROM THE LEDGER, NOT FROM A SCREEN. `previousBalanceFor`
 * takes it from the last stored receipt, so a refresh, a second window or a
 * different administrator all compute the same number, and a client that posts
 * its own figure cannot move it.
 *
 * THE ARITHMETIC IS DONE HERE, TWICE OVER. The client shows a running total
 * as the amount is typed, but nothing it sends is trusted: `previous_balance`,
 * `total_amount_due` and `remaining_balance` are all recomputed on the server
 * before the row is written, from the invoice and the ledger.
 *
 * NO ORDER OR INVOICE IS EVER MODIFIED. A receipt is a separate financial
 * record ABOUT an invoice. Recording one does not touch `orders`,
 * `order_items` or any total; an invoice states what was charged, and stays
 * stating it however much has since been paid.
 *
 * INVOICES ARE COMPUTED, NOT STORED. `gstInvoice.service` builds one on demand
 * from the orders in a billing period, so there is no invoices table to
 * reference — the receipt keeps the invoice number as text together with the
 * period it covers, which is what makes the same invoice rebuildable.
 */

const PAYMENT_TYPES = ['CASH', 'CARD', 'UPI', 'NETBANKING'] as const;
export type PaymentType = (typeof PAYMENT_TYPES)[number];

export const PAYMENT_TYPE_OPTIONS: Array<{ value: PaymentType; label: string }> = [
  { value: 'CASH', label: 'Cash' },
  { value: 'CARD', label: 'Card' },
  { value: 'UPI', label: 'UPI' },
  { value: 'NETBANKING', label: 'Netbanking' },
];

/** Money, to two places, as a number. Never a float sum of floats. */
function money(value: unknown): number {
  return Math.round(Number(value || 0) * 100) / 100;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** The business, or a 404. Every entry point starts here. */
async function assertBusiness(businessId: unknown): Promise<{
  id: string;
  name: string;
  establishment_name: string | null;
}> {
  const id = String(businessId ?? '').trim();
  if (!/^\d+$/.test(id)) throw new AppError('A valid business must be selected.', 400);

  const result = await query<{ id: string; name: string; establishment_name: string | null }>(
    `SELECT id, name, establishment_name FROM businesses WHERE id = ?`,
    [id]
  );
  if (!result.rows[0]) throw new AppError('Business not found.', 404);
  return { ...result.rows[0], id: String(result.rows[0].id) };
}

/** The name a business is shown under: the establishment name. */
export function displayBusinessName(row: {
  name?: string | null;
  establishment_name?: string | null;
}): string {
  return text(row.establishment_name) || text(row.name) || 'Business';
}

/* ===================================================================
 * THE LEDGER
 * =================================================================== */

export interface PaymentReceiptRow {
  id: string;
  receipt_number: string;
  business_id: string;
  /** The FULL invoice number, which is the identifier. */
  invoice_number: string;
  /** The first 12 characters, which is what is shown. */
  invoice_number_display: string;
  invoice_period_from: string;
  invoice_period_to: string;
  payment_date: string;
  payment_type: PaymentType;
  payment_reference: string | null;
  previous_balance: number;
  current_invoice_amount: number;
  total_amount_due: number;
  payment_received: number;
  remaining_balance: number;
  notes: string | null;
  created_at: string;
}

const SELECT_RECEIPT = `
  SELECT id, receipt_number, business_id, invoice_number,
         DATE_FORMAT(invoice_period_from, '%Y-%m-%d') AS invoice_period_from,
         DATE_FORMAT(invoice_period_to, '%Y-%m-%d')   AS invoice_period_to,
         DATE_FORMAT(payment_date, '%Y-%m-%d')        AS payment_date,
         payment_type, payment_reference,
         previous_balance, current_invoice_amount, total_amount_due,
         payment_received, remaining_balance, notes, created_at
    FROM business_payment_receipts`;

function toReceipt(row: any): PaymentReceiptRow {
  return {
    ...row,
    id: String(row.id),
    business_id: String(row.business_id),
    invoice_number_display: displayInvoiceNumber(row.invoice_number),
    previous_balance: money(row.previous_balance),
    current_invoice_amount: money(row.current_invoice_amount),
    total_amount_due: money(row.total_amount_due),
    payment_received: money(row.payment_received),
    remaining_balance: money(row.remaining_balance),
  };
}

/**
 * One business's receipts, newest first.
 *
 * SCOPED BY business_id IN THE QUERY, not filtered afterwards, so one
 * business's ledger can never appear in another's.
 */
export async function listReceipts(businessIdInput: unknown): Promise<PaymentReceiptRow[]> {
  const business = await assertBusiness(businessIdInput);
  const result = await query<any>(
    `${SELECT_RECEIPT} WHERE business_id = ? ORDER BY created_at DESC, id DESC LIMIT 300`,
    [business.id]
  );
  return result.rows.map(toReceipt);
}

export async function getReceipt(
  businessIdInput: unknown,
  receiptId: string
): Promise<PaymentReceiptRow> {
  const business = await assertBusiness(businessIdInput);
  const result = await query<any>(`${SELECT_RECEIPT} WHERE id = ? AND business_id = ?`, [
    receiptId,
    business.id,
  ]);
  // Another business's receipt id is a 404, not a 403: the response does not
  // confirm that it exists.
  if (!result.rows[0]) throw new AppError('Receipt not found for this business.', 404);
  return toReceipt(result.rows[0]);
}

/**
 * What this business owed BEFORE the invoice now being paid.
 *
 * Read from the ledger: the `remaining_balance` of the most recent receipt
 * against a DIFFERENT invoice. Zero when there is none, which is the right
 * answer for a business's first invoice.
 *
 * WHY "A DIFFERENT INVOICE" IS THE WHOLE POINT.
 *
 * Previous balance means "carried forward from earlier invoices". Taking it
 * from the latest receipt regardless would bill the CURRENT invoice twice as
 * soon as a second payment were made against it: that receipt's remaining
 * balance already contains this invoice's unpaid part, and adding the invoice
 * total on top counts it again.
 *
 *   invoice 1000, paid 400  ->  remaining 600
 *   a second payment on the SAME invoice:
 *      wrong:  previous 600 + current 1000 = 1600 due   (the invoice, twice)
 *      right:  previous   0 + current 1000 = 1000 due, of which 400 is paid
 *
 * What has already been paid against this invoice is handled separately, by
 * `receivedAgainstInvoice`, and subtracted from the amount due.
 */
export async function previousBalanceFor(
  businessId: string,
  currentInvoiceNumber?: string | null
): Promise<number> {
  const result = await query<{ remaining_balance: string }>(
    `SELECT remaining_balance FROM business_payment_receipts
      WHERE business_id = ? AND (? IS NULL OR invoice_number <> ?)
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [businessId, currentInvoiceNumber ?? null, currentInvoiceNumber ?? null]
  );
  return result.rows[0] ? money(result.rows[0].remaining_balance) : 0;
}

/** How much has already been received against one invoice. */
async function receivedAgainstInvoice(
  businessId: string,
  invoiceNumber: string
): Promise<number> {
  const result = await query<{ total: string }>(
    `SELECT COALESCE(SUM(payment_received), 0) AS total
       FROM business_payment_receipts
      WHERE business_id = ? AND invoice_number = ?`,
    [businessId, invoiceNumber]
  );
  return money(result.rows[0]?.total);
}

/* ===================================================================
 * THE FORM'S STARTING POINT
 * =================================================================== */

export interface PaymentContext {
  business: { id: string; name: string };
  /** Null when the business has no billable orders yet. */
  invoice: {
    invoice_number: string;
    invoice_number_display: string;
    invoice_date: string;
    period: { from: string; to: string; label: string };
    /** The invoice's own grand total. Never modified by a payment. */
    current_invoice_amount: number;
  } | null;
  previous_balance: number;
  total_amount_due: number;
  /** Already received against THIS invoice, across earlier receipts. */
  already_received: number;
  /** What is still outstanding on it. The amount a payment may not exceed. */
  outstanding: number;
  /** The windows this business's own billing cycle defines, for the picker. */
  periods: Array<{ from: string; to: string; label: string; cycle: string }>;
  message?: string;
}

/**
 * Everything the Payment Receipt form opens with.
 *
 * The LATEST invoice by default, so nothing has to be typed: the most recent
 * billing period that actually has orders in it. `from`/`to` override that,
 * for a payment against an older invoice — the existing billing-period list
 * comes back alongside so the screen can offer them.
 *
 * A business with no billable orders is not an error. It comes back with a
 * null invoice and a message, because "there is nothing to invoice yet" is a
 * legitimate state for a newly onboarded business.
 */
export async function getPaymentContext(
  businessIdInput: unknown,
  options: { from?: unknown; to?: unknown } = {}
): Promise<PaymentContext> {
  const business = await assertBusiness(businessIdInput);
  const businessName = displayBusinessName(business);

  const periods = await recentPeriodsForBusiness(business.id, 12);

  const asked = { from: text(options.from), to: text(options.to) };
  /*
   * WHICH INVOICE. An explicit period wins; otherwise the periods are tried
   * newest first and the first one that HAS orders is the latest invoice.
   * `buildInvoice` throws 404 for an empty window, which is what makes it the
   * test for "was there anything to bill".
   */
  const candidates = asked.from && asked.to
    ? [{ from: asked.from, to: asked.to, label: `${asked.from} to ${asked.to}`, cycle: '' }]
    : periods;

  for (const period of candidates) {
    try {
      const invoice = await buildInvoice(business.id, period.from, period.to);
      const current = money(invoice.totals.grand_total);

      // Carried forward from EARLIER invoices only -- see previousBalanceFor.
      const previous_balance = await previousBalanceFor(business.id, invoice.invoice_number);
      // What has already been paid against THIS invoice, so a second payment
      // against it cannot be asked for the whole amount again.
      const already_received = await receivedAgainstInvoice(
        business.id, invoice.invoice_number);
      const total_amount_due = money(previous_balance + current);

      return {
        business: { id: business.id, name: businessName },
        invoice: {
          invoice_number: invoice.invoice_number,
          invoice_number_display: invoice.invoice_number_display,
          invoice_date: invoice.invoice_date,
          period: { from: period.from, to: period.to, label: period.label },
          current_invoice_amount: current,
        },
        previous_balance,
        total_amount_due,
        already_received,
        outstanding: money(total_amount_due - already_received),
        periods,
      };
    } catch (error) {
      // 404 means the window held no billable orders; try the one before it.
      if ((error as AppError)?.statusCode === 404) continue;
      throw error;
    }
  }

  // No invoice to pay against: what is outstanding is whatever the last
  // receipt left, whichever invoice it was against.
  const carried = await previousBalanceFor(business.id);
  return {
    business: { id: business.id, name: businessName },
    invoice: null,
    previous_balance: carried,
    total_amount_due: carried,
    already_received: 0,
    outstanding: carried,
    periods,
    message: asked.from
      ? 'That period has no billable orders for this business.'
      : 'This business has no billable orders yet, so there is no invoice to pay against.',
  };
}

/* ===================================================================
 * RECORDING A PAYMENT
 * =================================================================== */

export interface RecordPaymentInput {
  invoice_period_from?: unknown;
  invoice_period_to?: unknown;
  payment_date?: unknown;
  payment_type?: unknown;
  payment_reference?: unknown;
  payment_received?: unknown;
  notes?: unknown;
  /** Only honoured where the deployment allows paying more than is owed. */
  allow_overpayment?: unknown;
}

function parsePaymentType(value: unknown): PaymentType {
  const type = String(value ?? '').trim().toUpperCase();
  if (!PAYMENT_TYPES.includes(type as PaymentType)) {
    throw new AppError(`Payment type must be one of: ${PAYMENT_TYPES.join(', ')}.`, 400);
  }
  return type as PaymentType;
}

function parseDate(value: unknown, label: string): string {
  const date = text(value);
  if (!date) throw new AppError(`${label} is required.`, 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new AppError(`${label} must be a date in YYYY-MM-DD form.`, 400);
  }
  if (Number.isNaN(new Date(`${date}T00:00:00Z`).getTime())) {
    throw new AppError(`${label} is not a real date.`, 400);
  }
  return date;
}

function parseAmount(value: unknown): number {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new AppError('Payment received amount is required.', 400);
  }
  const amount = Number(value);
  if (!Number.isFinite(amount)) {
    throw new AppError('Payment received amount must be a number.', 400);
  }
  if (amount < 0) {
    throw new AppError('Payment received amount cannot be negative.', 400);
  }
  return money(amount);
}

/** The next receipt number for this business: SWR/<business>/<n>. */
async function nextReceiptNumber(businessId: string): Promise<string> {
  const result = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM business_payment_receipts WHERE business_id = ?`,
    [businessId]
  );
  const sequence = Number(result.rows[0]?.n || 0) + 1;
  return `SWR/${String(businessId).padStart(4, '0')}/${String(sequence).padStart(5, '0')}`;
}

/**
 * Records one payment and returns the receipt.
 *
 * EVERY FIGURE THAT MATTERS IS RECOMPUTED HERE. The invoice total comes from
 * rebuilding the invoice, the previous balance from the ledger, and the total
 * due and remaining balance from those two plus the amount received. Nothing
 * the client sent about any of them is read — the request supplies the date,
 * the type, the reference and the amount, and nothing else.
 *
 * The invoice is rebuilt rather than trusted, which also proves it BELONGS to
 * this business: `buildInvoice` is given the business id, so a period from
 * another business's screen produces this business's invoice or none at all.
 */
export async function recordPayment(
  businessIdInput: unknown,
  input: RecordPaymentInput,
  recordedBy?: string
): Promise<PaymentReceiptRow> {
  const business = await assertBusiness(businessIdInput);

  const paymentDate = parseDate(input.payment_date, 'Payment date');
  const paymentType = parsePaymentType(input.payment_type);
  const received = parseAmount(input.payment_received);

  /*
   * A reference is kept for NETBANKING only. For cash, card and UPI it is
   * written as NULL rather than merely ignored, so a value sent by a client
   * cannot be stored against a payment type that has no such field.
   */
  const reference =
    paymentType === 'NETBANKING' ? text(input.payment_reference).slice(0, 120) || null : null;

  const from = parseDate(input.invoice_period_from, 'Invoice period start');
  const to = parseDate(input.invoice_period_to, 'Invoice period end');
  if (from > to) {
    throw new AppError('The invoice period start must not be after its end.', 400);
  }

  // Rebuilt, not trusted: this is what proves the invoice is this business's
  // and what its total actually is. Throws 404 when the period holds nothing.
  const invoice = await buildInvoice(business.id, from, to);
  const currentInvoiceAmount = money(invoice.totals.grand_total);

  // Carried forward from EARLIER invoices only, so a second payment against
  // this one does not bill it twice.
  const previousBalance = await previousBalanceFor(business.id, invoice.invoice_number);
  const totalAmountDue = money(previousBalance + currentInvoiceAmount);

  const paidAlready = await receivedAgainstInvoice(business.id, invoice.invoice_number);
  const outstanding = money(totalAmountDue - paidAlready);

  const allowOverpayment =
    input.allow_overpayment === true || String(input.allow_overpayment) === 'true';
  if (!allowOverpayment && received > outstanding) {
    throw new AppError(
      `Payment received (${received.toFixed(2)}) is more than the amount due (${outstanding.toFixed(2)}). ` +
        'Record the amount actually received, or split it across invoices.',
      400
    );
  }

  // Everything still owed after this payment: the amount due, less what was
  // already received against this invoice, less what is being received now.
  const remainingBalance = money(totalAmountDue - paidAlready - received);
  const receiptNumber = await nextReceiptNumber(business.id);

  const connection = await getClient();
  let insertedId: string;
  try {
    await connection.beginTransaction();
    const [inserted]: any = await connection.execute(
      `INSERT INTO business_payment_receipts
         (receipt_number, business_id, invoice_number, invoice_period_from, invoice_period_to,
          payment_date, payment_type, payment_reference,
          previous_balance, current_invoice_amount, total_amount_due,
          payment_received, remaining_balance, notes, recorded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        receiptNumber,
        business.id,
        // The FULL invoice number. The 12-character form is a label and is
        // derived for display; storing it would make two invoices for one
        // business indistinguishable in the ledger.
        invoice.invoice_number,
        from,
        to,
        paymentDate,
        paymentType,
        reference,
        previousBalance,
        currentInvoiceAmount,
        totalAmountDue,
        received,
        remainingBalance,
        text(input.notes).slice(0, 500) || null,
        recordedBy ?? null,
      ]
    );
    insertedId = String(inserted.insertId);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  // The figures, never anything about how the payment was authorised.
  logger.info(
    `[PaymentReceipt] ${receiptNumber} for business ${business.id}: received ${received}, ` +
      `due ${totalAmountDue}, remaining ${remainingBalance}`
  );

  return getReceipt(business.id, insertedId);
}
