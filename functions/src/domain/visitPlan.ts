/**
 * Visit planning from per-discipline frequencies (V2). Pure module: no Firebase imports.
 *
 * - The plan covers the 7 calendar days starting at `weekStart` (org-local).
 * - Fractional `perWeek` values are spread over consecutive Monday-aligned weeks: week `w`
 *   gets `floor(perWeek)` visits plus one more when `floor((w+1)·f) − floor(w·f) = 1`, where
 *   `f` is the fractional part. For `x.5` this is ISO-week parity (odd weeks get the extra
 *   visit); 0.25 gives one visit every fourth week, and so on.
 * - Visits that already exist for the patient and discipline in the window (any status except
 *   `cancelled`, plus cancelled *planned* visits, so a deliberately cancelled plan visit is not
 *   re-created) count toward the target.
 * - Planned visit ids are deterministic, `plan_{patientId}_{discipline}_{weekStart}_{n}` with
 *   n = 1…target, so re-running the plan is idempotent.
 */
import { addDays, isoToUtcMillis, isValidTimeZone } from './dates';
import type { Discipline, ISODate, PlannedVisit, VisitFrequency, VisitPlanConflict } from '../shared/types';

const DAY_MS = 86_400_000;
const MIN_MS = 60_000;
export const DEFAULT_PLAN_START = '09:00';
export const DEFAULT_PLAN_DURATION_MINUTES = 60;
/** Gap between two visits planned for the same patient/discipline on the same day. */
const SAME_DAY_GAP_MINUTES = 60;

/** Monday-aligned week number since the epoch (1970-01-01 was a Thursday). Continuous across years. */
export function weekIndex(iso: ISODate): number {
  const days = Math.floor(isoToUtcMillis(iso) / DAY_MS);
  return Math.floor((days + 3) / 7);
}

/** Visits due in week `w` for a (possibly fractional) weekly frequency. */
export function visitsInWeek(perWeek: number, w: number): number {
  if (!Number.isFinite(perWeek) || perWeek <= 0) return 0;
  const whole = Math.floor(perWeek);
  const frac = perWeek - whole;
  if (frac < 1e-9) return whole;
  const eps = 1e-9;
  return whole + (Math.floor((w + 1) * frac + eps) - Math.floor(w * frac + eps));
}

/** Day of week (0 = Sunday) of an ISO date. */
export function dayOfWeek(iso: ISODate): number {
  return new Date(isoToUtcMillis(iso)).getUTCDay();
}

/**
 * Days of the week to use for `count` visits. Preferred days win (deduplicated, 0–6);
 * otherwise visits are spread over Mon–Fri (centered: 1 → Wed, 2 → Tue/Thu, 3 → Mon/Wed/Fri),
 * spilling onto the weekend only for 6 or more visits.
 */
export function chooseDays(count: number, preferred?: readonly number[] | null): number[] {
  const pref = [...new Set((preferred ?? []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))];
  if (pref.length > 0) return pref;
  if (count <= 0) return [];
  if (count >= 7) return [1, 2, 3, 4, 5, 6, 0];
  if (count === 6) return [1, 2, 3, 4, 5, 6];
  const weekdays = [1, 2, 3, 4, 5];
  return Array.from({ length: count }, (_, i) => weekdays[Math.floor(((i + 0.5) * 5) / count)]!);
}

