import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { writeAudit } from '../lib/audit';
import { parse, requireOrg } from '../lib/context';
import { db, docRef, paths } from '../lib/db';
import { id } from '../lib/schemas';
import type { Alert, AlertActionRequest } from '../shared/types';

const schema = z.object({ orgId: id, alertId: id });

function patientIdOf(alert: Alert): string | null {
  return alert.source.type === 'message' ? null : alert.source.patientId;
}

/**
 * `ack`: open → acked (stops escalation). Acking an already-acked alert is a no-op.
 * `resolve`: open|acked → resolved. Resolving twice is a no-op.
 * Only a uid in `targetUids`, or an admin, may act.
 */
export async function alertActionHandler(request: CallableRequest<AlertActionRequest>, action: 'ack' | 'resolve'): Promise<Record<string, never>> {
  const input = parse(schema, request.data);
  const ctx = requireOrg(request, input.orgId);
  const ref = docRef(paths.alert(ctx.orgId, input.alertId));

  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Alert not found.');
    const alert = snap.data() as Alert;
    if (ctx.role !== 'admin' && !alert.targetUids.includes(ctx.uid)) {
      throw new HttpsError('permission-denied', 'You are not a recipient of this alert.');
    }
    if (action === 'ack') {
      if (alert.status === 'acked') return;
      if (alert.status !== 'open') throw new HttpsError('failed-precondition', 'Alert is already resolved.');
      tx.update(ref, { status: 'acked', ackedBy: ctx.uid, ackedAt: FieldValue.serverTimestamp() });
    } else {
      if (alert.status === 'resolved') return;
      const update: Record<string, unknown> = { status: 'resolved' };
      if (!alert.ackedBy) {
        update.ackedBy = ctx.uid;
        update.ackedAt = FieldValue.serverTimestamp();
      }
      tx.update(ref, update);
    }
    await writeAudit(
      ctx.orgId,
      {
        actorUid: ctx.uid,
        action: action === 'ack' ? 'alert.ack' : 'alert.resolve',
        resourceType: 'alert',
        resourceId: input.alertId,
        patientId: patientIdOf(alert),
        metadata: { level: alert.level },
      },
      tx,
    );
  });
  return {};
}

export const ackAlert = onCall((req: CallableRequest<AlertActionRequest>) => alertActionHandler(req, 'ack'));
export const resolveAlert = onCall((req: CallableRequest<AlertActionRequest>) => alertActionHandler(req, 'resolve'));
