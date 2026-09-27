/**
 * O1: archives patient channels whose `archiveAfter` (set by `dischargePatient` / `recordDeath`,
 * now + 72 h) has passed. Runs hourly. A channel whose patient was re-admitted in the meantime is
 * kept open (its `archiveAfter` is cleared instead).
 */
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { writeAudit } from '../lib/audit';
import { colRef, db, docRef, paths } from '../lib/db';
import { tsMillis } from '../lib/care';
import type { Channel, Patient } from '../shared/types';

/** Channels archived per org per run (the rest are picked up next hour). */
export const ARCHIVE_BATCH_LIMIT = 200;

export async function archiveOrgEndedChannels(orgId: string, now: Date): Promise<number> {
  const due = await colRef(paths.channels(orgId)).where('archiveAfter', '<=', Timestamp.fromDate(now)).limit(ARCHIVE_BATCH_LIMIT).get();
  let archived = 0;
  for (const doc of due.docs) {
    const done = await db().runTransaction(async (tx) => {
      const snap = await tx.get(doc.ref);
      if (!snap.exists) return false;
      const ch = snap.data() as Channel;
      const at = tsMillis(ch.archiveAfter ?? null);
      if (!Number.isFinite(at) || at > now.getTime()) return false;
      const patientSnap = ch.patientId ? await tx.get(docRef(paths.patient(orgId, ch.patientId))) : null;
      const patient = patientSnap?.exists ? (patientSnap.data() as Patient) : null;
      if (ch.archived === true || patient?.status === 'admitted') {
        // Already archived, or re-admitted within the delay: just clear the marker.
        tx.update(doc.ref, { archiveAfter: FieldValue.delete() });
        return false;
      }
      tx.update(doc.ref, { archived: true, archiveAfter: FieldValue.delete() });
      await writeAudit(
        orgId,
        { actorUid: 'system', action: 'channel.archive', resourceType: 'channel', resourceId: doc.id, patientId: ch.patientId ?? null, metadata: { reason: patient?.status ?? 'ended' } },
        tx,
      );
      return true;
    });
    if (done) archived++;
  }
  return archived;
}

export async function runArchiveEndedChannels(now: Date): Promise<{ orgs: number; archived: number }> {
  const orgs = await db().collection('orgs').get();
  let archived = 0;
  for (const doc of orgs.docs) {
    try {
      archived += await archiveOrgEndedChannels(doc.id, now);
    } catch (e) {
      logger.error('archiveEndedChannels failed for org', { orgId: doc.id, error: (e as Error).message });
    }
  }
  return { orgs: orgs.size, archived };
}

export const archiveEndedChannels = onSchedule({ schedule: '15 * * * *', timeZone: 'UTC', retryCount: 1 }, async () => {
  const res = await runArchiveEndedChannels(new Date());
  logger.info('archiveEndedChannels complete', res);
});
