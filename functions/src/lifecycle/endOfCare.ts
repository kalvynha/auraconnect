/** `dischargePatient` and `recordDeath`: end a patient's hospice stay. */
import { FieldValue, type Transaction } from 'firebase-admin/firestore';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { bereavementClosesOn, buildBereavementSchedule } from '../domain/bereavement';
import type { CareTeamMemberRef } from '../domain/taskTemplates';
import { writeAudit } from '../lib/audit';
import {
  appendPatientEvent,
  careTeamRefs,
  carePaths,
  loadPatient,
  patientDisplayName,
  prepareTemplateTasks,
  txPatient,
  txPrepareCancelOpenWork,
  txWriteTemplateTasks,
} from '../lib/care';
import { CLINICAL_ROLES, parse, requireOrg, type OrgContext } from '../lib/context';
import { colRef, db, docRef, paths } from '../lib/db';
import { assertActiveMembers } from '../lib/members';
import { id, isoDate } from '../lib/schemas';
import type {
  BereavementContact,
  DischargePatientRequest,
  DischargeReason,
  ISODate,
  Patient,
  RecordDeathRequest,
  TaskTemplateEvent,
} from '../shared/types';

export const DISCHARGE_REASON_LABELS: Record<DischargeReason, string> = {
  revocation: 'Revocation',
  transfer: 'Transfer',
  no_longer_terminally_ill: 'No longer terminally ill',
  moved_out_of_area: 'Moved out of area',
  for_cause: 'For cause',
  other: 'Other',
};

const dischargeSchema = z.object({
  orgId: id,
  patientId: id,
  dischargeDate: isoDate,
  reason: z.enum(['revocation', 'transfer', 'no_longer_terminally_ill', 'moved_out_of_area', 'for_cause', 'other']),
  notes: z.string().trim().max(2000).optional(),
});

const optText = (max: number) => z.string().trim().min(1).max(max).optional();
const deathSchema = z.object({
  orgId: id,
  patientId: id,
  date: isoDate,
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:mm').optional(),
  pronouncedBy: optText(200),
  location: optText(200),
  notes: z.string().trim().max(2000).optional(),
  bereavementRisk: z.enum(['low', 'moderate', 'high']).default('low'),
  bereavementAssigneeUid: id.optional(),
});

interface EndOfCare {
  ctx: OrgContext;
  patientId: string;
  event: Extract<TaskTemplateEvent, 'discharge' | 'death'>;
  date: ISODate;
  /** Called in the write phase with the freshly-read patient. */
  write: (
    tx: Transaction,
    patient: Patient,
  ) => { patientUpdate: Record<string, unknown>; summary: string; details: Record<string, unknown>; metadata: Record<string, unknown> };
  cancelReason: string;
  /** Patient and active care team already loaded by the caller (avoids reading them twice). */
  preloaded?: { patient: Patient; team: CareTeamMemberRef[] };
}

/**
 * Shared end-of-stay flow: patient must be admitted; archives the patient channel,
 * cancels future scheduled visits and open tasks, appends the event and
 * instantiates the template for `event`.
 */
async function endOfCare(p: EndOfCare): Promise<void> {
  const { ctx } = p;
  const pre = p.preloaded?.patient ?? (await loadPatient(ctx.orgId, p.patientId));
  const tasks = await prepareTemplateTasks(ctx.orgId, p.event, p.date, pre.careTeamUids ?? [], p.preloaded?.team);
  const now = new Date();

  await db().runTransaction(async (tx) => {
    const { ref, patient } = await txPatient(tx, ctx.orgId, p.patientId);
    if (patient.status !== 'admitted') {
      throw new HttpsError('failed-precondition', `Cannot record a ${p.event} for a patient with status "${patient.status}".`);
    }
    if (patient.admissionDate && p.date < patient.admissionDate) {
      throw new HttpsError('invalid-argument', `The ${p.event} date is before admission.`);
    }
    const chRef = patient.channelId ? docRef(paths.channel(ctx.orgId, patient.channelId)) : null;
    const chSnap = chRef ? await tx.get(chRef) : null;
    const cancel = await txPrepareCancelOpenWork(tx, ctx.orgId, p.patientId, now);

    // --- writes ---
    const { patientUpdate, summary, details, metadata } = p.write(tx, patient);
    tx.update(ref, { ...patientUpdate, updatedAt: FieldValue.serverTimestamp() });
    if (chRef && chSnap?.exists) tx.update(chRef, { archived: true });
    cancel.apply(p.cancelReason);
    appendPatientEvent(tx, ctx.orgId, p.patientId, { type: p.event, date: p.date, recordedBy: ctx.uid, summary, details });
    const taskIds = txWriteTemplateTasks(tx, ctx.orgId, p.event, tasks, { id: p.patientId, name: patientDisplayName(patient) }, ctx.uid);
    await writeAudit(
      ctx.orgId,
      {
        actorUid: ctx.uid,
        action: p.event === 'death' ? 'patient.death' : 'patient.discharge',
        resourceType: 'patient',
        resourceId: p.patientId,
        patientId: p.patientId,
        metadata: { ...metadata, cancelledVisits: cancel.visits, cancelledTasks: cancel.tasks, tasks: taskIds.length },
      },
      tx,
    );
  });
}

