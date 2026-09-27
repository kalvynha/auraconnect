/**
 * After-hours triage: `logTriageCall`, `assignTriageCall`, `resolveTriageCall`.
 *
 * Routing: an explicit `assignedUid` wins; otherwise whoever is on call now for
 * `roleKey` (or `org.triageRoleKey`). Urgent/emergent calls raise an alert
 * (source `triage`, priority urgent/critical) with the org's default escalation
 * policy. The push is PHI-free (generic alert title); details stay in Firestore.
 */
import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { truncateText } from '../domain/channels';
import { raiseAlert } from '../alerts/raiseAlert';
import { writeAudit } from '../lib/audit';
import { carePaths, orgSettings, patientDisplayName, requireOrgDoc, txCreateTask } from '../lib/care';
import { CLINICAL_ROLES, parse, requireOrg } from '../lib/context';
import { colRef, db, docRef, getDocData, paths } from '../lib/db';
import { assertActiveMembers, orgAdminUids } from '../lib/members';
import { id, isoDate } from '../lib/schemas';
import { resolveOnCall } from '../scheduling/resolveOnCall';
import type {
  Alert,
  AssignTriageCallRequest,
  LogTriageCallRequest,
  LogTriageCallResponse,
  Patient,
  Priority,
  ResolveTriageCallRequest,
  TriageCall,
  TriageUrgency,
} from '../shared/types';

export const TRIAGE_ALERT_PRIORITY: Record<TriageUrgency, Priority | null> = {
  routine: null,
  urgent: 'urgent',
  emergent: 'critical',
};

export function triageAlertId(callId: string): string {
  return `triage_${callId}`.replace(/[^A-Za-z0-9_-]/g, '_');
}

const text = (max: number) => z.string().trim().min(1).max(max);
const logSchema = z.object({
  orgId: id,
  patientId: id.optional(),
  callerName: text(200),
  callerRelationship: text(100).optional(),
  callerPhone: text(40).optional(),
  reason: text(2000),
  symptoms: z.array(text(200)).max(30).default([]),
  urgency: z.enum(['routine', 'urgent', 'emergent']),
  roleKey: id.optional(),
  assignedUid: id.optional(),
});
const assignSchema = z.object({ orgId: id, callId: id, assignedUid: id });
const resolveSchema = z.object({
  orgId: id,
  callId: id,
  disposition: z.enum(['advice_given', 'visit_scheduled', 'visit_made', 'md_contacted', 'ems_911', 'other']),
  dispositionNote: z.string().trim().max(4000).optional(),
  followUpTask: z.object({ title: text(200), assigneeUid: id.optional(), dueDate: isoDate.optional() }).optional(),
});

export async function logTriageCallHandler(request: CallableRequest<LogTriageCallRequest>): Promise<LogTriageCallResponse> {
  const input = parse(logSchema, request.data);
  const ctx = await requireOrg(request, input.orgId, CLINICAL_ROLES);
  const org = await requireOrgDoc(ctx.orgId);

  let patientName: string | null = null;
  if (input.patientId) {
    const p = await getDocData<Patient>(paths.patient(ctx.orgId, input.patientId));
    if (!p) throw new HttpsError('not-found', 'Patient not found.');
    patientName = patientDisplayName(p);
  }

  // Routing: explicit assignee, else the on-call person(s) for the role.
  const roleKey = input.roleKey ?? orgSettings(org).triageRoleKey ?? null;
  let onDuty: string[] = [];
  let assignedUid: string | null = null;
  if (input.assignedUid) {
    await assertActiveMembers(ctx.orgId, [input.assignedUid]);
    assignedUid = input.assignedUid;
    onDuty = [input.assignedUid];
  } else if (roleKey) {
    const res = await resolveOnCall(ctx.orgId, roleKey);
    if (!res.role && input.roleKey) throw new HttpsError('not-found', `On-call role "${input.roleKey}" not found.`);
    onDuty = res.uids;
    assignedUid = res.uids[0] ?? null;
  }

  const ref = colRef(carePaths.triageCalls(ctx.orgId)).doc();
  const batch = db().batch();
  batch.set(ref, {
    patientId: input.patientId ?? null,
    patientName,
    callerName: input.callerName,
    callerRelationship: input.callerRelationship ?? null,
    callerPhone: input.callerPhone ?? null,
    reason: input.reason,
    symptoms: input.symptoms,
    urgency: input.urgency,
    status: 'open',
    assignedUid,
    roleKey,
    alertId: null,
    disposition: null,
    dispositionNote: null,
    receivedAt: FieldValue.serverTimestamp(),
    receivedBy: ctx.uid,
    resolvedAt: null,
    resolvedBy: null,
  });
  await writeAudit(
    ctx.orgId,
    {
      actorUid: ctx.uid,
      action: 'triage.log',
      resourceType: 'triageCall',
      resourceId: ref.id,
      patientId: input.patientId ?? null,
      metadata: { urgency: input.urgency, roleKey, assigned: assignedUid !== null },
    },
    batch,
  );
  await batch.commit();

  let alertId: string | null = null;
  const priority = TRIAGE_ALERT_PRIORITY[input.urgency];
  if (priority) {
    let targets = onDuty;
    if (targets.length === 0) targets = await orgAdminUids(ctx.orgId);
    const res = await raiseAlert({
      orgId: ctx.orgId,
      alertId: triageAlertId(ref.id),
      title: input.urgency === 'emergent' ? 'Emergent triage call' : 'Urgent triage call',
      // Firestore only (alert readers are its recipients); pushes carry a generic title.
      body: truncateText(`${patientName ?? input.callerName}: ${input.reason}`, 280),
      priority,
      source: { type: 'triage', callId: ref.id, patientId: input.patientId ?? null },
      targetUids: targets,
      policyId: 'default',
      createdBy: ctx.uid,
    });
    alertId = res.alertId;
    await ref.update({ alertId });
  }
  return { callId: ref.id, assignedUid, alertId };
}

