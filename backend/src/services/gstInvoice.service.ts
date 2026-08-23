import { query } from '../config/database';
import { config } from '../config/env';
import { AppError } from '../utils/appError';
import { logger } from '../utils/logger';
import { periodForBusiness, BillingCycle } from './billingCycle.service';

/**
 * Business-wise GST invoices.
 *
 * Everything here is computed on the server from rows that already exist:
 * the business, its orders in the chosen window, and the line prices those
 * orders were placed at. Nothing is read from the request except the business
 * id and the two dates, so no amount can be influenced from the app.
 *
 * Prices come from `order_items.unit_price` / `total_price`, which are the
 * snapshot taken when the order was placed. That is deliberately not the live
 * catalogue price: an invoice has to show what was charged at the time, even
 * if the price list has moved since.
 *
 * THE PERIOD COMES FROM THE BUSINESS'S BILLING CYCLE. Calling with no dates
 * bills the current period for that business's own cycle — monthly,
 * fortnightly, quarterly, half-yearly or yearly — read from the database.
 * A cycle sent by the client is never consulted. Explicit dates are still
 * accepted for an ad-hoc statement, which is what the date pickers use.
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export interface InvoiceLine {
  description: string;
  /** The laundry service for the line, when the order recorded one. */
  service: string | null;
  /** "Hotel Laundry" / "Guest Laundry" — the rate the line was billed at. */
  laundry_type: string | null;
  /** The BILLABLE quantity — what this line is charged for. */
  quantity: number;
  /**
   * The pieces ORDERED, before any defective adjustment.
   *
   * Equal to `quantity` unless a Sorter found damaged pieces on one of the
   * orders behind this line. Carried so the invoice can show the adjustment
   * rather than only its result — a line that silently bills 8 of 10 invites
   * exactly the query this field answers.
   */
  ordered_quantity: number;
  /** Pieces found defective and therefore NOT billed. 0 on most lines. */
  defective_quantity: number;
  unit: string;
  /** Price per unit, exclusive of tax — the "Price/ unit" column. */
  rate: number;
  /** Quantity x rate, before tax. */
  taxable: number;
  /** Tax on this line, the figure the "GST" column shows. */
  gst_amount: number;
  /** Taxable + tax: the "Amount" column, which is tax-inclusive. */
  amount: number;
}

export interface InvoiceOrderRef {
  order_number: string;
  placed_on: string;
  amount: number;
}

/**
 * THE invoice number for a business and a period.
 *
 * Pure, and derived entirely from its inputs -- which is what makes an
 * invoice number stable: regenerating the same period's invoice produces the
 * same number rather than minting a new one, and anything that needs to NAME
 * the invoice an order falls under can work it out without building the
 * invoice.
 *
 * One definition, so the invoice, its PDF, the payment receipt and the Order
 * Detail list cannot end up spelling the same invoice differently.
 */
export function invoiceNumberFor(businessId: string, from: string, to: string): string {
  return `SWC/INV/${String(businessId).padStart(4, '0')}/${from.replace(/-/g, '')}-${to.replace(/-/g, '')}`;
}

/** How many characters of the invoice number are shown to people. */
export const INVOICE_NUMBER_DISPLAY_LENGTH = 12;

/**
 * The invoice number as it is SHOWN: the first 12 characters.
 *
 * One function, so the invoice screen, the invoice PDF, the billing receipt
 * and its file name cannot end up showing different numbers for one invoice.
 *
 * IT SHORTENS, IT DOES NOT REPLACE. The full number stays on the invoice
 * object, in the log line, in the stored payment receipt and in the downloaded
 * invoice's file name, because it is the identifier; this is a label.
 *
 * IT IS NOT UNIQUE, AND NOTHING MAY KEY ON IT. Twelve characters of the
 * current format -- `SWC/INV/0025/20260801-20260831` -- is `SWC/INV/0025`,
 * which every invoice for business 25 shares whatever period it covers. Two
 * invoices for the same business therefore display identically; a lookup, a
 * payment record or a file name that used this instead of the full number
 * would collide immediately, which is why every one of them stores the full
 * one.
 */
export function displayInvoiceNumber(invoiceNumber: string): string {
  return String(invoiceNumber ?? '').slice(0, INVOICE_NUMBER_DISPLAY_LENGTH);
}

