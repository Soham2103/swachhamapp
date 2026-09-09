import { query } from '../config/database';
import { AppError } from '../utils/appError';
import {
  GstInvoice,
  InvoiceLaundryType,
  displayInvoiceNumber,
  findInvoiceForPeriod,
  invoiceDateFor,
} from './gstInvoice.service';
import { BillingCycle, BILLING_CYCLE_LABELS } from './billingCycle.service';

/**
 * Invoice History — every invoice ever generated for a business, as rows.
 *
 * WHY THIS EXISTS AT ALL. Until migration 043 an invoice was a computation:
 * `gstInvoice.service` read the orders in a period and added them up, and
 * nothing was stored but the number, as loose text on a payment receipt.
 * That is fine for issuing an invoice and wrong for reading an old one back —
 * recomputing reads TODAY's orders and TODAY's prices, so a defective piece
 * adjusted after the fact, a backdated walking order or a price correction
 * would all silently restate a document that has already been sent and
 * possibly already paid.
 *
 * So the AMOUNTS ARE SNAPSHOT at generation time and never recomputed. What
 * this module stores is what the invoice was issued for.
 *
 * THE PDF IS NOT STORED. It is re-rendered on demand from the period held on
 * the row, which costs no storage; the row's own totals are what the history
 * displays, so the list can never disagree with what was issued even if a
 * re-render would.
 *
 * ISOLATION IS STRUCTURAL. Every function here takes a `businessId` and every
 * statement filters on it — the unique key, both indexes and the foreign key
 * are all scoped by business. There is no call in this module that can return
 * one business's invoice under another's id.
 */

/** One row of a business's invoice history, as the API returns it. */
export interface InvoiceHistoryEntry {
  id: string;
  /** The full invoice number — the identifier everything else keys on. */
  invoice_number: string;
  /** The first 12 characters, which is what people are shown. */
  invoice_number_display: string;
  business_id: string;
  /** The establishment name, resolved from the business. */
  business_name: string;
  period_from: string;
  period_to: string;
  billing_cycle: string;
  billing_cycle_label: string;
  /** A readable period, e.g. "August 2026" or "1–7 Sep 2026". */
  period_label: string;
  laundry_type: InvoiceLaundryType | null;
  laundry_type_label: string | null;
  /** The deduction this invoice was issued with, as a percentage. 0 for none. */
  discount_percent: number;
  /**
   * The lines added up BEFORE any deduction — the Sub Total the document
   * prints. Equal to `taxable_amount` on every invoice issued without one.
   */
  subtotal_amount: number;
  /** What the deduction came to in rupees. 0 when there was none. */
  discount_amount: number;
  taxable_amount: number;
  tax_amount: number;
  total_amount: number;
  order_count: number;
  line_count: number;
  status: InvoiceStatus;
  /** Money recorded against this invoice number, from the payment receipts. */
  amount_paid: number;
  /** total_amount - amount_paid, never below zero. */
  amount_due: number;
  /** When this invoice was FIRST issued. Never reset by a re-issue. */
  generated_at: string;
  /**
   * WHEN THE DOCUMENT WAS LAST ACTUALLY PRODUCED — "Last Generated On" on the
   * invoice card, and what the list is ordered by.
   *
   * Equal to `generated_at` until the invoice is regenerated, and moves every
   * time it is. This is the ONLY field that tracks the act of generating;
   * `invoice_date` below is a different date entirely and is deliberately not
   * derived from it.
   */
  last_generated_at: string;
  /**
   * The same moment as a plain calendar date — "Last Generated On" as the card
   * shows it.
   *
   * Sent already reduced to a date rather than left to the app, because
   * `last_generated_at` is a UTC instant: an invoice generated at 9pm IST is
   * 15:30 UTC the same day, but one generated at 2am IST is the PREVIOUS day
   * in UTC, so slicing the ISO string on the client would date it a day early.
   */
  last_generated_on: string;
  /**
   * THE INVOICE DATE: the billing period's last day plus two.
   *
   * A fact about the CYCLE, not about when anyone pressed Generate — so it is
   * derived from `period_to` rather than from either timestamp above, and
   * regenerating the invoice cannot move it. It was `generated_at`'s date,
   * which meant the same invoice was dated differently every time it was
   * produced.
   */
  invoice_date: string;
}

export type InvoiceStatus = 'ISSUED' | 'PART_PAID' | 'PAID' | 'CANCELLED';

const LAUNDRY_TYPE_LABELS: Record<InvoiceLaundryType, string> = {
  hotel: 'Hotel Laundry',
  guest: 'Guest Laundry',
};

