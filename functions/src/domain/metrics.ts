/**
 * Daily dashboard metrics. Pure module: no Firebase imports. The loader
 * (`metrics/loadMetricsInput.ts`) turns Firestore docs into these plain inputs.
 *
 * Definitions for a metrics day `date` (org-local calendar day):
 *  - census.admitted / referral: patients currently in that status (as of computation).
 *    dischargedToday / deathsToday: dischargeDate / death.date == date.
 *  - levelOfCare: admitted patients by level of care (missing → routine).
 *  - alerts: alerts created during the day; acked = those with ackedAt;
 *    medianAckMinutes over those; exhausted = those marked exhausted.
 *  - deadlines (admitted patients, completed keys excluded):
 *    dueNext7Days = due in [date, date + 7]; overdue = due before date (up to
 *    the reminder window of 30 days); completedOnTime30d / completedLate30d =
 *    completions whose org-local completion date is in (date − 30, date],
 *    on time when that local date ≤ the key's due date.
 *  - visits: visits scheduled to start during the day, by status.
 *  - triage: calls received during the day; emergent count; median minutes
 *    from received to resolved over the resolved ones.
 *  - volunteers: minutes logged with log.date in (date − 30, date]; active
 *    assignments.
 *  - bereavement: active plans; pending contacts due in [date, date + 7] and
 *    before date (overdue).
 */
import type { DailyMetrics, ISODate, LevelOfCare, Milestones, VisitStatus } from '../shared/types';
import { addDays, compareISO, isValidTimeZone, localDateParts } from './dates';
import { parseMilestoneKey, upcomingDeadlines } from './milestones';

export const DEADLINE_HORIZON_DAYS = 7;
export const COMPLETION_WINDOW_DAYS = 30;
export const VOLUNTEER_WINDOW_DAYS = 30;
export const BEREAVEMENT_HORIZON_DAYS = 7;

export interface MetricsPatient {
  status: string;
  levelOfCare?: LevelOfCare | null;
  dischargeDate?: ISODate | null;
  deathDate?: ISODate | null;
  milestones?: Milestones | null;
  /** milestone key → completion instant (ms). */
  completions?: Record<string, number>;
}

export interface MetricsAlert {
  createdAtMs: number;
  ackedAtMs: number | null;
  exhausted: boolean;
}

export interface MetricsTriageCall {
  urgency: string;
  receivedAtMs: number;
  resolvedAtMs: number | null;
}

export interface MetricsBereavementPlan {
  status: string;
  contacts: Array<{ dueDate: ISODate; status: string }>;
}

export interface MetricsInput {
  date: ISODate;
  timeZone: string;
  /**
   * Admitted patients plus any discharged / deceased in the last 30 days (for
   * today's counts and recent milestone completions). Duplicates not allowed.
   */
  patients: MetricsPatient[];
  /** Number of patients currently in `referral` status. */
  referralCount: number;
  alerts: MetricsAlert[];
  /** Visits scheduled during the day, by status (counts or derived with {@link countVisits}). */
  visits: Record<VisitStatus, number>;
  triageCalls: MetricsTriageCall[];
  volunteerLogs: Array<{ date: ISODate; minutes: number }>;
  activeVolunteerAssignments: number;
  bereavementPlans: MetricsBereavementPlan[];
}

export type DailyMetricsValues = Omit<DailyMetrics, 'computedAt'>;

export function median(values: readonly number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}

const round1 = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10);

export function countVisits(visits: ReadonlyArray<{ status: string }>): Record<VisitStatus, number> {
  const out: Record<VisitStatus, number> = { scheduled: 0, completed: 0, missed: 0, cancelled: 0 };
  for (const v of visits) if (v.status in out) out[v.status as VisitStatus]++;
  return out;
}

