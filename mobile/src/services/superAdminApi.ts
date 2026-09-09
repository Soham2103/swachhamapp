import * as SecureStore from 'expo-secure-store';
import { API_BASE_URL } from '../constants/api';
import apiClient from './api';
import { ApiResponse } from '../types';
// The Order Detail tab hands this straight to the existing Order Confirmation
// PDF generator, so it must be the business app's own order shape and not a
// look-alike defined here.
import { BusinessOrderDetail } from './businessOrderApi';

/**
 * Super Admin API.
 *
 * Same axios client as every other module, so the bearer token, base URL
 * and error shaping are the ones the app already has.
 */

export interface ChannelSummary {
  channel: 'B2B' | 'B2C';
  orders: number;
  revenue: number;
  average_order_value: number;
}

export interface SalesSummary {
  from: string;
  to: string;
  channels: ChannelSummary[];
  totals: { orders: number; revenue: number; cancelled_orders: number };
}

export interface SalesPoint {
  period: string;
  b2b_revenue: number;
  b2c_revenue: number;
  b2b_orders: number;
  b2c_orders: number;
}

export interface SalesTimeseries {
  from: string;
  to: string;
  granularity: string;
  points: SalesPoint[];
}

export interface PendingBusiness {
  id: string;
  name: string;
  business_type: string;
  contact_person_name: string | null;
  mobile_number: string | null;
  email: string | null;
  city: string | null;
  gst_number: string | null;
  status: string;
  created_at: string;
}

export interface PendingRider {
  id: string;
  name: string | null;
  email: string | null;
  mobile_number: string;
  approval_status: string | null;
  is_active: boolean;
  created_at: string;
}

export interface MissingField {
  key: string;
  label: string;
}

export interface BusinessCompletenessRow {
  business_id: string;
  business_name: string;
  status: string;
  gst_number: string | null;
  is_complete: boolean;
  missing_fields: MissingField[];
}

export interface BusinessDetail {
  /** B2B or B2C. */
  registration_type: RegistrationType;
  business_id: string;
  business_name: string;
  customer_type: string | null;
  other_type_specify: string | null;
  establishment_address: string | null;
  gst_number: string | null;
  pan_number: string | null;
  website: string | null;
  contact_person_name: string | null;
  designation: string | null;
  mobile_number: string | null;
  whatsapp_number: string | null;
  email_id: string | null;
  alternate_contact_person: string | null;
  alternate_mobile_no: string | null;
  status: string;
  is_complete: boolean;
  missing_fields: MissingField[];
}


/** The verified GSTIN details, as the backend normalised them. */
export interface GstDetails {
  gstin: string;
  legalName: string | null;
  tradeName: string | null;
  registrationStatus: string | null;
  businessType: string | null;
  state: string | null;
  registrationDate: string | null;
}

/**
 * The outcome of a verification call.
 *
 * `verified: false` is a real answer from the provider — the GSTIN is
 * unknown or the registration is not active — and carries a message to show.
 * A provider or configuration fault arrives as a thrown error instead.
 */
/** What POST /gst/lookup returns — the shape BusinessForm consumes. */
export interface GstLookupResult {
  verified: boolean;
  data?: {
    gstin: string;
    /** Derived by the server from GSTIN characters 3-12. Never typed. */
    pan_number: string;
    legalName: string | null;
    tradeName: string | null;
    registrationStatus: string | null;
    state: string | null;
    address: string | null;
    city: string | null;
    pincode: string | null;
  };
  message?: string;
}

export interface GstVerification {
  verified: boolean;
  details: GstDetails | null;
  message?: string;
}

/* ---- Price List ---- */

/**
 * One row of the GLOBAL customer price list: same price for everyone.
 *
 * ONE ROW PER (ITEM, SERVICE). An item priced for Wash and Fold and for Dry
 * Clean is two rows, told apart by `service_label`.
 */
export interface CustomerPrice {
  id: string;
  item_id: string;
  item_name: string;
  /** The service this price is for; null when it covers every service. */
  service_id: string | null;
  service_name: string | null;
  /** `service_name`, or "All services". Always safe to display. */
  service_label: string;
  category_id: string | null;
  category_name: string | null;
  parent_category_id: string | null;
  parent_category_name: string | null;
  service_types: string[];
  unit: string;
  customer_price: number;
  original_price: number | null;
  is_active: boolean;
  /** False when the catalogue item itself is deactivated. */
  item_is_active: boolean;
}

/** Hotel Laundry / Guest Laundry, as the API and database spell them. */
export type LaundryTypeValue = 'hotel' | 'guest';

export interface LaundryTypeOption {
  value: LaundryTypeValue;
  label: string;
}

/**
 * One row of a business's own price list, AT ONE LAUNDRY TYPE.
 *
 * A business is priced separately for Hotel Laundry and Guest Laundry, so a
 * row is identified by (business, item, laundry type). `id` and `price` are
 * null for an item that has no price at this type yet — the list deliberately
 * includes those so "not set" is visible rather than missing.
 */
export interface BusinessPrice {
  id: string | null;
  business_id: string;
  item_id: string;
  laundry_type: LaundryTypeValue;
  laundry_type_label: string;
  item_name: string;
  parent_category_id: string | null;
  parent_category_name: string | null;
  category_id: string | null;
  category_name: string | null;
  /**
   * The SERVICE this line prices.
   *
   * The price list has ONE LINE PER SERVICE the item is offered for, so this
   * is set on every line of a normal item. Null only for an item with no
   * services configured at all.
   */
  service_id: string | null;
  service_name: string | null;
  /** What the Service column shows. "All services" when there is no service. */
  service_label: string;
  /**
   * The item's base rate, when this service has no rate of its own — what an
   * order for this service would fall back to. Null when nothing is
   * inherited and the service really is unpriced.
   */
  inherited_price: number | null;
  /** True when this line bills `inherited_price` rather than its own rate. */
  is_inherited: boolean;
  /** What an order for this item + service would ACTUALLY be charged. */
  effective_price: number | null;
  /** Every service the ITEM is offered for, as codes. */
  service_types: string[];
  unit: string;
  /** The global customer price, for reference only. */
  customer_price: number | null;
  price: number | null;
  is_active: boolean;
  item_is_active: boolean;
}

/* ---- Bulk price update from an Excel sheet ---- */

/** What became of one row of the uploaded sheet. Only `invalid` is an error. */
export type PriceUploadRowStatus =
  | 'updated'
  | 'item_created'
  | 'unchanged'
  | 'price_not_set'
  | 'invalid';

export interface PriceUploadRow {
  /** The row number as the SPREADSHEET shows it — its header is row 1. */
  row: number;
  main_category: string;
  subcategory: string;
  service_type: string;
  item_name: string;
  /** The Price cell exactly as it was typed. */
  price: string;
  status: PriceUploadRowStatus;
  /** Why it failed. Null on every status but `invalid`. */
  reason: string | null;
  current_price?: number | null;
  /** Null when the Price cell was blank — "Price Not Set", not zero. */
  new_price?: number | null;
  /** True when this row adds the item to the catalogue. */
  creates_item?: boolean;
}

export interface PriceUploadResult {
  business: { id: string; name: string };
  laundry_type: LaundryTypeValue;
  laundry_type_label: string;
  /** False on the preview, which writes nothing. */
  applied: boolean;
  /** Rows that carried anything. Blank rows are not counted here. */
  total_rows: number;
  /** Wholly empty rows, skipped in silence. */
  blank_skipped: number;
  /** The item did not exist and was added to the catalogue. */
  items_created: number;
  /** An item already on the list had its price written or moved. */
  updated: number;
  /** Matched, and the sheet's figure is the one already stored. */
  unchanged: number;
  /**
   * Valid rows left with no price, because the Price cell was blank.
   * NOT disjoint from `items_created`: a new item with no price is both.
   */
  price_not_set: number;
  /** The only count that means something went wrong. */
  errors: number;
  failed_rows: PriceUploadRow[];
  changed_rows: PriceUploadRow[];
}

export interface PriceableItem {
  id: string;
  name: string;
  category_id: string | null;
  category_name: string | null;
  parent_category_id: string | null;
  parent_category_name: string | null;
  unit: string;
  scope: string;
  is_active: boolean;
  service_types: string[];
  has_customer_price: boolean;
}

/**
 * One node of the Category -> Sub-category tree.
 *
 * `parent_id === null` means it IS a Category; otherwise it is a
 * Sub-category of that id. The whole tree arrives in one call and the client
 * groups it, so choosing a Category needs no round trip.
 */
export interface ItemCategory {
  id: string;
  name: string;
  scope: string;
  parent_id: string | null;
  is_top_level: boolean;
  item_count: number;
}

/** A staff account the Super Admin manages. */
export interface StaffAccount {
  id: string;
  role: 'MANAGER' | 'RIDER' | 'SORTER';
  name: string | null;
  email: string | null;
  mobile_number: string;
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
  request_count: number;
  order_count: number;
}

/** A business master record, as the management page shows it. */
export interface BusinessAdmin {
  id: string;
  name: string;
  legal_name: string | null;
  establishment_name: string | null;
  address: string | null;
  establishment_address: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  gst_number: string | null;
  pan_number: string | null;
  billing_cycle: string | null;
  status: string;
  /** The establishment CATEGORY (hotel, restaurant…). */
  business_type: string | null;
  /** B2B or B2C — the registration type. */
  registration_type: RegistrationType;
  contact_person_name: string | null;
  designation: string | null;
  mobile_number: string | null;
  whatsapp_number: string | null;
  email_id: string | null;
  created_at: string;
  order_count: number;
  account_email: string | null;
  contacts?: BusinessContact[];
}

