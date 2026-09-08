/**
 * THE DEMO BUSINESS API.
 *
 * A drop-in stand-in for `services/businessOrderApi`, implementing the same
 * methods with the same signatures and the same response shapes, served
 * entirely from the device. `businessOrderApi` picks between this and the
 * real client once, at module load, on the build-time `DEMO_MODE` flag — so
 * every Business screen and the Business order store are untouched and cannot
 * tell the difference.
 *
 * NOTHING HERE OPENS A SOCKET. There is no axios import in this file and no
 * URL anywhere in it; the only I/O is the demo's own JSON file on the phone.
 *
 * THE RULES ARE THE REAL ONES. Quantities must be whole and positive, a cart
 * line must carry a service the item actually offers, a delivery must be a
 * later day than its pickup, only a freshly placed order may be cancelled —
 * each is enforced here with the same wording the backend answers with, so a
 * hotel that does the wrong thing in the demo is told what the real app would
 * tell them.
 */

import type { ApiResponse } from '../types';
import type {
  BusinessCart,
  BusinessCartItem,
  BusinessCategory,
  BusinessItem,
  BusinessOrderDetail,
  BusinessOrderItem,
  BusinessOrderResult,
  BusinessOrderSummary,
  BusinessOrderTracking,
  BusinessPickupSchedule,
  BusinessProfile,
  BusinessProfileUpdate,
  BusinessTimeSlot,
  LaundryServices,
  NearbyStore,
} from '../services/businessOrderApi';

import {
  DEMO_ITEMS,
  DEMO_MAIN_CATEGORIES,
  DEMO_NEARBY_STORES,
  DEMO_QUICK_ORDER_MULTIPLIER,
  DEMO_SERVICE_TYPES,
  DEMO_SUB_CATEGORIES,
  DEMO_TIME_SLOTS,
  demoServiceName,
  findDemoItem,
} from './demoCatalog';

import {
  DemoCart,
  DemoOrder,
  DemoOrderItem,
  DEMO_STATUS_FLOW,
  formatDemoOrderNumber,
  getDemoState,
  nextDemoStatus,
  resetDemoState,
  updateDemoState,
} from './demoState';

import { currentMinutesIST, isTodayIST, todayIST } from '../utils/istDates';

/* ------------------------------------------------------------------ *
 * ERRORS
 * ------------------------------------------------------------------ */

/**
 * An error shaped like the one axios would have thrown.
 *
 * `extractErrorMessage` in services/api.ts reads `error.response.data.message`
 * and treats an error WITHOUT a `response` as a network failure — so a plain
 * `Error` here would surface to the hotel as "Unable to reach the server",
 * which is exactly the wrong thing for an offline demo to say. Giving the
 * error a response makes every screen print the real rule instead.
 */
function demoError(message: string, status = 400): Error {
  const error = new Error(message) as Error & {
    response: { status: number; data: { success: false; message: string } };
    isDemoError: true;
  };
  error.response = { status, data: { success: false, message } };
  error.isDemoError = true;
  return error;
}

/** Every demo response carries the same envelope the API uses. */
function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

/* ------------------------------------------------------------------ *
 * MAPPING: stored demo records -> API shapes
 * ------------------------------------------------------------------ */

/** The catalogue's standard weight for a line, times its quantity. */
function lineWeight(weightKg: number | null, quantity: number): number {
  return Number((((weightKg ?? 0) as number) * quantity).toFixed(3));
}

/** One stored cart line, in the shape the Cart screen renders. */
function toCartItem(line: DemoCart['items'][number]): BusinessCartItem | null {
  const item = findDemoItem(line.item_id);
  if (!item) return null;
  return {
    // Must match the id `addCartItem` minted: the LINE, item plus service.
    id: `demo-cartline-${line.item_id}-${line.service_type}`,
    item_id: item.id,
    item_name: item.name,
    category_id: item.category_id,
    category_name: item.category_name,
    image_url: null,
    unit: item.unit,
    quantity: line.quantity,
    weight_kg: item.weight_kg,
    weight_unit: item.weight_unit,
    total_weight_kg: lineWeight(item.weight_kg, line.quantity),
    service_type: line.service_type,
    service_name: demoServiceName(line.service_type),
    available_service_types: item.service_types,
  };
}

