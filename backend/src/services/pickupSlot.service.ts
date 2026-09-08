import { AppError } from '../utils/appError';
import { getBusinessNow, timeToMinutes } from '../utils/istTime';

/**
 * Pickup and delivery scheduling for Business orders.
 *
 * Both are stored in the tables the schema already has — `pickups` and
 * `deliveries`, each with `scheduled_date`, `time_slot_start` and
 * `time_slot_end` — which is where the customer order flow already writes
 * its own schedule. No new column and no new table.
 *
 * The slot list lives here and nowhere else. The app fetches it rather than
 * hardcoding it, and the same list validates what comes back, so the two can
 * never drift apart. Pickup and delivery draw on the SAME list: there is one
 * working day, not one per leg.
 *
 * TIMEZONE. Every comparison is made in the business timezone (IST) through
 * `utils/istTime`, never against the database server's UTC clock. A pickup
 * booked at 00:30 IST is on today's date, not yesterday's.
 */

export interface PickupSlot {
  /** Stable id the app sends back, e.g. "09-11". */
  id: string;
  /** What the user sees, e.g. "9:00 AM – 11:00 AM". */
  label: string;
  /** SQL TIME values for the pickups / deliveries row. */
  start: string;
  end: string;
}

/**
 * The working day, in two-hour slots.
 *
 * The project had no business-hours configuration anywhere — no table, no
 * constant — so these are the hours specified for the Business flow. They are
 * defined once, here, and both legs and both validators read them, so a
 * future hours table can replace this list without touching anything else.
 */
export const PICKUP_SLOTS: PickupSlot[] = [
  { id: '09-11', label: '9:00 AM – 11:00 AM', start: '09:00:00', end: '11:00:00' },
  { id: '11-13', label: '11:00 AM – 1:00 PM', start: '11:00:00', end: '13:00:00' },
  { id: '13-15', label: '1:00 PM – 3:00 PM', start: '13:00:00', end: '15:00:00' },
  { id: '15-17', label: '3:00 PM – 5:00 PM', start: '15:00:00', end: '17:00:00' },
  { id: '17-19', label: '5:00 PM – 7:00 PM', start: '17:00:00', end: '19:00:00' },
];

/** Minutes since midnight at which a slot opens. */
export function slotStartMinutes(slot: PickupSlot): number {
  return timeToMinutes(slot.start);
}

/** YYYY-MM-DD, the only shape a date is accepted in. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Both note fields are optional; this is as much of one as is stored. */
const MAX_NOTE_LENGTH = 500;

/** Trimmed, capped, and never null — the columns take TEXT or nothing. */
function readNote(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, MAX_NOTE_LENGTH) : '';
}

/**
 * Pickup and delivery, each with its own date and its own slot.
 *
 * They are separate on purpose: the delivery is always a later day than the
 * pickup, so one shared date could not express a real booking.
 *
 * DELIVERY IS OPTIONAL. An order may be placed with the pickup alone and the
 * delivery arranged afterwards, so both delivery fields are null together or
 * set together -- never one without the other.
 */
export interface OrderSchedule {
  pickupDate: string;
  pickup: PickupSlot;
  deliveryDate: string | null;
  delivery: PickupSlot | null;
  /** Free text for the driver, e.g. gate code. Empty string when not given. */
  pickupNotes: string;
  /** Free text about the laundry itself, e.g. handling instructions. */
  serviceNotes: string;
}

/** Looks one slot up, with the message the user should see if it is missing. */
function requireSlot(value: unknown, missing: string, invalid: string): PickupSlot {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!id) throw new AppError(missing, 400);

  const slot = PICKUP_SLOTS.find((option) => option.id === id);
  if (!slot) throw new AppError(invalid, 400);

  return slot;
}

/** Whether a field was supplied at all — null, undefined and '' are not. */
function isPresent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  return true;
}

/**
 * The two ordering rules a booked delivery must satisfy.
 *
 * Shared by order creation and by scheduling a delivery afterwards, so the
 * rule cannot come to mean two different things on the two paths.
 */
