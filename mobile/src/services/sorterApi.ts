import apiClient from './api';
import { ApiResponse } from '../types';

/**
 * Sorter API.
 *
 * Uses the same axios client as every other module, so the bearer token, base
 * URL and error shaping are the ones the app already has.
 */

/** The three stages the Sorter works with, in workflow order. */
/**
 * `partially_completed` is an OUTCOME, never a request: an order reaches it by
 * having pending items, and the server refuses it as a target.
 */
export type SorterStage =
  | 'confirmed'
  | 'accepted'
  | 'ready'
  | 'partially_completed'
  | 'out_for_delivery';

export interface SorterOrderSummary {
  id: string;
  order_number: string;
  customer_name: string;
  /** The number to CALL about this job -- the account's own. */
  customer_contact: string | null;
  /**
   * The number the order was PLACED ON (`orders.placed_by_mobile`) -- what
   * passed OTP for that session. What the Order Confirmation PDF prints, and
   * a different question from `customer_contact`. NULL for older orders.
   */
  placed_by_mobile: string | null;
  laundry_type: string | null;
  order_type: string | null;
  /** The raw pipeline status, e.g. ORDER_PLACED. */
  status: string;
  /** That status expressed as a Sorter stage. */
  stage: SorterStage | null;
  item_count: number;
  total_quantity: number;
  total_weight_kg: number;
  has_confirmation_pdf: boolean;
  created_at: string;
  accepted_at: string | null;
  ready_at: string | null;
  /** How many defects have been reported against this order. */
  defect_count: number;
  /** WhatsApp state of the most recent defect, or null when there is none. */
  latest_defect_whatsapp_status: DefectWhatsAppStatus | null;
}

/** Only SENT means Meta actually accepted the message. */
export type DefectWhatsAppStatus = 'PENDING' | 'SENT' | 'FAILED';

export interface DefectRecord {
  id: string;
  order_id: string;
  /** Server-relative URL, e.g. /uploads/defects/....jpg */
  photo_url: string;
  description: string | null;
  reported_by: string | null;
  reported_at: string;
  whatsapp_status: DefectWhatsAppStatus;
  whatsapp_message_id: string | null;
  whatsapp_error: string | null;
  whatsapp_sent_at: string | null;
  whatsapp_to: string | null;
  /**
   * The same message sent to the Sorter who reported it. A null status means
   * no attempt has been recorded for this row yet.
   */
  sorter_whatsapp_status: DefectWhatsAppStatus | null;
  sorter_whatsapp_message_id: string | null;
  sorter_whatsapp_error: string | null;
  sorter_whatsapp_sent_at: string | null;
  sorter_whatsapp_to: string | null;
}

export interface SorterOrderItem {
  id: string;
  item_name: string;
  /** The laundry service for this line; null when it cannot be resolved. */
  laundry_service_name: string | null;
  category_name: string | null;
  /** The BILLABLE quantity: original_quantity - defective_quantity. */
  quantity: number;
  /** The pieces the order was placed for. The PHYSICAL count. */
  original_quantity: number;
  /** Pieces found damaged. 0 until an adjustment is recorded. */
  defective_quantity: number;
  /**
   * Where this line stands on its own, derived from the quantities below.
   *
   * Holding pieces back is NOT the same as finding them defective — pieces
   * can be pending with nothing wrong with them, and pending never moves an
   * amount.
   */
  item_status: ItemStatus;
  /** Pieces being held back for more processing. */
  pending_quantity: number;
  /** ordered - pending: the pieces going out with the next dispatch. */
  delivery_quantity: number;
  /** Why they are being held, when they are. */
  pending_reason: string | null;
  unit: string;
  weight_kg: number | null;
  total_weight_kg: number;
}

/**
 * Derived from the quantities, never chosen: READY when nothing is held,
 * PENDING when every piece is, PARTIALLY_PENDING in between.
 */
export type ItemStatus = 'PROCESSING' | 'READY' | 'PARTIALLY_PENDING' | 'PENDING';

/**
 * One recorded defective-piece adjustment, as the Sorter is allowed to see it.
 *
 * NO PRICE FIELDS, and not because they are hidden here — the Sorter
 * endpoints do not send them. The backend still calculates the line amount,
 * the order total and the payment position, and still stores them; the shop
 * floor's job is pieces, and what those pieces are worth is a billing
 * question it has no decision resting on.
 */
export interface OrderItemAdjustment {
  id: string;
  order_id: string;
  order_item_id: string;
  item_name: string;
  original_quantity: number;
  previous_defective_quantity: number;
  defective_quantity: number;
  final_quantity: number;
  reason: string | null;
  adjusted_by: string | null;
  adjusted_by_name: string | null;
  adjusted_at: string;
}