export interface GstInvoice {
  /**
   * The FULL invoice number. Unique per business and period, and the only
   * value anything internal should key on -- the log line, the file name, and
   * any future lookup.
   */
  invoice_number: string;
  /**
   * The SHORT form shown to people: the first 10 characters of the full one.
   *
   * It is a display string and nothing else. It is deliberately NOT unique --
   * ten characters of `SWC/INV/0025/20260801-20260831` is `SWC/INV/00`, which
   * every business shares -- so nothing may look an invoice up by it, and
   * `invoice_number` above stays the identifier.
   */
  invoice_number_display: string;
  invoice_date: string;
  period: {
    from: string;
    to: string;
    /** The cycle the period was derived from, when it was. */
    cycle?: BillingCycle;
    /** e.g. "August 2026", "1-14 Aug 2026", "Q3 2026". */
    label?: string;
  };

  supplier: {
    legal_name: string;
    gstin: string | null;
    state: string;
    address: string;
    email: string | null;
    phone: string | null;
    bank_name: string | null;
    bank_account: string | null;
    bank_ifsc: string | null;
    bank_holder: string | null;
    terms: string | null;
  };

  customer: {
    id: string;
    name: string;
    legal_name: string | null;
    gstin: string | null;
    address: string | null;
    city: string | null;
    state: string | null;
    pincode: string | null;
  };

  lines: InvoiceLine[];
  orders: InvoiceOrderRef[];

  totals: {
    taxable_value: number;
    gst_rate: number;
    /** Set for an intra-state supply; zero otherwise. */
    cgst: number;
    sgst: number;
    /** Set for an inter-state supply; zero otherwise. */
    igst: number;
    total_tax: number;
    grand_total: number;
    /** True when supplier and customer are in the same state. */
    intra_state: boolean;
    /** The grand total spelled out, as the reference invoice prints it. */
    amount_in_words: string;
  };
}

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen',
  'Eighteen', 'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

/** 0-99 in words. */
function twoDigits(n: number): string {
  if (n < 20) return ONES[n];
  const tens = TENS[Math.floor(n / 10)];
  const ones = ONES[n % 10];
  return ones ? `${tens} ${ones}` : tens;
}

/** A whole number in the Indian scale: crore, lakh, thousand, hundred. */
function wholeInWords(n: number): string {
  if (n === 0) return 'Zero';
  const parts: string[] = [];
  const push = (value: number, label: string) => {
    if (value > 0) parts.push(`${twoDigits(value)} ${label}`);
  };
  push(Math.floor(n / 10000000), 'Crore');
  push(Math.floor((n % 10000000) / 100000), 'Lakh');
  push(Math.floor((n % 100000) / 1000), 'Thousand');
  push(Math.floor((n % 1000) / 100), 'Hundred');

  const rest = n % 100;
  if (rest > 0) {
    // "Two Thousand and Thirty", the way the reference invoice reads.
    parts.push(parts.length ? `and ${twoDigits(rest)}` : twoDigits(rest));
  }
  return parts.join(' ');
}

/**
 * "2030.78" -> "Two Thousand and Thirty Rupees and Seventy Eight Paisa only",
 * which is the wording the reference invoice prints.
 */
export function amountInWords(amount: number): string {
  const rupees = Math.floor(amount);
  const paise = Math.round((amount - rupees) * 100);
  const head = `${wholeInWords(rupees)} Rupees`;
  return paise > 0 ? `${head} and ${twoDigits(paise)} Paisa only` : `${head} only`;
}

/** Rounds to paise, so the parts always add up to the total shown. */
function money(value: number): number {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function requireDate(value: unknown, label: string): string {
  const date = typeof value === 'string' ? value.trim() : '';
  if (!date || !DATE_ONLY.test(date)) {
    throw new AppError(`${label} must be a date in YYYY-MM-DD format.`, 400);
  }
  return date;
}

/**
 * Normalises a state for comparison: "Maharashtra", "maharashtra" and
 * "27-Maharashtra" (the code the GST lookup returns) all have to match.
 */
function stateKey(value: string | null | undefined): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
}

/**
 * Builds the invoice for one business over one date range.
 *
 * The range is compared as calendar dates in the business timezone, so an
 * order placed at 11pm IST on the last day of the window is inside it rather
 * than falling into the next UTC day.
 */
