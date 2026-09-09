import { query } from '../config/database';
import { config } from '../config/env';
import { AppError } from '../utils/appError';
import { logger } from '../utils/logger';
import { periodForBusiness, periodFor, BillingCycle } from './billingCycle.service';
import { buildInvoiceUpiPayment, UpiPayment } from './upiPayment.service';

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

/**
 * Which laundry type an invoice covers.
 *
 * `null` means BOTH, and is what every existing caller gets by leaving the
 * argument off: the payment receipts, the defective-adjustment lookup and any
 * historical invoice keep behaving exactly as they did. Hotel and Guest are
 * the two separate invoices the Business Account now generates.
 */
export type InvoiceLaundryType = 'hotel' | 'guest';

export const LAUNDRY_TYPE_LABELS: Record<InvoiceLaundryType, string> = {
  hotel: 'Hotel Laundry',
  guest: 'Guest Laundry',
};

/**
 * Reads a laundry type off a request, rejecting anything else.
 *
 * An unrecognised value is NOT quietly treated as "both": a typo in the query
 * string would then bill Hotel and Guest together on a document headed with
 * one of them, which is the exact mixing this feature exists to prevent.
 */
export function parseLaundryType(value: unknown): InvoiceLaundryType | null {
  if (value === undefined || value === null || value === '') return null;
  const key = String(value).trim().toLowerCase();
  if (key === 'hotel' || key === 'guest') return key;
  throw new AppError('Laundry type must be either "hotel" or "guest".', 400);
}

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
  /**
   * The pre-tax value of this line, and the figure every total is built from.
   *
   * IT IS THE SAME NUMBER AS `amount`, deliberately. It used to be
   * `SUM(order_items.total_price)` while `amount` was quantity x rate, so an
   * invoice carried two per-line figures and added the columns up from the one
   * it did not print — which is how a Sub Total that did not equal the Amount
   * column above it was possible at all. There is now one line value: the
   * document prints it, the subtotal sums it and the tax is taken on it.
   */
  taxable: number;
  /**
   * Tax on this line.
   *
   * The invoice table no longer carries a GST column, but the figure is still
   * computed here: the tax summary block and `totals` are summed from it, and
   * removing a COLUMN is not the same as removing the tax.
   */
  gst_amount: number;
  /**
   * The "Amount" column: QUANTITY x RATE, exclusive of tax.
   *
   * Stated as the multiplication the reader can do in their head from the two
   * columns beside it, and — since it is `taxable` — also the figure the Sub
   * Total is the sum of. The column, the total closing the column and the Sub
   * Total in the summary block are therefore one number three times over,
   * rather than three separately-written expressions that agree by luck.
   */
  amount: number;
  /**
   * What `order_items.total_price` recorded for this line, for reconciliation.
   *
   * NOT USED BY ANY TOTAL. It is the charge the orders behind the line stored,
   * kept beside the billed figure so a divergence between the two is visible
   * (it is also logged) instead of silently landing in the subtotal. On every
   * line whose stored price is its quantity x its rate — which is what the
   * order writers produce — it is identical to `amount`.
   */
  recorded_amount: number;
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
/** The prefix that says which kind of invoice this is. */
const TYPE_PREFIX: Record<InvoiceLaundryType, string> = {
  hotel: 'SWCH/INV',
  guest: 'SWCG/INV',
};
/** An invoice covering both types, which only pre-split callers produce. */
const UNTYPED_PREFIX = 'SWC/INV';

/**
 * THE PREFIXES THE PREVIOUS SCHEME USED, kept so its numbers stay readable.
 *
 * Nothing new is issued under them. They exist for `displayInvoiceNumber`,
 * which has to recognise an already-issued `SWC/HL/INV/0059` and show it
 * whole — an invoice's number is permanent, and a number already printed on a
 * document and recorded against a payment cannot be re-formatted later.
 */
const LEGACY_SERIAL_NUMBER = /^SWC\/(HL|GL)\/INV\//;

/**
 * The current shape: a type prefix and the business's own running number,
 * with nothing after it. `SWC/INV/27` is the untyped form of the same thing.
 *
 * Anchored at BOTH ends so it cannot match the original
 * `SWC/INV/0025/20260801-20260831`, which starts identically and must still
 * be trimmed for display.
 */
const SERIAL_NUMBER = /^SWC[HG]?\/INV\/\d+$/;

/**
 * The number an invoice is ISSUED under: a prefix for the type, and the
 * business's own running number.
 *
 *   SWCH/INV/27   hotel
 *   SWCG/INV/28   guest laundry
 *
 * ONE SEQUENCE PER BUSINESS, SHARED BY BOTH TYPES. The prefix is the only
 * thing the laundry type decides. The digits come from a counter held against
 * the business, so an account's invoices run 1, 2, 3, 4 in the order they were
 * issued whether each one is a Hotel or a Guest invoice — a Guest invoice
 * never restarts the numbering and never runs in parallel with the Hotel one.
 * `allocateBusinessSerial` below is what hands them out.
 *
 * NOT PADDED. `SWCH/INV/27` is the whole number; a 0027 would make the same
 * invoice two different strings depending on who wrote it down.
 */
