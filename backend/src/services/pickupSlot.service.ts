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

  // Belt and braces: with delivery_date > pickup_date this cannot fail, but
  // the requirement is on the datetimes, so the datetimes are what is
  // asserted. If the date rule above is ever relaxed, this still holds.
  if (`${deliveryDate}T${delivery.start}` <= `${pickupDate}T${pickup.start}`) {
    throw new AppError('Delivery time must be after pickup time.', 400);
  }
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
