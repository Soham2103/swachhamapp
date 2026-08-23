import { create } from 'zustand';
import businessOrderApi, {
  BusinessCart,
  BusinessOrderResult,
  BusinessPickupSchedule,
} from '../services/businessOrderApi';
import { extractErrorMessage } from '../services/api';

export type LaundryType = 'hotel' | 'guest';
export type OrderType = 'standard' | 'quick';

/**
 * Exactly two Business services. Wash + Iron is ONE combined service — there
 * is no standalone Wash and no standalone Iron.
 *
 * A service is never chosen for the order as a whole: it belongs to each cart
 * line, so a Shirt on Wash & Iron can sit next to Trousers on Dry Clean.
 */
export type ServiceType = 'wash_iron' | 'dry_clean';

export const SERVICE_OPTIONS: Array<{ value: ServiceType; label: string }> = [
  { value: 'wash_iron', label: 'Wash & Iron' },
  { value: 'dry_clean', label: 'Dry Clean' },
];

/** Shown on the Items page when an item is added with no service picked. */
export const ITEM_SERVICE_REQUIRED_MESSAGE =
  'Please select at least one laundry service for this item.';

/** Shown in the Cart when a line is still missing its service. */
export const CART_ITEM_SERVICE_REQUIRED_MESSAGE =
  'Every item must have at least one laundry service selected.';

/** The two Business order types, chosen in the Cart. */
export const ORDER_TYPE_OPTIONS: Array<{ value: OrderType; label: string }> = [
  { value: 'standard', label: 'Standard Order' },
  { value: 'quick', label: 'Quick Order' },
];

export const ORDER_TYPE_REQUIRED_MESSAGE = 'Please select an order type.';

/** Hotel / Guest, also chosen in the Cart — never before the catalogue. */
export const LAUNDRY_TYPE_OPTIONS: Array<{ value: LaundryType; label: string; hint: string }> = [
  { value: 'hotel', label: 'Hotel Laundry', hint: 'Linen and property-owned items' },
  { value: 'guest', label: 'Guest Laundry', hint: 'Items belonging to your guests' },
];

export const LAUNDRY_TYPE_REQUIRED_MESSAGE = 'Please select Hotel Laundry or Guest Laundry.';

export const CART_EMPTY_MESSAGE = 'Add at least one item to your cart before placing your order.';

/**
 * The four things the Pickup & Delivery page must have before an order is
 * sent. The same wording comes back from the server when a request that
 * skipped the screen is refused, so a rejection reads identically wherever
 * the user meets it.
 */
export const PICKUP_DATE_REQUIRED_MESSAGE = 'Please select a pickup date.';
export const PICKUP_TIME_REQUIRED_MESSAGE = 'Please select a pickup time.';
export const DELIVERY_DATE_REQUIRED_MESSAGE = 'Please select a delivery date.';
export const DELIVERY_TIME_REQUIRED_MESSAGE = 'Please select a delivery time.';

/**
 * Shown when Continue is pressed without a complete pickup. Only the pickup
 * can block Continue -- the delivery may be left for later.
 */
export const SCHEDULE_REQUIRED_MESSAGE = 'Please select pickup date and time.';

/** The delivery day must be strictly later than the pickup day. */
export const DELIVERY_AFTER_PICKUP_MESSAGE = 'Delivery date must be after pickup date.';

interface BusinessOrderState {
  laundryType: LaundryType | null;
  orderType: OrderType | null;
  cart: BusinessCart | null;
  isLoading: boolean;
  /** True from the moment Place Order is pressed until the request settles. */
  isPlacingOrder: boolean;

  /** Persists the order type chosen in the Cart. */
  saveOrderType: (value: OrderType) => Promise<void>;
  /** Persists the laundry type chosen in the Cart. */
  saveLaundryType: (value: LaundryType) => Promise<void>;

  loadCart: () => Promise<void>;
  /** `itemServiceType` is mandatory: it fixes the service for this line only. */
  addItem: (itemId: string, quantity: number, itemServiceType: string) => Promise<void>;
  updateItem: (itemId: string, quantity: number) => Promise<void>;
  /** Switches one cart line to another service the item supports. */
  setItemService: (itemId: string, itemServiceType: string) => Promise<void>;
  removeItem: (itemId: string) => Promise<void>;
  /** Copies a past order's items into the cart and shows them immediately. */
  repeatIntoCart: (orderId: string) => Promise<number>;
  /**
   * Places the order for the chosen pickup slot. No location of any kind is
   * involved — that was settled on the Allow Permission page before the app
   * was entered.
   */
  confirmOrder: (schedule: BusinessPickupSchedule) => Promise<BusinessOrderResult>;
  resetFlow: () => void;
}

/** Keeps the in-memory flow state in step with what the server stored. */
function fromCart(cart: BusinessCart) {
  return {
    cart,
    laundryType: (cart.laundry_type as LaundryType | null) ?? null,
    orderType: (cart.order_type as OrderType | null) ?? null,
  };
}

