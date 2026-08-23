/**
 * Indian Standard Time, for every Business scheduling decision.
 *
 * Swachham schedules in India. A device set to another timezone — or simply
 * left on UTC — must still be shown the Indian day and the Indian clock, so
 * nothing in the Business booking flow may call `new Date()` and read the
 * device's own calendar off it. Everything goes through this file.
 *
 * WHY FIXED-OFFSET ARITHMETIC. IST is UTC+05:30 and has been since 1945:
 * India observes no daylight saving, so a fixed offset is not an
 * approximation here, it is the definition. That keeps this correct without
 * `Intl` timezone data (which Hermes may ship trimmed) and without adding a
 * date library the project does not otherwise need.
 *
 * A "date key" throughout is YYYY-MM-DD — the same shape the API already
 * takes, and the shape `sorterDates` uses. Keys compare correctly as plain
 * strings, which is why every comparison below is a string comparison and
 * never a Date subtraction.
 */

/** IST is UTC+05:30, year-round. No DST has ever applied. */
const IST_OFFSET_MINUTES = 5 * 60 + 30;
const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const MONTH_SHORT = MONTH_NAMES.map((name) => name.slice(0, 3));
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The pieces of a moment as India reads it. */
export interface ISTNow {
  /** YYYY-MM-DD in IST. */
  dateKey: string;
  /** Minutes since IST midnight, e.g. 14:35 -> 875. */
  minutes: number;
  /** 0 = Sunday, matching Date.getDay(). */
  weekday: number;
}

/**
 * A Date shifted so its UTC fields read as IST wall-clock fields.
 *
 * Only this function does the shifting; everything else reads UTC getters off
 * the result, which is what makes the rest of the file timezone-proof.
 */
function toISTClock(instant: Date | number = Date.now()): Date {
  const ms = typeof instant === 'number' ? instant : instant.getTime();
  return new Date(ms + IST_OFFSET_MINUTES * MS_PER_MINUTE);
}

const pad = (value: number) => String(value).padStart(2, '0');

function keyOf(clock: Date): string {
  return `${clock.getUTCFullYear()}-${pad(clock.getUTCMonth() + 1)}-${pad(clock.getUTCDate())}`;
}

/**
 * The current moment in IST.
 *
 * Read at call time, never cached: a screen left open across midnight must
 * see the new Indian day the next time it asks.
 */
export function getCurrentIST(instant: Date | number = Date.now()): ISTNow {
  const clock = toISTClock(instant);
  return {
    dateKey: keyOf(clock),
    minutes: clock.getUTCHours() * 60 + clock.getUTCMinutes(),
    weekday: clock.getUTCDay(),
  };
}

/** Today's date key in IST — the earliest pickup date that may be offered. */
export function todayIST(): string {
  return getCurrentIST().dateKey;
}

/** Minutes since midnight in IST, for comparing against a slot's start. */
export function currentMinutesIST(): number {
  return getCurrentIST().minutes;
}

/** True when `dateKey` is the current Indian calendar day. */
export function isTodayIST(dateKey: string): boolean {
  return dateKey === todayIST();
}

/** True when `dateKey` is an Indian day that has already passed. */
export function isPastIST(dateKey: string): boolean {
  return dateKey < todayIST();
}

/** YYYY-MM-DD, `days` later. Negative values step backwards. */
export function addDays(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split('-').map(Number);
  // Built in UTC so the shift is pure arithmetic with no local-timezone
  // rollover: adding a day near a DST boundary elsewhere cannot move it.
  const base = Date.UTC(year, month - 1, day);
  return keyOf(new Date(base + days * MS_PER_DAY));
}

/**
 * The earliest delivery date for a given pickup date: the day AFTER pickup.
 *
 * Same-day delivery is not offered, so this is pickup + 1 with no special
 * cases. Falls back to tomorrow when no pickup date has been chosen yet, so a
 * caller never has to handle null itself.
 */
export function getMinimumDeliveryDate(pickupDateKey: string | null): string {
  return addDays(pickupDateKey || todayIST(), 1);
}