function assertDeliveryAfterPickup(
  pickupDate: string,
  pickup: PickupSlot,
  deliveryDate: string,
  delivery: PickupSlot
): void {
  // The delivery is always a later DAY. Same-day delivery is not offered, so
  // equal dates are refused as firmly as earlier ones.
  if (deliveryDate <= pickupDate) {
    throw new AppError('Delivery date must be after pickup date.', 400);
  }

  // A FULL 24 HOURS, measured from the pickup time — not merely the next day.
  //
  // "Tomorrow" is not the rule: a 6pm pickup collected on Monday cannot come
  // back at 9am Tuesday, which is fifteen hours, so the gap is asserted on the
  // datetimes rather than on the dates. The screen offers only slots that
  // satisfy this, and this is what makes a request that skipped the screen
  // fail the same way.
  if (minutesBetween(pickupDate, pickup.start, deliveryDate, delivery.start) < MINUTES_PER_DAY) {
    throw new AppError(
      'Delivery must be at least 24 hours after the pickup time.',
      400
    );
  }
}

/** A full day, in minutes — the minimum turnaround between pickup and delivery. */
const MINUTES_PER_DAY = 24 * 60;

/**
 * Minutes from one date+time to another.
 *
 * Both dates are YYYY-MM-DD and both times are HH:MM[:SS] as the slot table
 * stores them. Built in UTC so the subtraction is pure arithmetic: these are
 * wall-clock IST values on both sides, and the difference between two of them
 * is unaffected by the server's own timezone.
 */
function minutesBetween(
  fromDate: string,
  fromTime: string,
  toDate: string,
  toTime: string
): number {
  return (toTimestamp(toDate, toTime) - toTimestamp(fromDate, fromTime)) / 60_000;
}

function toTimestamp(dateKey: string, time: string): number {
  const [year, month, day] = dateKey.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  return Date.UTC(year, month - 1, day, hour || 0, minute || 0);
}

/** A required YYYY-MM-DD field, with its own wording when absent or malformed. */
function requireDate(value: unknown, missing: string, invalid: string): string {
  const date = typeof value === 'string' ? value.trim() : '';
  if (!date) throw new AppError(missing, 400);
  if (!DATE_ONLY.test(date)) throw new AppError(invalid, 400);
  return date;
}

/**
 * The slots that may still be booked on a given date, in the business
 * timezone.
 *
 * A future date offers the whole working day. Today offers only the slots
 * that have not started yet — at 14:35 IST the 9:00 and 11:00 and 13:00
 * slots are gone and 15:00 onward remain. A past date offers nothing.
 *
 * This is the same rule `resolveSchedule` enforces, so the list the app is
 * given and the list the server will accept are one list.
 */
export async function getSlotsForDate(
  dateInput?: unknown
): Promise<Array<PickupSlot & { available: boolean }>> {
  const withAvailability = (available: (slot: PickupSlot) => boolean) =>
    PICKUP_SLOTS.map((slot) => ({ ...slot, available: available(slot) }));

  const date = typeof dateInput === 'string' ? dateInput.trim() : '';
  // No date asked about: the caller wants the configured working day, which
  // is every slot. Availability is decided once a date exists.
  if (!date || !DATE_ONLY.test(date)) {
    return withAvailability(() => true);
  }

  const now = await getBusinessNow();
  if (date < now.date) return withAvailability(() => false);
  if (date > now.date) return withAvailability(() => true);

  return withAvailability((slot) => slotStartMinutes(slot) > now.minutes);
}

/**
 * Validates both dates and both slots chosen in the app.
 *
 * The app checks the same rules first, but this is what actually decides: a
 * request that skipped the screen, or edited its state, is refused here. The
 * messages are the exact wording the screen shows, so a rejection reads the
 * same wherever it surfaces.
 *
 * The rules, in the order a user meets them:
 *
 *   pickup_date    REQUIRED. Well-formed, not before today (IST).
 *   pickup_time    REQUIRED. A configured slot, and — when the pickup is
 *                  today — a slot that has not already started.
 *   delivery_date  OPTIONAL, but all-or-nothing with the time below.
 *   delivery_time  OPTIONAL, same.
 *
 *   When BOTH delivery fields are absent the order is accepted with no
 *   delivery booked; it can be scheduled later through scheduleDelivery.
 *   When ONE is present the request is refused naming the missing half —
 *   half a booking is a mistake, not a choice. When both are present the
 *   delivery must fall on a later DAY than the pickup, and its datetime
 *   must be after the pickup's.
 */
