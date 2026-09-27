/**
 * Visit callables: frequencies, schedule, update, complete, cancel.
 *
 * v3 (V4) permissions — see `canManageVisit`:
 *  - admins and `scheduling` holders may schedule, update, cancel and reassign any visit;
 *  - otherwise a clinical role (admin/clinician/intake) that is on the patient's care team,
 *    is the assignee, or created the visit;
 *  - Aide/LPN members with role `viewer` (FIELD_DISCIPLINES) may complete visits assigned to them.
 * Missed visits can be completed late or rescheduled to a future time; both resolve the
 * visit's `vm_` missed-visit alert.
 */
import { FieldValue, Timestamp, type Transaction } from 'firebase-admin/firestore';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { canManageVisit } from '../domain/visits';
import { writeAudit } from '../lib/audit';
import { carePaths, instant, patientDisplayName, tsMillis, txPatient } from '../lib/care';
import { CLINICAL_ROLES, parse, requireOrg, type OrgContext } from '../lib/context';
import { colRef, db, docRef, getDocData, paths } from '../lib/db';
import { assertActiveMembers } from '../lib/members';
import { memberHasCapability } from '../lib/permissions';
import { discipline, id } from '../lib/schemas';
import { missedVisitAlertId } from './checkMissedVisits';
import {
  FIELD_DISCIPLINES,
  type Alert,
  type CancelVisitRequest,
  type CompleteVisitRequest,
  type IdResponse,
  type Patient,
  type ScheduleVisitRequest,
  type SetVisitFrequenciesRequest,
  type UpdateVisitRequest,
  type Visit,
  type VisitType,
} from '../shared/types';

/** Longest allowed visit (continuous care can run long, but not past a day). */
export const MAX_VISIT_MS = 24 * 3_600_000;

/** Visit types that may be scheduled for a `referral`-status patient (before admission). */
export const REFERRAL_VISIT_TYPES: readonly VisitType[] = ['admission', 'evaluation'];

const isoInstant = z.string().datetime({ offset: true });
const note = z.string().trim().max(4000);
const visitType = z.enum(['routine', 'admission', 'evaluation', 'prn', 'aide_supervision']);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:mm');

const frequenciesSchema = z.object({
  orgId: id,
  patientId: id,
  frequencies: z
    .array(
      z.object({
        discipline,
        perWeek: z.number().positive().max(28),
        notes: note.nullable().default(null),
        // v3 (V2) planning hints; omitted when not given so older docs keep their shape.
        preferredDays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
        preferredStart: hhmm.optional(),
        durationMinutes: z.number().int().min(15).max(1440).optional(),
        assignedUid: id.nullable().optional(),
      }),
    )
    .max(20)
    .refine((fs) => new Set(fs.map((f) => f.discipline)).size === fs.length, 'one entry per discipline'),
});
const scheduleSchema = z.object({
  orgId: id,
  patientId: id,
  discipline,
  assignedUid: id.nullable().optional(),
  start: isoInstant,
  end: isoInstant,
  note: note.optional(),
  type: visitType.optional(),
});
const updateSchema = z.object({
  orgId: id,
  visitId: id,
  assignedUid: id.nullable().optional(),
  start: isoInstant.optional(),
  end: isoInstant.optional(),
  note: note.nullable().optional(),
});
const completeSchema = z.object({ orgId: id, visitId: id, note: note.optional() });
const cancelSchema = z.object({ orgId: id, visitId: id, reason: z.string().trim().min(1).max(1000) });

function assertSpan(start: Timestamp, end: Timestamp): void {
  const s = tsMillis(start);
  const e = tsMillis(end);
  if (!(e > s)) throw new HttpsError('invalid-argument', 'The visit must end after it starts.');
  if (e - s > MAX_VISIT_MS) throw new HttpsError('invalid-argument', 'A visit cannot be longer than 24 hours.');
}

function isClinical(ctx: OrgContext): boolean {
  return CLINICAL_ROLES.includes(ctx.role);
}

