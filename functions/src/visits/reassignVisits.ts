/**
 * `reassignVisits` (V3): bulk-moves up to 200 scheduled visits to one member (sick calls).
 * Admins and `scheduling` or `staffing` holders. Visits are updated in transactions of
 * `REASSIGN_TX_CHUNK`; each change is audited. The new assignee gets one PHI-free push.
 */
import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { writeAudit } from '../lib/audit';
import { carePaths } from '../lib/care';
import { parse, requireOrg } from '../lib/context';
import { db, docRef } from '../lib/db';
import { assertActiveMembers } from '../lib/members';
import { pushToMembers } from '../lib/notify';
import { memberHasCapability } from '../lib/permissions';
import { id } from '../lib/schemas';
import type { ReassignVisitsRequest, ReassignVisitsResponse, Visit } from '../shared/types';

export const MAX_REASSIGN_VISITS = 200;
/** Visits per transaction (each: 1 read, 1 update, 1 audit). */
export const REASSIGN_TX_CHUNK = 50;

const schema = z.object({
  orgId: id,
  visitIds: z.array(id).min(1).max(MAX_REASSIGN_VISITS),
  assignedUid: id,
  /** Staffing reason (e.g. "sick call"), kept in the audit log; the UI asks for no patient details. */
  reason: z.string().trim().min(1).max(200),
});

export async function reassignVisitsHandler(request: CallableRequest<ReassignVisitsRequest>): Promise<ReassignVisitsResponse> {
  const input = parse(schema, request.data);
  const ctx = await requireOrg(request, input.orgId);
  if (!memberHasCapability(ctx.member, 'scheduling') && !memberHasCapability(ctx.member, 'staffing')) {
    throw new HttpsError('permission-denied', 'This action needs the "scheduling" or "staffing" permission.');
  }
  await assertActiveMembers(ctx.orgId, [input.assignedUid]);
  const ids = [...new Set(input.visitIds)];
  const skipped: ReassignVisitsResponse['skipped'] = [];
  let reassigned = 0;

  for (let i = 0; i < ids.length; i += REASSIGN_TX_CHUNK) {
    const chunk = ids.slice(i, i + REASSIGN_TX_CHUNK);
    const res = await db().runTransaction(async (tx) => {
      const refs = chunk.map((v) => docRef(carePaths.visit(ctx.orgId, v)));
      const snaps = await tx.getAll(...refs);
      const skip: ReassignVisitsResponse['skipped'] = [];
      let n = 0;
      for (const snap of snaps) {
        if (!snap.exists) {
          skip.push({ visitId: snap.id, reason: 'not_found' });
          continue;
        }
        const v = snap.data() as Visit;
        if (v.status !== 'scheduled') {
          skip.push({ visitId: snap.id, reason: `status_${v.status}` });
          continue;
        }
        if (v.assignedUid === input.assignedUid) {
          skip.push({ visitId: snap.id, reason: 'already_assigned' });
          continue;
        }
        tx.update(snap.ref, { assignedUid: input.assignedUid, updatedAt: FieldValue.serverTimestamp() });
        await writeAudit(
          ctx.orgId,
          {
            actorUid: ctx.uid,
            action: 'visit.reassign',
            resourceType: 'visit',
            resourceId: snap.id,
            patientId: v.patientId,
            metadata: { from: v.assignedUid ?? null, to: input.assignedUid, bulk: ids.length > 1, reason: input.reason },
          },
          tx,
        );
        n++;
      }
      return { n, skip };
    });
    reassigned += res.n;
    skipped.push(...res.skip);
  }

  if (reassigned > 0 && input.assignedUid !== ctx.uid) {
    await pushToMembers(ctx.orgId, [input.assignedUid], reassigned === 1 ? 'A visit was assigned to you' : `${reassigned} visits were assigned to you`, {
      type: 'alert',
      orgId: ctx.orgId,
      priority: 'normal',
    });
  }
  return { reassigned, skipped };
}

export const reassignVisits = onCall({ timeoutSeconds: 120 }, reassignVisitsHandler);
