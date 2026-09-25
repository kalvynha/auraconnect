import { FieldValue } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { localDateParts } from '../domain/dates';
import { MILESTONE_LABELS, upcomingDeadlines } from '../domain/milestones';
import { colRef, db, docRef, paths } from '../lib/db';
import { loadActiveMembers } from '../lib/members';
import { raiseAlert } from '../alerts/raiseAlert';
import type { Member, Org, Patient } from '../shared/types';

/** Local hour at which reminders are raised (DATA_MODEL: 07:00 org time). */
export const REMINDER_LOCAL_HOUR = 7;

export function deadlineAlertId(patientId: string, key: string): string {
  return `dl_${patientId}_${key}`.replace(/[^A-Za-z0-9_-]/g, '_');
}

async function orgAdmins(orgId: string): Promise<string[]> {
  const snap = await colRef(paths.members(orgId)).where('role', '==', 'admin').where('active', '==', true).limit(20).get();
  return snap.docs.map((d) => (d.data() as Member).uid);
}

/**
 * Raises deadline alerts for one org's admitted patients as of `today` (org-local).
 * Keys already in `remindedMilestones` are skipped; new keys are recorded.
 * Care team → alert targets; an empty/inactive care team falls back to org admins.
 */
export async function checkOrgDeadlines(orgId: string, org: Org, today: string): Promise<number> {
  const patients = await colRef(paths.patients(orgId)).where('status', '==', 'admitted').get();
  let raised = 0;
  let admins: string[] | null = null;
  for (const doc of patients.docs) {
    const p = doc.data() as Patient;
    if (!p.milestones) continue;
    const reminded = new Set(p.remindedMilestones ?? []);
    const due = upcomingDeadlines(p.milestones, today, org.deadlineLeadDays ?? 3).filter((d) => !reminded.has(d.key));
    if (due.length === 0) continue;

    let targets = [...(await loadActiveMembers(orgId, p.careTeamUids ?? [])).keys()];
    if (targets.length === 0) targets = admins ??= await orgAdmins(orgId);
    if (targets.length === 0) {
      logger.warn('no recipients for deadline alert', { orgId, patientId: doc.id });
      continue;
    }
    for (const d of due) {
      const label = MILESTONE_LABELS[d.kind];
      await raiseAlert({
        orgId,
        alertId: deadlineAlertId(doc.id, d.key),
        title: d.overdue ? `${label} overdue (due ${d.dueDate})` : `${label} due ${d.dueDate}`,
        body: `${p.lastName}, ${p.firstName}`,
        priority: d.overdue ? 'urgent' : 'normal',
        source: { type: 'deadline', patientId: doc.id, milestone: d.kind, dueDate: d.dueDate },
        targetUids: targets,
        policyId: 'default',
        createdBy: 'system',
      });
      raised++;
    }
    await docRef(paths.patient(orgId, doc.id)).update({ remindedMilestones: FieldValue.arrayUnion(...due.map((d) => d.key)) });
  }
  return raised;
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