export function invoiceNumberForSerial(
  serial: number,
  laundryType?: InvoiceLaundryType | null
): string {
  const prefix = laundryType ? TYPE_PREFIX[laundryType] : UNTYPED_PREFIX;
  return `${prefix}/${serial}`;
}

/**
 * THE NUMBER AN INVOICE ISSUED BEFORE THE GLOBAL SERIAL CARRIES.
 *
 * Kept exactly as it was so every invoice already stored, and anything
 * recorded against its number, still resolves to the same string. Nothing
 * new is issued under this shape.
 */
export function invoiceNumberFor(
  businessId: string,
  from: string,
  to: string,
  laundryType?: InvoiceLaundryType | null
): string {
  const base = `SWC/INV/${String(businessId).padStart(4, '0')}/${from.replace(/-/g, '')}-${to.replace(/-/g, '')}`;
  /*
   * THE TYPE SUFFIX, AND ONLY WHEN THERE IS A TYPE.
   *
   * Hotel and Guest are two different invoices over the same business and the
   * same dates, so the number that identifies them cannot be the same string
   * — a payment recorded against one would otherwise be indistinguishable
   * from a payment against the other.
   *
   * Omitting it when no type is given is what keeps every invoice issued
   * before this feature, and every payment receipt already stored against
   * one, addressable by exactly the number it was issued under.
   *
   * The DISPLAYED number is unaffected: it is the first 12 characters, which
   * stop at the business id, well before this suffix.
   */
  return laundryType ? `${base}/${laundryType.toUpperCase()}` : base;
}

/**
 * The number this exact invoice should carry — reused if it has one, freshly
 * allocated only when it is being issued for the first time.
 *
 * WHAT "THIS EXACT INVOICE" MEANS: one business, one period, one laundry
 * type. Re-issuing that same invoice must NOT take a new serial, or every
 * regeneration would mint a duplicate row and orphan any payment recorded
 * against the previous number. So the stored row is consulted first, and an
 * invoice issued before the global serial existed keeps its original number
 * untouched.
 *
 * `allocate` is false for the PREVIEW: looking at what an invoice would come
 * to must not consume a number from the sequence. The preview then shows the
 * serial the invoice would take next, which is advisory — the number is
 * fixed, and the row is written, only when the document is actually issued.
 */
export async function resolveInvoiceNumber(
  businessId: string,
  from: string,
  to: string,
  laundryType: InvoiceLaundryType | null,
  opts: { allocate: boolean }
): Promise<{ invoiceNumber: string; serial: number | null }> {
  /*
   * ALREADY ISSUED? THEN IT KEEPS WHAT IT WAS ISSUED UNDER, whatever shape.
   *
   * This branch is what makes an invoice number permanent across every change
   * to the numbering scheme — including this one. An invoice issued as
   * `SWC/HL/INV/0059` reopens, re-renders and takes payment as that string;
   * it is never restated as `SWCH/INV/…` because a document has already been
   * sent under the old number and receipts are recorded against it.
   */
  const existing = await findInvoiceForPeriod(businessId, from, to, laundryType);
  if (existing) {
    // The business's own number when it has one; the old global serial is
    // what an invoice issued before this scheme reports.
    const serial = existing.business_serial ?? existing.serial;
    return {
      invoiceNumber: existing.invoice_number,
      serial: serial === null ? null : Number(serial),
    };
  }

  /*
   * ALREADY CLAIMED A NUMBER?
   *
   * The claim is written the moment a number is allocated, before the invoice
   * row exists — so if recording the invoice fails, `business_invoices` cannot
   * answer "what number did this take?" and the claim can. That is what stops
   * a second download of the same invoice minting a second number.
   */
  const typeKey = laundryType ?? '';
  const claimed = await query<{ serial: number | null; business_serial: number | null }>(
    `SELECT serial, business_serial FROM invoice_serial_claims
      WHERE business_id = ? AND period_from = ? AND period_to = ? AND laundry_type = ?
      LIMIT 1`,
    [businessId, from, to, typeKey]
  );
  if (claimed.rows.length > 0) {
    const row = claimed.rows[0];
    /*
     * A claim made under the OLD scheme has only a global serial, and the
     * number it stands for is the old-format one — rebuilding it with today's
     * prefixes would hand back a number the claim was never for.
     */
    if (row.business_serial === null) {
      const serial = Number(row.serial);
      return { invoiceNumber: legacySerialNumber(serial, laundryType), serial };
    }
    const serial = Number(row.business_serial);
    return { invoiceNumber: invoiceNumberForSerial(serial, laundryType), serial };
  }

  if (!opts.allocate) {
    /*
     * A peek, for the PREVIEW only: what this business's next invoice would be
     * numbered, without taking it. Two operators previewing at once may see
     * the same figure; neither has reserved it, and issuing is what decides.
     *
     * No row yet means this business has never been issued an invoice, and
     * its first one is 1 — the same value `allocateBusinessSerial` would
     * create the counter with.
     */
    const peek = await query<{ next_value: number }>(
      `SELECT next_value FROM business_invoice_sequence WHERE business_id = ?`,
      [businessId]
    );
    const next = peek.rows.length > 0 ? Number(peek.rows[0].next_value) : 1;
    return { invoiceNumber: invoiceNumberForSerial(next, laundryType), serial: null };
  }

  const allocated = await allocateBusinessSerial(businessId);
  /*
   * The claim is written under a unique key on the identity, so if a second
   * request for the same invoice got here first its number stands and ours is
   * simply not used. Re-reading rather than trusting `allocated` is what makes
   * both requests agree on one number.
   */
  await query(
    `INSERT INTO invoice_serial_claims
       (business_id, period_from, period_to, laundry_type, business_serial)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE business_serial = COALESCE(business_serial, VALUES(business_serial))`,
    [businessId, from, to, typeKey, allocated]
  );
  const settled = await query<{ business_serial: number | null }>(
    `SELECT business_serial FROM invoice_serial_claims
      WHERE business_id = ? AND period_from = ? AND period_to = ? AND laundry_type = ?
      LIMIT 1`,
    [businessId, from, to, typeKey]
  );
  const serial =
    settled.rows.length > 0 && settled.rows[0].business_serial !== null
      ? Number(settled.rows[0].business_serial)
      : allocated;
  return { invoiceNumber: invoiceNumberForSerial(serial, laundryType), serial };
}