export interface BusinessContact {
  id: string;
  business_id: string;
  contact_type: 'BUSINESS_HEAD' | 'ALTERNATIVE';
  name: string;
  designation: string | null;
  mobile: string | null;
  whatsapp: string | null;
  email: string | null;
  /** Whether this number may be used to identify the business at sign-in. */
  login_enabled: boolean;
  /** True when this contact also carries credentials, i.e. it can sign in. */
  has_login?: boolean;
}

/**
 * B2B or B2C.
 *
 * A B2B account must carry a GST number; a B2C one does not have one, and the
 * server discards a GSTIN sent with a B2C submission rather than storing it.
 */
export type RegistrationType = 'B2B' | 'B2C';

export const REGISTRATION_TYPES: Array<{ value: RegistrationType; label: string }> = [
  { value: 'B2B', label: 'B2B' },
  { value: 'B2C', label: 'B2C' },
];

/* ---- Business Account ---- */

export interface BusinessAccountSummary {
  id: string;
  /** The ESTABLISHMENT name — the display name everywhere. */
  name: string;
  legal_name: string | null;
  gst_number: string | null;
  status: string;
  registration_type: string;
  billing_cycle: string | null;
  order_count: number;
  receipt_count: number;
}

export interface BusinessAccountOrder {
  id: string;
  order_number: string;
  status: string;
  created_at: string;
  laundry_type: string | null;
  order_type: string | null;
  subtotal: string | number | null;
  total: string | number | null;
  total_weight_kg: string | number | null;
  /**
   * The number the order was actually placed on -- `orders.placed_by_mobile`,
   * the one that passed OTP for that session. NULL for orders placed before
   * the field existed; nothing substitutes the business's own number for it.
   */
  placed_by_mobile: string | null;
  placed_by_name: string | null;
  /**
   * The invoice this order falls under, derived from the business's billing
   * cycle and the order's own date -- the same number `buildInvoice` gives
   * that period's invoice. NULL for a cancelled order, which is billed on no
   * invoice.
   */
  invoice_number: string | null;
  /** The short form that is shown; see `invoice_number`. */
  invoice_number_display: string | null;
  item_count: number;
  total_quantity: number;
}

/**
 * One row of a business's Invoice History.
 *
 * The amounts are SNAPSHOTS: what the invoice was issued for at the moment it
 * was generated, not a recomputation from today's orders. `amount_paid` is
 * summed from the payment receipts recorded against this invoice number, and
 * `status` is derived from it — so an invoice cannot show as unpaid once money
 * has been recorded against it.
 */
export interface InvoiceHistoryEntry {
  id: string;
  /** The full invoice number — the identifier everything keys on. */
  invoice_number: string;
  /** The first 12 characters, which is what is shown. */
  invoice_number_display: string;
  business_id: string;
  business_name: string;
  period_from: string;
  period_to: string;
  billing_cycle: string;
  /** "Weekly", "15 Days", "Monthly", "Yearly". */
  billing_cycle_label: string;
  period_label: string;
  laundry_type: 'hotel' | 'guest' | null;
  laundry_type_label: string | null;
  /** The deduction the invoice was issued with, as a percentage. 0 for none. */
  discount_percent: number;
  /** The lines added up before any deduction — the Sub Total the PDF prints. */
  subtotal_amount: number;
  /** What that deduction came to in rupees. 0 when there was none. */
  discount_amount: number;
  taxable_amount: number;
  tax_amount: number;
  total_amount: number;
  order_count: number;
  line_count: number;
  status: 'ISSUED' | 'PART_PAID' | 'PAID' | 'CANCELLED';
  amount_paid: number;
  amount_due: number;
  generated_at: string;
  /**
   * The last time the document was produced — what the list is ordered by, so
   * a re-issued invoice comes back to the top without its invoice date moving.
   */
  last_generated_at: string;
  /**
   * "Last Generated On": the same moment as a plain YYYY-MM-DD, already in the
   * server's calendar. Use this for display — `last_generated_at` is a UTC
   * instant and slicing it can be a day out.
   */
  last_generated_on: string;
  /**
   * THE INVOICE DATE the PDF prints: the billing period's last day plus two.
   * A fact about the cycle, so regenerating the invoice never moves it — which
   * is exactly what distinguishes it from `last_generated_on`.
   */
  invoice_date: string;
}

/* ===================================================================
 * PURCHASE, SUPPLIER AND EXPENSE
 *
 * Every money field here is the SERVER'S figure. The purchase form computes
 * the same totals locally so the operator sees them update as they type, but
 * what is saved is always recomputed from the lines by the backend — see
 * `createPurchase`.
 * =================================================================== */

/** Cash, UPI, Bank Transfer, Card, Cheque, Other. */
export type PurchasePaymentMethod =
  | 'CASH' | 'UPI' | 'BANK_TRANSFER' | 'CARD' | 'CHEQUE' | 'OTHER';
export type PurchasePaymentStatus = 'UNPAID' | 'PARTIAL' | 'PAID';
export type PurchaseStatusValue = 'DRAFT' | 'RECEIVED' | 'RETURNED' | 'CANCELLED';

export interface PurchaseOptions {
  payment_methods: Array<{ value: PurchasePaymentMethod; label: string }>;
  purchase_statuses: PurchaseStatusValue[];
  payment_statuses: PurchasePaymentStatus[];
}

export interface Supplier {
  id: string;
  name: string;
  business_name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  gstin: string | null;
  opening_balance: number;
  notes: string | null;
  is_active: boolean;
  purchase_count: number;
  total_purchased: number;
  total_paid: number;
  /** opening_balance + total_purchased - total_paid. */
  outstanding: number;
}

export interface SupplierInput {
  name?: string;
  business_name?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  gstin?: string | null;
  opening_balance?: string | number;
  notes?: string | null;
  is_active?: boolean;
}

export interface SupplierPurchaseRef {
  id: string;
  purchase_number: string;
  purchase_date: string;
  invoice_number: string | null;
  total_amount: number;
  paid_amount: number;
  balance_amount: number;
  payment_status: PurchasePaymentStatus;
  purchase_status: PurchaseStatusValue;
}

export interface PurchaseLine {
  item_id: string | null;
  description: string;
  quantity: number;
  unit: string | null;
  rate: number;
  discount: number;
  tax: number;
  /** (quantity x rate) - discount + tax, computed by the server. */
  amount: number;
}

export interface Purchase {
  id: string;
  purchase_number: string;
  supplier_id: string;
  supplier_name: string;
  supplier_phone: string | null;
  supplier_gstin: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  purchase_date: string;
  due_date: string | null;
  subtotal: number;
  discount: number;
  tax: number;
  additional_charges: number;
  shipping_charges: number;
  round_off: number;
  total_amount: number;
  paid_amount: number;
  balance_amount: number;
  payment_status: PurchasePaymentStatus;
  purchase_status: PurchaseStatusValue;
  payment_type: PurchasePaymentMethod | null;
  notes: string | null;
  item_count: number;
  created_at: string;
  updated_at: string;
}

export interface PurchasePayment {
  id: string;
  purchase_id: string;
  amount: number;
  payment_method: PurchasePaymentMethod;
  payment_method_label: string;
  payment_date: string;
  reference_number: string | null;
  notes: string | null;
  created_at: string;
}

export interface PurchaseDetail extends Purchase {
  items: PurchaseLine[];
  payments: PurchasePayment[];
}

/** What the form sends. Deliberately carries NO total — the server computes it. */
export interface PurchaseInput {
  supplier_id?: string;
  invoice_number?: string | null;
  invoice_date?: string | null;
  purchase_date?: string;
  due_date?: string | null;
  payment_type?: PurchasePaymentMethod | null;
  purchase_status?: PurchaseStatusValue;
  notes?: string | null;
  discount?: string | number;
  additional_charges?: string | number;
  shipping_charges?: string | number;
  round_off?: string | number;
  items?: Array<{
    item_id?: string | null;
    description?: string;
    quantity?: string | number;
    unit?: string | null;
    rate?: string | number;
    discount?: string | number;
    tax?: string | number;
  }>;
}

export interface PurchasePaymentInput {
  amount?: string | number;
  payment_method?: PurchasePaymentMethod;
  payment_date?: string;
  reference_number?: string | null;
  notes?: string | null;
}

export interface PurchaseListParams {
  search?: string;
  supplier_id?: string;
  payment_status?: PurchasePaymentStatus;
  purchase_status?: PurchaseStatusValue;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
  sort?: string;
}

export interface PurchaseSummary {
  total_purchases: number;
  total_amount: number;
  this_month_count: number;
  this_month_amount: number;
  today_count: number;
  today_amount: number;
  unpaid_count: number;
  partial_count: number;
  paid_count: number;
  returned_count: number;
  outstanding_amount: number;
}

export interface ExpenseCategory {
  id: string;
  name: string;
  is_active: boolean;
  /** How many expenses use it — what makes it undeletable. */
  expense_count: number;
}

