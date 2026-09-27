/**
 * Reads the Firestore inputs for one org-day of {@link DailyMetrics}. Every
 * read is bounded by a date range, a status filter or an aggregate count:
 *  - patients: status == admitted, plus dischargeDate / death.date within the completion window
 *    (COMPLETION_WINDOW_DAYS, 30), so recent milestone completions of patients who left still count.
 *    Overdue deadlines have no look-back cap (S1); only completions use the 30-day window.
 *  - patients in referral: count()
 *  - alerts: createdAt in [dayStart, dayEnd)
 *  - visits: count() per status with scheduledStart in [dayStart, dayEnd)
 *  - triageCalls: receivedAt in [dayStart, dayEnd)
 *  - volunteerLogs: date in (date − 30, date]; volunteerAssignments: count() of active
 *  - bereavementPlans: status == active
 */
import { Timestamp, type Query } from 'firebase-admin/firestore';
import { addDays, localDateParts } from '../domain/dates';
import { completionDate } from '../domain/milestones';
import { COMPLETION_WINDOW_DAYS, VOLUNTEER_WINDOW_DAYS, zonedDayBounds, type MetricsInput, type MetricsPatient } from '../domain/metrics';
import { colRef, paths } from '../lib/db';
import type { Alert, BereavementPlan, ISODate, Org, Patient, TimestampLike, TriageCall, VisitStatus, VolunteerLog } from '../shared/types';

const VISIT_STATUSES: readonly VisitStatus[] = ['scheduled', 'completed', 'missed', 'cancelled'];
/** Safety caps on document reads (a hospice org-day is far below these). */
const MAX_DAY_DOCS = 5000;
const MAX_PATIENT_DOCS = 5000;
const MAX_VOLUNTEER_LOGS = 20000;

function ms(t: TimestampLike | null | undefined): number | null {
  if (!t) return null;
  return typeof t.toMillis === 'function' ? t.toMillis() : t.seconds * 1000 + Math.floor((t.nanoseconds ?? 0) / 1e6);
}

async function count(q: Query): Promise<number> {
  const snap = await q.count().get();
  return snap.data().count;
}

/**
 * S5: a completion counts from `completionDate()` — its `effectiveDate` (actual filing date) when
 * recorded, else the org-local date of `completedAt`. The metrics domain takes an instant, so the
 * date is passed as local noon of that day in `tz`.
 */
function toMetricsPatient(p: Patient, tz: string): MetricsPatient {
  const completions: Record<string, number> = {};
  const localDateOf = (at: unknown): ISODate | null => {
    const m = ms(at as TimestampLike | null | undefined);
    return m === null ? null : localDateParts(new Date(m), tz).date;
  };
  for (const [key, c] of Object.entries(p.milestoneCompletions ?? {})) {
    const day = completionDate(c, localDateOf);
    if (day) completions[key] = zonedDayBounds(day, tz).startMs + 12 * 3_600_000;
  }
  return {
    status: p.status,
    levelOfCare: p.levelOfCare ?? null,
    dischargeDate: p.dischargeDate ?? null,
    deathDate: p.death?.date ?? null,
    milestones: p.milestones ?? null,
    completions,
  };
}

export async function loadMetricsInput(orgId: string, org: Pick<Org, 'timezone'>, date: ISODate): Promise<MetricsInput> {
  const tz = org.timezone || 'UTC';
  const { startMs, endMs } = zonedDayBounds(date, tz);
  const start = Timestamp.fromMillis(startMs);
  const end = Timestamp.fromMillis(endMs);
  const col = (name: string) => colRef(`${paths.org(orgId)}/${name}`);
  const recentFrom = addDays(date, -(COMPLETION_WINDOW_DAYS - 1));

  const [admitted, discharged, deceased, referralCount, alerts, visitCounts, triage, logs, activeAssignments, plans] = await Promise.all([
    colRef(paths.patients(orgId)).where('status', '==', 'admitted').limit(MAX_PATIENT_DOCS).get(),
    colRef(paths.patients(orgId)).where('dischargeDate', '>=', recentFrom).limit(MAX_PATIENT_DOCS).get(),
    colRef(paths.patients(orgId)).where('death.date', '>=', recentFrom).limit(MAX_PATIENT_DOCS).get(),
    count(colRef(paths.patients(orgId)).where('status', '==', 'referral')),
    colRef(paths.alerts(orgId)).where('createdAt', '>=', start).where('createdAt', '<', end).limit(MAX_DAY_DOCS).get(),
    Promise.all(
      VISIT_STATUSES.map((status) =>
        count(col('visits').where('status', '==', status).where('scheduledStart', '>=', start).where('scheduledStart', '<', end)),
      ),
    ),
    col('triageCalls').where('receivedAt', '>=', start).where('receivedAt', '<', end).limit(MAX_DAY_DOCS).get(),
    col('volunteerLogs').where('date', '>', addDays(date, -VOLUNTEER_WINDOW_DAYS)).where('date', '<=', date).limit(MAX_VOLUNTEER_LOGS).get(),
    count(col('volunteerAssignments').where('status', '==', 'active')),
    col('bereavementPlans').where('status', '==', 'active').limit(MAX_DAY_DOCS).get(),
  ]);

  const patients = new Map<string, MetricsPatient>();
  for (const snap of [admitted, discharged, deceased]) {
    for (const d of snap.docs) if (!patients.has(d.id)) patients.set(d.id, toMetricsPatient(d.data() as Patient, tz));
  }

  return {
    date,
    timeZone: tz,
    patients: [...patients.values()],
    referralCount,
    alerts: alerts.docs.map((d) => {
      const a = d.data() as Alert;
      return { createdAtMs: ms(a.createdAt) ?? startMs, ackedAtMs: ms(a.ackedAt), exhausted: a.exhausted === true };
    }),
    visits: Object.fromEntries(VISIT_STATUSES.map((s, i) => [s, visitCounts[i]!])) as Record<VisitStatus, number>,
    triageCalls: triage.docs.map((d) => {
      const c = d.data() as TriageCall;
      return { urgency: c.urgency, receivedAtMs: ms(c.receivedAt) ?? startMs, resolvedAtMs: ms(c.resolvedAt) };
    }),
    volunteerLogs: logs.docs.map((d) => {
      const l = d.data() as VolunteerLog;
      return { date: l.date, minutes: Number(l.minutes) || 0, voided: !!l.voidedAt };
    }),
    activeVolunteerAssignments: activeAssignments,
    bereavementPlans: plans.docs.map((d) => {
      const p = d.data() as BereavementPlan;
      return { status: p.status, contacts: (p.contacts ?? []).map((c) => ({ dueDate: c.dueDate, status: c.status })) };
    }),
  };
}
