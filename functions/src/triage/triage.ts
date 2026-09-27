/**
 * After-hours triage: `logTriageCall`, `assignTriageCall`, `resolveTriageCall`.
 *
 * Routing: an explicit `assignedUid` wins; otherwise whoever is on call now for
 * `roleKey` (or `org.triageRoleKey`). Urgent/emergent calls raise an alert
 * (source `triage`, priority urgent/critical) with the org's default escalation
 * policy. The push is PHI-free (generic alert title); details stay in Firestore.
 *
 * v3 (O3, M3):
 *  - Routine calls with an assignee raise a `normal` alert to the assignee with no
 *    escalation (`policyId: null`), so the assignee is notified without paging.
 *  - `assignTriageCall` moves the linked alert's current recipients to the new
 *    assignee (raising a routine alert if the call had none) and pushes to them.
 *  - `resolveTriageCall` can create a PRN visit (assigned to the resolver by default).
 *  - Only the call's assignee, a recipient of its alert, or an admin may assign or
 *    resolve. An unassigned call with no alert can be picked up by any clinical member.
 */
import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { truncateText } from '../domain/channels';
import { raiseAlert } from '../alerts/raiseAlert';
import { alertNotificationTitle, alertPushData } from '../alerts/onAlertCreated';
import { pushToMembers } from '../lib/notify';
import { MAX_VISIT_MS } from '../visits/visits';
import { writeAudit } from '../lib/audit';
import { carePaths, instant, orgSettings, patientDisplayName, requireOrgDoc, tsMillis, txCreateTask } from '../lib/care';
import { CLINICAL_ROLES, parse, requireOrg, type OrgContext } from '../lib/context';
import { colRef, db, docRef, getDocData, paths } from '../lib/db';
import { assertActiveMembers, orgAdminUids } from '../lib/members';
import { id, isoDate } from '../lib/schemas';
import { resolveOnCall } from '../scheduling/resolveOnCall';
import type {
  Alert,
  AssignTriageCallRequest,
  Member,
  LogTriageCallRequest,
  LogTriageCallResponse,
  Patient,
  Priority,
  ResolveTriageCallRequest,
  TriageCall,
  TriageUrgency,
} from '../shared/types';

export interface ResolveTriageCallResponse {
  taskId: string | null;
  visitId: string | null;
}

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
  visit: z
    .object({ start: z.string().datetime({ offset: true }), end: z.string().datetime({ offset: true }), assignedUid: id.optional() })
    .optional(),
});

/** Title of the non-escalating alert for routine calls (PHI-free; the push uses a generic title). */
export const ROUTINE_TRIAGE_ALERT_TITLE = 'Triage call';

/**
 * M3: who may assign or resolve a call — its assignee, a recipient of its alert, or an admin.
 * A call with neither an assignee nor an alert is an open queue item any clinical member may pick up.
 */
export function canActOnTriageCall(ctx: Pick<OrgContext, 'uid' | 'role'>, call: Pick<TriageCall, 'assignedUid'>, alert: Pick<Alert, 'targetUids'> | null): boolean {
  if (ctx.role === 'admin') return true;
  if (call.assignedUid === ctx.uid) return true;
  if (alert && (alert.targetUids ?? []).includes(ctx.uid)) return true;
  return !call.assignedUid && !alert;
}

function assertCanActOnTriageCall(...args: Parameters<typeof canActOnTriageCall>): void {
  if (!canActOnTriageCall(...args)) {
    throw new HttpsError('permission-denied', 'Only the assigned clinician, an alert recipient or an admin can do this.');
  }
}

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
  if (!priority && assignedUid) {
    // O3: routine calls notify the assignee with a normal, non-escalating alert.
    const res = await raiseAlert({
      orgId: ctx.orgId,
      alertId: triageAlertId(ref.id),
      title: ROUTINE_TRIAGE_ALERT_TITLE,
      body: truncateText(`${patientName ?? input.callerName}: ${input.reason}`, 280),
      priority: 'normal',
      source: { type: 'triage', callId: ref.id, patientId: input.patientId ?? null },
      targetUids: [assignedUid],
      policyId: null,
      createdBy: ctx.uid,
    });
    alertId = res.alertId;
    await ref.update({ alertId });
  } else if (priority) {
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
  const result = await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Triage call not found.');
    const call = snap.data() as TriageCall;
    const alertRef = call.alertId ? docRef(paths.alert(ctx.orgId, call.alertId)) : null;
    const alertSnap = alertRef ? await tx.get(alertRef) : null;
    const alert = alertSnap?.exists ? (alertSnap.data() as Alert) : null;
    if (call.status !== 'open') throw new HttpsError('failed-precondition', 'The triage call is resolved.');
    assertCanActOnTriageCall(ctx, call, alert);
    if (call.assignedUid === input.assignedUid) return null;
    tx.update(ref, { assignedUid: input.assignedUid });
    // Let the new assignee see (and ack/resolve) the linked alert, and make them its current recipient.
    let pushAlert: Alert | null = null;
    if (alertRef && alert && alert.status !== 'resolved') {
      const current = (alert.currentTargetUids ?? []).filter((u) => u !== call.assignedUid);
      tx.update(alertRef, {
        targetUids: FieldValue.arrayUnion(input.assignedUid),
        currentTargetUids: [...new Set([...current, input.assignedUid])],
      });
      pushAlert = alert;
    }
    await writeAudit(
      ctx.orgId,
      { actorUid: ctx.uid, action: 'triage.assign', resourceType: 'triageCall', resourceId: input.callId, patientId: call.patientId, metadata: { from: call.assignedUid } },
      tx,
    );
    return { call, alertId: alertRef?.id ?? null, pushAlert };
  });
  if (!result) return {};
  if (result.pushAlert && result.alertId) {
    await pushToMembers(ctx.orgId, [input.assignedUid], alertNotificationTitle(result.pushAlert), alertPushData(ctx.orgId, result.alertId, result.pushAlert));
  } else if (!result.alertId) {
    // No alert yet (e.g. a routine call nobody was on call for): notify the new assignee without escalation.
    const res = await raiseAlert({
      orgId: ctx.orgId,
      alertId: triageAlertId(input.callId),
      title: ROUTINE_TRIAGE_ALERT_TITLE,
      body: truncateText(`${result.call.patientName ?? result.call.callerName}: ${result.call.reason}`, 280),
      priority: 'normal',
      source: { type: 'triage', callId: input.callId, patientId: result.call.patientId },
      targetUids: [input.assignedUid],
      policyId: null,
      createdBy: ctx.uid,
    });
    await ref.update({ alertId: res.alertId });
  }
  return {};
}

