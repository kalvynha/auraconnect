/**
 * Shared alert creation used by createAlert, onMessageCreated and
 * checkDeadlines. It only writes the alert doc (+ audit); the initial push
 * and first escalation check are done by `onAlertCreated`, so every alert
 * follows one code path no matter who created it.
 */
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { hasSteps, initialRecipients } from '../domain/escalation';
import { resolveOnCall } from '../scheduling/resolveOnCall';
import { writeAudit } from '../lib/audit';
import { colRef, db, docRef, getDocData, paths } from '../lib/db';
import type { AlertSource, EscalationPolicy, Org, Priority } from '../shared/types';

export interface RaiseAlertParams {
  orgId: string;
  /** Deterministic id for idempotency (e.g. `msg_{channel}_{message}`); random when omitted. */
  alertId?: string;
  title: string;
  body: string;
  priority: Priority;
  source: AlertSource;
  targetUids: readonly string[];
  /** A policy id, `'default'` for the org default, or null for no escalation. */
  policyId: string | 'default' | null;
  createdBy: string;
}

export interface RaiseAlertResult {
  alertId: string;
  created: boolean;
}

export async function resolvePolicy(
  orgId: string,
  policyId: string | 'default' | null,
): Promise<{ policyId: string | null; policy: EscalationPolicy | null }> {
  let pid = policyId;
  if (pid === 'default') {
    const org = await getDocData<Org>(paths.org(orgId));
    pid = org?.defaultEscalationPolicyId ?? null;
  }
  if (!pid) return { policyId: null, policy: null };
  const policy = await getDocData<EscalationPolicy>(paths.escalationPolicy(orgId, pid));
  return policy ? { policyId: pid, policy } : { policyId: null, policy: null };
}

export async function raiseAlert(params: RaiseAlertParams): Promise<RaiseAlertResult> {
  const { policyId, policy } = await resolvePolicy(params.orgId, params.policyId);
  // Level 0 = steps[0]: explicit targets plus step 0's target (usually 'original').
  const step0 = hasSteps(policy) ? policy.steps[0]!.target : null;
  const roleUids = step0?.kind === 'role' ? (await resolveOnCall(params.orgId, step0.roleKey)).uids : [];
  const targets = initialRecipients(params.targetUids, policy, () => roleUids);
  const ref = params.alertId ? docRef(paths.alert(params.orgId, params.alertId)) : colRef(paths.alerts(params.orgId)).doc();
  const now = FieldValue.serverTimestamp();
  const patientId =
    params.source.type === 'deadline' ? params.source.patientId : params.source.type === 'manual' ? params.source.patientId : null;

  const created = await db().runTransaction(async (tx) => {
    const existing = await tx.get(ref);
    if (existing.exists) return false;
    tx.create(ref, {
      title: params.title,
      body: params.body,
      priority: params.priority,
      source: params.source,
      targetUids: targets,
      currentTargetUids: targets,
      policyId,
      level: 0,
      exhausted: false,
      status: 'open',
      createdBy: params.createdBy,
      createdAt: now,
      ackedBy: null,
      ackedAt: null,
      // serverTimestamp() is not allowed inside arrays, so history uses a client Timestamp.
      history: [{ level: 0, targetUids: targets, at: Timestamp.now() }],
    });
    await writeAudit(
      params.orgId,
      {
        actorUid: params.createdBy,
        action: 'alert.create',
        resourceType: 'alert',
        resourceId: ref.id,
        patientId,
        metadata: { source: params.source.type, priority: params.priority, targets: targets.length },
      },
      tx,
    );
    return true;
  });
  return { alertId: ref.id, created };
}