/** The whole cart, with its total weight summed the way the server sums it. */
function toCart(cart: DemoCart): BusinessCart {
  const items = cart.items
    .map(toCartItem)
    .filter((item): item is BusinessCartItem => item !== null);
  return {
    id: cart.id,
    laundry_type: cart.laundry_type,
    order_type: cart.order_type,
    // Legacy cart-wide service. The app neither sets nor reads it; it is null
    // here for the same reason it is null on a real cart today.
    service_type: null,
    items,
    total_weight_kg: Number(
      items.reduce((sum, item) => sum + item.total_weight_kg, 0).toFixed(3)
    ),
  };
}

/**
 * The order-wide service, for the legacy `service_type` field the list shows.
 *
 * One code when every line shares it, null when they differ — which is the
 * honest answer for an order that mixes Wash & Fold towels with Dry Clean
 * curtains, and is what the list already handles.
 */
function orderWideService(order: DemoOrder): 'wash_fold' | 'wash_iron' | 'dry_clean' | null {
  const codes = new Set(order.items.map((item) => item.service_type).filter(Boolean));
  if (codes.size !== 1) return null;
  return [...codes][0] as 'wash_fold' | 'wash_iron' | 'dry_clean';
}

function toOrderSummary(order: DemoOrder): BusinessOrderSummary {
  const service = orderWideService(order);
  return {
    id: order.id,
    order_number: order.order_number,
    laundry_type: order.laundry_type,
    order_type: order.order_type,
    service_type: service,
    service_name: demoServiceName(service),
    status: order.status,
    item_count: order.items.length,
    total_quantity: order.items.reduce((sum, item) => sum + item.quantity, 0),
    total_weight_kg: Number(
      order.items
        .reduce((sum, item) => sum + lineWeight(item.weight_kg, item.quantity), 0)
        .toFixed(3)
    ),
    created_at: order.created_at,
    // Null until the order leaves PENDING_APPROVAL, matching the real API:
    // no Manager has scheduled it, so there is nothing to show.
    assigned_pickup_date: order.assigned_pickup_date ?? null,
    assigned_pickup_time: order.assigned_pickup_time ?? null,
  };
}

/**
 * A line's own status, derived from the order's.
 *
 * Only a Sorter can move a real line independently, and the demo has no
 * Sorter, so every line simply tracks the order: still being worked on, or
 * finished. Nothing in the demo produces a PENDING or partially pending line,
 * which is why every line reports zero pending pieces.
 */
function lineStatus(orderStatus: string): BusinessOrderItem['item_status'] {
  const finished = ['READY_FOR_DELIVERY', 'OUT_FOR_DELIVERY', 'DELIVERED', 'COMPLETED'];
  return finished.includes(orderStatus) ? 'READY' : 'PROCESSING';
}

function toOrderItem(item: DemoOrderItem, orderStatus: string): BusinessOrderItem {
  return {
    id: item.id,
    service_id: item.item_id,
    // Legacy column name: this is the ITEM's name, not the laundry service.
    service_name: item.item_name,
    laundry_service_name: demoServiceName(item.service_type),
    category_id: item.category_id,
    category_name: item.category_name,
    image_url: null,
    quantity: item.quantity,
    original_quantity: item.quantity,
    // The demo has no Sorter, so no line is ever adjusted for damage.
    defective_quantity: 0,
    item_status: lineStatus(orderStatus),
    pending_quantity: 0,
    delivery_quantity: item.quantity,
    pending_reason: null,
    unit: item.unit,
    weight_kg: item.weight_kg,
    total_weight_kg: lineWeight(item.weight_kg, item.quantity),
  };
}

function toOrderDetail(order: DemoOrder, profile: BusinessProfile): BusinessOrderDetail {
  return {
    ...toOrderSummary(order),
    business_name: profile.business_name,
    contact_person_name: profile.contact_person_name,
    placed_by_mobile: profile.mobile_number,
    business_email: profile.email_id,
    business_address: profile.establishment_address,
    items: order.items.map((item) => toOrderItem(item, order.status)),
    has_adjustment: false,
    has_pending_items: false,
  };
}

