import { FieldValue } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { localDateParts } from '../domain/dates';
import { MILESTONE_LABELS, unhandledDeadlines, upcomingDeadlines } from '../domain/milestones';
import { colRef, db, docRef, getMany, paths } from '../lib/db';
import { mapLimit } from '../lib/concurrency';
import { orgAdminUids } from '../lib/members';
import { raiseAlert, resolvePolicy } from '../alerts/raiseAlert';
import type { Member, Org, Patient } from '../shared/types';

/** Local hour at which reminders are raised (DATA_MODEL: 07:00 org time). */
export const REMINDER_LOCAL_HOUR = 7;

export function deadlineAlertId(patientId: string, key: string): string {
  return `dl_${patientId}_${key}`.replace(/[^A-Za-z0-9_-]/g, '_');
}

/** Patients processed in parallel per org (each raises its alerts, then records the keys). */
export const DEADLINE_CONCURRENCY = 8;

/**
 * Raises deadline alerts for one org's admitted patients as of `today` (org-local).
 * Keys already in `remindedMilestones` or `milestoneCompletions` are skipped; new keys are recorded.
 * Care team → alert targets; an empty/inactive care team falls back to org admins.
 *
 * Reads are batched: care-team members are loaded once for all patients with due
 * deadlines, and the org's default escalation policy is resolved once per run.
 * Patients are processed with bounded concurrency; after a failure no new
 * patients are started and the error is rethrown (the run logs it per org).
 */
export async function checkOrgDeadlines(orgId: string, org: Org, today: string): Promise<number> {
  const patients = await colRef(paths.patients(orgId)).where('status', '==', 'admitted').get();
  const work = patients.docs.flatMap((doc) => {
    const p = doc.data() as Patient;
    if (!p.milestones) return [];
    const due = unhandledDeadlines(upcomingDeadlines(p.milestones, today, org.deadlineLeadDays ?? 3), p.remindedMilestones, p.milestoneCompletions);
    return due.length === 0 ? [] : [{ id: doc.id, p, due }];
  });
  if (work.length === 0) return 0;

  const members = await getMany<Member>(work.flatMap(({ p }) => (p.careTeamUids ?? []).map((u) => paths.member(orgId, u))));
  const activeCareTeam = (uids: readonly string[]): string[] => {
    const out = new Set<string>();
    for (const u of new Set(uids)) {
      const m = members.get(paths.member(orgId, u));
      if (m?.active) out.add(m.uid);
    }
    return [...out];
  };
  const resolved = await resolvePolicy(orgId, 'default');
  let admins: Promise<string[]> | null = null;

  const raisedPerPatient = await mapLimit(work, DEADLINE_CONCURRENCY, async ({ id, p, due }) => {
    let targets = activeCareTeam(p.careTeamUids ?? []);
    if (targets.length === 0) targets = await (admins ??= orgAdminUids(orgId));
    if (targets.length === 0) {
      logger.warn('no recipients for deadline alert', { orgId, patientId: id });
      return 0;
    }
    for (const d of due) {
      const label = MILESTONE_LABELS[d.kind];
      await raiseAlert({
        orgId,
        alertId: deadlineAlertId(id, d.key),
        title: d.overdue ? `${label} overdue (due ${d.dueDate})` : `${label} due ${d.dueDate}`,
        body: `${p.lastName}, ${p.firstName}`,
        priority: d.overdue ? 'urgent' : 'normal',
        source: { type: 'deadline', patientId: id, milestone: d.kind, dueDate: d.dueDate },
        targetUids: targets,
        policyId: 'default',
        createdBy: 'system',
        resolved,
      });
    }
    await docRef(paths.patient(orgId, id)).update({ remindedMilestones: FieldValue.arrayUnion(...due.map((d) => d.key)) });
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
