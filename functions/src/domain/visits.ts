/**
 * Visit rules. Pure module: no Firebase imports.
 *
 * A `scheduled` visit becomes `missed` once its `scheduledEnd` is more than
 * `graceMinutes` in the past (strictly: end + grace < now).
 */

export interface VisitSpan {
  id: string;
  status: string;
  endMs: number;
}

/** True when a scheduled visit with this end time is past its grace period at `nowMs`. */
export function isVisitMissed(v: Pick<VisitSpan, 'status' | 'endMs'>, nowMs: number, graceMinutes: number): boolean {
  if (v.status !== 'scheduled' || !Number.isFinite(v.endMs)) return false;
  return v.endMs + Math.max(0, graceMinutes) * 60_000 < nowMs;
}

/** Visits that should be marked missed now, oldest end first. */
export function selectMissedVisits<T extends VisitSpan>(visits: readonly T[], nowMs: number, graceMinutes: number): T[] {
  return visits.filter((v) => isVisitMissed(v, nowMs, graceMinutes)).sort((a, b) => a.endMs - b.endMs);
}

/** Latest scheduledEnd (ms) that counts as missed at `nowMs`; used as the query bound. */
export function missedCutoffMs(nowMs: number, graceMinutes: number): number {
  return nowMs - Math.max(0, graceMinutes) * 60_000;
}
