/**
 * ISO calendar-date helpers (`YYYY-MM-DD`). All arithmetic is done in UTC so a
 * calendar date never shifts because of the server's or a user's time zone.
 * Pure module: no Firebase imports.
 */
import type { ISODate } from '../shared/types';

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/** True when `value` is a real calendar date in `YYYY-MM-DD` form (rejects 2026-02-30). */
export function isValidISODate(value: unknown): value is ISODate {
  if (typeof value !== 'string') return false;
  const m = ISO_RE.exec(value);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1000 || mo < 1 || mo > 12 || d < 1) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** Midnight UTC epoch millis for an ISO date. Throws on an invalid date. */
export function isoToUtcMillis(iso: ISODate): number {
  if (!isValidISODate(iso)) throw new RangeError(`Invalid ISO date: ${String(iso)}`);
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

/** Formats the UTC calendar date of `date` as `YYYY-MM-DD`. */
export function utcDateToISO(date: Date): ISODate {
  return date.toISOString().slice(0, 10);
}

/** `iso` plus `days` calendar days (negative allowed). */
export function addDays(iso: ISODate, days: number): ISODate {
  return utcDateToISO(new Date(isoToUtcMillis(iso) + days * DAY_MS));
}

/** Whole calendar days from `a` to `b` (`b - a`). */
export function diffDays(a: ISODate, b: ISODate): number {
  return Math.round((isoToUtcMillis(b) - isoToUtcMillis(a)) / DAY_MS);
}

/** Lexicographic compare works for ISO dates; exported for readability. */
export function compareISO(a: ISODate, b: ISODate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** True when `tz` is an IANA time zone the runtime understands. */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Local calendar date and hour of `instant` in `timeZone`. Falls back to UTC for an invalid zone. */
export function localDateParts(instant: Date, timeZone: string): { date: ISODate; hour: number } {
  const tz = isValidTimeZone(timeZone) ? timeZone : 'UTC';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}

/** Local calendar date ("today") of `instant` in `timeZone`. */
export function todayInTimeZone(instant: Date, timeZone: string): ISODate {
  return localDateParts(instant, timeZone).date;
}