/** Clinical roles, or anyone holding `scheduling` (e.g. a scheduler with role viewer). */
function assertCanSchedule(ctx: OrgContext): void {
  if (!isClinical(ctx) && !memberHasCapability(ctx.member, 'scheduling')) {
    throw new HttpsError('permission-denied', 'Your role does not allow this action.');
  }
}

export async function setVisitFrequenciesHandler(request: CallableRequest<SetVisitFrequenciesRequest>): Promise<Record<string, never>> {
  const input = parse(frequenciesSchema, request.data);
  const ctx = await requireOrg(request, input.orgId);
  assertCanSchedule(ctx);
  const planned = input.frequencies.map((f) => f.assignedUid).filter((u): u is string => !!u);
  if (planned.length) await assertActiveMembers(ctx.orgId, planned);
  await db().runTransaction(async (tx) => {
    const { ref, patient } = await txPatient(tx, ctx.orgId, input.patientId);
    if (patient.status !== 'admitted' && patient.status !== 'referral') {
      throw new HttpsError('failed-precondition', 'Visit frequencies can only be set for active patients.');
    }
    tx.update(ref, { visitFrequencies: input.frequencies, updatedAt: FieldValue.serverTimestamp() });
    await writeAudit(
      ctx.orgId,
      {
        actorUid: ctx.uid,
        action: 'patient.update',
        resourceType: 'patient',
        resourceId: input.patientId,
        patientId: input.patientId,
        metadata: { field: 'visitFrequencies', count: input.frequencies.length },
      },
      tx,
    );
  });
  return {};
}

export async function scheduleVisitHandler(request: CallableRequest<ScheduleVisitRequest>): Promise<IdResponse> {
  const input = parse(scheduleSchema, request.data);
  const ctx = await requireOrg(request, input.orgId);
  assertCanSchedule(ctx);
  const start = instant(input.start);
  const end = instant(input.end);
  assertSpan(start, end);
  const type: VisitType = input.type ?? 'routine';
  const assignedUid = input.assignedUid ?? null;
  if (assignedUid) await assertActiveMembers(ctx.orgId, [assignedUid]);
  const patient = await getDocData<Patient>(paths.patient(ctx.orgId, input.patientId));
  if (!patient) throw new HttpsError('not-found', 'Patient not found.');
  if (patient.status === 'referral') {
    if (!REFERRAL_VISIT_TYPES.includes(type)) {
      throw new HttpsError('failed-precondition', 'Only admission or evaluation visits can be scheduled before admission.');
    }
  } else if (patient.status !== 'admitted') {
    throw new HttpsError('failed-precondition', 'Visits can only be scheduled for admitted or referral patients.');
  }

  const ref = colRef(carePaths.visits(ctx.orgId)).doc();
  const now = FieldValue.serverTimestamp();
  const batch = db().batch();
  batch.set(ref, {
    patientId: input.patientId,
    patientName: patientDisplayName(patient),
    discipline: input.discipline,
    assignedUid,
    scheduledStart: start,
    scheduledEnd: end,
    status: 'scheduled',
    note: input.note ?? null,
    completedAt: null,
    completedBy: null,
    cancelledReason: null,
    createdBy: ctx.uid,
    createdAt: now,
    updatedAt: now,
    type,
  });
  await writeAudit(
    ctx.orgId,
    { actorUid: ctx.uid, action: 'visit.schedule', resourceType: 'visit', resourceId: ref.id, patientId: input.patientId, metadata: { discipline: input.discipline, type } },
    batch,
  );
  await batch.commit();
  return { id: ref.id };
}

/**
 * Loads a visit and its patient in a transaction and checks `canManageVisit`
 * (scheduling/admin, care team, assignee or creator).
 */
