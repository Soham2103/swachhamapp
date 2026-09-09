import { query } from '../config/database';
import { config } from '../config/env';
import { AppError } from '../utils/appError';
import { logger } from '../utils/logger';
import {
  InvoiceLaundryType,
  LAUNDRY_TYPE_LABELS,
  invoiceNumberFor,
  issuedInvoiceNumberFor,
  displayInvoiceNumber,
} from './gstInvoice.service';

/**
 * THE DAY-WISE ITEM QUANTITY REPORT.
 *
 * The second document the Business Account produces, alongside the invoice:
 * a grid of ITEM NAME down the side, the DATES across the top, and the
 * quantity of that item collected on that date in each cell — with a Total
 * row closing every date column.
 *
 *              | 01-08 | 02-08 | 03-08 | Total
 *   Face Towel |     5 |       |     2 |     7
 *   Bath Towel |    10 |     3 |       |    13
 *   Total      |    15 |     3 |     2 |    20
 *
 * It answers a different question from the invoice. The invoice says what is
 * owed and groups every line by rate, so one item at two prices is two rows
 * and the dates are gone. This says how much of each item moved on each day,
 * which is what a hotel's housekeeping reconciles against its own counts.
 *
 * IT IS BUILT FROM THE SAME INPUTS AS THE INVOICE, deliberately: the same
 * business, the same two dates, the same laundry type, the same exclusion of
 * cancelled orders, and the same `CONVERT_TZ` into the business timezone that
 * decides which day an order near midnight belongs to. Two documents covering
 * "the same period" have to mean the same thing by it.
 *
 * QUANTITY IS THE BILLABLE QUANTITY — `order_items.quantity`, the figure the
 * invoice charges for, after any defective pieces were taken off. The pieces
 * originally collected are carried alongside it so a discrepancy against the
 * hotel's own count has an explanation on the page rather than a query.
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** One row of the grid: an item, its quantity per date, and what it came to. */
export interface ItemQuantityRow {
  item_name: string;
  /** Quantity per date key (`YYYY-MM-DD`). Dates with none are absent. */
  by_date: Record<string, number>;
  /** The row's total across every date in the report. */
  total: number;
  /** Pieces collected before any defective adjustment. Equals `total` normally. */
  ordered_total: number;
  /** Pieces found defective and therefore not billed. 0 on most rows. */
  defective_total: number;

  /**
   * The price per piece this item was charged at, ex-tax.
   *
   * DERIVED AS `amount / total`, not read from one row, and that is exact
   * rather than approximate: when an item carried a single price all period,
   * `SUM(qty x price)` is `price x SUM(qty)`, so dividing back gives that
   * price to the paisa. Only an item whose price CHANGED mid-period gets an
   * effective rate here — and for that item there is no single "the rate" to
   * print anyway.
   *
   * The snapshot price the order was placed at, never the live price list, so
   * this sheet cannot drift from the invoice beside it.
   */
  rate: number;
  /** Quantity x rate, ex-tax — the money this item accounts for. */
  amount: number;
}

export interface ItemQuantityReport {
  /** The invoice this report accompanies — same business, period and type. */
  invoice_number: string;
  invoice_number_display: string;
  report_date: string;

  business: {
    id: string;
    name: string;
    legal_name: string | null;
    address: string | null;
    city: string | null;
    state: string | null;
    pincode: string | null;
    gstin: string | null;
  };

  supplier: {
    legal_name: string;
    address: string;
    gstin: string | null;
    email: string | null;
    phone: string | null;
  };

  period: { from: string; to: string };

  laundry_type: InvoiceLaundryType | null;
  laundry_type_label: string | null;

  /**
   * The date columns, ascending — ONLY the dates that actually carry orders.
   *
   * A fortnight with orders on four days is four columns, not fourteen. Empty
   * columns would push the ones that matter off the page for no information.
   */
  dates: string[];
  /** Map of date (YYYY-MM-DD) -> list of order_numbers on that date. */
  orders_by_date?: Record<string, string[]>;
  rows: ItemQuantityRow[];

  /** Column totals, keyed by the same date keys. */
  totals_by_date: Record<string, number>;
  /** The bottom-right cell: every piece in the period. */
  grand_total: number;
  /** Every row's amount added up, ex-tax. */
  amount_total: number;
  /** How many orders the grid was built from. */
  order_count: number;
}

function requireDate(value: unknown, label: string): string {
  const date = typeof value === 'string' ? value.trim() : '';
  if (!date || !DATE_ONLY.test(date)) {
    throw new AppError(`${label} must be a date in YYYY-MM-DD format.`, 400);
  }
  return date;
}

