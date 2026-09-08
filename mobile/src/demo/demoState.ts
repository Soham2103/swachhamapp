/**
 * THE DEMO'S OWN LITTLE DATABASE.
 *
 * Everything the demo build creates — the cart, the orders, the order
 * numbering — lives in ONE JSON file in the app's private document directory
 * on the phone. Nothing here ever leaves the device.
 *
 * WHY A FILE AND NOT SECURE STORE. `expo-secure-store` is the project's
 * session store, but Android warns above ~2 KB per value and the demo's order
 * list comfortably exceeds that. `expo-file-system` has no such limit, is
 * already a dependency, is used elsewhere in the app for PDFs, and needs no
 * network at any point.
 *
 * THE FILE IS THE DEMO'S ENTIRE WORLD. Deleting it (Reset Demo Data, or
 * clearing the app's storage) returns the demo to an EMPTY order list, and can
 * have no effect on anything outside this phone.
 *
 * THERE IS NO SAMPLE ORDER HISTORY. The demo used to seed twelve invented
 * orders so the list was never blank. It no longer does: a fresh demo starts
 * with NO orders at all, and the only orders it will ever show are the ones
 * the hotel places in front of you. Nothing is filtered or hidden to achieve
 * that — the orders array genuinely starts empty.
 */

import * as FileSystem from 'expo-file-system/legacy';

import type { BusinessProfile } from '../services/businessOrderApi';
import { DEMO_PROFILE } from './demoCatalog';

/** Where the state lives. One file, in the app's own sandbox. */
const STATE_FILE = `${FileSystem.documentDirectory}swachham-demo-state.json`;

/**
 * Bumped whenever the shape or the CONTENT of the file changes incompatibly.
 * A file written by an older demo build is discarded and rebuilt rather than
 * being read into a shape — or a world — it does not match.
 *
 * BUMPED TO 2 WITH THE REMOVAL OF THE SEEDED ORDERS. A phone that already ran
 * an older demo build has a version-1 file on disk holding the twelve sample
 * orders. Without this bump that file would still be read and those orders
 * would still appear, so the seed removal would only be true of a phone that
 * had never run the demo before. The mismatch makes the old file be dropped
 * and a fresh, EMPTY world written in its place, once, on first launch.
 */
const STATE_VERSION = 2;

/** The first order number the HOTEL creates. Nothing sits below it. */
export const FIRST_DEMO_ORDER_SEQUENCE = 1001;

/** How the demo numbers its orders: DEMO-1001, DEMO-1002, ... */
export function formatDemoOrderNumber(sequence: number): string {
  return `DEMO-${sequence}`;
}

/* ------------------------------------------------------------------ *
 * SHAPES
 * ------------------------------------------------------------------ */

export interface DemoCartItem {
  /** The cart line's own id — what the update/remove calls address. */
  id: string;
  item_id: string;
  quantity: number;
  /** The service for THIS line. Never order-wide. */
  service_type: 'wash_fold' | 'wash_iron' | 'dry_clean' | null;
}

export interface DemoCart {
  id: string;
  laundry_type: 'hotel' | 'guest' | null;
  order_type: 'standard' | 'quick' | null;
  items: DemoCartItem[];
}

export interface DemoOrderItem {
  id: string;
  item_id: string;
  item_name: string;
  category_id: string;
  category_name: string;
  unit: string;
  weight_kg: number | null;
  quantity: number;
  service_type: 'wash_fold' | 'wash_iron' | 'dry_clean' | null;
}

export interface DemoOrderLeg {
  date: string;
  slot_id: string;
}

export interface DemoOrder {
  id: string;
  order_number: string;
  laundry_type: 'hotel' | 'guest' | null;
  order_type: 'standard' | 'quick' | null;
  status: string;
  created_at: string;
  pickup: DemoOrderLeg;
  delivery: DemoOrderLeg | null;
  /**
   * THE COLLECTION "ASSIGNED" WHEN THE ORDER LEAVES PENDING_APPROVAL.
   *
   * The demo has no Manager — advancing the status by hand is what stands in
   * for one — so the assignment is made at that same moment, from the order's
   * OWN booked pickup. Nothing is invented and no date is written into the
   * code: it is the day and the slot start this order actually carries.
   *
   * Both null until then, and both null on orders created before this
   * existed, which is exactly what the real API returns for an order no
   * Manager has scheduled. The screens therefore behave identically in demo
   * mode and against the live backend.
   */
  assigned_pickup_date?: string | null;
  assigned_pickup_time?: string | null;
  items: DemoOrderItem[];
  /**
   * The order's STATUS HISTORY.
   *
   * Its `notes` is NOT one of the removed note fields: it holds the reason
   * recorded against a status change — a cancellation reason, say — and is
   * never typed by the hotel. It stays, because the tracking screen is built
   * on it.
   */
  history: Array<{ status: string; notes: string | null; created_at: string }>;
}