export async function buildInvoice(
  businessId: string,
  fromDate?: unknown,
  toDate?: unknown
): Promise<GstInvoice> {
  /*
   * Two ways in.
   *
   * With both dates: an ad-hoc statement for exactly that range, which is
   * what the date pickers produce.
   *
   * With neither: the business's CURRENT billing period, derived from the
   * cycle stored against it. `onDate` may be given instead to bill the period
   * containing some other day — that is how a past period is re-issued.
   */
  const explicit =
    (typeof fromDate === 'string' && fromDate.trim() !== '') ||
    (typeof toDate === 'string' && toDate.trim() !== '');

  let from: string;
  let to: string;
  let cycle: BillingCycle | undefined;
  let periodLabel: string | undefined;

  if (explicit) {
    from = requireDate(fromDate, 'From date');
    to = requireDate(toDate, 'To date');
  } else {
    const period = await periodForBusiness(businessId, undefined);
    from = period.from;
    to = period.to;
    cycle = period.cycle;
    periodLabel = period.label;
  }

  if (from > to) {
    throw new AppError('From date cannot be after To date.', 400);
  }

  const businessResult = await query<any>(
    `SELECT id, name, establishment_name, legal_name, trade_name, gst_number, gst_status,
            address, establishment_address, city, state, pincode
       FROM businesses WHERE id = ?`,
    [businessId]
  );
  const business = businessResult.rows[0];
  if (!business) {
    throw new AppError('Business not found', 404);
  }

  // Orders belong to a business through its users, which is the only link
  // between the two tables. Cancelled orders are left out — nothing is billed
  // for an order that never happened.
  const ordersResult = await query<any>(
    `SELECT o.id, o.order_number, o.created_at,
            DATE_FORMAT(DATE(CONVERT_TZ(o.created_at, '+00:00', ?)), '%Y-%m-%d') AS order_date,
            COALESCE(o.subtotal, 0) AS subtotal
       FROM orders o
       JOIN business_users bu ON bu.id = o.business_user_id
      WHERE bu.business_id = ?
        AND o.status <> 'CANCELLED'
        AND DATE(CONVERT_TZ(o.created_at, '+00:00', ?)) BETWEEN ? AND ?
      ORDER BY o.created_at ASC`,
    [config.BUSINESS_TZ_OFFSET, businessId, config.BUSINESS_TZ_OFFSET, from, to]
  );
  const orders = ordersResult.rows;

  if (orders.length === 0) {
    throw new AppError('This business has no orders in the selected period.', 404);
  }

  const orderIds = orders.map((row: any) => String(row.id));
  const placeholders = orderIds.map(() => '?').join(', ');

  /*
   * One invoice line per item + laundry type + service + rate, summed across
   * the period. Grouping by rate as well as by item keeps two different
   * prices for the same item on separate lines instead of averaging them
   * into a rate that was never charged; grouping by laundry type keeps the
   * Hotel and Guest rates for one item apart, which is exactly the case the
   * per-type price list creates.
   *
   * Every figure is the SNAPSHOT taken when the order was placed —
   * oi.unit_price, oi.total_price, oi.laundry_type — never the live price
   * list. A later change to the business's rates cannot move an invoice
   * that has already been issued.
   */
  const linesResult = await query<any>(
    `SELECT oi.service_name AS description,
            oi.laundry_type,
            COALESCE(
              (SELECT st.name FROM services st WHERE st.id = o.service_id),
              (SELECT MIN(st.name)
                 FROM item_service_types m
                 JOIN services st ON st.id = m.service_id
                WHERE m.item_id = oi.service_id
                  AND st.kind = 'SERVICE_TYPE' AND st.is_active = true
               HAVING COUNT(*) = 1)
            ) AS service,
            oi.unit,
            COALESCE(oi.unit_price, 0) AS rate,
            SUM(oi.quantity) AS quantity,
            -- The ordered and defective pieces behind this line, so the
            -- invoice can show WHY it bills fewer than were collected.
            -- COALESCE for lines written before migration 033, where the
            -- current quantity IS the original and nothing was defective.
            SUM(COALESCE(oi.original_quantity, oi.quantity)) AS ordered_quantity,
            SUM(COALESCE(oi.defective_quantity, 0)) AS defective_quantity,
            SUM(COALESCE(oi.total_price, 0)) AS amount
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
      WHERE oi.order_id IN (${placeholders})
      GROUP BY oi.service_name, oi.laundry_type, service, oi.unit, oi.unit_price
      ORDER BY oi.service_name ASC, oi.laundry_type ASC`,
    orderIds
  );

  const gstRate = Number(config.GST_RATE_PERCENT) || 0;

  const LAUNDRY_LABELS: Record<string, string> = {
    hotel: 'Hotel Laundry',
    guest: 'Guest Laundry',
  };

  const lines: InvoiceLine[] = linesResult.rows.map((row: any) => {
    const taxable = money(row.amount);
    const gstAmount = money((taxable * gstRate) / 100);
    return {
      description: row.description,
      service: row.service || null,
      laundry_type: row.laundry_type ? LAUNDRY_LABELS[row.laundry_type] || row.laundry_type : null,
      quantity: Number(row.quantity || 0),
      ordered_quantity: Number(row.ordered_quantity || row.quantity || 0),
      defective_quantity: Number(row.defective_quantity || 0),
      unit: row.unit || 'Nos',
      rate: money(row.rate),
      taxable,
      gst_amount: gstAmount,
      // Tax-inclusive, which is what the Amount column on the invoice shows.
      amount: money(taxable + gstAmount),
    };
  });

  const taxableValue = money(lines.reduce((sum, line) => sum + line.taxable, 0));

  /*
   * Place of supply. Same state as the supplier means CGST + SGST, each half
   * the rate; a different state means IGST at the full rate.
   *
   * A business with no state recorded is treated as intra-state, because
   * Swachham operates within one district — but the invoice shows the state
   * it used, so a wrong assumption is visible rather than silent.
   */
  const supplierState = config.COMPANY_STATE;
  const customerState = business.state || null;
  const intraState = !customerState || stateKey(customerState) === stateKey(supplierState);

  // Summed from the lines so the total always equals the column above it.
  const totalTax = money(lines.reduce((sum, line) => sum + line.gst_amount, 0));
  const halfTax = money(totalTax / 2);

  const cgst = intraState ? halfTax : 0;
  const sgst = intraState ? money(totalTax - halfTax) : 0;
  const igst = intraState ? 0 : totalTax;

  const invoiceDateResult = await query<{ d: string }>(
    `SELECT DATE_FORMAT(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', ?), '%Y-%m-%d') AS d`,
    [config.BUSINESS_TZ_OFFSET]
  );
  const invoiceDate = String(invoiceDateResult.rows[0].d);

  // Readable, unique per business and period, and derivable again from the
  // same inputs — regenerating the same invoice does not mint a new number.
  const invoiceNumber = invoiceNumberFor(String(business.id), from, to);

  logger.info(
    `[Invoice] built ${invoiceNumber}: ${orders.length} order(s), ${lines.length} line(s), taxable ${taxableValue}`
  );

  return {
    invoice_number: invoiceNumber,
    invoice_number_display: displayInvoiceNumber(invoiceNumber),
    invoice_date: invoiceDate,
    period: { from, to, cycle, label: periodLabel },

    supplier: {
      legal_name: config.COMPANY_LEGAL_NAME,
      gstin: config.COMPANY_GSTIN || null,
      state: supplierState,
      address: config.COMPANY_ADDRESS,
      email: config.COMPANY_EMAIL || null,
      phone: config.COMPANY_PHONE || null,
      bank_name: config.COMPANY_BANK_NAME || null,
      bank_account: config.COMPANY_BANK_ACCOUNT || null,
      bank_ifsc: config.COMPANY_BANK_IFSC || null,
      bank_holder: config.COMPANY_BANK_HOLDER || null,
      terms: config.COMPANY_INVOICE_TERMS || null,
    },

    customer: {
      id: String(business.id),
      /*
       * THE ESTABLISHMENT NAME IS THE DISPLAY NAME.
       *
       * `name` is what the invoice prints largest, so it is the name the
       * business trades under. The registered `legal_name` is kept below it --
       * a tax invoice should carry both -- but it is no longer what identifies
       * the business at a glance.
       */
      name: business.establishment_name || business.name,
      legal_name: business.legal_name || null,
      gstin: business.gst_number || null,
      address: business.address || business.establishment_address || null,
      city: business.city || null,
      state: customerState,
      pincode: business.pincode || null,
    },

    lines,
    orders: orders.map((row: any) => ({
      order_number: row.order_number,
      placed_on: String(row.order_date),
      amount: money(row.subtotal),
    })),

    totals: {
      taxable_value: taxableValue,
      gst_rate: gstRate,
      cgst,
      sgst,
      igst,
      total_tax: totalTax,
      grand_total: money(taxableValue + totalTax),
      intra_state: intraState,
      amount_in_words: amountInWords(money(taxableValue + totalTax)),
    },
  };
}