async function txVisitForAction(tx: Transaction, ctx: OrgContext, visitId: string) {
  const ref = docRef(carePaths.visit(ctx.orgId, visitId));
  const snap = await tx.get(ref);
  if (!snap.exists) throw new HttpsError('not-found', 'Visit not found.');
  const visit = snap.data() as Visit;
  const pSnap = await tx.get(docRef(paths.patient(ctx.orgId, visit.patientId)));
  const careTeam = pSnap.exists ? ((pSnap.data() as Patient).careTeamUids ?? []) : [];
  const actor = { uid: ctx.uid, role: ctx.role, discipline: ctx.member.discipline, capabilities: ctx.member.capabilities };
  if (!canManageVisit(actor, visit, careTeam)) {
    throw new HttpsError('permission-denied', 'Only the assignee, the patient’s care team, the scheduler or an admin can do this.');
  }
  return { ref, visit };
}

/**
 * Reads the visit's missed-visit alert inside a transaction (call before any write);
 * the returned function resolves it in the write phase when it is still open or acked.
 */
async function txPrepareResolveMissedAlert(tx: Transaction, orgId: string, visitId: string) {
  const ref = docRef(paths.alert(orgId, missedVisitAlertId(visitId)));
  const snap = await tx.get(ref);
  const alert = snap.exists ? (snap.data() as Alert) : null;
  return async (actorUid: string, patientId: string, why: 'completed' | 'rescheduled') => {
    if (!alert || alert.status === 'resolved') return false;
    const update: Record<string, unknown> = { status: 'resolved' };
    if (!alert.ackedBy) {
      update.ackedBy = actorUid;
      update.ackedAt = FieldValue.serverTimestamp();
    }
    tx.update(ref, update);
    await writeAudit(
      orgId,
      { actorUid, action: 'alert.resolve', resourceType: 'alert', resourceId: ref.id, patientId, metadata: { reason: `visit_${why}` } },
      tx,
    );
    return true;
  };
}

export async function updateVisitHandler(request: CallableRequest<UpdateVisitRequest>): Promise<Record<string, never>> {
  const input = parse(updateSchema, request.data);
  const ctx = await requireOrg(request, input.orgId);
  assertCanSchedule(ctx);
  if (input.assignedUid) await assertActiveMembers(ctx.orgId, [input.assignedUid]);
  await db().runTransaction(async (tx) => {
    const { ref, visit } = await txVisitForAction(tx, ctx, input.visitId);
    const wasMissed = visit.status === 'missed';
    if (visit.status !== 'scheduled' && !wasMissed) throw new HttpsError('failed-precondition', `A ${visit.status} visit cannot be changed.`);
    const resolveAlert = wasMissed ? await txPrepareResolveMissedAlert(tx, ctx.orgId, input.visitId) : null;
    const update: Record<string, unknown> = {};
    if (input.assignedUid !== undefined) update.assignedUid = input.assignedUid;
    if (input.note !== undefined) update.note = input.note;
    if (input.start !== undefined || input.end !== undefined) {
      const oldStart = visit.scheduledStart as Timestamp;
      const oldEnd = visit.scheduledEnd as Timestamp;
      const start = input.start ? instant(input.start) : oldStart;
      // Moving only the start keeps the visit's length.
      const end = input.end ? instant(input.end) : input.start ? Timestamp.fromMillis(tsMillis(start) + tsMillis(oldEnd) - tsMillis(oldStart)) : oldEnd;
      assertSpan(start, end);
      if (wasMissed && tsMillis(start) <= Date.now()) {
        throw new HttpsError('invalid-argument', 'A missed visit can only be rescheduled to a future time.');
      }
      update.scheduledStart = start;
      update.scheduledEnd = end;
    }
    if (wasMissed) {
      if (update.scheduledStart === undefined) {
        throw new HttpsError('failed-precondition', 'A missed visit can only be rescheduled (choose a new future time) or completed.');
      }
      update.status = 'scheduled';
    }
    const changed = Object.keys(update);
    if (changed.length === 0) return;
    tx.update(ref, { ...update, updatedAt: FieldValue.serverTimestamp() });
    await writeAudit(
      ctx.orgId,
      {
        actorUid: ctx.uid,
        action: 'visit.update',
        resourceType: 'visit',
        resourceId: input.visitId,
        patientId: visit.patientId,
        metadata: { fields: changed, ...(wasMissed ? { from: 'missed', rescheduled: true } : {}) },
      },
      tx,
    );
    if (resolveAlert) await resolveAlert(ctx.uid, visit.patientId, 'rescheduled');
  });
  return {};
}