/** One attempt to tell the customer about an adjustment. */
export interface AdjustmentNotification {
  id: string;
  order_id: string;
  last_adjustment_id: string | null;
  status: 'PENDING' | 'SENT' | 'FAILED';
  sent_to: string | null;
  message_id: string | null;
  error: string | null;
  template_name: string | null;
  sent_at: string | null;
  created_at: string;
}

/**
 * Where the money stands after an adjustment. Computed by the server and
 * never written: an adjustment does not touch a payment record.
 */
export interface SorterOrderDetail extends SorterOrderSummary {
  items: SorterOrderItem[];
  confirmation_pdf_url: string | null;
  /** Newest first. */
  defects: DefectRecord[];
  /** Newest first. */
  adjustments: OrderItemAdjustment[];
  adjustment_notifications: AdjustmentNotification[];
  has_adjustment: boolean;
  /** True when any piece anywhere on the order is being held back. */
  has_pending_items: boolean;
  /** Pieces held, and pieces going out, across the whole order. */
  pending_quantity: number;
  delivery_quantity: number;
}

/** What comes back after saving a defective quantity. Pieces, no money. */
export interface AdjustmentResult {
  order_id: string;
  order_number: string;
  item: {
    id: string;
    item_name: string;
    original_quantity: number;
    defective_quantity: number;
    final_quantity: number;
    weight_kg: number | null;
    total_weight_kg: number | null;
  };
  adjustment: OrderItemAdjustment;
}

/** What comes back after a stage change. */
export interface StatusResult {
  id: string;
  order_number: string;
  status: string;
  stage: SorterStage;
  /** Pieces held back and pieces going out, across the order. */
  pending_quantity: number;
  delivery_quantity: number;
  /** The per-line split, for the summary the Sorter confirms against. */
  items: ItemSplit[];
}

/** The split for one line, as the server calculated it. */
export interface ItemSplit {
  id: string;
  item_name: string;
  ordered_quantity: number;
  pending_quantity: number;
  /** ordered - pending. Computed by the server; never sent to it. */
  delivery_quantity: number;
  item_status: ItemStatus;
}

/** What comes back after changing how many pieces of one line are held. */
export interface ItemPendingResult {
  order_id: string;
  order_number: string;
  order_status: string;
  item: ItemSplit;
  /** Across the whole order, after this change. */
  pending_quantity: number;
  delivery_quantity: number;
}

export interface SorterQueue {
  orders: SorterOrderSummary[];
  counts: { confirmed: number; accepted: number; ready: number; active: number };
  /**
   * The calendar day the result was narrowed to, YYYY-MM-DD, as the server
   * reckons it from BUSINESS_TZ_OFFSET. null when no day filter applied.
   */
  business_date: string | null;
}

export interface Garment {
  id: string;
  order_id: string;
  barcode: string;
  item_name: string;
  service_name: string | null;
  weight_kg: number | null;
  piece_no: number;
  /** Set once this piece has been scanned for that stage. */
  accepted_scan_at: string | null;
  delivery_scan_at: string | null;
}

export interface ScanStatus {
  order_id: string;
  order_number: string;
  /**
   * Acceptance counts every piece the order was placed for;
   * `expected_delivery_count` counts only the pieces leaving with this
   * dispatch. They are equal unless the Sorter is holding some back.
   */
  status: string;
  expected_count: number;
  expected_delivery_count: number;
  acceptance_scanned: number;
  delivery_scanned: number;
  acceptance_matched: boolean;
  delivery_matched: boolean;
  garments: Garment[];
}

export interface ScanResult {
  success: true;
  barcode: string;
  garment: { id: string; item_name: string; service_name: string | null };
  scannedCount: number;
  expectedCount: number;
  remainingCount: number;
  quantityMatched: boolean;
  message: string;
}

export type ScanStageName = 'acceptance' | 'delivery';

/**
 * A defect endpoint answers 502 when Meta refused a copy, but still returns
 * the saved record in the body — the photo is stored either way.
 *
 * Pulling that record out lets the screens show what really happened instead
 * of a bare network error, and keeps them off a second POST, which would file
 * a duplicate defect. Anything without a record (404, 409, a real 500) is
 * rethrown so it surfaces as an error.
 */
function defectFromFailure(error: any): ApiResponse<DefectRecord> | null {
  const body = error?.response?.data;
  const record = body?.data;
  if (record && typeof record === 'object' && 'whatsapp_status' in record) {
    return { success: false, data: record as DefectRecord, message: body?.message };
  }
  return null;
}

