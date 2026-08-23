import { query } from '../config/database';
import { AppError } from '../utils/appError';
import { addDays, getBusinessDate } from '../utils/istTime';

/**
 * Billing cycles, and the invoice period each one implies.
 *
 * A business is billed on its own cycle, and the invoice for a given date
 * must cover exactly the period that cycle defines — not whatever two dates
 * someone typed. This module turns "which business, which date" into "which
 * period", and it is the only place that arithmetic lives.
 *
 * THE CYCLE IS READ FROM THE DATABASE, never from the request. A client that
 * sends `billing_cycle: 'YEARLY'` to widen its own invoice changes nothing:
 * `periodForBusiness` looks the business up.
 *
 * Every boundary is a calendar date in the business timezone, computed from
 * `utils/istTime`, so a period never shifts because the server is on UTC.
 */

export const BILLING_CYCLES = [
  'MONTHLY',
  'FORTNIGHTLY',
  'QUARTERLY',
  'HALF_YEARLY',
  'YEARLY',
] as const;

export type BillingCycle = (typeof BILLING_CYCLES)[number];

export const BILLING_CYCLE_LABELS: Record<BillingCycle, string> = {
  MONTHLY: 'Monthly',
  FORTNIGHTLY: 'Fortnightly',
  QUARTERLY: 'Quarterly',
  HALF_YEARLY: 'Half-Yearly',
  YEARLY: 'Yearly',
};

/** The cycle used when a business has none recorded. */
export const DEFAULT_BILLING_CYCLE: BillingCycle = 'MONTHLY';

/**
 * Accepts a cycle in any reasonable spelling and returns the stored one.
 * Anything else is refused rather than coerced.
 */
export function parseBillingCycle(value: unknown, label = 'Billing cycle'): BillingCycle {
  if (value === null || value === undefined || value === '') {
    throw new AppError(`${label} is required.`, 400);
  }
  const raw = String(value).trim().toUpperCase().replace(/[\s-]+/g, '_');
  if ((BILLING_CYCLES as readonly string[]).includes(raw)) return raw as BillingCycle;
  throw new AppError(`${label} must be one of: ${BILLING_CYCLES.join(', ')}.`, 400);
}

export function parseOptionalBillingCycle(value: unknown): BillingCycle | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  return parseBillingCycle(value);
}

/** The list the UI offers, so the options cannot drift from the enum. */
export function listBillingCycles(): Array<{ value: BillingCycle; label: string }> {
  return BILLING_CYCLES.map((value) => ({ value, label: BILLING_CYCLE_LABELS[value] }));
}

export interface BillingPeriod {
  /** YYYY-MM-DD, inclusive. */
  from: string;
  /** YYYY-MM-DD, inclusive. */
  to: string;
  cycle: BillingCycle;
  /** Human label for the invoice, e.g. "August 2026" or "1–14 Aug 2026". */
  label: string;
}

const MONTH_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];
const MONTH_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function parts(dateKey: string): { y: number; m: number; d: number } {
  const [y, m, d] = dateKey.split('-').map(Number);
  return { y, m, d };
}

const pad = (n: number) => String(n).padStart(2, '0');
const key = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** Days in a month, leap years included. */
function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** The last day of the month `dateKey` falls in. */
function endOfMonth(y: number, m: number): string {
  return key(y, m, daysInMonth(y, m));
}

/**
 * The billing period containing `onDate`, for a given cycle.
 *
 * FORTNIGHTLY is anchored to the MONTH, not to a rolling 14 days from some
 * arbitrary start: the 1st–14th and the 15th–end-of-month. A rolling window
 * would drift against the calendar and two consecutive invoices would
 * eventually overlap a month boundary in a way nobody could reconcile. The
 * second half is 14, 15 or 16 days depending on the month, which is what
 * "the second half of the month" means in practice and what the brief's own
 * example (1–14, 15–28) describes for a 28-day month.
 *
 * QUARTERLY, HALF_YEARLY and YEARLY are anchored to the calendar year, so
 * every business on the same cycle is invoiced for the same windows.
 */
