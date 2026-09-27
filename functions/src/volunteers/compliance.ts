/**
 * Volunteer 5% compliance math (42 CFR 418.78(e): volunteer time ≥ 5% of patient-care
 * hours of paid staff). Pure module: no Firebase imports.
 *
 * The report range [from, to] is split into calendar-month segments. For each month the
 * staff minutes are either the admin override (`staffHours/{YYYY-MM}.paidCareHours`,
 * prorated by the share of the month's days inside the range) or the summed durations of
 * the visits completed in that segment (`scheduledEnd − scheduledStart`).
 */
import { addDays, compareISO, diffDays } from '../domain/dates';
import type { ISODate, VolunteerComplianceMonth } from '../shared/types';

export const VOLUNTEER_TARGET_RATIO = 0.05;
export const MAX_REPORT_DAYS = 366;

export interface MonthSegment {
  /** `YYYY-MM`. */
  month: string;
  from: ISODate;
  to: ISODate;
  /** Days of the month inside the range / days in the month. */
  fraction: number;
}

function daysInMonth(month: string): number {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Splits [from, to] (inclusive) into calendar-month segments. */
export function monthSegments(from: ISODate, to: ISODate): MonthSegment[] {
  const out: MonthSegment[] = [];
  let cur = from;
  while (compareISO(cur, to) <= 0) {
    const month = cur.slice(0, 7);
    const lastOfMonth = `${month}-${String(daysInMonth(month)).padStart(2, '0')}`;
    const segTo = compareISO(lastOfMonth, to) < 0 ? lastOfMonth : to;
    out.push({ month, from: cur, to: segTo, fraction: (diffDays(cur, segTo) + 1) / daysInMonth(month) });
    cur = addDays(segTo, 1);
  }
  return out;
}

/** Visit duration in whole minutes (0 for missing or negative spans, capped at 24 h). */
export function visitMinutes(startMs: number, endMs: number): number {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 0;
  return Math.min(Math.round((endMs - startMs) / 60_000), 24 * 60);
}

export function complianceRatio(volunteerMinutes: number, staffMinutes: number): number | null {
  return staffMinutes > 0 ? volunteerMinutes / staffMinutes : null;
}

export function summarize(months: readonly VolunteerComplianceMonth[]) {
  const volunteerMinutes = months.reduce((n, m) => n + m.volunteerMinutes, 0);
  const staffMinutes = months.reduce((n, m) => n + m.staffMinutes, 0);
  const ratio = complianceRatio(volunteerMinutes, staffMinutes);
  return { volunteerMinutes, staffMinutes, ratio, target: VOLUNTEER_TARGET_RATIO, meetsTarget: ratio !== null && ratio >= VOLUNTEER_TARGET_RATIO };
}
