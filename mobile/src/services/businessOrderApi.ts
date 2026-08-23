import apiClient from './api';
import { ApiResponse } from '../types';

export interface BusinessCategory {
  id: string;
  name: string;
  slug: string;
  /** null = Main Category; set = Sub Category of that parent. */
  parent_id: string | null;
  image_url?: string | null;
  icon_name?: string | null;
  display_order: number;
  /** False means items come next rather than another category level. */
  has_subcategories: boolean;
  item_count: number;
  /** Sample item names shown as preview text on the card. */
  preview_items: string[];
}

export interface BusinessItem {
  id: string;
  category_id: string;
  category_name: string;
  parent_category_id: string | null;
  parent_category_name: string | null;
  standard_size: string | null;
  name: string;
  unit: string;
  /** Standard weight per piece, numeric, in `weight_unit`. */
  weight_kg: number | null;
  weight_unit: string;
  image_url?: string | null;
  icon_name?: string | null;
  is_active: boolean;
  /** Service codes this item can be given, e.g. ['wash_iron','dry_clean']. */
  service_types: string[];
}

export interface BusinessCartItem {
  id: string;
  item_id: string;
  item_name: string;
  category_id: string;
  category_name: string;
  image_url?: string | null;
  unit: string;
  quantity: number;
  weight_kg: number | null;
  weight_unit: string;
  total_weight_kg: number;
  /** The service this line was added for. */
  service_type: 'wash_iron' | 'dry_clean' | null;
  service_name: string | null;
  /** The services this item supports, so the line can be switched. */
  available_service_types: string[];
}

export interface BusinessCart {
  id: string;
  laundry_type: 'hotel' | 'guest' | null;
  order_type: 'standard' | 'quick' | null;
  /**
   * Legacy cart-wide service still returned by the API. The app no longer
   * sets or reads it: the service lives on each cart item instead.
   */
  service_type: 'wash_iron' | 'dry_clean' | null;
  items: BusinessCartItem[];
  /** SUM(item weight x quantity) across the cart, in kg. */
  total_weight_kg: number;
}

/** A pickup slot offered by the server; never hardcoded in the app. */
export interface BusinessTimeSlot {
  id: string;
  label: string;
  /** Minutes since midnight at which the slot opens, e.g. 9:00 AM -> 540. */
  start_minutes: number;
  /**
   * False when this slot cannot be booked on the date that was asked about —
   * on today, one whose start time has already passed in IST. The server
   * decides this, and refuses the same slot at order time.
   */
  available: boolean;
}

/**
 * What the user picked on the Pickup & Delivery page, sent with the order.
 *
 * Pickup and delivery each carry their own date AND their own slot: they are
 * separate bookings on separate days, never one date shared between them.
 * The server re-validates every field.
 */
export interface BusinessPickupSchedule {
  /** YYYY-MM-DD in IST. */
  pickupDate: string;
  /** Pickup slot id, e.g. "11-13". */
  pickupSlot: string;
  /**
   * YYYY-MM-DD in IST, always a later day than `pickupDate`.
   *
   * OPTIONAL: an order may be placed with the pickup alone and the delivery
   * scheduled afterwards through `scheduleDelivery`. Null together with
   * `deliverySlot` or set together with it -- never one without the other.
   */
  deliveryDate?: string | null;
  /** Delivery slot id, chosen independently of the pickup. Optional, as above. */
  deliverySlot?: string | null;
  /** Optional note for the driver on both legs. */
  pickupNotes?: string;
  /** Optional note about the laundry itself. */
  serviceNotes?: string;
}

export interface BusinessOrderResult {
  id: string;
  order_number: string;
  /** The pickup booked with this order. */
  pickup: { date: string; slot_label: string; slot_start: string; slot_end: string };
  /** The delivery, or null when it has not been scheduled yet. */
  delivery: { date: string; slot_label: string; slot_start: string; slot_end: string } | null;
  laundry_type: string;
  order_type: string;
  service_type: string;
  status: string;
  /* No amounts. The business app never shows a price, so the backend
     sends none: an order is priced server-side from business_price_list
     and the figures live on the order, not in this response. */
  total_weight_kg: number;
  items: Array<{
    item_id: string;
    item_name: string;
    category_id: string;
    quantity: number;
    unit: string;
    weight_kg: number | null;
    total_weight_kg: number;
  }>;
}