export function periodFor(cycle: BillingCycle, onDate: string): BillingPeriod {
  if (!DATE_ONLY.test(onDate)) {
    throw new AppError('Date must be in YYYY-MM-DD format.', 400);
  }
  const { y, m, d } = parts(onDate);

  switch (cycle) {
    case 'MONTHLY':
      return {
        cycle,
        from: key(y, m, 1),
        to: endOfMonth(y, m),
        label: `${MONTH_LONG[m - 1]} ${y}`,
      };

    case 'FORTNIGHTLY': {
      const firstHalf = d <= 14;
      const from = firstHalf ? key(y, m, 1) : key(y, m, 15);
      const to = firstHalf ? key(y, m, 14) : endOfMonth(y, m);
      return {
        cycle,
        from,
        to,
        label: `${parts(from).d}–${parts(to).d} ${MONTH_SHORT[m - 1]} ${y}`,
      };
    }

    case 'QUARTERLY': {
      // Q1 = Jan–Mar, Q2 = Apr–Jun, Q3 = Jul–Sep, Q4 = Oct–Dec.
      const quarter = Math.floor((m - 1) / 3);
      const startMonth = quarter * 3 + 1;
      const endMonth = startMonth + 2;
      return {
        cycle,
        from: key(y, startMonth, 1),
        to: endOfMonth(y, endMonth),
        label: `Q${quarter + 1} ${y} (${MONTH_SHORT[startMonth - 1]}–${MONTH_SHORT[endMonth - 1]})`,
      };
    }

    case 'HALF_YEARLY': {
      const firstHalf = m <= 6;
      const startMonth = firstHalf ? 1 : 7;
      const endMonth = firstHalf ? 6 : 12;
      return {
        cycle,
        from: key(y, startMonth, 1),
        to: endOfMonth(y, endMonth),
        label: `${firstHalf ? 'Jan–Jun' : 'Jul–Dec'} ${y}`,
      };
    }

    case 'YEARLY':
      return {
        cycle,
        from: key(y, 1, 1),
        to: key(y, 12, 31),
        label: `${y}`,
      };

    default: {
      // Exhaustive: adding a cycle without handling it fails to compile.
      const unreachable: never = cycle;
      throw new AppError(`Unsupported billing cycle: ${unreachable}`, 400);
    }
  }
}

/** The period immediately before the one containing `onDate`. */
export function previousPeriod(cycle: BillingCycle, onDate: string): BillingPeriod {
  const current = periodFor(cycle, onDate);
  // One day before this period starts is, by definition, inside the previous
  // one — which saves special-casing month and year rollovers per cycle.
  return periodFor(cycle, addDays(current.from, -1));
}

/** The business's own cycle, as recorded. Never taken from a request. */
export async function cycleForBusiness(businessId: string): Promise<BillingCycle> {
  const result = await query<{ billing_cycle: string | null }>(
    `SELECT billing_cycle FROM businesses WHERE id = ?`,
    [businessId]
  );
  if (!result.rows[0]) {
    throw new AppError('Business not found', 404);
  }
  const stored = result.rows[0].billing_cycle;
  // A business onboarded before billing cycles existed has none; monthly is
  // the sensible reading of "bill it the usual way" rather than an error
  // that would block its invoice entirely.
  return stored ? parseBillingCycle(stored) : DEFAULT_BILLING_CYCLE;
}

/**
 * The invoice period for one business, for the date given (default: today in
 * the business timezone).
 *
 * This is what the invoice endpoint uses when no explicit range is supplied:
 * the period comes from the business's own configuration, so an invoice
 * covers what the contract says it covers.
 */
export async function periodForBusiness(
  businessId: string,
  onDate?: unknown
): Promise<BillingPeriod> {
  const cycle = await cycleForBusiness(businessId);
  const date =
    typeof onDate === 'string' && DATE_ONLY.test(onDate.trim())
      ? onDate.trim()
      : await getBusinessDate();
  return periodFor(cycle, date);
}

/**
 * The last `count` periods for a business, newest first.
 *
 * Lets the Super Admin pick "which invoice" from a list the cycle defines,
 * instead of typing two dates and hoping they line up with a billing period.
 */
export async function recentPeriodsForBusiness(
  businessId: string,
  count = 6
): Promise<BillingPeriod[]> {
  const cycle = await cycleForBusiness(businessId);
  const today = await getBusinessDate();

  const periods: BillingPeriod[] = [];
  let cursor = today;
  for (let i = 0; i < Math.min(Math.max(count, 1), 24); i += 1) {
    const period = periodFor(cycle, cursor);
    periods.push(period);
    cursor = addDays(period.from, -1);
  }
  return periods;
}
