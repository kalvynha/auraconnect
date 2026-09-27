import { FieldValue } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { localDateParts } from '../domain/dates';
import { leadDaysResolver, MILESTONE_LABELS, reminderKey, unhandledDeadlines, upcomingDeadlines } from '../domain/milestones';
import { colRef, db, docRef, getMany, paths } from '../lib/db';
import { mapLimit } from '../lib/concurrency';
import { orgAdminUids } from '../lib/members';
import { raiseAlert, resolvePolicy } from '../alerts/raiseAlert';
import { LICENSED_DISCIPLINES, type Member, type Org, type Patient } from '../shared/types';

/** Local hour at which reminders are raised (DATA_MODEL: 07:00 org time). */
export const REMINDER_LOCAL_HOUR = 7;

/** Deterministic deadline alert id; pass `reminderKey(d)` (`{key}` or `{key}#overdue`). */
export function deadlineAlertId(patientId: string, key: string): string {
  return `dl_${patientId}_${key}`.replace(/[^A-Za-z0-9_-]/g, '_');
}

/** Patients processed in parallel per org (each raises its alerts, then records the keys). */
export const DEADLINE_CONCURRENCY = 8;

/**
 * Raises deadline alerts for one org's admitted patients as of `today` (org-local).
 *
 * S1/V1 reminder rules, per milestone key (completed keys are never alerted):
 *  - upcoming (due within the kind's lead days): one `normal` alert with no escalation
 *    (`policyId: null`), reminder key `{key}`, alert id `dl_{patient}_{key}`.
 *  - overdue (no look-back cap): one `urgent` alert on the org default escalation policy,
 *    reminder key `{key}#overdue`, alert id `dl_{patient}_{key}#overdue` (sanitized), raised
 *    even when the upcoming reminder was already sent. So each key alerts at most twice.
 * Recipients: active care-team members whose discipline is RN/NP/MD; when there are none,
 * the org's admins. Lead days: `deadlineLeadDaysByKind[kind]`, else the kind default
 * (NOE 3, recert 15, F2F 30, HOPE 2), else `deadlineLeadDays`.
 *
 * Reads are batched: care-team members are loaded once for all patients with due
 * deadlines, and the org's default escalation policy is resolved once per run.
 * Patients are processed with bounded concurrency; after a failure no new
 * patients are started and the error is rethrown (the run logs it per org).
 */
export async function checkOrgDeadlines(orgId: string, org: Org, today: string): Promise<number> {
  const patients = await colRef(paths.patients(orgId)).where('status', '==', 'admitted').get();
  const lead = leadDaysResolver(org);
  const work = patients.docs.flatMap((doc) => {
    const p = doc.data() as Patient;
    if (!p.milestones) return [];
    const due = unhandledDeadlines(upcomingDeadlines(p.milestones, today, lead), p.remindedMilestones, p.milestoneCompletions);
    return due.length === 0 ? [] : [{ id: doc.id, p, due }];
  });
  if (work.length === 0) return 0;

  const members = await getMany<Member>(work.flatMap(({ p }) => (p.careTeamUids ?? []).map((u) => paths.member(orgId, u))));
  const licensedCareTeam = (uids: readonly string[]): string[] => {
    const out = new Set<string>();
    for (const u of new Set(uids)) {
      const m = members.get(paths.member(orgId, u));
      if (m?.active && LICENSED_DISCIPLINES.includes(m.discipline)) out.add(m.uid);
    }
    return [...out];
  };
  const escalating = work.some(({ due }) => due.some((d) => d.overdue)) ? await resolvePolicy(orgId, 'default') : null;
  const noEscalation = { policyId: null, policy: null };
  let admins: Promise<string[]> | null = null;

  const raisedPerPatient = await mapLimit(work, DEADLINE_CONCURRENCY, async ({ id, p, due }) => {
    let targets = licensedCareTeam(p.careTeamUids ?? []);
    if (targets.length === 0) targets = await (admins ??= orgAdminUids(orgId));
    if (targets.length === 0) {
      logger.warn('no recipients for deadline alert', { orgId, patientId: id });
      return 0;
    }
    for (const d of due) {
      const label = MILESTONE_LABELS[d.kind];
      await raiseAlert({
        orgId,
        alertId: deadlineAlertId(id, reminderKey(d)),
        title: d.overdue ? `${label} overdue (due ${d.dueDate})` : `${label} due ${d.dueDate}`,
        body: `${p.lastName}, ${p.firstName}`,
        priority: d.overdue ? 'urgent' : 'normal',
        source: { type: 'deadline', patientId: id, milestone: d.kind, dueDate: d.dueDate },
        targetUids: targets,
        policyId: d.overdue ? 'default' : null,
        createdBy: 'system',
        resolved: d.overdue ? escalating! : noEscalation,
      });
    }
    await docRef(paths.patient(orgId, id)).update({ remindedMilestones: FieldValue.arrayUnion(...due.map(reminderKey)) });
    return due.length;
  });
  return raisedPerPatient.reduce((a, b) => a + b, 0);
}

/**
 * Runs hourly and processes each org whose local time is in the 07:00 hour,
 * so every org is checked once a day at 07:00 in its own time zone.
 * Set `force` to process every org regardless of local hour.
 */
export async function runDeadlineChecks(now: Date, opts: { force?: boolean } = {}): Promise<{ orgs: number; alerts: number }> {
  const orgs = await db().collection('orgs').get();
  let processed = 0;
  let alerts = 0;
  for (const doc of orgs.docs) {
    const org = doc.data() as Org;
    const local = localDateParts(now, org.timezone);
    if (!opts.force && local.hour !== REMINDER_LOCAL_HOUR) continue;
    try {
      alerts += await checkOrgDeadlines(doc.id, org, local.date);
      processed++;
    } catch (e) {
      logger.error('deadline check failed for org', { orgId: doc.id, error: (e as Error).message });
    }
  }
  return { orgs: processed, alerts };
}

export const checkDeadlines = onSchedule({ schedule: '0 * * * *', timeZone: 'UTC', retryCount: 1 }, async () => {
  const res = await runDeadlineChecks(new Date());
  logger.info('deadline check complete', res);
});