/** Offset (UTC ms) of `timeZone` at instant `ms`: local wall time minus UTC. */
export function tzOffsetMs(ms: number, timeZone: string): number {
  const tz = isValidTimeZone(timeZone) ? timeZone : 'UTC';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** UTC instant (ms) of local wall time `hhmm` on calendar date `iso` in `timeZone` (DST-aware). */
export function zonedTimeToUtcMs(iso: ISODate, hhmm: string, timeZone: string): number {
  const [h, m] = parseHHMM(hhmm) ?? [9, 0];
  const guess = isoToUtcMillis(iso) + h * 3_600_000 + m * MIN_MS;
  const off1 = tzOffsetMs(guess, timeZone);
  let ms = guess - off1;
  const off2 = tzOffsetMs(ms, timeZone);
  if (off2 !== off1) ms = guess - off2;
  return ms;
}

export function parseHHMM(v: string | null | undefined): [number, number] | null {
  const m = /^(\d{2}):(\d{2})$/.exec(v ?? '');
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  return h <= 23 && mi <= 59 ? [h, mi] : null;
}

export function planVisitId(patientId: string, discipline: Discipline, weekStart: ISODate, n: number): string {
  return `plan_${patientId}_${discipline}_${weekStart}_${n}`.replace(/[^A-Za-z0-9_-]/g, '_');
}

export interface PlanPatient {
  id: string;
  name: string;
  frequencies: readonly VisitFrequency[];
  /** Active care-team members in care-team order. */
  careTeam: ReadonlyArray<{ uid: string; discipline: Discipline }>;
}

export interface ExistingVisitSpan {
  id: string;
  patientId: string;
  discipline: Discipline;
  status: string;
  assignedUid: string | null;
  startMs: number;
  endMs: number;
}

export interface PlanInput {
  weekStart: ISODate;
  timeZone: string;
  nowMs: number;
  patients: readonly PlanPatient[];
  /** Visits in the window: the patients' visits and (for overlap checks) the assignees' visits. */
  existing: readonly ExistingVisitSpan[];
  /** Active member uids (to validate `VisitFrequency.assignedUid`). */
  activeUids: ReadonlySet<string>;
}

export interface PlanResult {
  visits: PlannedVisit[];
  conflicts: VisitPlanConflict[];
  /** Existing visits that counted toward targets. */
  existing: number;
}

const overlaps = (a: { startMs: number; endMs: number }, b: { startMs: number; endMs: number }) => a.startMs < b.endMs && b.startMs < a.endMs;

export function planWeek(input: PlanInput): PlanResult {
  const { weekStart, timeZone, nowMs } = input;
  const w = weekIndex(weekStart);
  const startDow = dayOfWeek(weekStart);
  const windowStartMs = zonedTimeToUtcMs(weekStart, '00:00', timeZone);
  const windowEndMs = zonedTimeToUtcMs(addDays(weekStart, 7), '00:00', timeZone);
  const inWindow = input.existing.filter((v) => v.startMs >= windowStartMs && v.startMs < windowEndMs);

  // Busy intervals per assignee (existing non-cancelled visits, then planned ones as they are added).
  const busy = new Map<string, Array<{ startMs: number; endMs: number; id: string }>>();
  for (const v of inWindow) {
    if (!v.assignedUid || v.status === 'cancelled') continue;
    busy.set(v.assignedUid, [...(busy.get(v.assignedUid) ?? []), { startMs: v.startMs, endMs: v.endMs, id: v.id }]);
  }

  const visits: PlannedVisit[] = [];
  const conflicts: VisitPlanConflict[] = [];
  let existingCount = 0;

  for (const p of input.patients) {
    for (const f of p.frequencies) {
      const target = visitsInWeek(f.perWeek, w);
      if (target <= 0) continue;
      const mine = inWindow.filter(
        (v) => v.patientId === p.id && v.discipline === f.discipline && (v.status !== 'cancelled' || v.id.startsWith('plan_')),
      );
      existingCount += mine.length;
      let needed = Math.max(0, target - mine.length);
      if (needed === 0) continue;

      // Assignee: the frequency's planned assignee when active, else the care-team member with this discipline.
      let assignedUid: string | null = null;
      if (f.assignedUid) {
        if (input.activeUids.has(f.assignedUid)) assignedUid = f.assignedUid;
        else {
          conflicts.push({
            kind: 'inactive_assignee', patientId: p.id, discipline: f.discipline, visitId: null,
            message: 'The planned assignee is not an active member; using the care team instead.',
          });
        }
      }
      assignedUid ??= p.careTeam.find((m) => m.discipline === f.discipline)?.uid ?? null;

      const days = chooseDays(target, f.preferredDays);
      const takenIds = new Set(mine.map((v) => v.id));
      const busyDays = new Set(mine.map((v) => Math.floor((v.startMs - windowStartMs) / DAY_MS)));
      const duration = (f.durationMinutes && f.durationMinutes > 0 ? f.durationMinutes : DEFAULT_PLAN_DURATION_MINUTES) * MIN_MS;
      const startHHMM = parseHHMM(f.preferredStart) ? f.preferredStart! : DEFAULT_PLAN_START;

      const slots = Array.from({ length: target }, (_, i) => {
        const n = i + 1;
        const dow = days[i % days.length]!;
        const offset = (dow - startDow + 7) % 7;
        const repeat = Math.floor(i / days.length);
        const date = addDays(weekStart, offset);
        const startMs = zonedTimeToUtcMs(date, startHHMM, timeZone) + repeat * (duration + SAME_DAY_GAP_MINUTES * MIN_MS);
        return { n, offset, id: planVisitId(p.id, f.discipline, weekStart, n), startMs, endMs: startMs + duration };
      });
      // Fill free slots, preferring days without a visit for this patient/discipline yet.
      const free = slots
        .filter((s) => !takenIds.has(s.id))
        .sort((a, b) => Number(busyDays.has(a.offset)) - Number(busyDays.has(b.offset)) || a.n - b.n);

      for (const s of free) {
        if (needed === 0) break;
        needed--;
        if (s.startMs <= nowMs) {
          conflicts.push({
            kind: 'past', patientId: p.id, discipline: f.discipline, visitId: s.id,
            message: 'This slot is already in the past and was not planned.',
          });
          continue;
        }
        const pv: PlannedVisit = {
          id: s.id,
          patientId: p.id,
          patientName: p.name,
          discipline: f.discipline,
          assignedUid,
          start: new Date(s.startMs).toISOString(),
          end: new Date(s.endMs).toISOString(),
        };
        visits.push(pv);
        if (!assignedUid) {
          conflicts.push({
            kind: 'unassigned', patientId: p.id, discipline: f.discipline, visitId: s.id,
            message: `No ${f.discipline} on the care team; the visit will be unassigned.`,
          });
          continue;
        }
        const theirs = busy.get(assignedUid) ?? [];
        if (theirs.some((b) => overlaps(b, s))) {
          conflicts.push({
            kind: 'overlap', patientId: p.id, discipline: f.discipline, visitId: s.id,
            message: 'The assignee already has a visit at this time.',
          });
        }
        busy.set(assignedUid, [...theirs, { startMs: s.startMs, endMs: s.endMs, id: s.id }]);
      }
    }
  }
  visits.sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
  return { visits, conflicts, existing: existingCount };
}