export interface Expense {
  id: string;
  expense_number: string;
  category_id: string;
  category_name: string;
  expense_date: string;
  description: string | null;
  amount: number;
  payment_method: PurchasePaymentMethod;
  payment_method_label: string;
  payment_status: 'PAID' | 'UNPAID';
  paid_by: string | null;
  reference_number: string | null;
  notes: string | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExpenseInput {
  category_id?: string;
  expense_date?: string;
  description?: string | null;
  amount?: string | number;
  payment_method?: PurchasePaymentMethod;
  payment_status?: 'PAID' | 'UNPAID';
  paid_by?: string | null;
  reference_number?: string | null;
  notes?: string | null;
}

export interface ExpenseListParams {
  search?: string;
  category_id?: string;
  payment_method?: PurchasePaymentMethod;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
  sort?: string;
}

export interface ExpenseCategoryTotal {
  category_id: string;
  category_name: string;
  amount: number;
  count: number;
}

export interface ExpenseSummary {
  total_count: number;
  total_amount: number;
  today_amount: number;
  this_month_amount: number;
  this_year_amount: number;
  unpaid_count: number;
  unpaid_amount: number;
  category_count: number;
  top_categories: ExpenseCategoryTotal[];
}


/* ===================================================================
 * KG REPORTS
 *
 * Weight processed, month by month. Every figure is computed by the server
 * from the order register — see `kgReport.service` — so nothing here sums,
 * converts or rounds anything.
 * =================================================================== */

export interface KgMonth {
  /** 'YYYY-MM'. */
  month: string;
  /** 'August 2026'. */
  label: string;
  orders: number;
  items: number;
  total_kg: number;
  /** Only on the all-customers report. */
  customers?: number;
}

export interface KgReport {
  from: string;
  to: string;
  /** Every month in the window, including those with no orders. */
  months: KgMonth[];
  totals: { orders: number; items: number; total_kg: number; customers: number };
  /** Present only on the per-customer report. */
  business?: { id: string; name: string };
}


/** One line of the ITEM WISE KG report. */
export interface ItemKgRow {
  item_id: string;
  item_name: string;
  /** Total quantity of this item in the window. */
  pieces: number;
  total_kg: number;
}

/**
 * The window every KG report accepts, and the two selections that narrow it.
 *
 * `business_id` and `laundry_type` are OMITTED for All — an absence rather
 * than a sentinel — so a report asked for without them is the report exactly
 * as it was before the filters existed.
 */
export interface KgReportParams {
  year?: number | string;
  month?: number | string;
  from?: string;
  to?: string;
  /** A business id, or omitted for every establishment. */
  business_id?: string;
  /** 'hotel' | 'guest', or omitted for both. */
  laundry_type?: string;
}

/** One axis entry of a pivot: the key cells are addressed by, and its label. */
export interface KgPivotAxis {
  key: string;
  label: string;
}

/**
 * A KG grid — hotels or items down the side, months or items across the top.
 *
 * Every row carries every column, zero-filled by the server, so the screen
 * never has to decide what a missing cell means.
 */
export interface KgPivotReport {
  from: string;
  to: string;
  columns: KgPivotAxis[];
  rows: Array<{
    key: string;
    label: string;
    cells: Record<string, number>;
    total_kg: number;
  }>;
  column_totals: Record<string, number>;
  grand_total_kg: number;
}

/** One line of the day-wise report: a day, a hotel, an item and its KG. */
export interface DayWiseKgRow {
  date: string;
  date_label: string;
  business_id: string;
  hotel_name: string;
  laundry_type: 'hotel' | 'guest';
  laundry_type_label: 'Hotel' | 'Guest';
  item_id: string;
  item_name: string;
  total_qty: number;
  total_kg: number;
}

export interface DayWiseKgReport {
  from: string;
  to: string;
  rows: DayWiseKgRow[];
  totals: { days: number; hotels: number; items: number; total_qty: number; total_kg: number };
}

export interface ItemKgReport {
  from: string;
  to: string;
  items: ItemKgRow[];
  totals: { item_count: number; pieces: number; total_kg: number; orders: number };
  /** Absent when the report covers ALL BUSINESS. */
  business?: { id: string; name: string };
  /** The ordering the server applied, echoed back. */
  sort: ItemKgSort;
}

export type ItemKgSort =
  | 'kg_desc' | 'kg_asc' | 'pieces_desc' | 'pieces_asc' | 'name_asc' | 'name_desc';


/* ---- Outstanding report ---- */

export interface OutstandingRow {
  business_id: string;
  establishment_name: string;
  legal_name: string | null;
  primary_contact_name: string | null;
  primary_contact_number: string | null;
  email: string | null;
  establishment_address: string | null;
  outstanding: number;
}

export interface OutstandingReport {
  rows: OutstandingRow[];
  totals: {
    /** Establishments WITH an outstanding amount. */
    establishments: number;
    total_outstanding: number;
    /** Every establishment considered, owing or not. */
    considered: number;
  };
  sort: OutstandingSort;
  min_outstanding: number;
}

export type OutstandingSort =
  | 'outstanding_desc' | 'outstanding_asc' | 'name_asc' | 'name_desc';


/* ---- Transaction summary (home page grid) ---- */

/** One card: an amount and the count behind it. */
export interface SummaryCell { amount: number; count: number }

/** One metric across the four periods. */
export interface SummaryMetric {
  today: SummaryCell;
  month: SummaryCell;
  year: SummaryCell;
  total: SummaryCell;
}

/** Which Sale card was opened. Only these two are clickable. */
export type SalePeriod = 'today' | 'month';

/** One order behind a Sale card. */
export interface SaleDetailRow {
  order_id: string;
  order_number: string;
  /** The establishment's `establishment_name`, or the customer's own name. */
  name: string;
  party_type: 'BUSINESS' | 'CUSTOMER';
  /** `orders.total` — the same column the card sums. */
  amount: number;
  created_at: string;
}

export interface SaleDetail {
  period: SalePeriod;
  rows: SaleDetailRow[];
  /** The server's own total for the list, so the view need not add it up. */
  total_amount: number;
  count: number;
  as_of: string;
}

export interface TransactionSummary {
  /** Everything billed, both kinds of order together. */
  sale: SummaryMetric;
  /** The part of `sale` placed by a walk-in customer. */
  sale_customer: SummaryMetric;
  /** The part of `sale` placed by an establishment. */
  sale_business: SummaryMetric;
  collection: SummaryMetric;
  product_count: SummaryMetric;
  expense: SummaryMetric;
  /** The day the periods were cut on, in the business timezone. */
  as_of: string;
}

/** A business customer there is actually a report for. */
export interface ReportableBusiness {
  id: string;
  name: string;
  orders: number;
  total_kg: number;
}

export type PaymentTypeValue = 'CASH' | 'CARD' | 'UPI' | 'NETBANKING';

export interface PaymentReceipt {
  id: string;
  receipt_number: string;
  business_id: string;
  /** The full identifier. */
  invoice_number: string;
  /** The first 12 characters — what is shown. */
  invoice_number_display: string;
  invoice_period_from: string;
  invoice_period_to: string;
  payment_date: string;
  payment_type: PaymentTypeValue;
  payment_reference: string | null;
  previous_balance: number;
  current_invoice_amount: number;
  total_amount_due: number;
  payment_received: number;
  remaining_balance: number;
  notes: string | null;
  created_at: string;
}

/**
 * What the Payment Receipt tab opens with.
 *
 * Every figure is computed by the server: the latest invoice, its total, the
 * previous balance from the stored ledger, and what is still outstanding.
 * Nothing here is typed by the operator.
 */
export interface PaymentContext {
  business: { id: string; name: string };
  invoice: {
    invoice_number: string;
    invoice_number_display: string;
    invoice_date: string;
    period: { from: string; to: string; label: string };
    current_invoice_amount: number;
  } | null;
  previous_balance: number;
  total_amount_due: number;
  already_received: number;
  outstanding: number;
  periods: Array<{ from: string; to: string; label: string; cycle: string }>;
  receipts: PaymentReceipt[];
  message?: string;
}

export interface BillingPeriod {
  from: string;
  to: string;
  cycle: string;
  label: string;
}

export interface LaundryServiceType {
  id: string;
  name: string;
  code: string;
}

/* ---- Creation requests + manager accounts ---- */

export type RequestType = 'BUSINESS' | 'RIDER' | 'SORTER';
export type RequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

/** A Manager's proposal, awaiting a Super Admin decision. */
export interface CreationRequest {
  id: string;
  request_type: RequestType;
  status: RequestStatus;
  requested_by: string;
  /** The Manager who submitted it. */
  requested_by_name: string | null;
  subject_name: string;
  subject_email: string | null;
  /** The whole submitted form, so everything can be read before deciding. */
  payload: any;
  rejection_reason: string | null;
  approved_at: string | null;
  created_entity_id: string | null;
  /** FAILED means the account exists but the credentials never arrived. */
  email_status: 'NOT_SENT' | 'SENT' | 'FAILED';
  email_error: string | null;
  created_at: string;
}

export interface ApprovalOutcome {
  request: CreationRequest;
  created: { id: string; name: string; username: string };
  /** The password is never returned — only whether the email went out. */
  email: { sent: boolean; error?: string };
}

export interface ManagerAccount {
  id: string;
  name: string | null;
  email: string | null;
  mobile_number: string;
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
  pending: number;
  approved: number;
  rejected: number;
}

const superAdminApi = {
  /**
   * Verifies a GSTIN through the backend, which is what talks to the GST
   * provider.
   *
   * No provider URL or key exists in this app — it sends a number and renders
   * the answer, so the provider can change without touching the app.
   */
  verifyGst: async (gstin: string): Promise<GstVerification> => {
    const response = await apiClient.post('/api/super-admin/verify-gstin', { gstin });
    const body = response.data as any;
    // { verified: true, data: {...} } or { verified: false, gstin }
    return {
      verified: Boolean(body?.data?.verified),
      details: body?.data?.data ?? null,
      message: body?.message,
    };
  },

  /**
   * The signed-in super admin's token, needed by the PDF download.
   *
   * `expo-file-system` performs its own request, so it cannot borrow the
   * axios interceptor that normally attaches the bearer token.
   */
  /**
   * The richer GST lookup, in the SAME shape the Manager's endpoint returns.
   *
   * One shape, because one form component consumes it: BusinessForm is shared
   * by registration and editing, so both roles' lookups have to answer alike.
   * The PAN in the response is derived by the server and shown read-only.
   */
  gstLookup: async (gstin: string): Promise<GstLookupResult> => {
    const res = await apiClient.post<ApiResponse<GstLookupResult>>(
      '/api/super-admin/gst/lookup',
      { gstin }
    );
    return { ...res.data.data, message: res.data.message };
  },

  authHeader: async (): Promise<Record<string, string>> => {
    const token = await SecureStore.getItemAsync('swachham_access_token');
    return token ? { Authorization: `Bearer ${token}` } : {};
  },

  /**
   * The invoice URL for a business over a date range, both YYYY-MM-DD.
   *
   * `laundryType` picks the Hotel or the Guest invoice. Omitting it asks for
   * one covering both, which is what this endpoint has always returned.
   */
  invoicePdfUrl: (
    businessId: string,
    from: string,
    to: string,
    laundryType?: LaundryTypeValue | null,
    /** Percentage off the subtotal before GST. Omitted or 0 sends nothing. */
    discountPercent?: number | null
  ): string =>
    `${API_BASE_URL}/api/super-admin/businesses/${businessId}/invoice.pdf` +
    `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` +
    (laundryType ? `&laundry_type=${encodeURIComponent(laundryType)}` : '') +
    (discountPercent ? `&discount_percent=${encodeURIComponent(String(discountPercent))}` : ''),

  /**
   * The day-wise item quantity sheet that accompanies the invoice.
   *
   * TAKES THE SAME THREE ARGUMENTS AS `invoicePdfUrl` ON PURPOSE. The screen
   * passes the values it just generated the invoice with, so the two
   * documents cannot be built over different windows or different types.
   */
  itemReportPdfUrl: (
    businessId: string,
    from: string,
    to: string,
    laundryType?: LaundryTypeValue | null
  ): string =>
    `${API_BASE_URL}/api/super-admin/businesses/${businessId}/item-report.pdf` +
    `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` +
    (laundryType ? `&laundry_type=${encodeURIComponent(laundryType)}` : ''),

  /* ---- Backdated walking orders ---- */

  /** The Excel template, built from this business's own priced catalogue. */
  walkingOrderTemplateUrl: (businessId: string, laundryType: LaundryTypeValue): string =>
    `${API_BASE_URL}/api/super-admin/business-account/${businessId}/walking-orders/template.xlsx` +
    `?laundry_type=${encodeURIComponent(laundryType)}`,

  /**
   * Validates a filled sheet and reports what WOULD be created.
   *
   * Writes nothing. `fileBase64` is the .xlsx read off the device.
   */
  previewWalkingOrder: async (
    businessId: string,
    body: { order_date: string; laundry_type: LaundryTypeValue; file_base64: string }
  ): Promise<any> => {
    const response = await apiClient.post(
      `/api/super-admin/business-account/${businessId}/walking-orders/preview`,
      body
    );
    return (response.data as any).data;
  },

  /**
   * Creates the backdated order. Re-validates server-side before writing, and
   * the whole write is one transaction.
   */
  importWalkingOrder: async (
    businessId: string,
    body: {
      order_date: string;
      laundry_type: LaundryTypeValue;
      file_base64: string;
      confirm_duplicate?: boolean;
    }
  ): Promise<any> => {
    const response = await apiClient.post(
      `/api/super-admin/business-account/${businessId}/walking-orders/import`,
      body
    );
    return (response.data as any).data;
  },

  /** The same invoice as data, used to show the totals before downloading. */
  getInvoice: async (
    businessId: string,
    from: string,
    to: string,
    laundryType?: LaundryTypeValue | null,
    /** Percentage off the subtotal before GST. Omitted or 0 sends nothing. */
    discountPercent?: number | null
  ): Promise<any> => {
    const response = await apiClient.get(
      `/api/super-admin/businesses/${businessId}/invoice`,
      {
        params: {
          from,
          to,
          ...(laundryType ? { laundry_type: laundryType } : {}),
          ...(discountPercent ? { discount_percent: discountPercent } : {}),
        },
      }
    );
    return (response.data as any).data;
  },

  getSalesSummary: async (from?: string, to?: string): Promise<SalesSummary> => {
    const res = await apiClient.get<ApiResponse<SalesSummary>>('/api/super-admin/sales/summary', {
      params: { from, to },
    });
    return res.data.data;
  },

  getSalesTimeseries: async (
    from?: string,
    to?: string,
    granularity: 'day' | 'month' = 'day'
  ): Promise<SalesTimeseries> => {
    const res = await apiClient.get<ApiResponse<SalesTimeseries>>(
      '/api/super-admin/sales/timeseries',
      { params: { from, to, granularity } }
    );
    return res.data.data;
  },

  getBusinessApprovals: async (status = 'PENDING'): Promise<PendingBusiness[]> => {
    const res = await apiClient.get<ApiResponse<PendingBusiness[]>>(
      '/api/super-admin/approvals/businesses',
      { params: { status } }
    );
    return res.data.data;
  },

  getRiderApprovals: async (status = 'PENDING'): Promise<PendingRider[]> => {
    const res = await apiClient.get<ApiResponse<PendingRider[]>>(
      '/api/super-admin/approvals/riders',
      { params: { status } }
    );
    return res.data.data;
  },

  decideBusiness: async (id: string, action: 'approve' | 'reject', note?: string) => {
    const res = await apiClient.patch<ApiResponse<{ id: string; status: string }>>(
      `/api/super-admin/approvals/businesses/${id}`,
      { action, note }
    );
    return res.data.data;
  },

  decideRider: async (id: string, action: 'approve' | 'reject', note?: string) => {
    const res = await apiClient.patch<ApiResponse<{ id: string; approval_status: string }>>(
      `/api/super-admin/approvals/riders/${id}`,
      { action, note }
    );
    return res.data.data;
  },

  listBusinesses: async (onlyIncomplete = false): Promise<BusinessCompletenessRow[]> => {
    const res = await apiClient.get<ApiResponse<BusinessCompletenessRow[]>>(
      '/api/super-admin/businesses',
      { params: onlyIncomplete ? { incomplete: 'true' } : {} }
    );
    return res.data.data;
  },

  getBusinessDetail: async (id: string): Promise<BusinessDetail> => {
    const res = await apiClient.get<ApiResponse<BusinessDetail>>(
      `/api/super-admin/businesses/${id}`
    );
    return res.data.data;
  },

  updateBusinessDetail: async (id: string, payload: Record<string, unknown>): Promise<BusinessDetail> => {
    const res = await apiClient.put<ApiResponse<BusinessDetail>>(
      `/api/super-admin/businesses/${id}`,
      payload
    );
    return res.data.data;
  },

  /* `createBusiness` and `createRider` are gone.
   *
   * POST /api/super-admin/businesses and POST /api/super-admin/riders no
   * longer exist on the server, so keeping the client methods would only
   * offer a call that 404s. A business and a rider both come into existence
   * through the Manager request -> Super Admin approval path, which is
   * `approveRequest` below and is unchanged. */

  /* =================================================================
   * PRICE LIST
   *
   * Every call here is SUPER_ADMIN only on the server. No price is ever
   * calculated in this app: the amounts shown are the ones the backend
   * returned, and edits post a figure the backend re-validates.
   * ================================================================= */

  /** Catalogue items, for the item pickers. */
  getPriceableItems: async (
    options: {
      search?: string;
      unpriced?: boolean;
      /** Top-level category — matches everything beneath it. */
      categoryId?: string;
      /** Sub-category — narrower. */
      subcategoryId?: string;
      /**
       * WHICH PRICE LIST IS ASKING.
       *
       * Hotel Laundry prices the business catalogue; Guest Laundry prices the
       * customer garment categories. Sent by the Business Price List so its
       * picker cannot offer an item its own list would then refuse to show.
       * The Customer Price List omits it and gets the whole catalogue, which
       * is the behaviour this call has always had.
       */
      laundryType?: LaundryTypeValue;
    } = {}
  ): Promise<PriceableItem[]> => {
    const res = await apiClient.get<ApiResponse<PriceableItem[]>>(
      '/api/super-admin/prices/items',
      {
        params: {
          search: options.search,
          unpriced: options.unpriced ? 'true' : undefined,
          category_id: options.categoryId,
          subcategory_id: options.subcategoryId,
          laundry_type: options.laundryType,
        },
      }
    );
    return res.data.data;
  },

  /**
   * "+ Create New Item" -- creates the catalogue item and nothing else.
   *
   * The same endpoint serves BOTH price lists, so an item created from the
   * Business Price List is immediately available on the Customer Price List
   * and vice versa; there is one catalogue, not two.
   *
   * A duplicate name inside the same sub-category is refused by the server
   * with 409 and the message is shown verbatim.
   */
  createItem: async (payload: {
    item_name: string;
    category_id?: string;
    subcategory_id?: string;
    unit?: string;
    service_types?: string[];
  }): Promise<PriceableItem> => {
    const res = await apiClient.post<ApiResponse<PriceableItem>>(
      '/api/super-admin/items',
      payload
    );
    return res.data.data;
  },

  /**
   * The Category -> Sub-category tree for the pickers.
   *
   * `laundryType` narrows it to that price list's catalogue and names the
   * Guest categories as the Guest list names them (Men's / Women's / Kids).
   * Omitted, every item category comes back, as before.
   */
  getPriceCategories: async (laundryType?: LaundryTypeValue): Promise<ItemCategory[]> => {
    const res = await apiClient.get<ApiResponse<ItemCategory[]>>(
      '/api/super-admin/prices/categories',
      { params: { laundry_type: laundryType } }
    );
    return res.data.data;
  },

  getPriceServiceTypes: async (): Promise<LaundryServiceType[]> => {
    const res = await apiClient.get<ApiResponse<LaundryServiceType[]>>(
      '/api/super-admin/prices/service-types'
    );
    return res.data.data;
  },

  /** Hotel Laundry / Guest Laundry, for the Business Price List selector. */
  getLaundryTypes: async (): Promise<LaundryTypeOption[]> => {
    const res = await apiClient.get<ApiResponse<LaundryTypeOption[]>>(
      '/api/super-admin/prices/laundry-types'
    );
    return res.data.data;
  },

  /* ---- Customer price list (global) ---- */

  getCustomerPrices: async (search?: string): Promise<CustomerPrice[]> => {
    const res = await apiClient.get<ApiResponse<CustomerPrice[]>>(
      '/api/super-admin/prices/customers',
      { params: { search } }
    );
    return res.data.data;
  },

  /**
   * The customer price list as a printable PDF.
   *
   * A URL rather than a response body because the file is fetched with
   * `FileSystem.downloadAsync`, the same way the profile and the invoice are —
   * it makes its own request, so `authHeader()` supplies the bearer token.
   *
   * The server builds the WHOLE list. It is deliberately not the screen's
   * current filter: this screen shows nothing until a Category and a
   * Sub-category are chosen, so printing what is on it could only ever produce
   * one sub-category.
   */
  customerPriceListPdfUrl: (includeInactive = false): string =>
    `${API_BASE_URL}/api/super-admin/prices/customers.pdf` +
    (includeInactive ? '?include_inactive=true' : ''),

  /**
   * Adds a price. Send `item_id` to price an existing catalogue item, or
   * `item_name` + `category_id` to create the item and price it in one go.
   */
  createCustomerPrice: async (payload: Record<string, unknown>): Promise<CustomerPrice> => {
    const res = await apiClient.post<ApiResponse<CustomerPrice>>(
      '/api/super-admin/prices/customers',
      payload
    );
    return res.data.data;
  },

  updateCustomerPrice: async (
    id: string,
    payload: Record<string, unknown>
  ): Promise<CustomerPrice> => {
    const res = await apiClient.put<ApiResponse<CustomerPrice>>(
      `/api/super-admin/prices/customers/${id}`,
      payload
    );
    return res.data.data;
  },

  /** Soft delete by default: the row is disabled, so old invoices still read. */
  deleteCustomerPrice: async (id: string, hard = false): Promise<void> => {
    await apiClient.delete(`/api/super-admin/prices/customers/${id}`, {
      params: hard ? { hard: 'true' } : {},
    });
  },

  /* ---- Business price list (per business) ---- */

  /**
   * Every item for this business at ONE laundry type, including the ones
   * with no price set at that type yet.
   */
  getBusinessPrices: async (
    businessId: string,
    laundryType: LaundryTypeValue,
    search?: string
  ): Promise<BusinessPrice[]> => {
    const res = await apiClient.get<ApiResponse<BusinessPrice[]>>(
      `/api/super-admin/prices/businesses/${businessId}`,
      { params: { laundry_type: laundryType, search } }
    );
    return res.data.data;
  },

  /**
   * ONE business's rate card, at ONE laundry type, as a printable PDF.
   *
   * The laundry type is part of the URL because it is part of what the sheet
   * is: Hotel and Guest are priced separately, so each has its own sheet
   * rather than one sheet carrying two rates per item.
   *
   * `includeUnset` prints the items this business has no rate for, marked
   * "Not set". Off by default — a rate card listing items with no rate is not
   * a rate card — but available when the gaps are what is wanted on paper.
   */
  businessPriceListPdfUrl: (
    businessId: string,
    laundryType: LaundryTypeValue,
    includeUnset = false
  ): string =>
    `${API_BASE_URL}/api/super-admin/prices/businesses/${businessId}/price-list.pdf` +
    `?laundry_type=${encodeURIComponent(laundryType)}` +
    (includeUnset ? '&include_unset=true' : ''),

  /* ---- Bulk price update (Excel) ---- */

  /**
   * The editable price sheet for this business at this laundry type.
   *
   * Main Category | Subcategory | Service Type | Item Name | Price, with the
   * CURRENT price already filled in and every identifying cell taken from the
   * live catalogue — so the sheet the Super Admin opens already names lines
   * that will match on the way back.
   *
   * `includeUnset` adds the lines with no rate yet, for filling the gaps. Off
   * by default, because their Price cell is blank and a blank Price is a
   * rejected row: a default sheet full of them would report errors the moment
   * it was returned untouched. Same flag, same default, as the printed card.
   *
   * `FileSystem.downloadAsync` makes its own request, so `authHeader()`
   * supplies the bearer token — see `invoicePdfUrl`.
   */
  businessPriceTemplateUrl: (
    businessId: string,
    laundryType: LaundryTypeValue,
    includeUnset = false
  ): string =>
    `${API_BASE_URL}/api/super-admin/prices/businesses/${businessId}/price-template.xlsx` +
    `?laundry_type=${encodeURIComponent(laundryType)}` +
    (includeUnset ? '&include_unset=true' : ''),

  /**
   * Validates a filled sheet and reports exactly what WOULD change.
   *
   * Writes nothing. `file_base64` is the .xlsx read off the device.
   */
  previewBusinessPriceUpload: async (
    businessId: string,
    body: { laundry_type: LaundryTypeValue; file_base64: string }
  ): Promise<PriceUploadResult> => {
    const res = await apiClient.post<ApiResponse<PriceUploadResult>>(
      `/api/super-admin/prices/businesses/${businessId}/price-upload/preview`,
      body
    );
    return res.data.data;
  },

  /**
   * Applies the prices. The sheet is re-validated on the server rather than
   * the preview being trusted, and the accepted rows are written in one
   * transaction. ONLY the Price of an existing line is ever changed.
   */
  uploadBusinessPrices: async (
    businessId: string,
    body: { laundry_type: LaundryTypeValue; file_base64: string }
  ): Promise<PriceUploadResult> => {
    const res = await apiClient.post<ApiResponse<PriceUploadResult>>(
      `/api/super-admin/prices/businesses/${businessId}/price-upload`,
      body
    );
    return res.data.data;
  },

  createBusinessPrice: async (
    businessId: string,
    payload: {
      item_id: string;
      laundry_type: LaundryTypeValue;
      /**
       * The service this price is for. Omitted or null sets the item's BASE
       * rate — the one that applies to every service without its own — which
       * is what a price set with no service has always meant.
       *
       * The server refuses a service the item is not offered for, and refuses
       * a second price for an item + service that already has one.
       */
      service_id?: string | null;
      price: string | number;
      is_active?: boolean;
    }
  ): Promise<BusinessPrice> => {
    const res = await apiClient.post<ApiResponse<BusinessPrice>>(
      `/api/super-admin/prices/businesses/${businessId}`,
      payload
    );
    return res.data.data;
  },

  updateBusinessPrice: async (
    businessId: string,
    priceId: string,
    payload: { price?: string | number; is_active?: boolean }
  ): Promise<BusinessPrice> => {
    const res = await apiClient.put<ApiResponse<BusinessPrice>>(
      `/api/super-admin/prices/businesses/${businessId}/${priceId}`,
      payload
    );
    return res.data.data;
  },

  deleteBusinessPrice: async (
    businessId: string,
    priceId: string,
    hard = false
  ): Promise<void> => {
    await apiClient.delete(`/api/super-admin/prices/businesses/${businessId}/${priceId}`, {
      params: hard ? { hard: 'true' } : {},
    });
  },

  /* =================================================================
   * CREATION REQUESTS  (business / rider / sorter)
   *
   * Approving is what creates the account, generates the password and
   * sends the email — all server-side. Nothing here ever receives a
   * password.
   * ================================================================= */

  getRequests: async (filters: { type?: string; status?: string } = {}): Promise<CreationRequest[]> => {
    const res = await apiClient.get<ApiResponse<CreationRequest[]>>(
      '/api/super-admin/requests',
      { params: filters }
    );
    return res.data.data;
  },

  getRequest: async (id: string): Promise<CreationRequest> => {
    const res = await apiClient.get<ApiResponse<CreationRequest>>(
      `/api/super-admin/requests/${id}`
    );
    return res.data.data;
  },

  /**
   * Approves a request WITH the initial password the Super Admin typed.
   *
   * The password goes out in the body and is never returned: the response
   * carries the created account and whether the email went out, nothing more.
   */
  approveRequest: async (
    id: string,
    credentials: { password: string; confirm_password: string }
  ): Promise<{ data: ApprovalOutcome; message: string }> => {
    const res = await apiClient.post<ApiResponse<ApprovalOutcome>>(
      `/api/super-admin/requests/${id}/approve`,
      credentials
    );
    return { data: res.data.data, message: res.data.message || '' };
  },

  rejectRequest: async (id: string, reason?: string): Promise<CreationRequest> => {
    const res = await apiClient.post<ApiResponse<CreationRequest>>(
      `/api/super-admin/requests/${id}/reject`,
      { reason }
    );
    return res.data.data;
  },

  /**
   * Sets a NEW password and re-sends the credentials after a failed email.
   * The original was never stored, which is why this takes a fresh one.
   */
  resendCredentials: async (
    id: string,
    credentials: { password: string; confirm_password: string }
  ): Promise<{ message: string }> => {
    const res = await apiClient.post<ApiResponse<{ username: string }>>(
      `/api/super-admin/requests/${id}/resend`,
      credentials
    );
    return { message: res.data.message || '' };
  },

  /* ---- Manager accounts (created here and nowhere else) ---- */

  getManagers: async (): Promise<ManagerAccount[]> => {
    const res = await apiClient.get<ApiResponse<ManagerAccount[]>>('/api/super-admin/managers');
    return res.data.data;
  },

  createManager: async (payload: {
    name: string;
    email: string;
    mobile_number: string;
    /** Typed by the Super Admin. Required — nothing is generated. */
    password: string;
    confirm_password: string;
  }): Promise<{ message: string }> => {
    const res = await apiClient.post<ApiResponse<unknown>>('/api/super-admin/managers', payload);
    return { message: res.data.message || '' };
  },

  setManagerActive: async (id: string, is_active: boolean): Promise<void> => {
    await apiClient.patch(`/api/super-admin/managers/${id}`, { is_active });
  },

  resetManagerPassword: async (
    id: string,
    credentials: { password: string; confirm_password: string }
  ): Promise<{ message: string }> => {
    const res = await apiClient.post<ApiResponse<unknown>>(
      `/api/super-admin/managers/${id}/reset-password`,
      credentials
    );
    return { message: res.data.message || '' };
  },

  /* =================================================================
   * ACCOUNT MANAGEMENT  (businesses, managers, riders, sorters)
   * ================================================================= */

  getBillingCycles: async (): Promise<Array<{ value: string; label: string }>> => {
    const res = await apiClient.get<ApiResponse<Array<{ value: string; label: string }>>>(
      '/api/super-admin/billing-cycles'
    );
    return res.data.data;
  },

  /** Every account of one role. Listing is unrestricted; creating is not. */
  getAccounts: async (
    segment: 'managers' | 'riders' | 'sorters'
  ): Promise<StaffAccount[]> => {
    const res = await apiClient.get<ApiResponse<StaffAccount[]>>(
      `/api/super-admin/accounts/${segment}`
    );
    return res.data.data;
  },

  /**
   * Creates a staff account. The role comes from the SEGMENT, not the body.
   *
   * 'riders' is not one of them, and the type says so. A Super Admin does not
   * create a rider — a Manager raises a rider request and the Super Admin
   * approves it. The server has no POST /accounts/riders route either, so
   * this is a matching restriction rather than the only one.
   */
  createAccount: async (
    segment: 'managers' | 'sorters',
    payload: {
      name: string; email: string; mobile_number: string;
      password: string; confirm_password: string;
    }
  ): Promise<{ message: string }> => {
    const res = await apiClient.post<ApiResponse<unknown>>(
      `/api/super-admin/accounts/${segment}`,
      payload
    );
    return { message: res.data.message || '' };
  },

  updateAccount: async (id: string, payload: Record<string, unknown>): Promise<StaffAccount> => {
    const res = await apiClient.put<ApiResponse<StaffAccount>>(
      `/api/super-admin/accounts/detail/${id}`,
      payload
    );
    return res.data.data;
  },

  setAccountActive: async (id: string, is_active: boolean): Promise<StaffAccount> => {
    const res = await apiClient.patch<ApiResponse<StaffAccount>>(
      `/api/super-admin/accounts/detail/${id}/status`,
      { is_active }
    );
    return res.data.data;
  },

  /** Sets a new password and emails it. Nothing is generated. */
  setAccountPassword: async (
    id: string,
    credentials: { password: string; confirm_password: string }
  ): Promise<{ message: string }> => {
    const res = await apiClient.post<ApiResponse<unknown>>(
      `/api/super-admin/accounts/detail/${id}/password`,
      credentials
    );
    return { message: res.data.message || '' };
  },

  /** Deletes, or disables when records depend on it — the message says which. */
  deleteAccount: async (id: string): Promise<{ message: string; deleted: boolean }> => {
    const res = await apiClient.delete<ApiResponse<{ deleted: boolean }>>(
      `/api/super-admin/accounts/detail/${id}`
    );
    return { message: res.data.message || '', deleted: Boolean(res.data.data?.deleted) };
  },

  /* ---- Businesses ---- */

  getManagedBusinesses: async (filters: { search?: string; status?: string } = {}):
    Promise<BusinessAdmin[]> => {
    const res = await apiClient.get<ApiResponse<BusinessAdmin[]>>(
      '/api/super-admin/manage/businesses',
      { params: filters }
    );
    return res.data.data;
  },

  getManagedBusiness: async (id: string): Promise<BusinessAdmin> => {
    const res = await apiClient.get<ApiResponse<BusinessAdmin>>(
      `/api/super-admin/manage/businesses/${id}`
    );
    return res.data.data;
  },

  updateManagedBusiness: async (id: string, payload: Record<string, unknown>):
    Promise<BusinessAdmin> => {
    const res = await apiClient.put<ApiResponse<BusinessAdmin>>(
      `/api/super-admin/manage/businesses/${id}`,
      payload
    );
    return res.data.data;
  },

  setBusinessActive: async (id: string, is_active: boolean): Promise<BusinessAdmin> => {
    const res = await apiClient.patch<ApiResponse<BusinessAdmin>>(
      `/api/super-admin/manage/businesses/${id}/status`,
      { is_active }
    );
    return res.data.data;
  },

  deleteBusiness: async (id: string): Promise<{ message: string; deleted: boolean }> => {
    const res = await apiClient.delete<ApiResponse<{ deleted: boolean }>>(
      `/api/super-admin/manage/businesses/${id}`
    );
    return { message: res.data.message || '', deleted: Boolean(res.data.data?.deleted) };
  },

  /* ---- Contacts ---- */

  getBusinessContacts: async (businessId: string): Promise<BusinessContact[]> => {
    const res = await apiClient.get<ApiResponse<BusinessContact[]>>(
      `/api/super-admin/manage/businesses/${businessId}/contacts`
    );
    return res.data.data;
  },

  replaceAlternativeContacts: async (
    businessId: string,
    alternative_contacts: Array<{ name: string; designation: string; mobile: string }>
  ): Promise<BusinessContact[]> => {
    const res = await apiClient.put<ApiResponse<BusinessContact[]>>(
      `/api/super-admin/manage/businesses/${businessId}/contacts`,
      { alternative_contacts }
    );
    return res.data.data;
  },

  /** Adds ONE alternative contact. The server refuses a fourth. */
  addAlternativeContact: async (
    businessId: string,
    payload: { name: string; designation: string; mobile: string; login_enabled?: boolean }
  ): Promise<BusinessContact> => {
    const res = await apiClient.post<ApiResponse<BusinessContact>>(
      `/api/super-admin/manage/businesses/${businessId}/contacts`,
      payload
    );
    return res.data.data;
  },

  /** Edits one contact in place. */
  updateBusinessContact: async (
    businessId: string,
    contactId: string,
    payload: Record<string, unknown>
  ): Promise<BusinessContact> => {
    const res = await apiClient.put<ApiResponse<BusinessContact>>(
      `/api/super-admin/manage/businesses/${businessId}/contacts/${contactId}`,
      payload
    );
    return res.data.data;
  },

  /** Removes one alternative contact. The server refuses the last one. */
  deleteAlternativeContact: async (
    businessId: string,
    contactId: string
  ): Promise<{ id: string; deleted: boolean }> => {
    const res = await apiClient.delete<ApiResponse<{ id: string; deleted: boolean }>>(
      `/api/super-admin/manage/businesses/${businessId}/contacts/${contactId}`
    );
    return res.data.data;
  },

  /** Whether this contact's number may reach the business login page. */
  setContactLoginEnabled: async (
    businessId: string,
    contactId: string,
    login_enabled: boolean
  ): Promise<BusinessContact> => {
    const res = await apiClient.patch<ApiResponse<BusinessContact>>(
      `/api/super-admin/manage/businesses/${businessId}/contacts/${contactId}/login`,
      { login_enabled }
    );
    return res.data.data;
  },

  /**
   * Sets a NEW password on the business's login account.
   *
   * There is nothing to read back: only the hash was ever stored, so the
   * existing password cannot be shown and is never returned. The response
   * says which username it applies to and whether the notification email
   * reached the business.
   */
  setBusinessPassword: async (
    businessId: string,
    payload: { password: string; confirm_password: string }
  ): Promise<{ username: string; message: string; emailSent: boolean }> => {
    const res = await apiClient.post<
      ApiResponse<{ username: string; email: { sent: boolean; error?: string } }>
    >(`/api/super-admin/manage/businesses/${businessId}/password`, payload);
    return {
      username: res.data.data.username,
      message: res.data.message || '',
      emailSent: Boolean(res.data.data.email?.sent),
    };
  },

  /**
   * The Business Profile PDF for ONE business.
   *
   * A URL rather than a response body because the file is downloaded with
   * `FileSystem.downloadAsync`, the same way the GST invoice is — it makes
   * its own request, so `authHeader()` supplies the bearer token.
   */
  businessProfilePdfUrl: (businessId: string): string =>
    `${API_BASE_URL}/api/super-admin/manage/businesses/${businessId}/profile.pdf`,

  /* =================================================================
   * BUSINESS ACCOUNT
   *
   * One business at a time. Every call names the business in its PATH and the
   * server scopes each query by it, so one business's orders, invoices,
   * receipts and balances can never appear under another's.
   * ================================================================= */

  /** Every registered business, under its establishment name. */
  getBusinessAccounts: async (search?: string): Promise<BusinessAccountSummary[]> => {
    const res = await apiClient.get<ApiResponse<BusinessAccountSummary[]>>(
      '/api/super-admin/business-account/businesses',
      { params: search ? { search } : undefined }
    );
    return res.data.data;
  },

  /** One business's orders — the Order Detail tab. */
  getBusinessAccountOrders: async (
    businessId: string,
    search?: string
  ): Promise<{ business: { id: string; name: string }; orders: BusinessAccountOrder[] }> => {
    const res = await apiClient.get<
      ApiResponse<{ business: { id: string; name: string }; orders: BusinessAccountOrder[] }>
    >(`/api/super-admin/business-account/${businessId}/orders`,
      { params: search ? { search } : undefined });
    return res.data.data;
  },

  /**
   * ONE of a business's orders, in full.
   *
   * The SAME `BusinessOrderDetail` the business app's own order screen loads,
   * so the Order Confirmation PDF built from it is produced by the existing
   * generator from the existing order -- there is no Super Admin copy of the
   * document. Read-only: nothing here creates or changes an order.
   */
  getBusinessAccountOrder: async (
    businessId: string,
    orderId: string
  ): Promise<{ business: { id: string; name: string }; order: BusinessOrderDetail }> => {
    const res = await apiClient.get<
      ApiResponse<{ business: { id: string; name: string }; order: BusinessOrderDetail }>
    >(`/api/super-admin/business-account/${businessId}/orders/${orderId}`);
    return res.data.data;
  },

  /* ---- INVOICE HISTORY ----
   *
   * Every invoice ever generated FOR ONE BUSINESS. The business is in the
   * path and the server filters every statement by it — there is no call that
   * lists invoices across businesses, which is what keeps one business's
   * invoices out of another's history.
   *
   * The amounts are the ones each invoice was ISSUED for, snapshot when it was
   * generated, not a recomputation from today's orders.
   */
  getInvoiceHistory: async (
    businessId: string,
    options?: { limit?: number; offset?: number }
  ): Promise<{ invoices: InvoiceHistoryEntry[]; total: number }> => {
    const res = await apiClient.get<ApiResponse<{ invoices: InvoiceHistoryEntry[]; total: number }>>(
      `/api/super-admin/business-account/${businessId}/invoices`,
      { params: options }
    );
    return res.data.data;
  },

  /** One stored invoice, scoped to its business. */
  getInvoiceFromHistory: async (
    businessId: string,
    invoiceId: string
  ): Promise<InvoiceHistoryEntry> => {
    const res = await apiClient.get<ApiResponse<{ invoice: InvoiceHistoryEntry }>>(
      `/api/super-admin/business-account/${businessId}/invoices/${invoiceId}`
    );
    return res.data.data.invoice;
  },

  /**
   * A stored invoice's PDF, as a URL.
   *
   * Downloaded with `FileSystem.downloadAsync` like the other documents, so
   * `authHeader()` supplies the bearer token — see `invoicePdfUrl`.
   */
  historyInvoicePdfUrl: (businessId: string, invoiceId: string): string =>
    `${API_BASE_URL}/api/super-admin/business-account/${businessId}/invoices/${invoiceId}/invoice.pdf`,

  /**
   * The Payment Receipt tab's starting point, and the payment history.
   *
   * `from`/`to` select an older invoice; omitted, the server finds the latest.
   */
  getPaymentContext: async (
    businessId: string,
    period?: { from: string; to: string }
  ): Promise<PaymentContext> => {
    const res = await apiClient.get<ApiResponse<PaymentContext>>(
      `/api/super-admin/business-account/${businessId}/payments`,
      { params: period ? { from: period.from, to: period.to } : undefined }
    );
    return res.data.data;
  },

  /**
   * Records a payment.
   *
   * Only the date, the type, the reference and the amount are sent: the
   * balances are recomputed server-side from the invoice and the ledger, so
   * nothing this screen displays can move what is stored.
   */
  recordPayment: async (
    businessId: string,
    payload: {
      invoice_period_from: string;
      invoice_period_to: string;
      payment_date: string;
      payment_type: PaymentTypeValue;
      payment_reference?: string;
      payment_received: number;
      notes?: string;
    }
  ): Promise<PaymentReceipt> => {
    const res = await apiClient.post<ApiResponse<PaymentReceipt>>(
      `/api/super-admin/business-account/${businessId}/payments`,
      payload
    );
    return res.data.data;
  },

  /** The Billing Receipt PDF for one recorded payment. */
  billingReceiptPdfUrl: (businessId: string, receiptId: string): string =>
    `${API_BASE_URL}/api/super-admin/business-account/${businessId}/payments/${receiptId}/receipt.pdf`,

  /** The invoice windows this business's own billing cycle defines. */
  getBillingPeriods: async (businessId: string, count = 6): Promise<BillingPeriod[]> => {
    const res = await apiClient.get<ApiResponse<BillingPeriod[]>>(
      `/api/super-admin/businesses/${businessId}/billing-periods`,
      { params: { count } }
    );
    return res.data.data;
  },

  /* =================================================================
   * PURCHASE, SUPPLIER AND EXPENSE
   *
   * COMPANY-WIDE. These are what Swachham spends running its own laundry —
   * detergent, packaging, electricity, rent — so none of them takes a
   * business. `businesses` are Swachham's CUSTOMERS, and a drum of
   * detergent belongs to none of them.
   *
   * FILTERING AND PAGING HAPPEN ON THE SERVER. Every list method passes its
   * filters as query parameters and receives one page; nothing here loads a
   * register in full to filter it in JavaScript.
   * ================================================================= */

  /** Payment methods and statuses, so the app never hardcodes them. */
  getPurchaseOptions: async (): Promise<PurchaseOptions> => {
    const res = await apiClient.get<ApiResponse<PurchaseOptions>>(
      '/api/super-admin/purchases/options'
    );
    return res.data.data;
  },

  /* ---- Suppliers ---- */

  getSuppliers: async (params?: {
    search?: string; include_inactive?: boolean; limit?: number; offset?: number;
  }): Promise<{ suppliers: Supplier[]; total: number }> => {
    const res = await apiClient.get<ApiResponse<{ suppliers: Supplier[]; total: number }>>(
      '/api/super-admin/purchases/suppliers', { params }
    );
    return res.data.data;
  },

  getSupplier: async (supplierId: string): Promise<Supplier> => {
    const res = await apiClient.get<ApiResponse<Supplier>>(
      `/api/super-admin/purchases/suppliers/${supplierId}`
    );
    return res.data.data;
  },

  createSupplier: async (payload: SupplierInput): Promise<Supplier> => {
    const res = await apiClient.post<ApiResponse<Supplier>>(
      '/api/super-admin/purchases/suppliers', payload
    );
    return res.data.data;
  },

  updateSupplier: async (supplierId: string, payload: SupplierInput): Promise<Supplier> => {
    const res = await apiClient.put<ApiResponse<Supplier>>(
      `/api/super-admin/purchases/suppliers/${supplierId}`, payload
    );
    return res.data.data;
  },

  deleteSupplier: async (supplierId: string): Promise<void> => {
    await apiClient.delete(`/api/super-admin/purchases/suppliers/${supplierId}`);
  },

  getSupplierPurchases: async (
    supplierId: string
  ): Promise<{ purchases: SupplierPurchaseRef[]; total: number }> => {
    const res = await apiClient.get<ApiResponse<{ purchases: SupplierPurchaseRef[]; total: number }>>(
      `/api/super-admin/purchases/suppliers/${supplierId}/purchases`
    );
    return res.data.data;
  },

  /* ---- Purchases ---- */

  getPurchaseSummary: async (
    params?: { from?: string; to?: string }
  ): Promise<PurchaseSummary> => {
    const res = await apiClient.get<ApiResponse<PurchaseSummary>>(
      '/api/super-admin/purchases/summary', { params }
    );
    return res.data.data;
  },

  getPurchases: async (
    params?: PurchaseListParams
  ): Promise<{ purchases: Purchase[]; total: number }> => {
    const res = await apiClient.get<ApiResponse<{ purchases: Purchase[]; total: number }>>(
      '/api/super-admin/purchases', { params }
    );
    return res.data.data;
  },

  getPurchase: async (purchaseId: string): Promise<PurchaseDetail> => {
    const res = await apiClient.get<ApiResponse<PurchaseDetail>>(
      `/api/super-admin/purchases/${purchaseId}`
    );
    return res.data.data;
  },

  /**
   * Creates a purchase.
   *
   * NO TOTAL IS SENT. The server computes the subtotal, tax, total and
   * balance from the lines and charges below — the figures the form shows are
   * a preview of that arithmetic, never its source.
   */
  createPurchase: async (payload: PurchaseInput): Promise<PurchaseDetail> => {
    const res = await apiClient.post<ApiResponse<PurchaseDetail>>(
      '/api/super-admin/purchases', payload
    );
    return res.data.data;
  },

  updatePurchase: async (
    purchaseId: string, payload: PurchaseInput
  ): Promise<PurchaseDetail> => {
    const res = await apiClient.put<ApiResponse<PurchaseDetail>>(
      `/api/super-admin/purchases/${purchaseId}`, payload
    );
    return res.data.data;
  },

  deletePurchase: async (purchaseId: string): Promise<void> => {
    await apiClient.delete(`/api/super-admin/purchases/${purchaseId}`);
  },

  recordPurchasePayment: async (
    purchaseId: string, payload: PurchasePaymentInput
  ): Promise<PurchaseDetail> => {
    const res = await apiClient.post<ApiResponse<PurchaseDetail>>(
      `/api/super-admin/purchases/${purchaseId}/payments`, payload
    );
    return res.data.data;
  },

  deletePurchasePayment: async (
    purchaseId: string, paymentId: string
  ): Promise<PurchaseDetail> => {
    const res = await apiClient.delete<ApiResponse<PurchaseDetail>>(
      `/api/super-admin/purchases/${purchaseId}/payments/${paymentId}`
    );
    return res.data.data;
  },

  /* ---- Expense categories ---- */

  getExpenseCategories: async (includeInactive = false): Promise<ExpenseCategory[]> => {
    const res = await apiClient.get<ApiResponse<{ categories: ExpenseCategory[] }>>(
      '/api/super-admin/expenses/categories',
      { params: { include_inactive: includeInactive } }
    );
    return res.data.data.categories;
  },

  createExpenseCategory: async (name: string): Promise<ExpenseCategory> => {
    const res = await apiClient.post<ApiResponse<ExpenseCategory>>(
      '/api/super-admin/expenses/categories', { name }
    );
    return res.data.data;
  },

  updateExpenseCategory: async (
    categoryId: string, payload: { name?: string; is_active?: boolean }
  ): Promise<ExpenseCategory> => {
    const res = await apiClient.put<ApiResponse<ExpenseCategory>>(
      `/api/super-admin/expenses/categories/${categoryId}`, payload
    );
    return res.data.data;
  },

  deleteExpenseCategory: async (categoryId: string): Promise<void> => {
    await apiClient.delete(`/api/super-admin/expenses/categories/${categoryId}`);
  },

  /* ---- Expenses ---- */

  getExpenseSummary: async (
    params?: { from?: string; to?: string }
  ): Promise<ExpenseSummary> => {
    const res = await apiClient.get<ApiResponse<ExpenseSummary>>(
      '/api/super-admin/expenses/summary', { params }
    );
    return res.data.data;
  },

  getExpenses: async (
    params?: ExpenseListParams
  ): Promise<{ expenses: Expense[]; total: number; total_amount: number }> => {
    const res = await apiClient.get<
      ApiResponse<{ expenses: Expense[]; total: number; total_amount: number }>
    >('/api/super-admin/expenses', { params });
    return res.data.data;
  },

  getExpense: async (expenseId: string): Promise<Expense> => {
    const res = await apiClient.get<ApiResponse<Expense>>(
      `/api/super-admin/expenses/${expenseId}`
    );
    return res.data.data;
  },

  createExpense: async (payload: ExpenseInput): Promise<Expense> => {
    const res = await apiClient.post<ApiResponse<Expense>>(
      '/api/super-admin/expenses', payload
    );
    return res.data.data;
  },

  updateExpense: async (
    expenseId: string, payload: ExpenseInput
  ): Promise<Expense> => {
    const res = await apiClient.put<ApiResponse<Expense>>(
      `/api/super-admin/expenses/${expenseId}`, payload
    );
    return res.data.data;
  },

  deleteExpense: async (expenseId: string): Promise<void> => {
    await apiClient.delete(`/api/super-admin/expenses/${expenseId}`);
  },

  /** Expenses grouped by category — the report behind the dashboard's chart. */
  getExpensesByCategory: async (
    params?: { from?: string; to?: string }
  ): Promise<ExpenseCategoryTotal[]> => {
    const res = await apiClient.get<ApiResponse<{ categories: ExpenseCategoryTotal[] }>>(
      '/api/super-admin/expenses/by-category', { params }
    );
    return res.data.data.categories;
  },

  /* =================================================================
   * KG REPORTS
   * ================================================================= */

  /** The business customers with countable orders — the dropdown's list. */
  getReportableBusinesses: async (): Promise<ReportableBusiness[]> => {
    const res = await apiClient.get<ApiResponse<{ businesses: ReportableBusiness[] }>>(
      '/api/super-admin/reports/kg/businesses'
    );
    return res.data.data.businesses;
  },

  /**
   * TOTAL KG — every business customer combined, month by month.
   *
   * The window is expressed either as `year` (+ optional `month`) or as an
   * explicit `from`/`to`; the server resolves whichever arrives.
   */
  getTotalKgReport: async (params?: {
    year?: number | string; month?: number | string; from?: string; to?: string;
  }): Promise<KgReport> => {
    const res = await apiClient.get<ApiResponse<KgReport>>(
      '/api/super-admin/reports/kg/total', { params }
    );
    return res.data.data;
  },

  /** PER CUSTOMER KG — one business customer, month by month. */
  getBusinessKgReport: async (
    businessId: string,
    params?: { year?: number | string; month?: number | string; from?: string; to?: string }
  ): Promise<KgReport> => {
    const res = await apiClient.get<ApiResponse<KgReport>>(
      `/api/super-admin/reports/kg/business/${businessId}`, { params }
    );
    return res.data.data;
  },

  /**
   * ITEM WISE KG — pieces and weight per item.
   *
   * `businessId` omitted means ALL BUSINESS: the server combines the same
   * item across every customer into ONE row rather than repeating it.
   */
  getItemWiseKgReport: async (
    businessId?: string,
    params?: {
      year?: number | string; month?: number | string;
      from?: string; to?: string; sort?: ItemKgSort;
    }
  ): Promise<ItemKgReport> => {
    const res = await apiClient.get<ApiResponse<ItemKgReport>>(
      '/api/super-admin/reports/kg/items',
      { params: { ...params, business_id: businessId || undefined } }
    );
    return res.data.data;
  },

  /**
   * THE THREE KG PIVOTS — a grid, not a list.
   *
   * All three come back in ONE shape: `columns` across the top, `rows` down
   * the side, `cells` keyed by column, plus the totals. The screen draws any
   * of them without knowing which it is holding.
   *
   * The figures are the existing reports' own — these endpoints pivot them,
   * they do not recompute them.
   */
  getHotelMonthlyKgReport: async (params?: KgReportParams): Promise<KgPivotReport> => {
    const res = await apiClient.get<ApiResponse<KgPivotReport>>(
      '/api/super-admin/reports/kg/hotel-monthly', { params }
    );
    return res.data.data;
  },

  getItemMonthlyKgReport: async (params?: KgReportParams): Promise<KgPivotReport> => {
    const res = await apiClient.get<ApiResponse<KgPivotReport>>(
      '/api/super-admin/reports/kg/item-monthly', { params }
    );
    return res.data.data;
  },

  getHotelItemKgReport: async (params?: KgReportParams): Promise<KgPivotReport> => {
    const res = await apiClient.get<ApiResponse<KgPivotReport>>(
      '/api/super-admin/reports/kg/hotel-item', { params }
    );
    return res.data.data;
  },

  /**
   * DAY-WISE, HOTEL-WISE, ITEM-WISE KG — one line per day, hotel and item.
   *
   * The same KG the item reports carry, cut a day at a time and already
   * ordered day, then hotel, then item by the server.
   */
  getDayWiseKgReport: async (params?: KgReportParams): Promise<DayWiseKgReport> => {
    const res = await apiClient.get<ApiResponse<DayWiseKgReport>>(
      '/api/super-admin/reports/kg/day-wise', { params }
    );
    return res.data.data;
  },

  /**
   * The URL a KG report's PDF is downloaded from.
   *
   * The document is rendered by the SERVER from the same service the JSON
   * above comes from, so what is printed cannot drift from what is shown.
   * `FileSystem.downloadAsync` fetches it and needs the bearer token, which
   * is why this hands back a URL rather than the bytes — see `authHeader`.
   */
  kgReportPdfUrl: (
    report: 'hotel-monthly' | 'item-monthly' | 'hotel-item' | 'day-wise',
    params: KgReportParams = {}
  ): string => {
    const query = Object.entries(params)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
      .join('&');
    return `${API_BASE_URL}/api/super-admin/reports/kg/${report}.pdf${query ? `?${query}` : ''}`;
  },

  /**
   * OUTSTANDING — what each establishment still owes.
   *
   * The balance comes from the same ledger the Business Account screen and
   * the Record Payment form use, so this report can never disagree with them.
   */
  getOutstandingReport: async (params?: {
    search?: string;
    min_outstanding?: number | string;
    include_settled?: boolean;
    sort?: OutstandingSort;
    limit?: number;
    offset?: number;
  }): Promise<OutstandingReport> => {
    const res = await apiClient.get<ApiResponse<OutstandingReport>>(
      '/api/super-admin/reports/outstanding', { params }
    );
    return res.data.data;
  },

  /** The home page's Transaction Summary grid. */
  getTransactionSummary: async (): Promise<TransactionSummary> => {
    const res = await apiClient.get<ApiResponse<TransactionSummary>>(
      '/api/super-admin/transaction-summary'
    );
    return res.data.data;
  },

  /**
   * The orders behind a Sale card — Today or Current Month.
   *
   * The server applies the SAME filter and the same business-timezone day the
   * card itself is summed over, so the list adds up to the figure that was
   * tapped. Nothing is filtered or totalled on this side.
   */
  getSaleDetail: async (period: SalePeriod): Promise<SaleDetail> => {
    const res = await apiClient.get<ApiResponse<SaleDetail>>(
      '/api/super-admin/transaction-summary/sale', { params: { period } }
    );
    return res.data.data;
  },
};

export default superAdminApi;