/**
 * The number a GLOBAL serial was issued under, in the shape that scheme used.
 *
 * Only ever used to re-read a claim written before migration 066. Nothing is
 * issued under this shape, and it is deliberately not exported: a caller
 * reaching for it would be minting an old-format number for a new invoice.
 */
function legacySerialNumber(serial: number, laundryType: InvoiceLaundryType | null): string {
  const prefix = laundryType ? (laundryType === 'hotel' ? 'SWC/HL/INV' : 'SWC/GL/INV') : 'SWC/INV';
  return `${prefix}/${String(serial).padStart(4, '0')}`;
}

/**
 * Takes the next invoice number from THIS BUSINESS's counter.
 *
 * ONE COUNTER PER BUSINESS, SHARED BY HOTEL AND GUEST. The laundry type is
 * not a parameter and deliberately cannot be: it decides the prefix and
 * nothing else, so the digits keep running 1, 2, 3, 4 across both kinds.
 *
 * ATOMIC, so two invoices issued for one business at the same instant cannot
 * take the same number. It is a SINGLE statement:
 *
 *   - the business has no counter yet — the INSERT creates it, hands back 1
 *     through `LAST_INSERT_ID(1)` and stores 2 as the next value;
 *   - it already has one — `LAST_INSERT_ID(next_value)` returns the number the
 *     counter was on and moves it past, under the row lock the UPDATE half of
 *     the statement already holds.
 *
 * Either way MySQL computes the value and remembers it on the SAME statement,
 * so there is no read-then-write window for a second connection to slip into
 * and no explicit transaction is needed. `business_invoice_sequence` has no
 * AUTO_INCREMENT column, which is what keeps `LAST_INSERT_ID()` reporting the
 * number we asked it to rather than a new row id.
 */
async function allocateBusinessSerial(businessId: string): Promise<number> {
  await query(
    `INSERT INTO business_invoice_sequence (business_id, next_value)
     VALUES (?, LAST_INSERT_ID(1) + 1)
     ON DUPLICATE KEY UPDATE next_value = LAST_INSERT_ID(next_value) + 1`,
    [businessId]
  );
  const got = await query<{ serial: number }>(`SELECT LAST_INSERT_ID() AS serial`);
  const serial = Number(got.rows[0]?.serial);
  if (!Number.isFinite(serial) || serial < 1) {
    throw new AppError('The invoice number could not be allocated. Run the migrations.', 500);
  }
  return serial;
}

/** One stored invoice, as the period lookup below returns it. */
export interface StoredInvoiceRef {
  id: number;
  invoice_number: string;
  serial: number | null;
  business_serial: number | null;
  /** True when the row's period IS the cycle period, not merely inside it. */
  exact: boolean;
}