export const sorterApi = {
  /**
   * The queue.
   *
   * `today` asks the server for the current business day; `date`
   * (YYYY-MM-DD) asks for a specific one. Either way the filtering happens in
   * SQL, so Request History never pulls the whole history down to the phone.
   */
  getOrders: async (
    stage?: SorterStage,
    options: { date?: string; today?: boolean; limit?: number } = {}
  ): Promise<ApiResponse<SorterQueue>> => {
    const params: Record<string, string | number> = {};
    if (stage) params.stage = stage;
    // scope=today lets the server decide which day "today" is, from the
    // configured business timezone — the handset clock never decides it.
    if (options.today) params.scope = 'today';
    if (options.date) params.date = options.date;
    if (options.limit) params.limit = options.limit;

    const response = await apiClient.get<ApiResponse<SorterQueue>>('/api/sorter/orders', {
      params: Object.keys(params).length ? params : undefined,
    });
    return response.data;
  },

  getOrderById: async (orderId: string): Promise<ApiResponse<SorterOrderDetail>> => {
    const response = await apiClient.get<ApiResponse<SorterOrderDetail>>(
      `/api/sorter/orders/${orderId}`
    );
    return response.data;
  },

  /**
   * Requests one workflow step. The server validates the transition, so an
   * out-of-order request comes back as an error rather than being applied.
   */
  updateStatus: async (
    orderId: string,
    status: Exclude<SorterStage, 'confirmed' | 'partially_completed'>,
    /**
     * The answer to "are there any pending items in this order?", sent with
     * the `ready` step.
     *
     *   omitted        the question was not asked; item statuses are untouched
     *                  and the order completes exactly as it always has.
     *   { itemIds: [] }        "No, all items completed"
     *   { itemIds: [...] }     "Yes, pending items" — those are held back and
     *                          the order becomes PARTIALLY_COMPLETED so the
     *                          ready items can still go.
     *
     * Omitting it and sending an empty list mean different things, so the
     * field is only included when the question was actually answered.
     */
    pending?: { items: Array<{ orderItemId: string; pendingQuantity: number }>; reason?: string }
  ): Promise<ApiResponse<StatusResult>> => {
    const response = await apiClient.patch<ApiResponse<StatusResult>>(
      `/api/sorter/orders/${orderId}/status`,
      pending === undefined
        ? { status }
        : { status, pendingItems: pending.items, pendingReason: pending.reason },
    );
    return response.data;
  },

  /** Counts for both stages plus every garment's scan state. */
  getScanStatus: async (orderId: string): Promise<ApiResponse<ScanStatus>> => {
    const response = await apiClient.get<ApiResponse<ScanStatus>>(
      `/api/sorter/orders/${orderId}/scan-status`
    );
    return response.data;
  },

  getGarments: async (orderId: string): Promise<ApiResponse<Garment[]>> => {
    const response = await apiClient.get<ApiResponse<Garment[]>>(
      `/api/sorter/orders/${orderId}/garments`
    );
    return response.data;
  },

  /** Idempotent: an order that already has barcodes keeps them. */
  generateGarments: async (
    orderId: string
  ): Promise<ApiResponse<ScanStatus & { created: number }>> => {
    const response = await apiClient.post<ApiResponse<ScanStatus & { created: number }>>(
      `/api/sorter/orders/${orderId}/garments/generate`
    );
    return response.data;
  },

  /**
   * Sends one barcode. The server decides whether it counts — the screen never
   * increments a local tally.
   */
  scan: async (
    orderId: string,
    stage: ScanStageName,
    barcode: string
  ): Promise<ApiResponse<ScanResult>> => {
    const response = await apiClient.post<ApiResponse<ScanResult>>(
      `/api/sorter/orders/${orderId}/scan/${stage}`,
      { barcode }
    );
    return response.data;
  },

  /**
   * Reports a defective piece: uploads the photo and asks the backend to
   * notify the customer on WhatsApp.
   *
   * The photo travels as base64 in JSON. Meta credentials live only on the
   * server — this app never holds a WhatsApp token or phone number id.
   *
   * A resolved promise does NOT mean WhatsApp succeeded: check
   * `data.whatsapp_status`, which is only 'SENT' when Meta accepted it.
   */
  reportDefect: async (
    orderId: string,
    payload: { photoBase64: string; mimeType?: string; description?: string }
  ): Promise<ApiResponse<DefectRecord>> => {
    try {
      const response = await apiClient.post<ApiResponse<DefectRecord>>(
        `/api/sorter/orders/${orderId}/defect`,
        {
          photoBase64: payload.photoBase64,
          mimeType: payload.mimeType || 'image/jpeg',
          description: payload.description,
        },
        // A photo takes longer than a JSON call, and the server also has to
        // hand it to Meta before replying.
        { timeout: 60000 }
      );
      return response.data;
    } catch (error) {
      // 502 means the defect was saved but a WhatsApp copy was refused. That
      // is a real outcome to display, not a failed upload to repeat.
      const saved = defectFromFailure(error);
      if (saved) return saved;
      throw error;
    }
  },

  getDefects: async (orderId: string): Promise<ApiResponse<DefectRecord[]>> => {
    const response = await apiClient.get<ApiResponse<DefectRecord[]>>(
      `/api/sorter/orders/${orderId}/defects`
    );
    return response.data;
  },

  /**
   * Retries a failed WhatsApp notification. The server refuses with 409 if it
   * was already sent, unless `force` is passed — that is the duplicate guard.
   */
  retryDefectWhatsApp: async (
    orderId: string,
    defectId: string,
    force = false
  ): Promise<ApiResponse<DefectRecord>> => {
    try {
      const response = await apiClient.post<ApiResponse<DefectRecord>>(
        `/api/sorter/orders/${orderId}/defects/${defectId}/whatsapp`,
        { force },
        { timeout: 60000 }
      );
      return response.data;
    } catch (error) {
      // A refused send comes back 502 with the record; the 409 duplicate
      // guard carries no record and is rethrown as an error.
      const saved = defectFromFailure(error);
      if (saved) return saved;
      throw error;
    }
  },

  /* ---- Defective piece adjustment ---- */

  /**
   * Records the defective quantity for ONE line and re-prices the order.
   *
   * The body carries a quantity and a reason and NOTHING ELSE. The price is
   * read from the order line on the server, inside the transaction, so this
   * call cannot change what an item costs — only how many pieces are billed.
   *
   * The new figure REPLACES the previous one rather than adding to it, so
   * correcting 2 to 3 leaves 3 defective and not 5.
   */
  adjustDefectiveQuantity: async (
    orderId: string,
    orderItemId: string,
    defectiveQuantity: number,
    reason?: string
  ): Promise<ApiResponse<AdjustmentResult>> => {
    const response = await apiClient.patch<ApiResponse<AdjustmentResult>>(
      `/api/sorter/orders/${orderId}/items/${orderItemId}/defective`,
      { defectiveQuantity, reason: reason || undefined }
    );
    return response.data;
  },

  /** Every adjustment on an order, the notifications sent, and the money position. */
  getAdjustments: async (
    orderId: string
  ): Promise<
    ApiResponse<{
      adjustments: OrderItemAdjustment[];
      notifications: AdjustmentNotification[];
    }>
  > => {
    const response = await apiClient.get<
      ApiResponse<{
        adjustments: OrderItemAdjustment[];
        notifications: AdjustmentNotification[];
      }>
    >(`/api/sorter/orders/${orderId}/adjustments`);
    return response.data;
  },

  /* ---- Pending items / partial completion ---- */

  /**
   * Sets how many PIECES of one line are being held.
   *
   * `0` releases the line: the Sorter has finished the held pieces, so the
   * whole line goes with the next dispatch and the order returns to
   * READY_FOR_DELIVERY once nothing anywhere on it is held.
   *
   * It REPLACES rather than accumulates — sending 2 after 3 leaves 2 held.
   *
   * Nothing financial moves: holding pieces back or releasing them does not
   * touch price, billed quantity, invoice or payment.
   */
  setItemPendingQuantity: async (
    orderId: string,
    orderItemId: string,
    pendingQuantity: number,
    reason?: string
  ): Promise<ApiResponse<ItemPendingResult>> => {
    const response = await apiClient.patch<ApiResponse<ItemPendingResult>>(
      `/api/sorter/orders/${orderId}/items/${orderItemId}/pending`,
      { pendingQuantity, reason: reason || undefined }
    );
    return response.data;
  },

  /**
   * Tells the customer or business about the adjustment.
   *
   * A SEPARATE action from saving, so correcting a figure three times does
   * not send three messages. A second send for the same adjustment is refused
   * with 409; recording a new defective quantity makes one allowed again.
   */
  sendAdjustmentWhatsApp: async (
    orderId: string,
    force = false
  ): Promise<ApiResponse<AdjustmentNotification>> => {
    try {
      const response = await apiClient.post<ApiResponse<AdjustmentNotification>>(
        `/api/sorter/orders/${orderId}/defective-notification`,
        { force },
        { timeout: 60000 }
      );
      return response.data;
    } catch (error: any) {
      // A refused send comes back 502 WITH the record, so the screen can show
      // the real reason Meta gave. The 409 duplicate guard carries no record
      // and is rethrown for the caller to surface as a message.
      const body = error?.response?.data;
      if (error?.response?.status === 502 && body?.data) return body;
      throw error;
    }
  },

  /**
   * The confirmation document. Returns the stored URL when the order has one,
   * along with the order detail the shared PDF template renders from.
   */
  getConfirmationPdf: async (
    orderId: string
  ): Promise<ApiResponse<{ url: string | null; order: SorterOrderDetail }>> => {
    const response = await apiClient.get<
      ApiResponse<{ url: string | null; order: SorterOrderDetail }>
    >(`/api/sorter/orders/${orderId}/pdf`);
    return response.data;
  },
};

export default sorterApi;