export interface LaundryServiceType {
  id: string;
  name: string;
  code: 'wash_iron' | 'dry_clean';
  category_id: string;
  category_name: string;
}

export interface BusinessOrderSummary {
  id: string;
  order_number: string;
  laundry_type: string | null;
  order_type: string | null;
  service_type: string | null;
  service_name: string | null;
  status: string;
  item_count: number;
  total_quantity: number;
  /** SUM(item weight x quantity) for the order, in kg. */
  total_weight_kg: number;
  created_at: string;
}

export interface LaundryServices {
  category: BusinessCategory | null;
  serviceTypes: LaundryServiceType[];
}

export interface BusinessOrderItem {
  id: string;
  service_id: string | null;
  /** The item's own name — legacy column name, not the laundry service. */
  service_name: string;
  /**
   * The laundry service for THIS line (e.g. "Wash & Iron"), null when the
   * order predates per-item services and cannot be resolved.
   */
  laundry_service_name: string | null;
  category_id: string | null;
  category_name: string | null;
  image_url: string | null;
  /** The BILLABLE quantity: original_quantity - defective_quantity. */
  quantity: number;
  /**
   * The pieces the order was placed for. Equal to `quantity` until a Sorter
   * records a defective piece against the line.
   */
  original_quantity: number;
  /** Pieces the Sorter found damaged. 0 on a line never adjusted. */
  defective_quantity: number;
  /**
   * Where this line stands on its own.
   *
   *   PROCESSING  with Swachham, being worked on
   *   READY       finished, and going out with the next dispatch
   *   PENDING     held back because it needs more time, while the rest of the
   *               order goes out
   *
   * READ-ONLY here. Only a Sorter can change it, through an endpoint a
   * business token cannot reach.
   */
  item_status: 'PROCESSING' | 'READY' | 'PARTIALLY_PENDING' | 'PENDING';
  /** Pieces still being processed at Swachham. */
  pending_quantity: number;
  /** ordered - pending: the pieces going out with the next dispatch. */
  delivery_quantity: number;
  /** Why they are being held, when they are. */
  pending_reason: string | null;
  unit: string;
  weight_kg: number | null;
  total_weight_kg: number;
}

export interface BusinessOrderDetail extends BusinessOrderSummary {
  business_name: string;
  contact_person_name: string | null;
  /**
   * The number this order was PLACED ON -- `orders.placed_by_mobile`.
   *
   * Not the business's number and not the account's: it is what the person
   * who placed the order proved by OTP for that session, so an order placed
   * by an alternative contact carries the alternative contact's number.
   *
   * NULL for orders placed before the field existed. Nothing substitutes the
   * account's number for it; those orders show "N/A".
   */
  placed_by_mobile: string | null;
  business_email: string | null;
  business_address: string | null;
  items: BusinessOrderItem[];
  /**
   * True when any line carries a defective adjustment.
   *
   * The documents use it to decide whether to print the Ordered / Defective /
   * Final columns at all, so an order nobody adjusted reads exactly as it
   * always did rather than carrying three columns explaining nothing.
   */
  has_adjustment: boolean;
  /** True when some of this order is finished and some is still in process. */
  has_pending_items: boolean;
}

export interface BusinessOrderTracking {
  order_id: string;
  order_number: string;
  status: string;
  is_cancelled: boolean;
  can_cancel: boolean;
  current_stage: string | null;
  stages: Array<{ key: string; label: string; completed: boolean; current: boolean; at: string | null }>;
  history: Array<{ status: string; notes: string | null; created_at: string }>;
}

export interface BusinessProfile {
  business_id: string;
  business_name: string;
  /** The establishment CATEGORY (hotel, restaurant…), from businesses.business_type. */
  customer_type: string | null;
  /** B2B or B2C — the registration type. A B2C account carries no GST number. */
  registration_type: 'B2B' | 'B2C';
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
  account_name: string;
  account_email: string;
}

export interface NearbyStore {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  district: string | null;
  state: string | null;
  pincode: string | null;
  latitude: number;
  longitude: number;
  contact_number: string | null;
  distance_km: number;
}

