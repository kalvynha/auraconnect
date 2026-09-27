/**
 * `closeExpiredBereavementPlans` (daily): for each org, active plans whose `closesOn` is
 * before the org-local today are closed when every contact is done or skipped; otherwise
 * they are flagged `needsReview` (once) so the coordinator finishes or skips what is left.
 * Reads: the org list plus only the expired active plans (index bereavementPlans
 * (status, closesOn)). Every write is audited as `system`.
 */
import { FieldValue, type QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { todayInTimeZone } from '../domain/dates';
import { autoCloseDecision } from '../domain/bereavement';
import { writeAudit } from '../lib/audit';
import { carePaths } from '../lib/care';
import { colRef, db } from '../lib/db';
import type { BereavementPlan, Org } from '../shared/types';

const PAGE = 300;
/** Safety cap per org per run; the rest is picked up the next day. */
const MAX_PER_ORG = 3000;

export async function closeExpiredPlansForOrg(orgId: string, today: string): Promise<{ closed: number; flagged: number }> {
  let closed = 0;
  let flagged = 0;
  let scanned = 0;
  const base = colRef(carePaths.bereavementPlans(orgId)).where('status', '==', 'active').where('closesOn', '<', today).orderBy('closesOn');
  let last: QueryDocumentSnapshot | null = null;
  for (;;) {
    const snap = await (last ? base.startAfter(last) : base).limit(PAGE).get();
    for (const d of snap.docs) {
      const res = await db().runTransaction(async (tx) => {
        const fresh = await tx.get(d.ref);
        if (!fresh.exists) return 'none' as const;
        const plan = fresh.data() as BereavementPlan;
        const decision = autoCloseDecision(plan, today);
        if (decision === 'close') {
          tx.update(d.ref, {
            status: 'closed',
            needsReview: false,
            closedAt: FieldValue.serverTimestamp(),
            closedBy: 'system',
            updatedAt: FieldValue.serverTimestamp(),
          });
          await writeAudit(orgId, { actorUid: 'system', action: 'bereavement.close', resourceType: 'bereavementPlan', resourceId: d.id, patientId: plan.patientId, metadata: { auto: true } }, tx);
        } else if (decision === 'review' && plan.needsReview !== true) {
          tx.update(d.ref, { needsReview: true, updatedAt: FieldValue.serverTimestamp() });
          const pending = (plan.contacts ?? []).filter((c) => c.status === 'pending').length;
          await writeAudit(orgId, { actorUid: 'system', action: 'bereavement.update', resourceType: 'bereavementPlan', resourceId: d.id, patientId: plan.patientId, metadata: { needsReview: true, pendingContacts: pending } }, tx);
        } else {
          return 'none' as const;
        }
        return decision;
      });
      if (res === 'close') closed++;
      if (res === 'review') flagged++;
    }
    scanned += snap.docs.length;
    if (snap.docs.length < PAGE || scanned >= MAX_PER_ORG) break;
    last = snap.docs[snap.docs.length - 1]!;
  }
  return { closed, flagged };
}

export async function runCloseExpiredBereavementPlans(now: Date): Promise<{ orgs: number; closed: number; flagged: number; failed: number }> {
  const orgs = await db().collection('orgs').get();
  const out = { orgs: 0, closed: 0, flagged: 0, failed: 0 };
  for (const doc of orgs.docs) {
    const org = doc.data() as Org;
    try {
      const r = await closeExpiredPlansForOrg(doc.id, todayInTimeZone(now, org.timezone || 'UTC'));
      out.orgs++;
      out.closed += r.closed;
      out.flagged += r.flagged;
    } catch (e) {
      out.failed++;
      logger.error('bereavement auto-close failed for org', { orgId: doc.id, code: (e as { code?: unknown })?.code ?? (e as Error)?.name ?? 'unknown' });
    }
  }
  return out;
}

export const closeExpiredBereavementPlans = onSchedule(
  { schedule: '30 6 * * *', timeZone: 'UTC', timeoutSeconds: 540, retryCount: 1 },
  async () => {
    const res = await runCloseExpiredBereavementPlans(new Date());
    logger.info('bereavement auto-close complete', res);
  },
);