/**
 * THE INVOICE THAT ALREADY COVERS THIS BILLING PERIOD, if there is one.
 *
 * ONE DEFINITION OF "THE SAME INVOICE", used by everything that has to decide
 * between updating an invoice and issuing a new one — the number resolver and
 * the history recorder both call this, so they cannot disagree about whether
 * an invoice exists. They used to decide separately, one on an exact period
 * match and the other on a month bucket, which is how a second document could
 * take a fresh number while overwriting the first one's row.
 *
 * MATCHING IS BY BUSINESS + PERIOD + LAUNDRY TYPE. Hotel and Guest remain two
 * documents over one period, as they always have been — they carry different
 * prefixes and different totals and cannot be one row.
 *
 * A CONTAINED PERIOD COUNTS AS THE SAME INVOICE. An exact match wins, but a
 * row whose period sits INSIDE this billing cycle is adopted when there is no
 * exact one: it was raised for part of this cycle, before the period was
 * pinned to the registered cycle, and it is that cycle's invoice. Adopting it
 * is what lets an invoice first raised for 1–9 September keep its number when
 * September's cycle is billed in full — rather than stranding it and issuing a
 * second invoice for the same month, which is the duplicate this exists to
 * prevent. A row covering MORE than the cycle is never adopted: it describes a
 * different, wider span and is not this invoice.
 */
export async function findInvoiceForPeriod(
  businessId: string,
  from: string,
  to: string,
  laundryType: InvoiceLaundryType | null
): Promise<StoredInvoiceRef | null> {
  const rows = await query<{
    id: number;
    invoice_number: string;
    serial: number | null;
    business_serial: number | null;
    exact: number;
  }>(
    `SELECT id, invoice_number, serial, business_serial,
            (period_from = ? AND period_to = ?) AS exact
       FROM business_invoices
      WHERE business_id = ?
        AND ((laundry_type IS NULL AND ? IS NULL) OR laundry_type = ?)
        AND period_from >= ? AND period_to <= ?
      ORDER BY exact DESC, last_generated_at DESC, id DESC
      LIMIT 1`,
    [from, to, businessId, laundryType, laundryType, from, to]
  );
  if (rows.rows.length === 0) return null;
  const row = rows.rows[0];
  return {
    id: Number(row.id),
    invoice_number: row.invoice_number,
    serial: row.serial === null ? null : Number(row.serial),
    business_serial: row.business_serial === null ? null : Number(row.business_serial),
    exact: Number(row.exact) === 1,
  };
}

/**
 * THE NUMBER AN INVOICE WAS ACTUALLY ISSUED UNDER, or null if it never was.
 *
 * WHY ANYTHING NEEDS THIS. Several screens name the invoice a period falls
 * under — the Orders list, the defect-adjustment notice, the item report — and
 * each of them used to DERIVE that name with `invoiceNumberFor`, from the
 * business id and the dates. That worked while the number was a pure function
 * of those inputs. It stopped being one the moment numbers came from a
 * counter: a derived `SWC/INV/0047` names no invoice that exists, and printing
 * it beside a real `SWCH/INV/27` invites exactly the confusion of two numbers
 * for one document.
 *
 * So the issued number is READ. Null means this period has not been invoiced
 * yet, which is a fact worth showing as "not invoiced" rather than papering
 * over with a number nothing was issued under.
 */
export async function issuedInvoiceNumberFor(
  businessId: string,
  from: string,
  to: string,
  laundryType: InvoiceLaundryType | null
): Promise<string | null> {
  const rows = await query<{ invoice_number: string }>(
    `SELECT invoice_number
       FROM business_invoices
      WHERE business_id = ? AND period_from = ? AND period_to = ?
        AND ((laundry_type IS NULL AND ? IS NULL) OR laundry_type = ?)
      ORDER BY id DESC
      LIMIT 1`,
    [businessId, from, to, laundryType, laundryType]
  );
  return rows.rows.length > 0 ? rows.rows[0].invoice_number : null;
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
  const full = String(invoiceNumber ?? '');
  /*
   * A SERIALLED NUMBER IS SHOWN WHOLE.
   *
   * `SWCH/INV/27` — and the `SWC/HL/INV/0059` the scheme before it issued —
   * carry nothing but the type and the number, so there is nothing to trim.
   * Trimming would be actively wrong: twelve characters of `SWCH/INV/1234`
   * is `SWCH/INV/123`, which cuts the number in half and reads as a
   * different invoice.
   *
   * The slice below applies only to the ORIGINAL shape,
   * `SWC/INV/0025/20260801-20260831`, whose tail is the period and the type
   * and was never meant to be read.
   */
  if (SERIAL_NUMBER.test(full) || LEGACY_SERIAL_NUMBER.test(full)) return full;
  return full.slice(0, INVOICE_NUMBER_DISPLAY_LENGTH);
}