export async function assignTriageCallHandler(request: CallableRequest<AssignTriageCallRequest>): Promise<Record<string, never>> {
  const input = parse(assignSchema, request.data);
  const ctx = await requireOrg(request, input.orgId, CLINICAL_ROLES);
  await assertActiveMembers(ctx.orgId, [input.assignedUid]);
  const ref = docRef(carePaths.triageCall(ctx.orgId, input.callId));
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Triage call not found.');
    const call = snap.data() as TriageCall;
    const alertRef = call.alertId ? docRef(paths.alert(ctx.orgId, call.alertId)) : null;
    const alertSnap = alertRef ? await tx.get(alertRef) : null;
    if (call.status !== 'open') throw new HttpsError('failed-precondition', 'The triage call is resolved.');
    if (call.assignedUid === input.assignedUid) return;
    tx.update(ref, { assignedUid: input.assignedUid });
    // Let the new assignee see (and ack/resolve) the linked alert.
    if (alertRef && alertSnap?.exists && (alertSnap.data() as Alert).status !== 'resolved') {
      tx.update(alertRef, { targetUids: FieldValue.arrayUnion(input.assignedUid) });
    }
    await writeAudit(
      ctx.orgId,
      { actorUid: ctx.uid, action: 'triage.assign', resourceType: 'triageCall', resourceId: input.callId, patientId: call.patientId, metadata: { from: call.assignedUid } },
      tx,
    );
  });
  return {};
}

export async function resolveTriageCallHandler(request: CallableRequest<ResolveTriageCallRequest>): Promise<Record<string, never>> {
  const input = parse(resolveSchema, request.data);
  const ctx = await requireOrg(request, input.orgId, CLINICAL_ROLES);
  if (input.followUpTask?.assigneeUid) await assertActiveMembers(ctx.orgId, [input.followUpTask.assigneeUid]);
  const ref = docRef(carePaths.triageCall(ctx.orgId, input.callId));
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Triage call not found.');
    const call = snap.data() as TriageCall;
    const alertRef = call.alertId ? docRef(paths.alert(ctx.orgId, call.alertId)) : null;
    const alertSnap = alertRef ? await tx.get(alertRef) : null;
    if (call.status !== 'open') throw new HttpsError('failed-precondition', 'The triage call is already resolved.');

    const now = FieldValue.serverTimestamp();
    tx.update(ref, {
      status: 'resolved',
      disposition: input.disposition,
      dispositionNote: input.dispositionNote ?? null,
      resolvedAt: now,
      resolvedBy: ctx.uid,
    });
    if (alertRef && alertSnap?.exists) {
      const alert = alertSnap.data() as Alert;
      if (alert.status !== 'resolved') {
        tx.update(alertRef, { status: 'resolved', ...(alert.ackedBy ? {} : { ackedBy: ctx.uid, ackedAt: now }) });
        await writeAudit(
          ctx.orgId,
          { actorUid: ctx.uid, action: 'alert.resolve', resourceType: 'alert', resourceId: alertRef.id, patientId: call.patientId, metadata: { level: alert.level, via: 'triage' } },
          tx,
        );
      }
    }
    let taskId: string | null = null;
    if (input.followUpTask) {
      taskId = txCreateTask(tx, ctx.orgId, {
        title: input.followUpTask.title,
        description: null,
        patientId: call.patientId,
        patientName: call.patientName,
        assigneeUid: input.followUpTask.assigneeUid ?? call.assignedUid ?? null,
        discipline: null,
        dueDate: input.followUpTask.dueDate ?? null,
        priority: 'normal',
        source: { type: 'triage', callId: input.callId },
        createdBy: ctx.uid,
      });
      await writeAudit(
        ctx.orgId,
        { actorUid: ctx.uid, action: 'task.create', resourceType: 'task', resourceId: taskId, patientId: call.patientId, metadata: { source: 'triage' } },
        tx,
      );
    }
    await writeAudit(
      ctx.orgId,
      {
        actorUid: ctx.uid,
        action: 'triage.resolve',
        resourceType: 'triageCall',
        resourceId: input.callId,
        patientId: call.patientId,
        metadata: { disposition: input.disposition, followUpTaskId: taskId },
      },
      tx,
    );
  });
  return {};
}

export const logTriageCall = onCall(logTriageCallHandler);
export const assignTriageCall = onCall(assignTriageCallHandler);
export const resolveTriageCall = onCall(resolveTriageCallHandler);
