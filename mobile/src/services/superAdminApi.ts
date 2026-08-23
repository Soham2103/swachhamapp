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

/** One row of the GLOBAL customer price list: same price for everyone. */
export interface CustomerPrice {
  id: string;
  item_id: string;
  item_name: string;
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
  service_types: string[];
  unit: string;
  /** The global customer price, for reference only. */
  customer_price: number | null;
  price: number | null;
  is_active: boolean;
  item_is_active: boolean;
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

  /** The invoice URL for a business over a date range, both YYYY-MM-DD. */
  invoicePdfUrl: (businessId: string, from: string, to: string): string =>
    `${API_BASE_URL}/api/super-admin/businesses/${businessId}/invoice.pdf` +
    `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,

  /** The same invoice as data, used to show the totals before downloading. */
  getInvoice: async (businessId: string, from: string, to: string): Promise<any> => {
    const response = await apiClient.get(
      `/api/super-admin/businesses/${businessId}/invoice`,
      { params: { from, to } }
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

  getPriceCategories: async (): Promise<ItemCategory[]> => {
    const res = await apiClient.get<ApiResponse<ItemCategory[]>>(
      '/api/super-admin/prices/categories'
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

  createBusinessPrice: async (
    businessId: string,
    payload: {
      item_id: string;
      laundry_type: LaundryTypeValue;
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
};

export default superAdminApi;