export interface GstInvoice {
  /**
   * The FULL invoice number. Unique per business and period, and the only
   * value anything internal should key on -- the log line, the file name, and
   * any future lookup.
   */
  invoice_number: string;
  /**
   * The running number this invoice was issued under WITHIN ITS BUSINESS —
   * the digits in `invoice_number`, shared by Hotel and Guest.
   *
   * Null on a preview, which has not taken a number, and on an invoice issued
   * before the per-business sequence existed, where it reports the global
   * serial that scheme handed out instead. The number above is what
   * identifies the invoice; this is what the counter gave it.
   */
  invoice_serial: number | null;
  /**
   * The SHORT form shown to people: the first 10 characters of the full one.
   *
   * It is a display string and nothing else. It is deliberately NOT unique --
   * ten characters of `SWC/INV/0025/20260801-20260831` is `SWC/INV/00`, which
   * every business shares -- so nothing may look an invoice up by it, and
   * `invoice_number` above stays the identifier.
   */
  invoice_number_display: string;
  /**
   * THE INVOICE DATE: two days after the billing period ends.
   *
   * NOT the day the document was generated. An invoice is dated from the
   * period it bills, so September's invoice is dated 2 October whether it was
   * produced on the 2nd, the 5th or re-produced in November — regenerating it
   * to pick up late orders must not move the date on a document that has
   * already been sent, and two operators generating it on different days must
   * not produce two differently-dated invoices for one period.
   *
   * Derived from `period.to` by `invoiceDateFor`, so it is a fact about the
   * billing cycle rather than about the moment of generation. When the
   * document WAS generated is a separate thing entirely, recorded as
   * `last_generated_at` on the stored invoice.
   */
  invoice_date: string;

  /**
   * WHICH LAUNDRY TYPE THIS INVOICE COVERS, or null when it covers both.
   *
   * Null is what every pre-existing caller produces, so an invoice opened the
   * way it always was still reports honestly rather than claiming a type it
   * was never filtered by.
   */
  laundry_type: InvoiceLaundryType | null;
  /** "Hotel Laundry" / "Guest Laundry" — the Type field, ready to print. */
  laundry_type_label: string | null;

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
    /**
     * The supplier's VPA — the same account as `bank_account`, reached over
     * UPI. Null when none is configured. It sits here, beside the other
     * "Pay To" details, because that is what it is: one more way to pay the
     * account the invoice already names.
     */
    upi_id: string | null;
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

  /**
   * The scan-to-pay block: the UPI intent for THIS invoice, and the QR that
   * carries it.
   *
   * Built from the supplier's configured VPA and `totals.grand_total`, so the
   * amount a scan pre-fills is the amount the Total row prints — the same
   * number, not a second calculation. When no valid VPA is configured it
   * reports `available: false` with a message to print in the QR's place;
   * every other field on this invoice is unaffected either way.
   */
  upi_payment: UpiPayment;

