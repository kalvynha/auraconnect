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
  /**
   * `resolvePolicy(orgId, policyId)` already loaded by the caller. Jobs that raise many
   * alerts resolve it once per run instead of re-reading the org and policy per alert.
   */
  resolved?: ResolvedPolicy;
}

export interface ResolvedPolicy {
  policyId: string | null;
  policy: EscalationPolicy | null;
}

export interface RaiseAlertResult {
  alertId: string;
  created: boolean;
}

export async function resolvePolicy(orgId: string, policyId: string | 'default' | null): Promise<ResolvedPolicy> {
  let pid = policyId;
  if (pid === 'default') {
    const org = await getDocData<Org>(paths.org(orgId));
    pid = org?.defaultEscalationPolicyId ?? null;
  }
  if (!pid) return { policyId: null, policy: null };
  const policy = await getDocData<EscalationPolicy>(paths.escalationPolicy(orgId, pid));
  return policy ? { policyId: pid, policy } : { policyId: null, policy: null };
}

/** gRPC ALREADY_EXISTS (6), as reported by the Firestore server SDK for a failed `create`. */
export function isAlreadyExists(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return code === 6 || code === 'already-exists' || code === 'ALREADY_EXISTS';
}

export async function raiseAlert(params: RaiseAlertParams): Promise<RaiseAlertResult> {
  const { policyId, policy } = params.resolved ?? (await resolvePolicy(params.orgId, params.policyId));
  // Level 0 = steps[0]: explicit targets plus step 0's target (usually 'original').
  const step0 = hasSteps(policy) ? policy.steps[0]!.target : null;
  const roleUids = step0?.kind === 'role' ? (await resolveOnCall(params.orgId, step0.roleKey)).uids : [];
  const targets = initialRecipients(params.targetUids, policy, () => roleUids);
  const ref = params.alertId ? docRef(paths.alert(params.orgId, params.alertId)) : colRef(paths.alerts(params.orgId)).doc();
  const now = FieldValue.serverTimestamp();
  const patientId = 'patientId' in params.source ? params.source.patientId : null;

  // One atomic batch: `create` fails with ALREADY_EXISTS (and writes nothing, audit included) when the
  // deterministic id was already raised, so no transactional read (or lock) is needed for idempotency.
  const batch = db().batch();
  batch.create(ref, {
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
    batch,
  );
  let created = true;
  try {
    await batch.commit();
  } catch (e) {
    if (!isAlreadyExists(e)) throw e;
    created = false;
  }
  return { alertId: ref.id, created };
}