export async function dischargePatientHandler(request: CallableRequest<DischargePatientRequest>): Promise<Record<string, never>> {
  const input = parse(dischargeSchema, request.data);
  const ctx = requireOrg(request, input.orgId, CLINICAL_ROLES);
  await endOfCare({
    ctx,
    patientId: input.patientId,
    event: 'discharge',
    date: input.dischargeDate,
    cancelReason: 'Patient discharged',
    write: (_tx, patient) => {
      return {
        patientUpdate: { status: 'discharged', dischargeDate: input.dischargeDate, dischargeReason: input.reason },
        summary: `Discharged: ${DISCHARGE_REASON_LABELS[input.reason]}`,
        details: { reason: input.reason, notes: input.notes ?? null, levelOfCare: patient.levelOfCare },
        metadata: { reason: input.reason },
      };
    },
  });
  return {};
}

export async function recordDeathHandler(request: CallableRequest<RecordDeathRequest>): Promise<Record<string, never>> {
  const input = parse(deathSchema, request.data);
  const ctx = requireOrg(request, input.orgId, CLINICAL_ROLES);
  let assignee: string | null = input.bereavementAssigneeUid ?? null;
  let preloaded: EndOfCare['preloaded'];
  if (assignee) {
    await assertActiveMembers(ctx.orgId, [assignee]);
  } else {
    const patient = await loadPatient(ctx.orgId, input.patientId);
    const team = await careTeamRefs(ctx.orgId, patient.careTeamUids ?? []);
    preloaded = { patient, team };
    assignee = team.find((m) => m.discipline === 'SW')?.uid ?? null;
  }
  const planRef = colRef(carePaths.bereavementPlans(ctx.orgId)).doc();

  await endOfCare({
    ctx,
    patientId: input.patientId,
    event: 'death',
    date: input.date,
    cancelReason: 'Patient deceased',
    preloaded,
    write: (tx, patient) => {
      const death = {
        date: input.date,
        time: input.time ?? null,
        pronouncedBy: input.pronouncedBy ?? null,
        location: input.location ?? null,
        notes: input.notes ?? null,
      };
      const contacts: BereavementContact[] = buildBereavementSchedule(input.date).map((c) => ({
        ...c,
        status: 'pending',
        completedAt: null,
        completedBy: null,
        note: null,
      }));
      const now = FieldValue.serverTimestamp();
      tx.set(planRef, {
        patientId: input.patientId,
        patientName: patientDisplayName(patient),
        deathDate: input.date,
        primaryContact: patient.caregiver ?? null,
        riskLevel: input.bereavementRisk,
        assignedUid: assignee,
        contacts,
        status: 'active',
        closesOn: bereavementClosesOn(input.date),
        createdAt: now,
        updatedAt: now,
      });
      return {
        patientUpdate: { status: 'deceased', death, bereavementPlanId: planRef.id },
        summary: `Death recorded${input.time ? ` at ${input.time}` : ''}`,
        details: { ...death, bereavementPlanId: planRef.id },
        metadata: { bereavementPlanId: planRef.id, riskLevel: input.bereavementRisk },
      };
    },
  });
  return {};
}

export const dischargePatient = onCall(dischargePatientHandler);
export const recordDeath = onCall(recordDeathHandler);
