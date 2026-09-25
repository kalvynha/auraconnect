import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';
import { z } from 'zod';
import { decideEscalation, nextStep, type EscalationDecision } from '../domain/escalation';
import { writeAudit } from '../lib/audit';
import { db, docRef, getDocData, paths } from '../lib/db';
import { pushToMembers } from '../lib/notify';
import { enqueueEscalationCheck, type EscalationTaskPayload } from '../lib/tasks';
import { resolveOnCall } from '../scheduling/resolveOnCall';
import type { Alert, EscalationPolicy } from '../shared/types';
import { alertNotificationTitle, alertPushData } from './onAlertCreated';

const payloadSchema = z.object({
  orgId: z.string().min(1),
  alertId: z.string().min(1),
  expectedLevel: z.number().int().min(0),
});

/**
 * Escalation check (see domain/escalation.ts for the level semantics).
 * Idempotent: a check whose `expectedLevel` no longer matches the alert, or
 * for an alert that is not open, does nothing.
 */
export async function handleEscalation(payload: EscalationTaskPayload): Promise<EscalationDecision> {
  const { orgId, alertId, expectedLevel } = payload;
  const ref = docRef(paths.alert(orgId, alertId));
  const pre = await getDocData<Alert>(paths.alert(orgId, alertId));
  if (!pre) return { action: 'noop', reason: 'not_open' };
  const policy = pre.policyId ? await getDocData<EscalationPolicy>(paths.escalationPolicy(orgId, pre.policyId)) : null;

  // Resolve a role target outside the transaction (it needs queries).
  const step = nextStep(policy, expectedLevel);
  let roleUids: string[] = [];
  if (pre.status === 'open' && step?.step.target.kind === 'role') {
    roleUids = (await resolveOnCall(orgId, step.step.target.roleKey)).uids;
  }

  const decision = await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { action: 'noop', reason: 'not_open' } as EscalationDecision;
    const alert = snap.data() as Alert;
    const d = decideEscalation(alert, policy, expectedLevel, { resolveRole: () => roleUids });
    if (d.action === 'noop') return d;
    if (d.action === 'exhaust') {
      tx.update(ref, { exhausted: true });
    } else {
      tx.update(ref, {
        level: d.level,
        currentTargetUids: d.currentTargetUids,
        targetUids: d.targetUids,
        history: FieldValue.arrayUnion({ level: d.level, targetUids: d.currentTargetUids, at: Timestamp.now() }),
      });
    }
    await writeAudit(
      orgId,
      {
        actorUid: 'system',
        action: 'alert.escalate',
        resourceType: 'alert',
        resourceId: alertId,
        patientId: alert.source.type === 'message' ? null : alert.source.patientId,
        metadata: d.action === 'exhaust' ? { level: d.level, exhausted: true } : { level: d.level, targets: d.currentTargetUids.length },
      },
      tx,
    );
    return d;
  });

  if (decision.action === 'advance') {
    await pushToMembers(orgId, decision.currentTargetUids, alertNotificationTitle(pre), alertPushData(orgId, alertId, pre));
    await enqueueEscalationCheck({ orgId, alertId, expectedLevel: decision.level }, decision.nextCheckMinutes * 60);
  } else if (decision.action === 'noop') {
    logger.info('escalation check skipped', { orgId, alertId, expectedLevel, reason: decision.reason });
  }
  return decision;
}

export const escalateAlert = onTaskDispatched(
  {
    retryConfig: { maxAttempts: 5, minBackoffSeconds: 30 },
    rateLimits: { maxConcurrentDispatches: 50 },
  },
  async (req) => {
    const parsed = payloadSchema.safeParse(req.data);
    if (!parsed.success) {
      logger.error('invalid escalation payload');
      return;
    }
    await handleEscalation(parsed.data);
  },
);