/**
 * Builds the report for one business, one date range and one laundry type.
 *
 * Both dates are REQUIRED here, unlike `buildInvoice` — this document is only
 * ever generated for the range an invoice was just generated for, so there is
 * no billing-cycle fallback to guess with. The caller passes the invoice's
 * own period, which is what keeps the two documents on the same window.
 */
export async function buildItemQuantityReport(
  businessId: string,
  fromDate: unknown,
  toDate: unknown,
  laundryType?: InvoiceLaundryType | null
): Promise<ItemQuantityReport> {
  const from = requireDate(fromDate, 'From date');
  const to = requireDate(toDate, 'To date');
  if (from > to) {
    throw new AppError('From date cannot be after To date.', 400);
  }

  const businessResult = await query<any>(
    `SELECT id, name, establishment_name, legal_name, gst_number,
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
   * ONE ROW PER ITEM PER DAY.
   *
   * Grouped by the item's name and the order's date in the BUSINESS's
   * timezone — the same `CONVERT_TZ` expression the invoice filters on, so
   * the two documents agree about which day an order near midnight fell on.
   *
   * Not grouped by rate, unlike the invoice: this is a count of pieces, and
   * the same towel at two prices is still the same towel here.
   */
  const rowsResult = await query<any>(
    `SELECT oi.service_name AS item_name,
            DATE_FORMAT(DATE(CONVERT_TZ(o.created_at, '+00:00', ?)), '%Y-%m-%d') AS order_date,
            SUM(oi.quantity) AS quantity,
            SUM(COALESCE(oi.original_quantity, oi.quantity)) AS ordered_quantity,
            SUM(COALESCE(oi.defective_quantity, 0)) AS defective_quantity,
            -- The money this item accounts for on this day, from the SNAPSHOT
            -- price the order was placed at. Multiplied per row before it is
            -- summed, so an item whose price changed mid-period still totals
            -- correctly instead of being averaged first.
            SUM(oi.quantity * COALESCE(oi.unit_price, 0)) AS amount
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       JOIN business_users bu ON bu.id = o.business_user_id
      WHERE bu.business_id = ?
        AND o.status <> 'CANCELLED'
        AND DATE(CONVERT_TZ(o.created_at, '+00:00', ?)) BETWEEN ? AND ?
        ${laundryType ? 'AND o.laundry_type = ? AND oi.laundry_type = ?' : ''}
      GROUP BY oi.service_name, order_date
      ORDER BY oi.service_name ASC, order_date ASC`,
    laundryType
      ? [
          config.BUSINESS_TZ_OFFSET,
          businessId,
          config.BUSINESS_TZ_OFFSET,
          from,
          to,
          laundryType,
          laundryType,
        ]
      : [config.BUSINESS_TZ_OFFSET, businessId, config.BUSINESS_TZ_OFFSET, from, to]
  );

  if (rowsResult.rows.length === 0) {
    throw new AppError(
      typeLabel
        ? `This business has no ${typeLabel} orders in the selected period.`
        : 'This business has no orders in the selected period.',
      404
    );
  }

  // How many orders stand behind the grid — stated on the report so it can be
  // reconciled against the invoice's own order count.
  const orderCountResult = await query<{ c: number }>(
    `SELECT COUNT(*) AS c
       FROM orders o
       JOIN business_users bu ON bu.id = o.business_user_id
      WHERE bu.business_id = ?
        AND o.status <> 'CANCELLED'
        AND DATE(CONVERT_TZ(o.created_at, '+00:00', ?)) BETWEEN ? AND ?
        ${laundryType ? 'AND o.laundry_type = ?' : ''}`,
    laundryType
      ? [businessId, config.BUSINESS_TZ_OFFSET, from, to, laundryType]
      : [businessId, config.BUSINESS_TZ_OFFSET, from, to]
  );

  // Pivot the flat (item, date, qty) rows into the grid.
  const dateSet = new Set<string>();
  const byItem = new Map<string, ItemQuantityRow>();

  for (const row of rowsResult.rows) {
    const date = String(row.order_date);
    const name = String(row.item_name ?? '').trim() || 'Unnamed item';
    const quantity = Number(row.quantity || 0);

    dateSet.add(date);

    let entry = byItem.get(name);
    if (!entry) {
      entry = {
        item_name: name, by_date: {}, total: 0, ordered_total: 0, defective_total: 0,
        rate: 0, amount: 0,
      };
      byItem.set(name, entry);
    }
    // Summed rather than assigned: the group above is already one row per
    // item per day, but an item whose name differs only by trimming would
    // otherwise overwrite instead of adding.
    entry.by_date[date] = (entry.by_date[date] || 0) + quantity;
    entry.total += quantity;
    entry.ordered_total += Number(row.ordered_quantity || row.quantity || 0);
    entry.defective_total += Number(row.defective_quantity || 0);
    entry.amount += Number(row.amount || 0);
  }

  /** Rounds to paise, so the parts always add up to the total shown. */
  const money = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

  // The rate falls out of the money and the pieces — see `rate` on the row.
  for (const entry of byItem.values()) {
    entry.amount = money(entry.amount);
    entry.rate = entry.total > 0 ? money(entry.amount / entry.total) : 0;
  }

  const dates = Array.from(dateSet).sort();
  const rows = Array.from(byItem.values()).sort((a, b) =>
    a.item_name.localeCompare(b.item_name)
  );

  const totalsByDate: Record<string, number> = {};
  for (const date of dates) {
    totalsByDate[date] = rows.reduce((sum, row) => sum + (row.by_date[date] || 0), 0);
  }
  const grandTotal = rows.reduce((sum, row) => sum + row.total, 0);
  const amountTotal = money(rows.reduce((sum, row) => sum + row.amount, 0));

  const ordersPerDateResult = await query<{ order_date: string; order_number: string }>(
    `SELECT DATE_FORMAT(DATE(CONVERT_TZ(o.created_at, '+00:00', ?)), '%Y-%m-%d') AS order_date,
            o.order_number
       FROM orders o
       JOIN business_users bu ON bu.id = o.business_user_id
      WHERE bu.business_id = ?
        AND o.status <> 'CANCELLED'
        AND DATE(CONVERT_TZ(o.created_at, '+00:00', ?)) BETWEEN ? AND ?
        ${laundryType ? 'AND o.laundry_type = ?' : ''}
      ORDER BY o.created_at ASC`,
    laundryType
      ? [config.BUSINESS_TZ_OFFSET, businessId, config.BUSINESS_TZ_OFFSET, from, to, laundryType]
      : [config.BUSINESS_TZ_OFFSET, businessId, config.BUSINESS_TZ_OFFSET, from, to]
  );

  const ordersByDate: Record<string, string[]> = {};
  for (const row of ordersPerDateResult.rows) {
    const d = String(row.order_date);
    if (!ordersByDate[d]) ordersByDate[d] = [];
    if (!ordersByDate[d].includes(row.order_number)) {
      ordersByDate[d].push(row.order_number);
    }
  }

  const reportDateResult = await query<{ d: string }>(
    `SELECT DATE_FORMAT(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', ?), '%Y-%m-%d') AS d`,
    [config.BUSINESS_TZ_OFFSET]
  );

  /*
   * The SAME number the invoice for this business, period and type carries, so
   * the two documents are visibly one pair rather than two loose files.
   *
   * READ, not derived. The invoice's number comes from a counter now, so
   * rebuilding it from the business and the dates would print a number that
   * names no invoice — and this sheet exists precisely to be read alongside
   * one. The derived form remains the fallback for a period whose invoice has
   * not been issued yet, which is what this always showed.
   */
  const invoiceNumber =
    (await issuedInvoiceNumberFor(String(business.id), from, to, laundryType ?? null)) ??
    invoiceNumberFor(String(business.id), from, to, laundryType ?? null);

  logger.info(
    `[ItemReport] built for ${invoiceNumber}: ${rows.length} item(s) over ${dates.length} date(s), ` +
      `type ${typeLabel ?? 'all'}, ${grandTotal} piece(s)`
  );

  return {
    invoice_number: invoiceNumber,
    invoice_number_display: displayInvoiceNumber(invoiceNumber),
    report_date: String(reportDateResult.rows[0].d),

    business: {
      id: String(business.id),
      name: business.establishment_name || business.name,
      legal_name: business.legal_name || null,
      address: business.address || business.establishment_address || null,
      city: business.city || null,
      state: business.state || null,
      pincode: business.pincode || null,
      gstin: business.gst_number || null,
    },

    supplier: {
      legal_name: config.COMPANY_LEGAL_NAME,
      address: config.COMPANY_ADDRESS,
      gstin: config.COMPANY_GSTIN || null,
      email: config.COMPANY_EMAIL || null,
      phone: config.COMPANY_PHONE || null,
    },

    period: { from, to },
    laundry_type: laundryType ?? null,
    laundry_type_label: typeLabel,

    dates,
    orders_by_date: ordersByDate,
    rows,
    totals_by_date: totalsByDate,
    grand_total: grandTotal,
    amount_total: amountTotal,
    order_count: Number(orderCountResult.rows[0]?.c || 0),
  };
}
