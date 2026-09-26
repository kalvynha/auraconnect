/** Visit callables: frequencies, schedule, update, complete, cancel. */
import { FieldValue, type Timestamp, type Transaction } from 'firebase-admin/firestore';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { writeAudit } from '../lib/audit';
import { assertCanActOnPatientWork, carePaths, instant, patientDisplayName, tsMillis, txPatient } from '../lib/care';
import { CLINICAL_ROLES, parse, requireOrg, type OrgContext } from '../lib/context';
import { colRef, db, docRef, getDocData, paths } from '../lib/db';
import { assertActiveMembers } from '../lib/members';
import { discipline, id } from '../lib/schemas';
import type {
  CancelVisitRequest,
  CompleteVisitRequest,
  IdResponse,
  Patient,
  ScheduleVisitRequest,
  SetVisitFrequenciesRequest,
  UpdateVisitRequest,
  Visit,
} from '../shared/types';

/** Longest allowed visit (continuous care can run long, but not past a day). */
export const MAX_VISIT_MS = 24 * 3_600_000;

const isoInstant = z.string().datetime({ offset: true });
const note = z.string().trim().max(4000);

const frequenciesSchema = z.object({
  orgId: id,
  patientId: id,
  frequencies: z
    .array(z.object({ discipline, perWeek: z.number().positive().max(28), notes: note.nullable().default(null) }))
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

export async function setVisitFrequenciesHandler(request: CallableRequest<SetVisitFrequenciesRequest>): Promise<Record<string, never>> {
  const input = parse(frequenciesSchema, request.data);
  const ctx = requireOrg(request, input.orgId, CLINICAL_ROLES);
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
  const ctx = requireOrg(request, input.orgId, CLINICAL_ROLES);
  const start = instant(input.start);
  const end = instant(input.end);
  assertSpan(start, end);
  const assignedUid = input.assignedUid ?? null;
  if (assignedUid) await assertActiveMembers(ctx.orgId, [assignedUid]);
  const patient = await getDocData<Patient>(paths.patient(ctx.orgId, input.patientId));
  if (!patient) throw new HttpsError('not-found', 'Patient not found.');
  if (patient.status !== 'admitted') throw new HttpsError('failed-precondition', 'Visits can only be scheduled for admitted patients.');

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
  });
  await writeAudit(
    ctx.orgId,
    { actorUid: ctx.uid, action: 'visit.schedule', resourceType: 'visit', resourceId: ref.id, patientId: input.patientId, metadata: { discipline: input.discipline } },
    batch,
  );
  await batch.commit();
  return { id: ref.id };
}

/**
 * Loads a visit and its patient in a transaction and checks that the caller is the
 * assignee, on the patient's care team, or an admin.
 */
async function txVisitForAction(tx: Transaction, ctx: OrgContext, visitId: string) {
  const ref = docRef(carePaths.visit(ctx.orgId, visitId));
  const snap = await tx.get(ref);
  if (!snap.exists) throw new HttpsError('not-found', 'Visit not found.');
  const visit = snap.data() as Visit;
  const pSnap = await tx.get(docRef(paths.patient(ctx.orgId, visit.patientId)));
  const careTeam = pSnap.exists ? ((pSnap.data() as Patient).careTeamUids ?? []) : [];
  assertCanActOnPatientWork(ctx, careTeam, [visit.assignedUid]);
  return { ref, visit };
}

export async function updateVisitHandler(request: CallableRequest<UpdateVisitRequest>): Promise<Record<string, never>> {
  const input = parse(updateSchema, request.data);
  const ctx = requireOrg(request, input.orgId, CLINICAL_ROLES);
  if (input.assignedUid) await assertActiveMembers(ctx.orgId, [input.assignedUid]);
  await db().runTransaction(async (tx) => {
    const { ref, visit } = await txVisitForAction(tx, ctx, input.visitId);
    if (visit.status !== 'scheduled') throw new HttpsError('failed-precondition', `A ${visit.status} visit cannot be changed.`);
    const update: Record<string, unknown> = {};
    if (input.assignedUid !== undefined) update.assignedUid = input.assignedUid;
    if (input.note !== undefined) update.note = input.note;
    if (input.start !== undefined || input.end !== undefined) {
      const start = input.start ? instant(input.start) : (visit.scheduledStart as Timestamp);
      const end = input.end ? instant(input.end) : (visit.scheduledEnd as Timestamp);
      assertSpan(start, end);
      update.scheduledStart = start;
      update.scheduledEnd = end;
    }
    const changed = Object.keys(update);
    if (changed.length === 0) return;
    tx.update(ref, { ...update, updatedAt: FieldValue.serverTimestamp() });
    await writeAudit(
      ctx.orgId,
      { actorUid: ctx.uid, action: 'visit.update', resourceType: 'visit', resourceId: input.visitId, patientId: visit.patientId, metadata: { fields: changed } },
      tx,
    );
  });
  return {};
}

export async function completeVisitHandler(request: CallableRequest<CompleteVisitRequest>): Promise<Record<string, never>> {
  const input = parse(completeSchema, request.data);
  const ctx = requireOrg(request, input.orgId, CLINICAL_ROLES);
  await db().runTransaction(async (tx) => {
    const { ref, visit } = await txVisitForAction(tx, ctx, input.visitId);
    if (visit.status === 'completed') return;
    // A missed visit may still be documented as completed (late documentation).
    if (visit.status !== 'scheduled' && visit.status !== 'missed') {
      throw new HttpsError('failed-precondition', `A ${visit.status} visit cannot be completed.`);
    }
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
  });
  return {};
}

export async function cancelVisitHandler(request: CallableRequest<CancelVisitRequest>): Promise<Record<string, never>> {
  const input = parse(cancelSchema, request.data);
  const ctx = requireOrg(request, input.orgId, CLINICAL_ROLES);
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
