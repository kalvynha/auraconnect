/**
 * `checkMissedVisits` (every 30 minutes): marks scheduled visits `missed` once
 * `scheduledEnd` is more than `org.missedVisitGraceMinutes` in the past.
 *
 * v3 (V1) alerting follows `org.missedVisitAlertMode` (default `assignee`):
 *  - per-visit `visit_missed` alert (normal priority, id `vm_{visitId}`) to the assignee, or to
 *    the care-team RN when unassigned (`assignee_admins` adds the admins; `digest`/`off` skip it);
 *  - once a day at 07:00 org-local time, a PHI-free "missed visits digest" (id `vmd_{date}`) to
 *    admins and `scheduling` holders, counting visits missed in the previous 24 hours
 *    (every mode except `off`).
 * The patient's name is only in the per-visit alert body in Firestore; pushes use the
 * generic alert title. Completing or rescheduling a missed visit resolves its `vm_` alert.
 */
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { localDateParts } from '../domain/dates';
import { digestEnabled, missedCutoffMs, missedVisitRecipients, selectMissedVisits } from '../domain/visits';
import { raiseAlert } from '../alerts/raiseAlert';
import { writeAudit } from '../lib/audit';
import { mapLimit } from '../lib/concurrency';
import { carePaths, orgSettings, tsMillis } from '../lib/care';
import { colRef, db, docRef, getDocData, paths } from '../lib/db';
import { loadActiveMembers, orgAdminUids } from '../lib/members';
import type { Member, Org, Patient, Visit } from '../shared/types';

/** Max visits handled per org per run; the rest are picked up next run. */
export const MISSED_VISIT_BATCH = 200;
/** Visits marked missed in parallel (each is its own small transaction + alert). */
export const MISSED_VISIT_CONCURRENCY = 10;
/** Local hour of the daily digest (same as deadline reminders). */
export const MISSED_DIGEST_LOCAL_HOUR = 7;
/** Most visits counted by one digest. */
export const MISSED_DIGEST_MAX = 1000;

export function missedVisitAlertId(visitId: string): string {
  return `vm_${visitId}`.replace(/[^A-Za-z0-9_-]/g, '_');
}

export function missedDigestAlertId(localDate: string): string {
  return `vmd_${localDate}`.replace(/[^A-Za-z0-9_-]/g, '_');
}

/** Marks one visit missed if it is still scheduled. Returns the visit when marked. */
async function markMissed(orgId: string, visitId: string): Promise<Visit | null> {
  const ref = docRef(carePaths.visit(orgId, visitId));
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const v = snap.data() as Visit;
    if (v.status !== 'scheduled') return null;
    tx.update(ref, { status: 'missed', updatedAt: FieldValue.serverTimestamp() });
    await writeAudit(
      orgId,
      { actorUid: 'system', action: 'visit.missed', resourceType: 'visit', resourceId: visitId, patientId: v.patientId, metadata: { discipline: v.discipline } },
      tx,
    );
    return v;
  });
}

export async function checkOrgMissedVisits(orgId: string, org: Partial<Org>, now: Date): Promise<number> {
  const settings = orgSettings(org);
  const grace = settings.missedVisitGraceMinutes;
  const mode = settings.missedVisitAlertMode;
  const nowMs = now.getTime();
  const snap = await colRef(carePaths.visits(orgId))
    .where('status', '==', 'scheduled')
    .where('scheduledEnd', '<', Timestamp.fromMillis(missedCutoffMs(nowMs, grace)))
    .orderBy('scheduledEnd', 'asc')
    .limit(MISSED_VISIT_BATCH)
    .get();
  const candidates = selectMissedVisits(
    snap.docs.map((d) => ({ id: d.id, status: String(d.get('status')), endMs: tsMillis(d.get('scheduledEnd')) })),
    nowMs,
    grace,
  );

  let admins: Promise<string[]> | null = null;
  const raisedPerVisit = await mapLimit(candidates, MISSED_VISIT_CONCURRENCY, async (c): Promise<number> => {
    const visit = await markMissed(orgId, c.id);
    if (!visit || mode === 'digest' || mode === 'off') return 0;
    const assignee = visit.assignedUid && (await loadActiveMembers(orgId, [visit.assignedUid])).has(visit.assignedUid) ? visit.assignedUid : null;
    let careTeam: Array<{ uid: string; discipline: string }> = [];
    if (!assignee) {
      const patient = await getDocData<Patient>(paths.patient(orgId, visit.patientId));
      const uids = patient?.careTeamUids ?? [];
      const active = await loadActiveMembers(orgId, uids);
      careTeam = uids.flatMap((u) => (active.has(u) ? [{ uid: u, discipline: active.get(u)!.discipline }] : []));
    }
    // Admins are only loaded when needed (assignee_admins, or nobody else to tell).
    const needAdmins = mode === 'assignee_admins' || (!assignee && careTeam.length === 0);
    const adminUids = needAdmins ? await (admins ??= orgAdminUids(orgId)) : [];
    const targets = missedVisitRecipients(mode, { assignee, careTeam, admins: adminUids });
    if (targets.length === 0) {
      logger.warn('no recipients for missed-visit alert', { orgId, visitId: c.id });
      return 0;
    }
    await raiseAlert({
      orgId,
      alertId: missedVisitAlertId(c.id),
      title: `Missed ${visit.discipline} visit`,
      body: visit.patientName,
      priority: 'normal',
      source: { type: 'visit_missed', visitId: c.id, patientId: visit.patientId },
      targetUids: targets,
      policyId: null,
      createdBy: 'system',
    });
    return 1;
  });
  return raisedPerVisit.reduce((a, b) => a + b, 0);
}