export async function completeVisitHandler(request: CallableRequest<CompleteVisitRequest>): Promise<Record<string, never>> {
  const input = parse(completeSchema, request.data);
  // Viewers are allowed in so Aide/LPN field staff can complete their own visits (checked below).
  const ctx = await requireOrg(request, input.orgId);
  const fieldViewer = !isClinical(ctx) && !memberHasCapability(ctx.member, 'scheduling');
  if (fieldViewer && !FIELD_DISCIPLINES.includes(ctx.member.discipline)) {
    throw new HttpsError('permission-denied', 'Your role does not allow this action.');
  }
  await db().runTransaction(async (tx) => {
    const ref = docRef(carePaths.visit(ctx.orgId, input.visitId));
    let visit: Visit;
    if (fieldViewer) {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new HttpsError('not-found', 'Visit not found.');
      visit = snap.data() as Visit;
      if (visit.assignedUid !== ctx.uid) throw new HttpsError('permission-denied', 'You can only complete visits assigned to you.');
    } else {
      visit = (await txVisitForAction(tx, ctx, input.visitId)).visit;
    }
    if (visit.status === 'completed') return;
    // A missed visit may still be documented as completed (late documentation).
    if (visit.status !== 'scheduled' && visit.status !== 'missed') {
      throw new HttpsError('failed-precondition', `A ${visit.status} visit cannot be completed.`);
    }
    const resolveAlert = visit.status === 'missed' ? await txPrepareResolveMissedAlert(tx, ctx.orgId, input.visitId) : null;
    const now = FieldValue.serverTimestamp();
    tx.update(ref, {
      status: 'completed',
      completedAt: now,
      completedBy: ctx.uid,
      ...(input.note !== undefined ? { note: input.note } : {}),
      updatedAt: now,
    });
    await writeAudit(
      ctx.orgId,
      { actorUid: ctx.uid, action: 'visit.complete', resourceType: 'visit', resourceId: input.visitId, patientId: visit.patientId, metadata: { from: visit.status } },
      tx,
    );
    if (resolveAlert) await resolveAlert(ctx.uid, visit.patientId, 'completed');
  });
  return {};
}

export async function cancelVisitHandler(request: CallableRequest<CancelVisitRequest>): Promise<Record<string, never>> {
  const input = parse(cancelSchema, request.data);
  const ctx = await requireOrg(request, input.orgId);
  assertCanSchedule(ctx);
  await db().runTransaction(async (tx) => {
    const { ref, visit } = await txVisitForAction(tx, ctx, input.visitId);
    if (visit.status === 'cancelled') return;
    if (visit.status !== 'scheduled') throw new HttpsError('failed-precondition', `A ${visit.status} visit cannot be cancelled.`);
    tx.update(ref, { status: 'cancelled', cancelledReason: input.reason, updatedAt: FieldValue.serverTimestamp() });
    await writeAudit(
      ctx.orgId,
      { actorUid: ctx.uid, action: 'visit.cancel', resourceType: 'visit', resourceId: input.visitId, patientId: visit.patientId },
      tx,
    );
  });
  return {};
}

export const setVisitFrequencies = onCall(setVisitFrequenciesHandler);
export const scheduleVisit = onCall(scheduleVisitHandler);
export const updateVisit = onCall(updateVisitHandler);
export const completeVisit = onCall(completeVisitHandler);
export const cancelVisit = onCall(cancelVisitHandler);