export async function resolveSchedule(input: {
  pickupDate?: unknown;
  pickupSlot?: unknown;
  deliveryDate?: unknown;
  deliverySlot?: unknown;
  pickupNotes?: unknown;
  serviceNotes?: unknown;
}): Promise<OrderSchedule> {
  const pickupDate = requireDate(
    input.pickupDate,
    'Please select a pickup date.',
    'Please select a valid pickup date.'
  );
  const pickup = requireSlot(
    input.pickupSlot,
    'Please select a pickup time.',
    'Please select a valid pickup time.'
  );
  // Delivery is optional as a PAIR. Presence is tested before either is
  // parsed, so "date without time" is reported as the missing time rather
  // than as a malformed anything.
  const hasDeliveryDate = isPresent(input.deliveryDate);
  const hasDeliverySlot = isPresent(input.deliverySlot);

  if (hasDeliveryDate && !hasDeliverySlot) {
    throw new AppError('Please select a delivery time.', 400);
  }
  if (!hasDeliveryDate && hasDeliverySlot) {
    throw new AppError('Please select a delivery date.', 400);
  }

  const deliveryDate = hasDeliveryDate
    ? requireDate(
        input.deliveryDate,
        'Please select a delivery date.',
        'Please select a valid delivery date.'
      )
    : null;
  const delivery = hasDeliverySlot
    ? requireSlot(
        input.deliverySlot,
        'Please select a delivery time.',
        'Please select a valid delivery time.'
      )
    : null;

  // One reading of the clock for every comparison below, so a request cannot
  // be judged against two different "nows".
  const now = await getBusinessNow();

  // Compared as calendar dates, so a same-day pickup is allowed all day.
  if (pickupDate < now.date) {
    throw new AppError('Pickup date cannot be in the past.', 400);
  }
  // ...but a slot that has already started today is not a booking, it is a
  // request to travel backwards.
  if (pickupDate === now.date && slotStartMinutes(pickup) <= now.minutes) {
    throw new AppError('That pickup time has already passed. Please choose a later slot.', 400);
  }

  // Only when a delivery was actually asked for.
  if (deliveryDate && delivery) {
    assertDeliveryAfterPickup(pickupDate, pickup, deliveryDate, delivery);
  }

  // Notes are optional: nothing here refuses an order for leaving them blank.
  return {
    pickupDate,
    pickup,
    deliveryDate,
    delivery,
    pickupNotes: readNote(input.pickupNotes),
    serviceNotes: readNote(input.serviceNotes),
  };
}

/**
 * Validates a delivery being added to an order that already has a pickup.
 *
 * The pickup is read from the order rather than taken from the request, so
 * the "after the pickup" rule is checked against what was actually booked
 * and cannot be sidestepped by sending a different pickup alongside.
 *
 * Both halves are required here: this call exists to book a delivery, so
 * arriving with only one of them is a mistake either way.
 */
export async function resolveDeliverySchedule(
  pickupDate: string,
  pickupSlotStart: string,
  input: { deliveryDate?: unknown; deliverySlot?: unknown }
): Promise<{ deliveryDate: string; delivery: PickupSlot }> {
  const deliveryDate = requireDate(
    input.deliveryDate,
    'Please select a delivery date.',
    'Please select a valid delivery date.'
  );
  const delivery = requireSlot(
    input.deliverySlot,
    'Please select a delivery time.',
    'Please select a valid delivery time.'
  );

  // The stored pickup, reconstructed as a slot so the shared rule applies
  // unchanged. Only `start` is compared, which is what the rule uses.
  assertDeliveryAfterPickup(
    pickupDate,
    { id: '', label: '', start: pickupSlotStart, end: pickupSlotStart },
    deliveryDate,
    delivery
  );

  return { deliveryDate, delivery };
}

/* ===================================================================
 * THE PICKUP TIMES A MANAGER MAY ASSIGN
 *
 * The customer and the business book a two-hour SLOT; a Manager names a
 * MOMENT -- "4:00 PM" -- because that is the appointment the customer is
 * told to expect and a two-hour window is not an appointment.
 *
 * THE WORKING DAY IS NOT REDEFINED HERE. Both the first and last time below
 * are derived from `PICKUP_SLOTS`, which remains the single statement of when
 * Swachham operates: change the slot list and these move with it. That is the
 * whole reason this is computed rather than typed out.
 *
 * As with the slots, the list is served to the app and the same list
 * validates what comes back, so the two cannot drift apart.
 * =================================================================== */

/** How finely a Manager may place a collection within the working day. */
const PICKUP_TIME_STEP_MINUTES = 30;

export interface PickupTime {
  /** Stable id the app sends back, e.g. "16:00". */
  id: string;
  /** What everyone is shown, e.g. "4:00 PM". */
  label: string;
  /** The SQL TIME value stored on the order. */
  value: string;
  /** Minutes since midnight, for the same cutoff the slots use. */
  minutes: number;
}