export const useBusinessOrderStore = create<BusinessOrderState>((set, get) => ({
  laundryType: null,
  orderType: null,
  cart: null,
  isLoading: false,
  isPlacingOrder: false,

  saveOrderType: async (value: OrderType) => {
    try {
      set({ isLoading: true });
      // Only the order type is sent, so the laundry type already on the cart
      // is left untouched.
      const response = await businessOrderApi.setCartContext({ orderType: value });
      set(fromCart(response.data));
    } catch (error: any) {
      throw new Error(extractErrorMessage(error, 'Failed to select order type'));
    } finally {
      set({ isLoading: false });
    }
  },

  saveLaundryType: async (value: LaundryType) => {
    try {
      set({ isLoading: true });
      const response = await businessOrderApi.setCartContext({ laundryType: value });
      set(fromCart(response.data));
    } catch (error: any) {
      throw new Error(extractErrorMessage(error, 'Failed to select laundry type'));
    } finally {
      set({ isLoading: false });
    }
  },

  loadCart: async () => {
    try {
      set({ isLoading: true });
      const response = await businessOrderApi.getCart();
      set(fromCart(response.data));
    } catch (error: any) {
      throw new Error(extractErrorMessage(error, 'Failed to load cart'));
    } finally {
      set({ isLoading: false });
    }
  },

  addItem: async (itemId: string, quantity: number, itemServiceType: string) => {
    if (get().isLoading) return;
    // Guarded here as well as on the Items page, so no path can create a
    // cart line without a service.
    if (!itemServiceType) throw new Error(ITEM_SERVICE_REQUIRED_MESSAGE);
    try {
      set({ isLoading: true });
      const response = await businessOrderApi.addCartItem(itemId, quantity, itemServiceType);
      set(fromCart(response.data));
    } catch (error: any) {
      throw new Error(extractErrorMessage(error, 'Failed to add item to cart'));
    } finally {
      set({ isLoading: false });
    }
  },

  setItemService: async (itemId: string, itemServiceType: string) => {
    if (get().isLoading) return;
    try {
      set({ isLoading: true });
      const response = await businessOrderApi.setCartItemService(itemId, itemServiceType);
      set(fromCart(response.data));
    } catch (error: any) {
      throw new Error(extractErrorMessage(error, 'Failed to change item service'));
    } finally {
      set({ isLoading: false });
    }
  },

  updateItem: async (itemId: string, quantity: number) => {
    if (get().isLoading) return;
    try {
      set({ isLoading: true });
      const response = await businessOrderApi.updateCartItem(itemId, quantity);
      set(fromCart(response.data));
    } catch (error: any) {
      throw new Error(extractErrorMessage(error, 'Failed to update item'));
    } finally {
      set({ isLoading: false });
    }
  },

  removeItem: async (itemId: string) => {
    if (get().isLoading) return;
    try {
      set({ isLoading: true });
      const response = await businessOrderApi.removeCartItem(itemId);
      set(fromCart(response.data));
    } catch (error: any) {
      throw new Error(extractErrorMessage(error, 'Failed to remove item'));
    } finally {
      set({ isLoading: false });
    }
  },

  repeatIntoCart: async (orderId: string) => {
    try {
      set({ isLoading: true });
      const response = await businessOrderApi.repeatOrder(orderId);
      // The server returns the rebuilt cart, so the Cart screen already has
      // the repeated items the moment the user lands on it.
      set(fromCart(response.data.cart));
      return response.data.item_count;
    } catch (error: any) {
      throw new Error(extractErrorMessage(error, 'Failed to repeat order'));
    } finally {
      set({ isLoading: false });
    }
  },

  confirmOrder: async (schedule: BusinessPickupSchedule) => {
    // One request per order. `isPlacingOrder` is set before anything can
    // await, so a second tap that slips past the button's disabled state is
    // still rejected here rather than creating a duplicate order.
    if (get().isPlacingOrder) throw new Error('Your order is already being placed...');
    if (get().isLoading) throw new Error('Please wait...');

    // The four Cart validations, in the order the user meets them. The
    // backend enforces the same rules, so a direct API call is rejected too.
    const { cart, orderType, laundryType } = get();
    const items = cart?.items || [];
    if (items.length === 0) throw new Error(CART_EMPTY_MESSAGE);
    if (items.some((item) => !item.service_type)) {
      throw new Error(CART_ITEM_SERVICE_REQUIRED_MESSAGE);
    }
    if (!orderType) throw new Error(ORDER_TYPE_REQUIRED_MESSAGE);
    if (!laundryType) throw new Error(LAUNDRY_TYPE_REQUIRED_MESSAGE);
    // The server refuses an unscheduled order too; this stops the request
    // being sent at all.
    if (!schedule?.pickupDate) throw new Error(PICKUP_DATE_REQUIRED_MESSAGE);
    if (!schedule?.pickupSlot) throw new Error(PICKUP_TIME_REQUIRED_MESSAGE);

    // Delivery is OPTIONAL, but all-or-nothing: an order may be placed with
    // the pickup alone and the delivery arranged later, yet half a delivery
    // is a mistake rather than a choice.
    if (schedule.deliveryDate && !schedule.deliverySlot) {
      throw new Error(DELIVERY_TIME_REQUIRED_MESSAGE);
    }
    if (!schedule.deliveryDate && schedule.deliverySlot) {
      throw new Error(DELIVERY_DATE_REQUIRED_MESSAGE);
    }
    // Checked here as well as on the screen, so a caller that builds its own
    // schedule object cannot slip a same-day delivery past the store.
    if (schedule.deliveryDate && schedule.deliveryDate <= schedule.pickupDate) {
      throw new Error(DELIVERY_AFTER_PICKUP_MESSAGE);
    }

    try {
      set({ isPlacingOrder: true });
      const response = await businessOrderApi.confirmOrder(schedule);
      set({ cart: null, laundryType: null, orderType: null });
      return response.data;
    } catch (error: any) {
      throw new Error(extractErrorMessage(error, 'Failed to place order'));
    } finally {
      set({ isPlacingOrder: false });
    }
  },

  resetFlow: () => set({ laundryType: null, orderType: null, cart: null }),
}));