/**
 * `count` consecutive date keys starting at `startKey` (inclusive).
 *
 * Used for both strips: pickup starts at today in IST, delivery starts at the
 * minimum delivery date.
 */
export function dateRange(startKey: string, count: number): string[] {
  return Array.from({ length: count }, (_, offset) => addDays(startKey, offset));
}

/* ===================================================================
 * FORMATTING
 *
 * Written out rather than delegated to `toLocaleDateString`, which formats
 * in the device's locale and calendar. The Business flow shows Indian dates
 * to Indian operators, so the wording is fixed here.
 * =================================================================== */

/** "22 August 2026". */
export function formatLongDateIST(dateKey: string): string {
  const [year, month, day] = dateKey.split('-').map(Number);
  return `${day} ${MONTH_NAMES[month - 1]} ${year}`;
}

/** "22 Aug 2026" — the compact form the date field shows. */
export function formatShortDateIST(dateKey: string): string {
  const [year, month, day] = dateKey.split('-').map(Number);
  return `${day} ${MONTH_SHORT[month - 1]} ${year}`;
}

/** "22 Aug" — for the narrow cells of a date strip. */
export function formatDayMonthIST(dateKey: string): string {
  const [, month, day] = dateKey.split('-').map(Number);
  return `${day} ${MONTH_SHORT[month - 1]}`;
}

/** "Today" / "Tomorrow" / "Mon", relative to the current Indian day. */
export function relativeDayCaption(dateKey: string): string {
  const today = todayIST();
  if (dateKey === today) return 'Today';
  if (dateKey === addDays(today, 1)) return 'Tomorrow';
  const [year, month, day] = dateKey.split('-').map(Number);
  return WEEKDAY_SHORT[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
}

/* ===================================================================
 * VALIDATION
 *
 * The screen calls these to decide what to offer and whether Continue may
 * proceed. The server runs the equivalent checks in
 * `backend/src/services/pickupSlot.service.ts`, and the server is what
 * actually decides — these exist so the user is told early, not so the rule
 * lives here.
 * =================================================================== */

/**
 * The minimum a slot must carry for these rules to apply to it. Field named
 * as the API sends it, so a response row satisfies this without remapping.
 */
export interface SchedulableSlot {
  id: string;
  label: string;
  /** Minutes since midnight at which the slot opens. */
  start_minutes: number;
}

/**
 * The slots that may still be booked on `dateKey`.
 *
 * On a future day every configured slot is available. On today, a slot is
 * dropped once the current Indian time has reached its start — booking a
 * 10:00 pickup at 14:35 is not a thing that can happen. A past day yields
 * nothing at all.
 */
export function getAvailableSlots<T extends SchedulableSlot>(
  slots: T[],
  dateKey: string | null
): T[] {
  if (!dateKey || isPastIST(dateKey)) return [];
  if (!isTodayIST(dateKey)) return slots;

  const now = currentMinutesIST();
  return slots.filter((slot) => slot.start_minutes > now);
}

/** Why a pickup choice is not acceptable, or null when it is. */
export function validatePickupDateTime(
  dateKey: string | null,
  slot: SchedulableSlot | null
): string | null {
  if (!dateKey) return 'Please select a pickup date.';
  if (isPastIST(dateKey)) return 'Pickup date cannot be in the past.';
  if (!slot) return 'Please select a pickup time.';
  if (isTodayIST(dateKey) && slot.start_minutes <= currentMinutesIST()) {
    return 'That pickup time has already passed. Please choose a later slot.';
  }
  return null;
}

/** Why a delivery choice is not acceptable, or null when it is. */
export function validateDeliveryDateTime(
  pickupDateKey: string | null,
  deliveryDateKey: string | null,
  deliverySlot: SchedulableSlot | null
): string | null {
  if (!deliveryDateKey) return 'Please select a delivery date.';
  if (pickupDateKey && deliveryDateKey <= pickupDateKey) {
    return 'Delivery date must be after pickup date.';
  }
  if (!deliverySlot) return 'Please select a delivery time.';
  return null;
}
