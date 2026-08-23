import { query } from '../config/database';
import { config } from '../config/env';

/**
 * "Now", as India reads it.
 *
 * Every business scheduling decision is made in IST. The clock of record is
 * the DATABASE's, converted through `config.BUSINESS_TZ_OFFSET` — the same
 * source the order number, the Sorter queue and the GST invoice already use.
 * Reading `new Date()` in Node instead would introduce a second clock that
 * can disagree with the one the rest of the system stamps rows with.
 *
 * Centralised here so no route or service does its own timezone arithmetic.
 */

export interface BusinessNow {
  /** YYYY-MM-DD in the business timezone. */
  date: string;
  /** HH:MM:SS in the business timezone. */
  time: string;
  /** Minutes since midnight, for comparing against a slot start. */
  minutes: number;
}

/**
 * The current business date and time, in one round trip.
 *
 * Both halves come from the same instant, so a call that straddles midnight
 * cannot return yesterday's date with today's time.
 */
export async function getBusinessNow(): Promise<BusinessNow> {
  const result = await query<{ d: string; t: string }>(
    `SELECT DATE_FORMAT(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', ?), '%Y-%m-%d') AS d,
            DATE_FORMAT(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', ?), '%H:%i:%s') AS t`,
    [config.BUSINESS_TZ_OFFSET, config.BUSINESS_TZ_OFFSET]
  );
  const date = String(result.rows[0].d);
  const time = String(result.rows[0].t);
  const [hours, minutes] = time.split(':').map(Number);

  return { date, time, minutes: hours * 60 + minutes };
}

/** The current business calendar date, YYYY-MM-DD. */
export async function getBusinessDate(): Promise<string> {
  return (await getBusinessNow()).date;
}

/** "HH:MM:SS" to minutes since midnight. */
export function timeToMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

/**
 * YYYY-MM-DD, `days` later. Pure arithmetic in UTC, so no local timezone can
 * shift the result across a day boundary.
 */
export function addDays(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day) + days * 86_400_000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}