export interface DemoState {
  version: number;
  /** The number the NEXT order created by the hotel will carry. */
  sequence: number;
  cart: DemoCart;
  orders: DemoOrder[];
  profile: BusinessProfile;
}

/* ------------------------------------------------------------------ *
 * THE ORDER LIFECYCLE
 * ------------------------------------------------------------------ */

/**
 * The statuses a demo order walks through, in order.
 *
 * These are the REAL `orders.status` values the database holds, not invented
 * demo labels, so the tracking screen lights the same stages and the order
 * list prints the same wording it does in production.
 */
export const DEMO_STATUS_FLOW = [
  'ORDER_PLACED',
  'PICKUP_SCHEDULED',
  'PICKED_UP',
  'SORTING',
  'WASHING',
  'READY_FOR_DELIVERY',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
] as const;

/** The status after this one, or null at the end of the line. */
export function nextDemoStatus(status: string): string | null {
  const index = DEMO_STATUS_FLOW.indexOf(status as (typeof DEMO_STATUS_FLOW)[number]);
  if (index < 0 || index >= DEMO_STATUS_FLOW.length - 1) return null;
  return DEMO_STATUS_FLOW[index + 1];
}

/* ------------------------------------------------------------------ *
 * THE SEEDED ORDER HISTORY — REMOVED
 *
 * Twelve invented orders (DEMO-0989 to DEMO-1000) were built here and handed
 * to `buildInitialState`, so a brand-new demo opened onto a populated Orders
 * list. They are gone in full — the seed table, the types describing it, and
 * the three helpers that turned it into stored orders — rather than being
 * filtered out downstream, so there is no sample order left in the demo for
 * anything to accidentally read.
 *
 * The hotel's own first order is still DEMO-1001; the numbering simply no
 * longer has anything below it.
 * ------------------------------------------------------------------ */

/**
 * A brand-new demo world: an empty cart, the demo profile, and NO ORDERS.
 *
 * `orders` starts as a genuinely empty array. Everything the Orders list and
 * the Order Detail screen show from here on was placed by the hotel during
 * the demo, through the same create-order path the production app uses.
 */
export function buildInitialState(): DemoState {
  return {
    version: STATE_VERSION,
    sequence: FIRST_DEMO_ORDER_SEQUENCE,
    cart: { id: 'demo-cart', laundry_type: null, order_type: null, items: [] },
    orders: [],
    profile: { ...DEMO_PROFILE },
  };
}

/* ------------------------------------------------------------------ *
 * LOAD / SAVE
 * ------------------------------------------------------------------ */

let cached: DemoState | null = null;
/** In-flight load, so several screens starting at once share one read. */
let loading: Promise<DemoState> | null = null;
/** Writes are chained, so two quick actions cannot interleave their saves. */
let writeChain: Promise<void> = Promise.resolve();

async function readFromDisk(): Promise<DemoState | null> {
  try {
    const info = await FileSystem.getInfoAsync(STATE_FILE);
    if (!info.exists) return null;
    const raw = await FileSystem.readAsStringAsync(STATE_FILE);
    const parsed = JSON.parse(raw) as DemoState;
    if (!parsed || parsed.version !== STATE_VERSION || !Array.isArray(parsed.orders)) return null;
    return parsed;
  } catch {
    // A corrupt or unreadable file is not an error the hotel should ever see:
    // the demo simply starts again from an empty state.
    return null;
  }
}

/**
 * The demo state, loaded from disk on first use and held in memory after.
 *
 * Every demo API call awaits this, so a cold start that lands straight on the
 * Orders screen still sees the persisted orders.
 */
export async function getDemoState(): Promise<DemoState> {
  if (cached) return cached;
  if (loading) return loading;

  loading = (async () => {
    const stored = await readFromDisk();
    cached = stored ?? buildInitialState();
    if (!stored) await persist();
    loading = null;
    return cached;
  })();

  return loading;
}

/** Writes the in-memory state to disk. Failures never break the demo. */
async function persist(): Promise<void> {
  const snapshot = cached;
  if (!snapshot) return;
  writeChain = writeChain
    .then(() => FileSystem.writeAsStringAsync(STATE_FILE, JSON.stringify(snapshot)))
    .catch((error) => {
      if (__DEV__) console.warn('[Demo] could not save demo state', error);
    });
  return writeChain;
}

/**
 * Applies a change to the demo state and saves it.
 *
 * The mutation runs against the live object, so callers can read the result
 * immediately; persistence happens behind it.
 */
export async function updateDemoState<T>(mutate: (state: DemoState) => T): Promise<T> {
  const state = await getDemoState();
  const result = mutate(state);
  await persist();
  return result;
}

/**
 * RESET DEMO DATA.
 *
 * Throws the file away and rebuilds an EMPTY world: every order placed during
 * the demo is cleared, the cart empties, and numbering returns to DEMO-1001.
 * No sample orders come back, because there are none. It touches nothing but
 * this phone's own copy.
 */
export async function resetDemoState(): Promise<void> {
  cached = buildInitialState();
  await persist();
}
