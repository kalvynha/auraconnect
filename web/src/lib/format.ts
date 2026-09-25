import type { TimestampLike } from '@shared/types';

export function tsToDate(ts: TimestampLike | null | undefined): Date | null {
  if (!ts) return null;
  if (typeof ts.toDate === 'function') return ts.toDate();
  if (typeof ts.seconds === 'number') return new Date(ts.seconds * 1000 + Math.floor((ts.nanoseconds ?? 0) / 1e6));
  return null;
}

export function tsMillis(ts: TimestampLike | null | undefined): number {
  return tsToDate(ts)?.getTime() ?? 0;
}

export function formatInstant(ts: TimestampLike | null | undefined): string {
  const d = tsToDate(ts);
  if (!d) return '—';
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatTime(ts: TimestampLike | null | undefined): string {
  const d = tsToDate(ts);
  if (!d) return '';
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** Today's calendar date in the browser's local time zone, `YYYY-MM-DD`. */
export function todayISO(): string {
  return toISODate(new Date());
}

export function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Days from `from` to `to` (both `YYYY-MM-DD`), computed in UTC to avoid DST drift. */
export function daysBetween(from: string, to: string): number {
  const a = Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10));
  const b = Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10));
  return Math.round((b - a) / 86400000);
}

/** Format a `YYYY-MM-DD` date without any time-zone shifting. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export type DueState = 'overdue' | 'soon' | 'ok' | 'past';

/** Classify a due date relative to today: overdue, due within `soonDays`, or fine. */
export function dueState(dueISO: string | null | undefined, soonDays = 7): DueState {
  if (!dueISO) return 'ok';
  const diff = daysBetween(todayISO(), dueISO);
  if (diff < 0) return 'overdue';
  if (diff <= soonDays) return 'soon';
  return 'ok';
}

/** `datetime-local` input value for a Date (local time). */
export function toDateTimeLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function errorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return 'Something went wrong.';
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