export async function resolveTriageCallHandler(request: CallableRequest<ResolveTriageCallRequest>): Promise<ResolveTriageCallResponse> {
  const input = parse(resolveSchema, request.data);
  const ctx = await requireOrg(request, input.orgId, CLINICAL_ROLES);
  if (input.followUpTask?.assigneeUid) await assertActiveMembers(ctx.orgId, [input.followUpTask.assigneeUid]);
  // O3: optional PRN visit, assigned to the resolver unless another member is chosen.
  let visit: { start: ReturnType<typeof instant>; end: ReturnType<typeof instant>; assignee: Member } | null = null;
  if (input.visit) {
    const start = instant(input.visit.start);
    const end = instant(input.visit.end);
    const span = tsMillis(end) - tsMillis(start);
    if (!(span > 0)) throw new HttpsError('invalid-argument', 'The visit must end after it starts.');
    if (span > MAX_VISIT_MS) throw new HttpsError('invalid-argument', 'A visit cannot be longer than 24 hours.');
    const assigneeUid = input.visit.assignedUid ?? ctx.uid;
    const assignee = assigneeUid === ctx.uid ? ctx.member : (await assertActiveMembers(ctx.orgId, [assigneeUid])).get(assigneeUid)!;
    visit = { start, end, assignee: { ...assignee, uid: assigneeUid } };
  }
  const ref = docRef(carePaths.triageCall(ctx.orgId, input.callId));
  const result = await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Triage call not found.');
    const call = snap.data() as TriageCall;
    const alertRef = call.alertId ? docRef(paths.alert(ctx.orgId, call.alertId)) : null;
    const alertSnap = alertRef ? await tx.get(alertRef) : null;
    const patientSnap = visit && call.patientId ? await tx.get(docRef(paths.patient(ctx.orgId, call.patientId))) : null;
    if (call.status !== 'open') throw new HttpsError('failed-precondition', 'The triage call is already resolved.');
    assertCanActOnTriageCall(ctx, call, alertSnap?.exists ? (alertSnap.data() as Alert) : null);
    let visitDoc: Record<string, unknown> | null = null;
    if (visit) {
      if (!call.patientId || !patientSnap?.exists) throw new HttpsError('failed-precondition', 'A visit needs a call linked to a patient.');
      const patient = patientSnap.data() as Patient;
      if (patient.status !== 'admitted') throw new HttpsError('failed-precondition', 'Visits can only be scheduled for admitted patients.');
      const ts = FieldValue.serverTimestamp();
      // Same fields as `scheduleVisit`; a visit that already ended and was made by the resolver is recorded as completed.
      const done = tsMillis(visit.end) <= Date.now() && visit.assignee.uid === ctx.uid;
      visitDoc = {
        patientId: call.patientId,
        patientName: patientDisplayName(patient),
        discipline: visit.assignee.discipline,
        assignedUid: visit.assignee.uid,
        scheduledStart: visit.start,
        scheduledEnd: visit.end,
        status: done ? 'completed' : 'scheduled',
        note: 'PRN visit from after-hours triage call',
        completedAt: done ? ts : null,
        completedBy: done ? ctx.uid : null,
        cancelledReason: null,
        createdBy: ctx.uid,
        createdAt: ts,
        updatedAt: ts,
      };
    }

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
    let visitId: string | null = null;
    if (visitDoc) {
      const visitRef = colRef(carePaths.visits(ctx.orgId)).doc();
      visitId = visitRef.id;
      tx.set(visitRef, visitDoc);
      await writeAudit(
        ctx.orgId,
        {
          actorUid: ctx.uid,
          action: visitDoc.status === 'completed' ? 'visit.complete' : 'visit.schedule',
          resourceType: 'visit',
          resourceId: visitId,
          patientId: call.patientId,
          metadata: { source: 'triage', callId: input.callId, discipline: visitDoc.discipline, assigned: true },
        },
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
        metadata: { disposition: input.disposition, followUpTaskId: taskId, visitId },
      },
      tx,
    );
    return { taskId, visitId };
  });
  return result;
}

export const logTriageCall = onCall(logTriageCallHandler);
export const assignTriageCall = onCall(assignTriageCallHandler);
export const resolveTriageCall = onCall(resolveTriageCallHandler);