/** 960 -> "16:00:00". */
function minutesToTime(minutes: number): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}:00`;
}

/** 960 -> "4:00 PM". The wording is fixed, not the device's locale. */
export function formatClockLabel(minutes: number): string {
  const hour24 = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const suffix = hour24 >= 12 ? 'PM' : 'AM';
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${String(minute).padStart(2, '0')} ${suffix}`;
}

/**
 * Every time a collection may be assigned to, through the working day.
 *
 * Opens when the first slot opens and stops one step BEFORE the last slot
 * closes: an appointment made exactly at closing time leaves no window to
 * keep it in, so the last offer is 6:30 PM for a day that ends at 7:00 PM.
 */
export const PICKUP_TIMES: PickupTime[] = (() => {
  const opens = timeToMinutes(PICKUP_SLOTS[0].start);
  const closes = timeToMinutes(PICKUP_SLOTS[PICKUP_SLOTS.length - 1].end);

  const times: PickupTime[] = [];
  for (let minutes = opens; minutes <= closes - PICKUP_TIME_STEP_MINUTES; minutes += PICKUP_TIME_STEP_MINUTES) {
    times.push({
      id: minutesToTime(minutes).slice(0, 5),
      label: formatClockLabel(minutes),
      value: minutesToTime(minutes),
      minutes,
    });
  }
  return times;
})();

/**
 * The times that may still be assigned on a given date, in the business
 * timezone — the same shape, and the same rule, as `getSlotsForDate`.
 *
 * A past date offers nothing, a future date offers the whole day, and today
 * offers only what has not yet come round.
 */
export async function getPickupTimesForDate(
  dateInput?: unknown
): Promise<Array<PickupTime & { available: boolean }>> {
  const withAvailability = (available: (time: PickupTime) => boolean) =>
    PICKUP_TIMES.map((time) => ({ ...time, available: available(time) }));

  const date = typeof dateInput === 'string' ? dateInput.trim() : '';
  if (!date || !DATE_ONLY.test(date)) return withAvailability(() => true);

  const now = await getBusinessNow();
  if (date < now.date) return withAvailability(() => false);
  if (date > now.date) return withAvailability(() => true);

  return withAvailability((time) => time.minutes > now.minutes);
}

/**
 * A pickup date and time a Manager submitted, validated against the working
 * day and against the clock.
 *
 * THE PAST IS REFUSED HERE, not in the app. The screen offers only what is
 * still ahead, and this is what makes a request that skipped the screen —
 * or one that sat on it until the chosen time went by — fail the same way.
 * Both halves are judged in IST through `getBusinessNow`, never against the
 * database server's UTC clock.
 */
export async function resolvePickupAssignment(input: {
  pickupDate?: unknown;
  pickupTime?: unknown;
}): Promise<{ date: string; time: PickupTime }> {
  const date = requireDate(
    input.pickupDate,
    'Please choose a pickup date.',
    'Pickup date must be in YYYY-MM-DD form.'
  );

  const id = typeof input.pickupTime === 'string' ? input.pickupTime.trim() : '';
  if (!id) throw new AppError('Please choose a pickup time.', 400);

  /*
   * Accepted as "16:00" or "16:00:00" — the id the list is served with, and
   * the value a stored assignment reads back as. A Manager changing the time
   * of an order that already has one is otherwise sending back something the
   * list would not recognise.
   */
  const time = PICKUP_TIMES.find((option) => option.id === id || option.value === id);
  if (!time) {
    throw new AppError('That pickup time is not one of the available times.', 400);
  }

  const now = await getBusinessNow();
  if (date < now.date) {
    throw new AppError('Pickup date cannot be in the past.', 400);
  }
  if (date === now.date && time.minutes <= now.minutes) {
    throw new AppError('That pickup time has already passed. Please choose a later time.', 400);
  }

  return { date, time };
}

/**
 * The operational window for an assigned time, for the `pickups` row.
 *
 * `pickups` stores a start and an end because that is the shape a booked slot
 * has had since the first schema, and the rider and the delivery-turnaround
 * rule both read it. An assigned time is a single moment, so the window it
 * implies is one slot long — the same two hours the booking slots use, taken
 * from the slot list rather than restated — and it never runs past closing.
 */
export function pickupWindowFor(time: PickupTime): { start: string; end: string } {
  const firstSlot = PICKUP_SLOTS[0];
  const slotLength = timeToMinutes(firstSlot.end) - timeToMinutes(firstSlot.start);
  const closes = timeToMinutes(PICKUP_SLOTS[PICKUP_SLOTS.length - 1].end);

  return {
    start: time.value,
    end: minutesToTime(Math.min(time.minutes + slotLength, closes)),
  };
}