export type BusinessProfileUpdate = Partial<{
  customerType: string;
  otherTypeSpecify: string | null;
  establishmentAddress: string;
  gstNumber: string | null;
  panNumber: string | null;
  website: string | null;
  contactPersonName: string;
  designation: string | null;
  mobileNumber: string;
  whatsappNumber: string | null;
  emailId: string;
  alternateContactPerson: string | null;
  alternateMobileNo: string | null;
}>;

export const businessOrderApi = {
  getProfile: async (): Promise<ApiResponse<BusinessProfile>> => {
    const response = await apiClient.get<ApiResponse<BusinessProfile>>('/api/businesses/profile');
    return response.data;
  },

  updateProfile: async (payload: BusinessProfileUpdate): Promise<ApiResponse<BusinessProfile>> => {
    const response = await apiClient.put<ApiResponse<BusinessProfile>>('/api/businesses/profile', payload);
    return response.data;
  },

  getLaundryServices: async (): Promise<ApiResponse<LaundryServices>> => {
    const response = await apiClient.get<ApiResponse<LaundryServices>>('/api/businesses/services');
    return response.data;
  },

  getCategories: async (serviceType?: string): Promise<ApiResponse<BusinessCategory[]>> => {
    const response = await apiClient.get<ApiResponse<BusinessCategory[]>>('/api/businesses/categories', {
      params: serviceType ? { serviceType } : undefined,
    });
    return response.data;
  },

  getSubCategories: async (
    categoryId: string,
    serviceType?: string
  ): Promise<ApiResponse<BusinessCategory[]>> => {
    const response = await apiClient.get<ApiResponse<BusinessCategory[]>>(
      `/api/businesses/categories/${categoryId}/subcategories`,
      { params: serviceType ? { serviceType } : undefined }
    );
    return response.data;
  },

  getItemsByCategory: async (
    categoryId: string,
    serviceType?: string
  ): Promise<ApiResponse<BusinessItem[]>> => {
    const response = await apiClient.get<ApiResponse<BusinessItem[]>>(
      `/api/businesses/categories/${categoryId}/items`,
      { params: serviceType ? { serviceType } : undefined }
    );
    return response.data;
  },

  /** `serviceType` omitted means "All" — no service filtering. */
  searchItems: async (params: {
    search?: string;
    categoryId?: string;
    serviceType?: string;
  }): Promise<ApiResponse<BusinessItem[]>> => {
    const response = await apiClient.get<ApiResponse<BusinessItem[]>>('/api/businesses/items', { params });
    return response.data;
  },

  getCart: async (): Promise<ApiResponse<BusinessCart>> => {
    const response = await apiClient.get<ApiResponse<BusinessCart>>('/api/businesses/cart');
    return response.data;
  },

  /** Order Type + Laundry Type, both chosen in the Cart. */
  setCartContext: async (context: {
    laundryType?: string;
    orderType?: string;
  }): Promise<ApiResponse<BusinessCart>> => {
    const response = await apiClient.put<ApiResponse<BusinessCart>>(
      '/api/businesses/cart/context',
      context
    );
    return response.data;
  },

  /**
   * `itemServiceType` is the service for this line. It is required: there is
   * no order-wide service, so every line carries its own.
   */
  addCartItem: async (
    itemId: string,
    quantity: number,
    itemServiceType: string
  ): Promise<ApiResponse<BusinessCart>> => {
    const response = await apiClient.post<ApiResponse<BusinessCart>>('/api/businesses/cart/items', {
      itemId,
      quantity,
      itemServiceType,
    });
    return response.data;
  },

  updateCartItem: async (itemId: string, quantity: number): Promise<ApiResponse<BusinessCart>> => {
    const response = await apiClient.put<ApiResponse<BusinessCart>>(
      `/api/businesses/cart/items/${itemId}`,
      { quantity }
    );
    return response.data;
  },

  /** Same endpoint as updateCartItem — the line's service instead of its quantity. */
  setCartItemService: async (
    itemId: string,
    itemServiceType: string
  ): Promise<ApiResponse<BusinessCart>> => {
    const response = await apiClient.put<ApiResponse<BusinessCart>>(
      `/api/businesses/cart/items/${itemId}`,
      { itemServiceType }
    );
    return response.data;
  },

  removeCartItem: async (itemId: string): Promise<ApiResponse<BusinessCart>> => {
    const response = await apiClient.delete<ApiResponse<BusinessCart>>(`/api/businesses/cart/items/${itemId}`);
    return response.data;
  },

  getOrders: async (): Promise<ApiResponse<BusinessOrderSummary[]>> => {
    const response = await apiClient.get<ApiResponse<BusinessOrderSummary[]>>('/api/businesses/orders');
    return response.data;
  },

  getOrderById: async (orderId: string): Promise<ApiResponse<BusinessOrderDetail>> => {
    const response = await apiClient.get<ApiResponse<BusinessOrderDetail>>(
      `/api/businesses/orders/${orderId}`
    );
    return response.data;
  },

  repeatOrder: async (
    orderId: string
  ): Promise<ApiResponse<{ item_count: number; cart: BusinessCart }>> => {
    const response = await apiClient.post<ApiResponse<{ item_count: number; cart: BusinessCart }>>(
      `/api/businesses/orders/${orderId}/repeat`
    );
    return response.data;
  },

  getNearbyStores: async (params: {
    latitude: number;
    longitude: number;
    radiusKm?: number;
  }): Promise<ApiResponse<NearbyStore[]>> => {
    const response = await apiClient.get<ApiResponse<NearbyStore[]>>(
      '/api/businesses/stores/nearby',
      { params }
    );
    return response.data;
  },

  cancelOrder: async (
    orderId: string,
    reason?: string
  ): Promise<ApiResponse<{ id: string; order_number: string; status: string }>> => {
    const response = await apiClient.patch<ApiResponse<{ id: string; order_number: string; status: string }>>(
      `/api/businesses/orders/${orderId}/cancel`,
      { reason }
    );
    return response.data;
  },

  getOrderTracking: async (orderId: string): Promise<ApiResponse<BusinessOrderTracking>> => {
    const response = await apiClient.get<ApiResponse<BusinessOrderTracking>>(
      `/api/businesses/orders/${orderId}/tracking`
    );
    return response.data;
  },

  /** The pickup slots on offer, defined by the server. */
  /**
   * The bookable slots. Passing a date asks the server which of them are
   * still available on THAT day, so the app never offers a slot the order
   * endpoint would reject.
   */
  /**
   * Books the delivery for an order that was placed with the pickup alone.
   * Both fields are required here — this call exists to schedule a delivery.
   */
  scheduleDelivery: async (
    orderId: string,
    deliveryDate: string,
    deliverySlot: string
  ): Promise<ApiResponse<{ order_id: string; order_number: string; delivery: BusinessOrderResult['delivery'] }>> => {
    const response = await apiClient.patch(
      `/api/businesses/orders/${orderId}/delivery`,
      { deliveryDate, deliverySlot }
    );
    return response.data as ApiResponse<{
      order_id: string;
      order_number: string;
      delivery: BusinessOrderResult['delivery'];
    }>;
  },

  getTimeSlots: async (date?: string): Promise<ApiResponse<BusinessTimeSlot[]>> => {
    const response = await apiClient.get<ApiResponse<BusinessTimeSlot[]>>(
      '/api/businesses/time-slots',
      { params: date ? { date } : {} }
    );
    return response.data;
  },

  /**
   * Places the order. The body carries only the chosen pickup date and slot —
   * the items come from the server-side cart, and the bearer token says who
   * is ordering.
   *
   * No coordinates and no location header: the service area was settled on
   * the Allow Permission page when the app opened.
   */
  confirmOrder: async (
    schedule: BusinessPickupSchedule
  ): Promise<ApiResponse<BusinessOrderResult>> => {
    const response = await apiClient.post<ApiResponse<BusinessOrderResult>>(
      '/api/businesses/orders',
      {
        pickupDate: schedule.pickupDate,
        pickupSlot: schedule.pickupSlot,
        // Sent as null rather than omitted, so "not scheduled" is explicit.
        deliveryDate: schedule.deliveryDate || null,
        deliverySlot: schedule.deliverySlot || null,
        pickupNotes: schedule.pickupNotes,
        serviceNotes: schedule.serviceNotes,
      }
    );
    return response.data;
  },
};

export default businessOrderApi;