/** DATE columns come back as Date objects on some drivers; normalise to YYYY-MM-DD. */
function dateKey(value: unknown): string {
  if (value instanceof Date) {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  return String(value ?? '').slice(0, 10);
}

const money = (value: unknown) => Number(value ?? 0);

/**
 * RECORD an invoice that has just been generated.
 *
 * Called with the invoice `gstInvoice.service` just built, so the figures
 * stored are the very ones the document prints — they are read off the
 * invoice rather than recomputed here, which is what makes the row and the
 * PDF agree by construction.
 *
 * IDEMPOTENT, ON THE BILLING PERIOD. Billing a cycle that already has an
 * invoice UPDATES that row — new orders inside the period are added to the
 * invoice that exists rather than raising a second one, and it keeps its
 * number. The generation timestamp is deliberately NOT reset: an invoice keeps
 * the date it was first issued.
 *
 * "THE SAME INVOICE" IS DECIDED BY `findInvoiceForPeriod`, the same function
 * the number resolver uses. It used to be decided here, independently, by
 * bucketing the period into a month — so the resolver could conclude an
 * invoice was new (and take a fresh number) while this concluded it already
 * existed (and overwrote the old row with that new number). One definition
 * means the number and the row can no longer disagree.
 *
 * Never throws into the caller's path: recording history must not be able to
 * fail an invoice that has otherwise been generated correctly. A failure is
 * logged by the caller and the invoice is still returned.
 */
export async function recordInvoice(
  invoice: GstInvoice,
  options: { cycle?: BillingCycle | null; generatedBy?: string | null } = {}
): Promise<void> {
  const cycle = options.cycle ?? invoice.period.cycle ?? 'MONTHLY';
  const businessId = invoice.customer.id;
  const laundryType = invoice.laundry_type ?? null;

  const existing = await findInvoiceForPeriod(
    businessId,
    invoice.period.from,
    invoice.period.to,
    laundryType
  );
  const existingId: number | null = existing ? existing.id : null;

  if (existingId !== null) {
    /*
     * RE-ISSUING IS A GENERATION, AND THE LIST ORDERS BY IT.
     *
     * `last_generated_at` moves to now; `generated_at` is deliberately NOT
     * touched — that one is the invoice DATE, printed on the document, and an
     * invoice keeps the date it was first issued. But an operator who has this
     * second regenerated an old period expects to find it at the top of the
     * Issued Invoice list, and ordering by the first issue would leave it
     * wherever it was raised months ago. See migration 065.
     */
    await query(
      `UPDATE business_invoices
          SET invoice_number = ?,
              -- The business's own running number, written beside the string
              -- it appears in. COALESCE so a re-issue cannot blank it if the
              -- invoice is ever rebuilt from a path that has no number.
              business_serial = COALESCE(?, business_serial),
              period_from = ?,
              period_to = ?,
              billing_cycle = ?,
              laundry_type = ?,
              discount_percent = ?,
              subtotal_amount = ?,
              taxable_amount = ?,
              tax_amount = ?,
              total_amount = ?,
              order_count = ?,
              line_count = ?,
              generated_by = COALESCE(?, generated_by),
              last_generated_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
      [
        invoice.invoice_number,
        invoice.invoice_serial ?? null,
        invoice.period.from,
        invoice.period.to,
        cycle,
        laundryType,
        invoice.totals?.discount_percent ?? 0,
        // The Sub Total the document printed, stored beside the taxable value
        // it was reduced to — read off the same invoice, never recomputed.
        invoice.totals?.subtotal ?? 0,
        invoice.totals?.taxable_value ?? 0,
        invoice.totals?.total_tax ?? 0,
        invoice.totals?.grand_total ?? 0,
        invoice.orders?.length ?? 0,
        invoice.lines?.length ?? 0,
        options.generatedBy ?? null,
        existingId,
      ]
    );
  } else {
    await query(
      `INSERT INTO business_invoices
         (invoice_number, business_serial, business_id, period_from, period_to,
          billing_cycle, laundry_type, discount_percent, subtotal_amount,
          taxable_amount, tax_amount, total_amount, order_count, line_count,
          generated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        invoice.invoice_number,
        // The running number within this business — the digits in the string
        // above, so the row and the document can never disagree about it.
        invoice.invoice_serial ?? null,
        businessId,
        invoice.period.from,
        invoice.period.to,
        cycle,
        laundryType,
        invoice.totals?.discount_percent ?? 0,
        invoice.totals?.subtotal ?? 0,
        invoice.totals?.taxable_value ?? 0,
        invoice.totals?.total_tax ?? 0,
        invoice.totals?.grand_total ?? 0,
        invoice.orders?.length ?? 0,
        invoice.lines?.length ?? 0,
        options.generatedBy ?? null,
      ]
    );
  }
}

interface InvoiceRow {
  id: number;
  invoice_number: string;
  business_id: number;
  business_name: string | null;
  period_from: unknown;
  period_to: unknown;
  billing_cycle: string;
  laundry_type: InvoiceLaundryType | null;
  discount_percent: string | number | null;
  subtotal_amount: string | number | null;
  taxable_amount: string | number;
  tax_amount: string | number;
  total_amount: string | number;
  order_count: number;
  line_count: number;
  status: InvoiceStatus;
  generated_at: Date | string;
  last_generated_at: Date | string | null;
  amount_paid: string | number | null;
}

/**
 * The SELECT behind both the list and the single lookup.
 *
 * `amount_paid` is summed from `business_payment_receipts` joined on the
 * invoice NUMBER, which is how payments have always been attached to an
 * invoice — see migration 032. Scoped by business_id on both sides so a
 * matching number under a different business cannot contribute.
 */
const SELECT_INVOICE = `
  SELECT i.id, i.invoice_number, i.business_id,
         COALESCE(NULLIF(b.establishment_name, ''), b.name) AS business_name,
         i.period_from, i.period_to, i.billing_cycle, i.laundry_type,
         i.discount_percent, i.subtotal_amount,
         i.taxable_amount, i.tax_amount, i.total_amount,
         i.order_count, i.line_count, i.status, i.generated_at, i.last_generated_at,
         (SELECT COALESCE(SUM(r.payment_received), 0)
            FROM business_payment_receipts r
           WHERE r.business_id = i.business_id
             AND r.invoice_number = i.invoice_number) AS amount_paid
    FROM business_invoices i
    JOIN businesses b ON b.id = i.business_id
`;

/**
 * The stored status, corrected against what has actually been paid.
 *
 * The column carries ISSUED until something says otherwise, and CANCELLED is
 * the one state a human sets. PAID and PART_PAID are DERIVED from the receipts
 * rather than stored, so recording a payment cannot leave an invoice showing
 * the wrong state because a second update was missed.
 */
function resolveStatus(row: InvoiceRow): InvoiceStatus {
  if (row.status === 'CANCELLED') return 'CANCELLED';
  const paid = money(row.amount_paid);
  const total = money(row.total_amount);
  // A hair under, to survive the rounding of a decimal column.
  if (paid >= total - 0.005 && total > 0) return 'PAID';
  if (paid > 0) return 'PART_PAID';
  return 'ISSUED';
}

function toEntry(row: InvoiceRow): InvoiceHistoryEntry {
  const from = dateKey(row.period_from);
  const to = dateKey(row.period_to);
  const total = money(row.total_amount);
  const paid = money(row.amount_paid);
  const cycle = row.billing_cycle as BillingCycle;

  /*
   * THE SUB TOTAL, AS ISSUED — falling back to the taxable value for a row
   * written before the column existed, where the invoice carried no deduction
   * and the two are the same addition.
   *
   * It is never divided back out of the taxable value by the percentage: that
   * would be a second calculation of a figure the invoice already recorded,
   * and the rounding would not survive it.
   */
  const taxable = money(row.taxable_amount);
  const subtotal = money(row.subtotal_amount) || taxable;
  // The deduction, as the difference between the two figures above — the same
  // subtraction the document printed, not a re-application of the percentage.
  const discountAmount = Math.max(0, Number((subtotal - taxable).toFixed(2)));

  return {
    id: String(row.id),
    invoice_number: row.invoice_number,
    invoice_number_display: displayInvoiceNumber(row.invoice_number),
    business_id: String(row.business_id),
    business_name: row.business_name || '',
    period_from: from,
    period_to: to,
    billing_cycle: row.billing_cycle,
    billing_cycle_label: BILLING_CYCLE_LABELS[cycle] ?? row.billing_cycle,
    period_label: `${from} to ${to}`,
    laundry_type: row.laundry_type,
    laundry_type_label: row.laundry_type ? LAUNDRY_TYPE_LABELS[row.laundry_type] : null,
    discount_percent: Number(row.discount_percent || 0),
    subtotal_amount: subtotal,
    discount_amount: discountAmount,
    taxable_amount: taxable,
    tax_amount: money(row.tax_amount),
    total_amount: total,
    order_count: Number(row.order_count || 0),
    line_count: Number(row.line_count || 0),
    status: resolveStatus(row),
    amount_paid: paid,
    amount_due: Math.max(0, Number((total - paid).toFixed(2))),
    generated_at: new Date(row.generated_at).toISOString(),
    last_generated_at: new Date(row.last_generated_at ?? row.generated_at).toISOString(),
    last_generated_on: dateKey(row.last_generated_at ?? row.generated_at),
    // From the PERIOD, through the same function the PDF's date comes from —
    // so the card and the document it opens are always dated identically.
    invoice_date: invoiceDateFor(to),
  };
}

/**
 * ONE BUSINESS'S invoice history, newest first.
 *
 * `businessId` is not optional and is not defaulted: there is no call here
 * that lists every business's invoices together, which is what keeps one
 * business's invoices out of another's history.
 */
export async function listInvoicesForBusiness(
  businessId: string,
  options: { limit?: number; offset?: number } = {}
): Promise<{ invoices: InvoiceHistoryEntry[]; total: number }> {
  const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 200);
  const offset = Math.max(Number(options.offset) || 0, 0);

  /*
   * NEWEST GENERATED FIRST, which is not the same as newest period.
   *
   * It was ordered by `period_to`, so an invoice raised TODAY for an older
   * period — a re-issue, a period billed late, a back-dated walking order
   * tidied up afterwards — landed somewhere down the list, and the invoice the
   * operator had just generated was not the one at the top. The list is a
   * record of what has been ISSUED, so it is ordered by when.
   *
   * `last_generated_at`, not `generated_at`: the latter is the invoice DATE and
   * is never reset, so regenerating an old period would leave it exactly where
   * it was. See migration 065.
   *
   * `id` breaks the tie, because the column has one-second resolution and two
   * invoices — a Hotel and a Guest for the same business — are routinely raised
   * inside the same second. The later row is the later invoice.
   */
  const rows = await query<InvoiceRow>(
    `${SELECT_INVOICE}
     WHERE i.business_id = ?
     ORDER BY i.last_generated_at DESC, i.id DESC`,
    [businessId]
  );

  const entries = rows.rows.map(toEntry);

  const seen = new Map<string, InvoiceHistoryEntry>();
  for (const entry of entries) {
    const cycle = (entry.billing_cycle || 'MONTHLY').toUpperCase();
    const laundry = entry.laundry_type || 'all';
    const fromMonth = entry.period_from.slice(0, 7);
    const fromYear = entry.period_from.slice(0, 4);

    let periodKey = `${fromMonth}`;
    if (cycle === 'QUARTERLY') {
      const m = Number(entry.period_from.slice(5, 7));
      const q = Math.floor((m - 1) / 3) + 1;
      periodKey = `${fromYear}-Q${q}`;
    } else if (cycle === 'HALF_YEARLY') {
      const m = Number(entry.period_from.slice(5, 7));
      const h = m <= 6 ? 1 : 2;
      periodKey = `${fromYear}-H${h}`;
    } else if (cycle === 'YEARLY') {
      periodKey = `${fromYear}`;
    } else if (cycle === 'WEEKLY' || cycle === 'FORTNIGHTLY') {
      periodKey = `${entry.period_from}_${entry.period_to}`;
    }

    /*
     * ONE ROW PER BUSINESS + CYCLE + TYPE + PERIOD, AND IT IS THE FIRST SEEN.
     *
     * The query above already returns the newest-generated invoice first, so
     * the first row for a key IS the latest issue of that invoice — keeping it
     * is what stops a regenerated invoice appearing twice in the list.
     *
     * It used to compare ids and replace, which under the old period ordering
     * could keep one row while the list showed it in another row's position.
     * Insertion order into this map is the order the list is rendered in, so
     * the row kept and the place it appears are now decided by the same thing.
     */
    const uniqueKey = `${entry.business_id}_${cycle}_${laundry}_${periodKey}`;
    if (!seen.has(uniqueKey)) {
      seen.set(uniqueKey, entry);
    }
  }

  const deduplicated = Array.from(seen.values());
  const paginated = deduplicated.slice(offset, offset + limit);

  return {
    invoices: paginated,
    total: deduplicated.length,
  };
}

/**
 * One invoice, by its id, WITHIN a business.
 *
 * Both the id and the business are in the WHERE clause. Passing another
 * business's invoice id returns 404 rather than that business's invoice —
 * which is the difference between a check and a filter.
 */
export async function getInvoiceForBusiness(
  businessId: string,
  invoiceId: string
): Promise<InvoiceHistoryEntry> {
  const rows = await query<InvoiceRow>(
    `${SELECT_INVOICE} WHERE i.business_id = ? AND i.id = ?`,
    [businessId, invoiceId]
  );
  const row = rows.rows[0];
  if (!row) throw new AppError('Invoice not found', 404);
  return toEntry(row);
}