/** Admins plus active members holding the `scheduling` capability. */
export async function schedulerUids(orgId: string): Promise<string[]> {
  const [admins, sched] = await Promise.all([
    orgAdminUids(orgId, 50),
    colRef(paths.members(orgId)).where('capabilities', 'array-contains', 'scheduling').limit(100).get(),
  ]);
  const out = new Set(admins);
  for (const d of sched.docs) {
    const m = d.data() as Member;
    if (m.active) out.add(m.uid);
  }
  return [...out].sort();
}

/**
 * Raises the org's daily missed-visit digest when it is 07:xx local time and the mode allows it.
 * Idempotent per local date (deterministic alert id). Returns the number of missed visits
 * reported (0 when nothing was raised).
 */
export async function sendMissedVisitDigest(orgId: string, org: Partial<Org>, now: Date): Promise<number> {
  const settings = orgSettings(org);
  if (!digestEnabled(settings.missedVisitAlertMode)) return 0;
  const local = localDateParts(now, settings.timezone);
  if (local.hour !== MISSED_DIGEST_LOCAL_HOUR) return 0;
  const since = Timestamp.fromMillis(now.getTime() - 24 * 3_600_000);
  const missed = await colRef(carePaths.visits(orgId))
    .where('status', '==', 'missed')
    .where('scheduledEnd', '>=', since)
    .orderBy('scheduledEnd', 'asc')
    .limit(MISSED_DIGEST_MAX)
    .get();
  const count = missed.size;
  if (count === 0) return 0;
  const targets = await schedulerUids(orgId);
  if (targets.length === 0) {
    logger.warn('no recipients for missed-visit digest', { orgId });
    return 0;
  }
  const res = await raiseAlert({
    orgId,
    alertId: missedDigestAlertId(local.date),
    title: `Missed visits digest: ${count} in the last 24 hours`,
    body: `${count} visit${count === 1 ? '' : 's'} were marked missed in the last 24 hours. Open Visits to reschedule or document them.`,
    priority: 'normal',
    source: { type: 'visit_missed_digest', date: local.date, count, patientId: null },
    targetUids: targets,
    policyId: null,
    createdBy: 'system',
  });
  return res.created ? count : 0;
}

export async function runMissedVisitChecks(now: Date): Promise<{ orgs: number; alerts: number }> {
  const orgs = await db().collection('orgs').get();
  let processed = 0;
  let alerts = 0;
  let digests = 0;
  for (const doc of orgs.docs) {
    try {
      alerts += await checkOrgMissedVisits(doc.id, doc.data() as Org, now);
      if ((await sendMissedVisitDigest(doc.id, doc.data() as Org, now)) > 0) digests++;
      processed++;
    } catch (e) {
      logger.error('missed-visit check failed for org', { orgId: doc.id, error: (e as Error).message });
    }
  }
  if (digests > 0) logger.info('missed-visit digests raised', { digests });
  return { orgs: processed, alerts };
}

export const checkMissedVisits = onSchedule({ schedule: 'every 30 minutes', timeZone: 'UTC', retryCount: 1 }, async () => {
  const res = await runMissedVisitChecks(new Date());
  logger.info('missed-visit check complete', res);
});