export function computeDailyMetricsValues(input: MetricsInput): DailyMetricsValues {
  const { date } = input;
  const tz = isValidTimeZone(input.timeZone) ? input.timeZone : 'UTC';
  const horizon = addDays(date, DEADLINE_HORIZON_DAYS);
  const completionFrom = addDays(date, -COMPLETION_WINDOW_DAYS); // exclusive

  const census = { admitted: 0, referral: input.referralCount, dischargedToday: 0, deathsToday: 0 };
  const levelOfCare: Record<LevelOfCare, number> = { routine: 0, continuous: 0, respite: 0, gip: 0 };
  const deadlines = { dueNext7Days: 0, overdue: 0, completedOnTime30d: 0, completedLate30d: 0 };

  for (const p of input.patients) {
    if (p.status === 'admitted') census.admitted++;
    if (p.dischargeDate === date) census.dischargedToday++;
    if (p.deathDate === date) census.deathsToday++;
    const completions = p.completions ?? {};

    if (p.status === 'admitted') {
      const loc = p.levelOfCare && p.levelOfCare in levelOfCare ? p.levelOfCare : 'routine';
      levelOfCare[loc]++;
      if (p.milestones) {
        for (const d of upcomingDeadlines(p.milestones, date, DEADLINE_HORIZON_DAYS)) {
          if (completions[d.key] !== undefined) continue;
          if (d.overdue) deadlines.overdue++;
          else if (compareISO(d.dueDate, horizon) <= 0) deadlines.dueNext7Days++;
        }
      }
    }

    for (const [key, completedMs] of Object.entries(completions)) {
      const parsed = parseMilestoneKey(key);
      if (!parsed || !Number.isFinite(completedMs)) continue;
      const doneOn = localDateParts(new Date(completedMs), tz).date;
      if (compareISO(doneOn, completionFrom) <= 0 || compareISO(doneOn, date) > 0) continue;
      if (compareISO(doneOn, parsed.dueDate) <= 0) deadlines.completedOnTime30d++;
      else deadlines.completedLate30d++;
    }
  }

  const ackMinutes = input.alerts.filter((a) => a.ackedAtMs !== null).map((a) => (a.ackedAtMs! - a.createdAtMs) / 60_000);
  const alerts = {
    created: input.alerts.length,
    acked: ackMinutes.length,
    medianAckMinutes: round1(median(ackMinutes)),
    exhausted: input.alerts.filter((a) => a.exhausted).length,
  };

  const resolveMinutes = input.triageCalls.filter((c) => c.resolvedAtMs !== null).map((c) => (c.resolvedAtMs! - c.receivedAtMs) / 60_000);
  const triage = {
    calls: input.triageCalls.length,
    emergent: input.triageCalls.filter((c) => c.urgency === 'emergent').length,
    medianResolveMinutes: round1(median(resolveMinutes)),
  };

  const volunteerFrom = addDays(date, -VOLUNTEER_WINDOW_DAYS); // exclusive
  const minutesLast30d = input.volunteerLogs
    .filter((l) => compareISO(l.date, volunteerFrom) > 0 && compareISO(l.date, date) <= 0)
    .reduce((sum, l) => sum + (Number.isFinite(l.minutes) ? l.minutes : 0), 0);

  const active = input.bereavementPlans.filter((p) => p.status === 'active');
  const bHorizon = addDays(date, BEREAVEMENT_HORIZON_DAYS);
  let contactsDueNext7Days = 0;
  let contactsOverdue = 0;
  for (const plan of active) {
    for (const c of plan.contacts ?? []) {
      if (c.status !== 'pending') continue;
      if (compareISO(c.dueDate, date) < 0) contactsOverdue++;
      else if (compareISO(c.dueDate, bHorizon) <= 0) contactsDueNext7Days++;
    }
  }

  return {
    date,
    census,
    levelOfCare,
    alerts,
    deadlines,
    visits: { ...input.visits },
    triage,
    volunteers: { minutesLast30d, activeAssignments: input.activeVolunteerAssignments },
    bereavement: { activePlans: active.length, contactsDueNext7Days, contactsOverdue },
  };
}

/** Offset (ms) of `timeZone` from UTC at `instantMs` (local = utc + offset). */
function tzOffsetMs(instantMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instantMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

/** UTC instant of local midnight at the start of `date` in `timeZone` (DST-aware). */
export function zonedMidnightMs(date: ISODate, timeZone: string): number {
  const tz = isValidTimeZone(timeZone) ? timeZone : 'UTC';
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d);
  let ms = guess - tzOffsetMs(guess, tz);
  ms = guess - tzOffsetMs(ms, tz);
  return ms;
}

/** `[start, end)` instants of the org-local calendar day `date`. */
export function zonedDayBounds(date: ISODate, timeZone: string): { startMs: number; endMs: number } {
  return { startMs: zonedMidnightMs(date, timeZone), endMs: zonedMidnightMs(addDays(date, 1), timeZone) };
}