/** A slot id turned into the label / start / end trio an order result holds. */
function slotLeg(leg: { date: string; slot_id: string } | null) {
  if (!leg) return null;
  const slot = DEMO_TIME_SLOTS.find((option) => option.id === leg.slot_id) || DEMO_TIME_SLOTS[0];
  return {
    date: leg.date,
    slot_label: slot.label,
    slot_start: slot.start,
    slot_end: slot.end,
  };
}

function toOrderResult(order: DemoOrder): BusinessOrderResult {
  return {
    id: order.id,
    order_number: order.order_number,
    pickup: slotLeg(order.pickup)!,
    delivery: slotLeg(order.delivery),
    laundry_type: order.laundry_type || '',
    order_type: order.order_type || '',
    service_type: orderWideService(order) || '',
    status: order.status,
    total_weight_kg: toOrderSummary(order).total_weight_kg,
    items: order.items.map((item) => ({
      item_id: item.item_id,
      item_name: item.item_name,
      category_id: item.category_id,
      quantity: item.quantity,
      unit: item.unit,
      weight_kg: item.weight_kg,
      total_weight_kg: lineWeight(item.weight_kg, item.quantity),
    })),
  };
}

/* ------------------------------------------------------------------ *
 * TRACKING
 * ------------------------------------------------------------------ */

/**
 * The seven stages, exactly as backend/src/services/businessOrder.service.ts
 * defines them, so the tracking screen draws the same ladder it does against
 * the real API.
 */
const TRACKING_STAGES: Array<{ key: string; label: string; statuses: string[] }> = [
  { key: 'pending', label: 'Awaiting Confirmation', statuses: ['PENDING_APPROVAL'] },
  { key: 'placed', label: 'Order Placed', statuses: ['ORDER_PLACED'] },
  {
    key: 'confirmed',
    label: 'Confirmed',
    statuses: ['PICKUP_SCHEDULED', 'PICKUP_ASSIGNED', 'PICKED_UP', 'RECEIVED_AT_FACILITY'],
  },
  {
    key: 'processing',
    label: 'Processing',
    statuses: ['SORTING', 'WASHING', 'DRYING', 'IRONING', 'QUALITY_CHECK'],
  },
  { key: 'ready', label: 'Ready', statuses: ['READY_FOR_DELIVERY', 'PARTIALLY_COMPLETED'] },
  {
    key: 'out_for_delivery',
    label: 'Out for Delivery',
    statuses: ['DELIVERY_ASSIGNED', 'OUT_FOR_DELIVERY'],
  },
  { key: 'completed', label: 'Completed', statuses: ['DELIVERED', 'COMPLETED'] },
];

/** Cancellation closes once the order is accepted — the backend's own rule. */
const CANCELLABLE_STATUSES = ['PENDING_APPROVAL', 'ORDER_PLACED'];

function toTracking(order: DemoOrder): BusinessOrderTracking {
  const isCancelled = order.status === 'CANCELLED';
  const currentIndex = TRACKING_STAGES.findIndex((stage) =>
    stage.statuses.includes(order.status)
  );

  const stages = TRACKING_STAGES.map((stage, index) => {
    const reached = order.history.find((entry) => stage.statuses.includes(entry.status));
    return {
      key: stage.key,
      label: stage.label,
      completed: !isCancelled && currentIndex >= 0 && index < currentIndex,
      current: !isCancelled && index === currentIndex,
      at: reached?.created_at ?? (stage.key === 'placed' ? order.created_at : null),
    };
  });

  return {
    order_id: order.id,
    order_number: order.order_number,
    status: order.status,
    is_cancelled: isCancelled,
    can_cancel: CANCELLABLE_STATUSES.includes(order.status),
    current_stage: currentIndex >= 0 ? TRACKING_STAGES[currentIndex].key : null,
    stages,
    history: order.history,
    // The same two fields the real tracking endpoint returns, from the same
    // order, so the tracking screen renders the pickup card identically here.
    assigned_pickup_date: order.assigned_pickup_date ?? null,
    assigned_pickup_time: order.assigned_pickup_time ?? null,
  };
}

