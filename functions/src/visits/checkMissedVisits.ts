/**
 * `checkMissedVisits` (every 30 minutes): marks scheduled visits `missed` once
 * `scheduledEnd` is more than `org.missedVisitGraceMinutes` in the past and
 * raises a normal-priority `visit_missed` alert to the assignee (or the care
 * team) and the org's admins. The patient's name is only in the alert body in
 * Firestore; pushes use the generic alert title.
 */
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { normalizeUids } from '../domain/channels';
import { missedCutoffMs, selectMissedVisits } from '../domain/visits';
import { raiseAlert } from '../alerts/raiseAlert';
import { writeAudit } from '../lib/audit';
import { mapLimit } from '../lib/concurrency';
import { carePaths, orgSettings, tsMillis } from '../lib/care';
import { colRef, db, docRef, getDocData, paths } from '../lib/db';
import { loadActiveMembers, orgAdminUids } from '../lib/members';
import type { Org, Patient, Visit } from '../shared/types';

/** Max visits handled per org per run; the rest are picked up next run. */
export const MISSED_VISIT_BATCH = 200;
/** Visits marked missed in parallel (each is its own small transaction + alert). */
export const MISSED_VISIT_CONCURRENCY = 10;

export function missedVisitAlertId(visitId: string): string {
  return `vm_${visitId}`.replace(/[^A-Za-z0-9_-]/g, '_');
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
  const grace = orgSettings(org).missedVisitGraceMinutes;
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
    if (!visit) return 0;
    let primary: string[] = [];
    if (visit.assignedUid) primary = [...(await loadActiveMembers(orgId, [visit.assignedUid])).keys()];
    if (primary.length === 0) {
      const patient = await getDocData<Patient>(paths.patient(orgId, visit.patientId));
      primary = [...(await loadActiveMembers(orgId, patient?.careTeamUids ?? [])).keys()];
    }
    const targets = normalizeUids([...primary, ...(await (admins ??= orgAdminUids(orgId)))]);
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

export async function runMissedVisitChecks(now: Date): Promise<{ orgs: number; alerts: number }> {
  const orgs = await db().collection('orgs').get();
  let processed = 0;
  let alerts = 0;
  for (const doc of orgs.docs) {
    try {
      alerts += await checkOrgMissedVisits(doc.id, doc.data() as Org, now);
      processed++;
    } catch (e) {
      logger.error('missed-visit check failed for org', { orgId: doc.id, error: (e as Error).message });
    }
  }
  return { orgs: processed, alerts };
}

export const checkMissedVisits = onSchedule({ schedule: 'every 30 minutes', timeZone: 'UTC', retryCount: 1 }, async () => {
  const res = await runMissedVisitChecks(new Date());
  logger.info('missed-visit check complete', res);
});