  totals: {
    /**
     * The lines added up, BEFORE any deduction — the Sub Total the invoice
     * has always printed. Equal to `taxable_value` whenever no deduction is
     * applied, which is every invoice that does not ask for one.
     */
    subtotal: number;
    /** The deduction taken off the subtotal, as a percentage. 0 when none. */
    discount_percent: number;
    /** What that percentage came to in rupees. 0 when none. */
    discount_amount: number;
    /** The subtotal less the deduction — what GST is charged on. */
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

/**
 * "2026-08-14" + 1 -> "2026-08-15". Rolls over months and years by
 * construction, so a period ending on the 30th or the 31st needs no special
 * case and 30 December + 2 lands in the next year.
 */
function addDays(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  // UTC, so a local DST shift cannot move the date by a day.
  const next = new Date(Date.UTC(y, m - 1, d + days));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

/** "2026-08-14" -> "2026-08-15". Used to step from one billing period to the next. */
function addOneDay(dateKey: string): string {
  return addDays(dateKey, 1);
}

/** How long after a billing period closes the invoice for it is dated. */
export const INVOICE_DATE_DAYS_AFTER_PERIOD = 2;

/**
 * THE INVOICE DATE FOR A BILLING PERIOD: its last day plus two.
 *
 *   1–30 September  ->  2 October
 *   1–15 October    ->  17 October
 *
 * ONE DEFINITION, EXPORTED, because three things have to agree on it: the
 * invoice object the PDF is drawn from, the Invoice Details block at the head
 * of that PDF, and the Acknowledgment strip at its foot. They all read the
 * single `invoice_date` field this produces rather than working the date out
 * again, so the two places the document prints it cannot drift apart.
 *
 * The stored invoice history derives it the same way, from the period on the
 * row — so an invoice listed in the Business Account and the same invoice
 * reopened as a PDF are dated identically, without the date being stored
 * twice.
 *
 * IT DOES NOT DEPEND ON TODAY. That is the whole point: see `invoice_date`.
 */
export function invoiceDateFor(periodTo: string): string {
  return addDays(periodTo, INVOICE_DATE_DAYS_AFTER_PERIOD);
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
/**
 * The deduction percentage, or 0 — never anything that could misprice an
 * invoice.
 *
 * Absent, blank and null all mean "no deduction", which is what every caller
 * that predates the field sends. Anything present must be a real number from
 * 0 to 100: a negative would inflate the bill above its own lines and over
 * 100 would invert it, so both are refused outright rather than clamped, and
 * the operator is told. Decimals such as 5.5 are kept, rounded to the paisa
 * the money itself is kept in.
 */
export function normaliseDiscountPercent(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'string' && value.trim() === '') return 0;

  const percent = Number(value);
  if (!Number.isFinite(percent)) {
    throw new AppError('Discount / Deduction must be a number.', 400);
  }
  if (percent < 0 || percent > 100) {
    throw new AppError('Discount / Deduction must be between 0 and 100 percent.', 400);
  }
  return Math.round(percent * 100) / 100;
}

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
  toDate?: unknown,
  /**
   * Restricts the invoice to ONE laundry type. Omitted (or null) bills both,
   * which is what every caller that predates the split does.
   */
  laundryType?: InvoiceLaundryType | null,
  /**
   * Percentage taken off the subtotal before GST. Omitted means none, which
   * is what every caller that predates the field does.
   */
  discountPercentInput?: unknown,
  /**
   * True only when the invoice is actually being ISSUED — the download that
   * puts it on record. That is the one moment a serial may be taken from the
   * global sequence; a preview must never consume one.
   */
  issue: boolean = false,
  /**
   * RE-RENDER THE GIVEN DATES EXACTLY, without resolving them to a cycle.
   *
   * For REOPENING AN INVOICE THAT WAS ALREADY ISSUED, and nothing else. A
   * stored invoice's PDF is re-rendered from the period on its row rather than
   * kept as bytes, and that row is the document of record: an invoice issued
   * for 1–30 August has to reopen as 1–30 August, whatever the business's
   * cycle would make of those dates today. Snapping it would restate a
   * document that has already been sent, and an invoice raised before the
   * period was pinned to the cycle can span two of today's periods — which
   * generation rightly refuses and re-rendering must not.
   *
   * Generation never passes this. Every path that CREATES or UPDATES an
   * invoice goes through the cycle, which is what keeps one invoice per
   * billing period true.
   */
  exactPeriod: boolean = false
): Promise<GstInvoice> {
  /*
   * THE PERIOD IS THE BUSINESS'S REGISTERED BILLING CYCLE. ALWAYS.
   *
   * The dates on the request no longer define the window — they only say
   * WHICH window. The period containing the From date is looked up from the
   * cycle stored against the business at registration, and that cycle period
   * is what gets billed, end to end.
   *
   * WHY THE DATES CANNOT DEFINE IT ANY MORE. They used to: two dates produced
   * an invoice for exactly that range. That makes "the invoice for September"
   * a different document depending on which day the operator happened to pick
   * as the To date, so 1–29, 1–30 and 1–31 August were three invoices, with
   * three numbers, for one billing period — which is exactly what this data
   * already contains. An invoice is now identified by the CYCLE it covers, so
   * billing the same cycle again finds the invoice that exists and updates it
   * instead of raising another.
   *
   * With no dates at all, the CURRENT period is billed, as before.
   *
   * The From date is what anchors the lookup; a To date is still validated so
   * a malformed one is refused rather than silently ignored, and a range that
   * runs backwards is still an error. Beyond that the To date only matters
   * when it picks a different cycle than the From date, which is reported
   * below rather than guessed at.
   */
  const explicit =
    (typeof fromDate === 'string' && fromDate.trim() !== '') ||
    (typeof toDate === 'string' && toDate.trim() !== '');

  let anchor: string | undefined;
  if (explicit) {
    const askedFrom = requireDate(fromDate, 'From date');
    const askedTo = requireDate(toDate, 'To date');
    if (askedFrom > askedTo) {
      throw new AppError('From date cannot be after To date.', 400);
    }
    anchor = askedFrom;
  }

  const period = await periodForBusiness(businessId, anchor);
  /*
   * `exactPeriod` re-renders the dates as given — see the parameter. The cycle
   * and its label still come from the business, because the document names the
   * cycle it was raised under, but they do not move the window.
   */
  const reRender = exactPeriod && explicit;
  const from = reRender ? String(fromDate).trim() : period.from;
  const to = reRender ? String(toDate).trim() : period.to;
  const cycle: BillingCycle | undefined = period.cycle;
  const periodLabel: string | undefined = reRender ? undefined : period.label;

  /*
   * A RANGE THAT SPANS MORE THAN ONE BILLING PERIOD IS REFUSED, NOT NARROWED.
   *
   * An invoice covers exactly one billing cycle, so a range crossing a
   * boundary names no single invoice. Quietly billing the period around the
   * From date looked reasonable and is not: on a fortnightly account, asking
   * for the whole of August bills 1–14 and DROPS every order from the 15th
   * onwards — an invoice that is wrong rather than one that is missing. If
   * the orders happen to all sit in the half that was dropped, the operator
   * is told there is no data at all, for a month that has plenty.
   *
   * So the ambiguity goes back to the operator, naming the periods the range
   * touches so the next pick is a single one. Nothing is refused when the
   * range sits inside one period, which is every ordinary request.
   */
  if (explicit && !reRender) {
    const askedFrom = String(fromDate).trim();
    const askedTo = String(toDate).trim();
    if (askedTo > to) {
      const spanned: string[] = [];
      let cursor = from;
      // Bounded: one step per period, and a range cannot touch more of them
      // than it has days.
      for (let i = 0; i < 64 && cursor <= askedTo; i += 1) {
        const p = periodFor(cycle!, cursor);
        spanned.push(p.label ? `${p.label} (${p.from} to ${p.to})` : `${p.from} to ${p.to}`);
        cursor = addOneDay(p.to);
      }
      throw new AppError(
        `${askedFrom} to ${askedTo} covers ${spanned.length} billing periods of this ` +
          `business's ${cycle} cycle, and an invoice covers one. Choose a date inside the ` +
          `period you want to bill: ${spanned.join('; ')}.`,
        400
      );
    }
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

  const typeLabel = laundryType ? LAUNDRY_TYPE_LABELS[laundryType] : null;

  /*
   * THE TYPE FILTER, APPLIED AT THE ORDER LEVEL.
   *
   * `orders.laundry_type` is the type the whole order was placed under, and
   * `order_items.laundry_type` was backfilled from it (migration 026), so the
   * two agree. Filtering here as well as on the lines below is what keeps the
   * `orders` list, the order COUNT and the per-order amounts on the invoice
   * from describing orders whose lines were then excluded.
   */
  const orderTypeClause = laundryType ? ' AND o.laundry_type = ?' : '';
  const orderTypeValues = laundryType ? [laundryType] : [];

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
        AND DATE(CONVERT_TZ(o.created_at, '+00:00', ?)) BETWEEN ? AND ?${orderTypeClause}
      ORDER BY o.created_at ASC`,
    [config.BUSINESS_TZ_OFFSET, businessId, config.BUSINESS_TZ_OFFSET, from, to, ...orderTypeValues]
  );
  const orders = ordersResult.rows;

  if (orders.length === 0) {
    throw new AppError(
      typeLabel
        ? `This business has no ${typeLabel} orders in the selected period.`
        : 'This business has no orders in the selected period.',
      404
    );
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
              (SELECT st.name FROM services st WHERE st.id = oi.laundry_service_id),
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
            -- The charge the order rows RECORDED, carried for reconciliation
            -- only. The billed figure is quantity x rate, computed below, so
            -- the Amount column and the Sub Total cannot come from two
            -- different sums. Aliased recorded_amount rather than amount so
            -- the two can never be confused at the point of use.
            SUM(COALESCE(oi.total_price, 0)) AS recorded_amount
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
      WHERE oi.order_id IN (${placeholders})${laundryType ? ' AND oi.laundry_type = ?' : ''}
      GROUP BY oi.service_name, oi.laundry_type, service, oi.unit, oi.unit_price
      ORDER BY oi.service_name ASC, oi.laundry_type ASC`,
    // A second guard on the LINES, not only on the orders above: an order
    // carrying a line of the other type could otherwise slip a Guest item
    // onto a Hotel invoice.
    laundryType ? [...orderIds, laundryType] : orderIds
  );

  const gstRate = Number(config.GST_RATE_PERCENT) || 0;

  const lines: InvoiceLine[] = linesResult.rows.map((row: any) => {
    const quantity = Number(row.quantity || 0);
    const rate = money(row.rate);

    /*
     * THE LINE'S VALUE, COMPUTED ONCE.
     *
     * Quantity x Price/unit, rounded to the paisa here and nowhere else. It is
     * what the Amount column prints, what the subtotal is the sum of and what
     * the line's tax is taken on — the three used to be derived from two
     * different sums, which is precisely how a Sub Total could disagree with
     * the column of amounts printed above it.
     */
    const amount = money(quantity * rate);

    /*
     * The charge the order rows stored. Equal to `amount` for everything the
     * order writers produce (`total_price = unit_price x quantity`), so a
     * difference means the line's stored price and its own two columns
     * disagree — a data problem worth seeing, not something to quietly bill.
     * Said once here rather than left to surface as an invoice that does not
     * add up.
     */
    const recordedAmount = money(row.recorded_amount);
    if (Math.abs(recordedAmount - amount) >= 0.01) {
      logger.warn(
        `[Invoice] line "${row.description}" bills ${amount} (${quantity} x ${rate}) but ` +
          `order_items.total_price records ${recordedAmount}; the invoice uses the billed figure.`
      );
    }

    return {
      description: row.description,
      service: row.service || null,
      laundry_type: row.laundry_type
        ? LAUNDRY_TYPE_LABELS[row.laundry_type as InvoiceLaundryType] || row.laundry_type
        : null,
      quantity,
      ordered_quantity: Number(row.ordered_quantity || row.quantity || 0),
      defective_quantity: Number(row.defective_quantity || 0),
      unit: row.unit || 'Nos',
      rate,
      // ONE figure, under both names: the subtotal sums `taxable` and the
      // document prints `amount`, and they cannot differ because they are it.
      taxable: amount,
      gst_amount: money((amount * gstRate) / 100),
      amount,
      recorded_amount: recordedAmount,
    };
  });

  /*
   * THE DEDUCTION, TAKEN OFF BEFORE TAX.
   *
   * The subtotal is the AMOUNT COLUMN added up — `line.amount`, the very field
   * the document prints on each row — so the figure closing the table and the
   * Sub Total in the summary block are the same addition, not two. A deduction
   * comes off that, and GST is then charged on what remains, so the tax
   * follows the money actually being billed rather than a figure the customer
   * is not paying. No deduction leaves `taxableValue` identical to the
   * subtotal, which is every invoice that does not ask for one.
   */
  const subtotal = money(lines.reduce((sum, line) => sum + line.amount, 0));
  const discountPercent = normaliseDiscountPercent(discountPercentInput);
  const discountAmount = discountPercent > 0 ? money((subtotal * discountPercent) / 100) : 0;
  const taxableValue = money(subtotal - discountAmount);

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

  /*
   * THE TAX, TAKEN ON THE FIGURE THE INVOICE PRINTS.
   *
   * The rate is applied to `taxableValue` — the Sub Total less any deduction,
   * which is the number stated immediately above the tax rows — so a reader
   * checking the document can reproduce every line of the summary block from
   * the two figures in front of them.
   *
   * IT WAS THE SUM OF THE PER-LINE TAX, and only fell back to this when a
   * deduction had been applied. Rounding each line's tax to the paisa and then
   * adding those up can land a paisa away from the rate applied to their
   * total, which on the printed document reads as a Total that does not follow
   * from the Sub Total above it. `gst_amount` is still computed per line and
   * still carried — nothing consumes it as a total any more.
   */
  const totalTax = money((taxableValue * gstRate) / 100);
  const halfTax = money(totalTax / 2);

  const cgst = intraState ? halfTax : 0;
  const sgst = intraState ? money(totalTax - halfTax) : 0;
  const igst = intraState ? 0 : totalTax;

  /*
   * THE INVOICE DATE, FROM THE PERIOD RATHER THAN FROM THE CLOCK.
   *
   * This used to read today's date in the business timezone, so the same
   * invoice was dated differently every time it was produced — and after a
   * regeneration to pick up late orders, the reissued document contradicted
   * the one already sent. It is now the billing period's last day plus two,
   * which is a fact about the cycle and stays put however often the invoice
   * is regenerated.
   */
  const invoiceDate = invoiceDateFor(to);

  /*
   * THE NUMBER. Reused if this invoice already has one, so regenerating it
   * does not mint a second; a serial is taken from the one global sequence
   * only when it is being issued for the first time.
   */
  const resolved = await resolveInvoiceNumber(
    String(business.id), from, to, laundryType ?? null, { allocate: issue }
  );
  const invoiceNumber = resolved.invoiceNumber;
  const invoiceSerial = resolved.serial;

  /*
   * THE FINAL PAYABLE FIGURE, NAMED ONCE.
   *
   * It was computed inline in `totals` twice — once for `grand_total` and
   * once for the words. Hoisting it means the QR below cannot encode an
   * amount arrived at by a third, separately-written expression: there is now
   * one figure, and the Total row, the amount in words and the scan all read
   * it.
   */
  const grandTotal = money(taxableValue + totalTax);

  /*
   * The scan-to-pay QR. Awaited rather than fired off, because the invoice is
   * a single object handed to the PDF renderer and the app alike — a QR that
   * arrived after the document was drawn would print on neither.
   *
   * It cannot fail the invoice: `buildInvoiceUpiPayment` reports its problems
   * as an unavailable state instead of throwing.
   */
  const upiPayment = await buildInvoiceUpiPayment({
    amount: grandTotal,
    reference: displayInvoiceNumber(invoiceNumber),
  });

  logger.info(
    `[Invoice] built ${invoiceNumber}: ${orders.length} order(s), ${lines.length} line(s), ` +
      `type ${typeLabel ?? 'all'}, taxable ${taxableValue}`
  );

  return {
    invoice_number: invoiceNumber,
    invoice_serial: invoiceSerial,
    invoice_number_display: displayInvoiceNumber(invoiceNumber),
    invoice_date: invoiceDate,
    laundry_type: laundryType ?? null,
    laundry_type_label: typeLabel,
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
      // The VPA actually used for the QR, not the raw setting: an unset or
      // malformed one reports as absent here too, so the printed details and
      // the QR can never disagree about whether UPI is on offer.
      upi_id: upiPayment.vpa,
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

    upi_payment: upiPayment,

    totals: {
      subtotal,
      discount_percent: discountPercent,
      discount_amount: discountAmount,
      taxable_value: taxableValue,
      gst_rate: gstRate,
      cgst,
      sgst,
      igst,
      total_tax: totalTax,
      grand_total: grandTotal,
      intra_state: intraState,
      amount_in_words: amountInWords(grandTotal),
    },
  };
}