/* ------------------------------------------------------------------ *
 * VALIDATION, in the backend's words
 * ------------------------------------------------------------------ */

const SERVICE_CODES = ['wash_fold', 'wash_iron', 'dry_clean'];

function requireWholeQuantity(quantity: number): void {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw demoError('Quantity must be a positive whole number');
  }
}

/** The item must exist AND must actually offer the service asked for. */
function requireItemService(itemId: string, serviceType: string): BusinessItem {
  const item = findDemoItem(itemId);
  if (!item) throw demoError('Item not found', 404);
  if (!SERVICE_CODES.includes(serviceType)) throw demoError('Invalid service type');
  if (!item.service_types.includes(serviceType)) {
    throw demoError(`${item.name} is not offered for that service.`);
  }
  return item;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/* ------------------------------------------------------------------ *
 * THE API
 * ------------------------------------------------------------------ */

export const demoBusinessOrderApi = {
  /* ---------------- profile ---------------- */

  getProfile: async (): Promise<ApiResponse<BusinessProfile>> => {
    const state = await getDemoState();
    return ok({ ...state.profile });
  },

  /**
   * Profile edits are kept, so the hotel can change a contact name in the
   * demo and see it stick. Reset Demo Data puts the sample profile back.
   */
  updateProfile: async (payload: BusinessProfileUpdate): Promise<ApiResponse<BusinessProfile>> => {
    const updated = await updateDemoState((state) => {
      const profile = state.profile;
      if (payload.customerType !== undefined) profile.customer_type = payload.customerType;
      if (payload.otherTypeSpecify !== undefined) profile.other_type_specify = payload.otherTypeSpecify;
      if (payload.establishmentAddress !== undefined) profile.establishment_address = payload.establishmentAddress;
      if (payload.gstNumber !== undefined) profile.gst_number = payload.gstNumber;
      if (payload.panNumber !== undefined) profile.pan_number = payload.panNumber;
      if (payload.website !== undefined) profile.website = payload.website;
      if (payload.contactPersonName !== undefined) profile.contact_person_name = payload.contactPersonName;
      if (payload.designation !== undefined) profile.designation = payload.designation;
      if (payload.mobileNumber !== undefined) profile.mobile_number = payload.mobileNumber;
      if (payload.whatsappNumber !== undefined) profile.whatsapp_number = payload.whatsappNumber;
      if (payload.emailId !== undefined) profile.email_id = payload.emailId;
      if (payload.alternateContactPerson !== undefined) profile.alternate_contact_person = payload.alternateContactPerson;
      if (payload.alternateMobileNo !== undefined) profile.alternate_mobile_no = payload.alternateMobileNo;
      return { ...profile };
    });
    return ok(updated);
  },

  /* ---------------- catalogue ---------------- */

  getLaundryServices: async (): Promise<ApiResponse<LaundryServices>> =>
    ok({
      category: null,
      serviceTypes: DEMO_SERVICE_TYPES,
      quickOrderMultiplier: DEMO_QUICK_ORDER_MULTIPLIER,
    }),

  getCategories: async (serviceType?: string): Promise<ApiResponse<BusinessCategory[]>> =>
    ok(filterCategoriesByService(DEMO_MAIN_CATEGORIES, serviceType)),

  getSubCategories: async (
    categoryId: string,
    serviceType?: string
  ): Promise<ApiResponse<BusinessCategory[]>> =>
    ok(
      filterCategoriesByService(
        DEMO_SUB_CATEGORIES.filter((category) => category.parent_id === categoryId),
        serviceType
      )
    ),

  getItemsByCategory: async (
    categoryId: string,
    serviceType?: string
  ): Promise<ApiResponse<BusinessItem[]>> =>
    ok(
      sortByFrequency(
        DEMO_ITEMS.filter(
          (item) =>
            (item.category_id === categoryId || item.parent_category_id === categoryId) &&
            offersService(item, serviceType)
        )
      )
    ),

  /** `serviceType` omitted means "All" — no service filtering, as in the API. */
  searchItems: async (params: {
    search?: string;
    categoryId?: string;
    serviceType?: string;
  }): Promise<ApiResponse<BusinessItem[]>> => {
    const term = (params.search || '').trim().toLowerCase();
    return ok(
      sortByFrequency(
        DEMO_ITEMS.filter((item) => {
          if (params.categoryId) {
            const inCategory =
              item.category_id === params.categoryId ||
              item.parent_category_id === params.categoryId;
            if (!inCategory) return false;
          }
          if (!offersService(item, params.serviceType)) return false;
          if (!term) return true;
          return (
            item.name.toLowerCase().includes(term) ||
            item.category_name.toLowerCase().includes(term)
          );
        })
      )
    );
  },

  /* ---------------- cart ---------------- */

  getCart: async (): Promise<ApiResponse<BusinessCart>> => {
    const state = await getDemoState();
    return ok(toCart(state.cart));
  },

  setCartContext: async (context: {
    laundryType?: string;
    orderType?: string;
  }): Promise<ApiResponse<BusinessCart>> => {
    const cart = await updateDemoState((state) => {
      if (context.laundryType !== undefined) {
        if (!['hotel', 'guest'].includes(context.laundryType)) {
          throw demoError('Invalid laundry type');
        }
        state.cart.laundry_type = context.laundryType as 'hotel' | 'guest';
      }
      if (context.orderType !== undefined) {
        if (!['standard', 'quick'].includes(context.orderType)) {
          throw demoError('Invalid order type');
        }
        state.cart.order_type = context.orderType as 'standard' | 'quick';
      }
      return toCart(state.cart);
    });
    return ok(cart);
  },

  /**
   * Adds an item, or tops up the line that is already there.
   *
   * Same behaviour as the server's `ON DUPLICATE KEY UPDATE`: one line per
   * item, its quantity summed and its service re-stated. The Cart addresses
   * lines by ITEM id, so one line per item is not an optimisation — it is
   * what makes the Cart's own update and remove calls unambiguous.
   */
  addCartItem: async (
    itemId: string,
    quantity: number,
    itemServiceType: string
  ): Promise<ApiResponse<BusinessCart>> => {
    requireWholeQuantity(quantity);
    requireItemService(itemId, itemServiceType);

    const cart = await updateDemoState((state) => {
      /*
       * ONE LINE PER ITEM **AND SERVICE**, matching the server's unique key
       * (cart_id, service_id, laundry_service_key). Merging on `item_id`
       * alone folded Shirt / Dry Clean into Shirt / Wash & Iron, so the two
       * could never exist side by side here at all.
       */
      const existing = state.cart.items.find(
        (line) => line.item_id === itemId && line.service_type === itemServiceType
      );
      if (existing) {
        existing.quantity += quantity;
      } else {
        state.cart.items.push({
          // The id names the LINE, so it has to carry the service too.
          id: `demo-cartline-${itemId}-${itemServiceType}`,
          item_id: itemId,
          quantity,
          service_type: itemServiceType as DemoOrderItem['service_type'],
        });
      }
      return toCart(state.cart);
    });
    return ok(cart);
  },

  updateCartItem: async (cartItemId: string, quantity: number): Promise<ApiResponse<BusinessCart>> => {
    requireWholeQuantity(quantity);
    const cart = await updateDemoState((state) => {
      // BY LINE ID, not item id — an item id names every service that item
      // is in the cart at.
      const line = state.cart.items.find((entry) => entry.id === cartItemId);
      if (!line) throw demoError('Cart item not found', 404);
      line.quantity = quantity;
      return toCart(state.cart);
    });
    return ok(cart);
  },

  setCartItemService: async (
    cartItemId: string,
    itemServiceType: string
  ): Promise<ApiResponse<BusinessCart>> => {
    const cart = await updateDemoState((state) => {
      const line = state.cart.items.find((entry) => entry.id === cartItemId);
      if (!line) throw demoError('Cart item not found', 404);
      requireItemService(line.item_id, itemServiceType);
      /*
       * Moving a line onto a service the cart already holds merges the two,
       * the way the server does — the alternative is two identical lines.
       */
      const clash = state.cart.items.find(
        (entry) => entry !== line && entry.item_id === line.item_id && entry.service_type === itemServiceType
      );
      if (clash) {
        clash.quantity += line.quantity;
        state.cart.items.splice(state.cart.items.indexOf(line), 1);
        return toCart(state.cart);
      }
      line.service_type = itemServiceType as DemoOrderItem['service_type'];
      line.id = `demo-cartline-${line.item_id}-${itemServiceType}`;
      return toCart(state.cart);
    });
    return ok(cart);
  },

  removeCartItem: async (cartItemId: string): Promise<ApiResponse<BusinessCart>> => {
    const cart = await updateDemoState((state) => {
      // BY LINE ID: deleting Shirt / Wash & Iron must leave Shirt / Dry Clean.
      const index = state.cart.items.findIndex((entry) => entry.id === cartItemId);
      if (index < 0) throw demoError('Cart item not found', 404);
      state.cart.items.splice(index, 1);
      return toCart(state.cart);
    });
    return ok(cart);
  },

  /* ---------------- orders ---------------- */

  getOrders: async (): Promise<ApiResponse<BusinessOrderSummary[]>> => {
    const state = await getDemoState();
    return ok(state.orders.map(toOrderSummary));
  },

  getOrderById: async (orderId: string): Promise<ApiResponse<BusinessOrderDetail>> => {
    const state = await getDemoState();
    const order = state.orders.find((entry) => entry.id === orderId);
    if (!order) throw demoError('Order not found', 404);
    return ok(toOrderDetail(order, state.profile));
  },

  /** Copies a past order's lines into the cart, replacing what was there. */
  repeatOrder: async (
    orderId: string
  ): Promise<ApiResponse<{ item_count: number; cart: BusinessCart }>> => {
    const result = await updateDemoState((state) => {
      const order = state.orders.find((entry) => entry.id === orderId);
      if (!order) throw demoError('Order not found', 404);

      // The same line id as everywhere else — item AND service — so a
      // repeated order whose lines share an item stays two lines.
      state.cart.items = order.items.map((item) => ({
        id: `demo-cartline-${item.item_id}-${item.service_type}`,
        item_id: item.item_id,
        quantity: item.quantity,
        service_type: item.service_type,
      }));
      state.cart.laundry_type = order.laundry_type;
      state.cart.order_type = order.order_type;

      return { item_count: state.cart.items.length, cart: toCart(state.cart) };
    });
    return ok(result);
  },

  cancelOrder: async (
    orderId: string,
    reason?: string
  ): Promise<ApiResponse<{ id: string; order_number: string; status: string }>> => {
    const result = await updateDemoState((state) => {
      const order = state.orders.find((entry) => entry.id === orderId);
      if (!order) throw demoError('Order not found', 404);
      if (!CANCELLABLE_STATUSES.includes(order.status)) {
        throw demoError('This order can no longer be cancelled.');
      }
      order.status = 'CANCELLED';
      order.history.push({
        status: 'CANCELLED',
        notes: reason?.trim() || null,
        created_at: new Date().toISOString(),
      });
      return { id: order.id, order_number: order.order_number, status: order.status };
    });
    return ok(result);
  },

  getOrderTracking: async (orderId: string): Promise<ApiResponse<BusinessOrderTracking>> => {
    const state = await getDemoState();
    const order = state.orders.find((entry) => entry.id === orderId);
    if (!order) throw demoError('Order not found', 404);
    return ok(toTracking(order));
  },

  scheduleDelivery: async (
    orderId: string,
    deliveryDate: string,
    deliverySlot: string
  ): Promise<
    ApiResponse<{ order_id: string; order_number: string; delivery: BusinessOrderResult['delivery'] }>
  > => {
    const result = await updateDemoState((state) => {
      const order = state.orders.find((entry) => entry.id === orderId);
      if (!order) throw demoError('Order not found', 404);
      if (!DATE_ONLY.test(deliveryDate)) throw demoError('Please select a delivery date.');
      if (!DEMO_TIME_SLOTS.some((slot) => slot.id === deliverySlot)) {
        throw demoError('Please select a delivery time.');
      }
      if (deliveryDate <= order.pickup.date) {
        throw demoError('Delivery date must be after pickup date.');
      }
      order.delivery = { date: deliveryDate, slot_id: deliverySlot };
      return {
        order_id: order.id,
        order_number: order.order_number,
        delivery: slotLeg(order.delivery),
      };
    });
    return ok(result);
  },

  /**
   * The bookable slots for a date.
   *
   * A slot on TODAY whose start time has already passed in IST is returned
   * unavailable rather than hidden — the same answer the server gives, so the
   * strip greys it out exactly as it would in production.
   */
  getTimeSlots: async (date?: string): Promise<ApiResponse<BusinessTimeSlot[]>> => {
    const target = date || todayIST();
    const nowMinutes = currentMinutesIST();
    const isToday = isTodayIST(target);
    return ok(
      DEMO_TIME_SLOTS.map((slot) => ({
        id: slot.id,
        label: slot.label,
        start_minutes: slot.startMinutes,
        available: isToday ? slot.startMinutes > nowMinutes : true,
      }))
    );
  },

  /**
   * PLACES THE DEMO ORDER.
   *
   * Reads the cart, applies the same rules the server applies, writes the
   * order into the demo's own file, empties the cart, and moves the numbering
   * on. The result is the same object the real endpoint returns, so the
   * confirmation modal shows the real order number, pickup and delivery.
   */
  confirmOrder: async (
    schedule: BusinessPickupSchedule
  ): Promise<ApiResponse<BusinessOrderResult>> => {
    const result = await updateDemoState((state) => {
      const cart = state.cart;

      if (cart.items.length === 0) {
        throw demoError('Add at least one item to your cart before placing your order.');
      }
      if (cart.items.some((line) => !line.service_type)) {
        throw demoError('Every item must have at least one laundry service selected.');
      }
      if (!cart.laundry_type) {
        throw demoError('Please select Hotel Laundry or Guest Laundry.');
      }
      if (!schedule.pickupDate || !DATE_ONLY.test(schedule.pickupDate)) {
        throw demoError('Please select a pickup date.');
      }
      if (!schedule.pickupSlot || !DEMO_TIME_SLOTS.some((s) => s.id === schedule.pickupSlot)) {
        throw demoError('Please select a pickup time.');
      }
      if (schedule.deliveryDate && !schedule.deliverySlot) {
        throw demoError('Please select a delivery time.');
      }
      if (!schedule.deliveryDate && schedule.deliverySlot) {
        throw demoError('Please select a delivery date.');
      }
      if (schedule.deliveryDate && schedule.deliveryDate <= schedule.pickupDate) {
        throw demoError('Delivery date must be after pickup date.');
      }

      const now = new Date().toISOString();
      const sequence = state.sequence;
      const order: DemoOrder = {
        id: `demo-order-${sequence}`,
        order_number: formatDemoOrderNumber(sequence),
        laundry_type: cart.laundry_type,
        // Standard is the default and is applied here, exactly as the Cart
        // applies it to a cart that was never given a type.
        order_type: cart.order_type || 'standard',
        status: 'ORDER_PLACED',
        created_at: now,
        pickup: { date: schedule.pickupDate, slot_id: schedule.pickupSlot },
        delivery:
          schedule.deliveryDate && schedule.deliverySlot
            ? { date: schedule.deliveryDate, slot_id: schedule.deliverySlot }
            : null,
        items: cart.items.map((line, index) => {
          const item = findDemoItem(line.item_id)!;
          return {
            id: `demo-order-${sequence}-line-${index + 1}`,
            item_id: item.id,
            item_name: item.name,
            category_id: item.category_id,
            category_name: item.category_name,
            unit: item.unit,
            weight_kg: item.weight_kg,
            quantity: line.quantity,
            service_type: line.service_type,
          };
        }),
        history: [{ status: 'ORDER_PLACED', notes: null, created_at: now }],
      };

      // Newest first, matching the order the list is served in.
      state.orders.unshift(order);
      state.sequence = sequence + 1;
      state.cart = { id: 'demo-cart', laundry_type: null, order_type: null, items: [] };

      return toOrderResult(order);
    });
    return ok(result);
  },

  /* ---------------- stores ---------------- */

  /**
   * The nearest stores.
   *
   * The coordinates the screen passes are ignored: a demo phone may have
   * location switched off or be a thousand kilometres from any store, and an
   * empty list would read as a fault rather than as a demo. The fixed
   * distances are the ones on the sample records.
   */
  getNearbyStores: async (_params: {
    latitude: number;
    longitude: number;
    radiusKm?: number;
  }): Promise<ApiResponse<NearbyStore[]>> => ok(DEMO_NEARBY_STORES),
};

/* ------------------------------------------------------------------ *
 * DEMO-ONLY EXTRAS
 *
 * Not part of the real API surface. Nothing in the Business screens calls
 * these except the two controls that exist only in a demo build.
 * ------------------------------------------------------------------ */

/**
 * SIMULATE NEXT STATUS.
 *
 * Walks one order one step along the real status flow and records the step in
 * its history, so the tracking ladder and the order list both move. Returns
 * the new status, or null when the order has reached the end of the line (or
 * was cancelled, which is not a point on it).
 */
export async function advanceDemoOrderStatus(orderId: string): Promise<string | null> {
  return updateDemoState((state) => {
    const order = state.orders.find((entry) => entry.id === orderId);
    if (!order) throw demoError('Order not found', 404);
    if (order.status === 'CANCELLED') return null;

    const next = nextDemoStatus(order.status);
    if (!next) return null;

    /*
     * LEAVING PENDING_APPROVAL IS THE DEMO'S MANAGER APPROVAL, so it is where
     * the collection is assigned — the one moment the real flow assigns it.
     *
     * The date and time come from the order's OWN booked pickup: its date,
     * and the START of the slot it was booked into. Nothing is hardcoded and
     * nothing is guessed, and it is written only onto THIS order.
     *
     * Only on the first crossing. A later step must not rewrite a collection
     * that has already been agreed.
     */
    if (order.status === 'PENDING_APPROVAL' && !order.assigned_pickup_date) {
      const slot = DEMO_TIME_SLOTS.find((option) => option.id === order.pickup.slot_id);
      if (slot) {
        order.assigned_pickup_date = order.pickup.date;
        order.assigned_pickup_time = slot.start;
      }
    }

    order.status = next;
    order.history.push({ status: next, notes: null, created_at: new Date().toISOString() });
    return next;
  });
}

/** Whether this order has anywhere left to go, for the button's label. */
export function isDemoStatusFinal(status: string): boolean {
  return status === 'CANCELLED' || DEMO_STATUS_FLOW.indexOf(status as never) === DEMO_STATUS_FLOW.length - 1;
}

/** RESET DEMO DATA. Rebuilds an empty world; touches this phone only. */
export async function resetDemoData(): Promise<void> {
  await resetDemoState();
}

/* ------------------------------------------------------------------ *
 * HELPERS
 * ------------------------------------------------------------------ */

/** Whether an item offers the service being filtered on; no filter passes all. */
function offersService(item: BusinessItem, serviceType?: string): boolean {
  if (!serviceType) return true;
  return item.service_types.includes(serviceType);
}

/** Drops categories left with nothing in them once a service filter applies. */
function filterCategoriesByService(
  categories: BusinessCategory[],
  serviceType?: string
): BusinessCategory[] {
  if (!serviceType) return categories;
  return categories
    .map((category) => {
      const count = DEMO_ITEMS.filter(
        (item) =>
          (item.category_id === category.id || item.parent_category_id === category.id) &&
          offersService(item, serviceType)
      ).length;
      return { ...category, item_count: count };
    })
    // The API only returns categories that still have items — `HAVING
    // item_count > 0` — so an empty card is never offered.
    .filter((category) => category.item_count > 0);
}

/**
 * Frequently-ordered items first.
 *
 * The server sorts the catalogue this way and the Items page relies on it
 * arriving sorted, badging the top of the list as "Frequent" without
 * re-sorting anything itself.
 */
function sortByFrequency(items: BusinessItem[]): BusinessItem[] {
  return [...items].sort(
    (a, b) => b.order_count - a.order_count || a.name.localeCompare(b.name)
  );
}

export default demoBusinessOrderApi;
