/**
 * `dischargePatient` and `recordDeath`: end a patient's hospice stay.
 *
 * v3:
 *  - H4: licensed staff (RN/NP/MD) or admins only.
 *  - O1: the patient channel is not archived at once; `archiveAfter` = now + 72 h and the hourly
 *    `archiveEndedChannels` job archives it. `recordDeath` may name the death `visitId`, which is
 *    completed (ending at the time of death) instead of cancelled, and the care team gets a
 *    normal alert "Patient death recorded" plus a system message in the channel.
 */
import { FieldValue, Timestamp, type Transaction } from 'firebase-admin/firestore';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { bereavementClosesOn, buildBereavementSchedule, survivorFromCaregiver } from '../domain/bereavement';
import { resolveBereavementCoordinator } from '../bereavement/coordinator';
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
  assertCanActOnPatientWork,
  requireOrgDoc,
  tsMillis,
} from '../lib/care';
import { CLINICAL_ROLES, parse, requireOrg, type OrgContext } from '../lib/context';
import { colRef, db, docRef, paths } from '../lib/db';
import { assertActiveMembers } from '../lib/members';
import { requireLicensed } from '../lib/permissions';
import { alertCareTeam, txPostSystemMessage, zonedLocalToEpochMs } from './notifyCareTeam';
import { id, isoDate } from '../lib/schemas';
import type {
  BereavementContact,
  DischargePatientRequest,
  DischargeReason,
  ISODate,
  Patient,
  RecordDeathRequest,
  TaskTemplateEvent,
  Visit,
} from '../shared/types';

/** O1: the patient channel stays open this long after discharge or death, then is archived. */
export const CHANNEL_ARCHIVE_DELAY_MS = 72 * 3_600_000;

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
  visitId: id.optional(),
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
  /** O1: a visit to complete (ending at `visitEndMs`) instead of cancelling it. */
  visit?: { id: string; endMs: number };
  /** O1: posted in the patient channel as a system message. */
  channelMessage?: string;
}

/**
 * Shared end-of-stay flow: patient must be admitted; archives the patient channel,
 * cancels future scheduled visits and open tasks, appends the event and
 * instantiates the template for `event`.
 */
async function endOfCare(p: EndOfCare): Promise<Patient> {
  const { ctx } = p;
  const pre = p.preloaded?.patient ?? (await loadPatient(ctx.orgId, p.patientId));
  const tasks = await prepareTemplateTasks(ctx.orgId, p.event, p.date, pre.careTeamUids ?? [], p.preloaded?.team);
  const now = new Date();

  return db().runTransaction(async (tx) => {
    const { ref, patient } = await txPatient(tx, ctx.orgId, p.patientId);
    if (patient.status !== 'admitted') {
      throw new HttpsError('failed-precondition', `Cannot record a ${p.event} for a patient with status "${patient.status}".`);
    }
    if (patient.admissionDate && p.date < patient.admissionDate) {
      throw new HttpsError('invalid-argument', `The ${p.event} date is before admission.`);
    }
    const chRef = patient.channelId ? docRef(paths.channel(ctx.orgId, patient.channelId)) : null;
    const chSnap = chRef ? await tx.get(chRef) : null;
    const visitRef = p.visit ? docRef(carePaths.visit(ctx.orgId, p.visit.id)) : null;
    const visitSnap = visitRef ? await tx.get(visitRef) : null;
    let visitEnd: Timestamp | null = null;
    if (p.visit) {
      const visit = visitSnap?.exists ? (visitSnap.data() as Visit) : null;
      if (!visit || visit.patientId !== p.patientId) throw new HttpsError('invalid-argument', 'That visit does not belong to this patient.');
      if (visit.status !== 'scheduled' && visit.status !== 'missed') {
        throw new HttpsError('failed-precondition', `A ${visit.status} visit cannot be completed.`);
      }
      assertCanActOnPatientWork(ctx, patient.careTeamUids, [visit.assignedUid]);
      // Ends at the time of death, but never before the visit started or after now.
      const startMs = tsMillis(visit.scheduledStart);
      visitEnd = Timestamp.fromMillis(Math.min(now.getTime(), Math.max(p.visit.endMs, Number.isFinite(startMs) ? startMs : p.visit.endMs)));
    }
    const cancel = await txPrepareCancelOpenWork(tx, ctx.orgId, p.patientId, now, p.visit ? [p.visit.id] : []);

    // --- writes ---
    const { patientUpdate, summary, details, metadata } = p.write(tx, patient);
    tx.update(ref, { ...patientUpdate, updatedAt: FieldValue.serverTimestamp() });
    const channelOpen = !!(chRef && chSnap?.exists && chSnap.get('archived') !== true);
    if (chRef && channelOpen) {
      tx.update(chRef, { archiveAfter: Timestamp.fromMillis(now.getTime() + CHANNEL_ARCHIVE_DELAY_MS) });
      if (p.channelMessage) txPostSystemMessage(tx, ctx.orgId, chRef.id, p.channelMessage);
    }
    cancel.apply(p.cancelReason);
    if (visitRef && visitEnd) {
      tx.update(visitRef, { status: 'completed', completedAt: visitEnd, completedBy: ctx.uid, updatedAt: FieldValue.serverTimestamp() });
      await writeAudit(
        ctx.orgId,
        { actorUid: ctx.uid, action: 'visit.complete', resourceType: 'visit', resourceId: visitRef.id, patientId: p.patientId, metadata: { event: p.event } },
        tx,
      );
    }
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
        metadata: {
          ...metadata,
          cancelledVisits: cancel.visits,
          cancelledTasks: cancel.tasks,
          tasks: taskIds.length,
          completedVisitId: p.visit?.id ?? null,
          channelArchiveDelayed: channelOpen,
        },
      },
      tx,
    );
    return patient;
  });
}

export async function dischargePatientHandler(request: CallableRequest<DischargePatientRequest>): Promise<Record<string, never>> {
  const input = parse(dischargeSchema, request.data);
  const ctx = await requireOrg(request, input.orgId, CLINICAL_ROLES);
  await requireLicensed(ctx);
  await endOfCare({
    ctx,
    patientId: input.patientId,
    event: 'discharge',
    date: input.dischargeDate,
    cancelReason: 'Patient discharged',
    channelMessage: `Patient discharged by ${ctx.member.displayName || 'a care team member'}. This channel will be archived in 72 hours.`,
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
  const ctx = await requireOrg(request, input.orgId, CLINICAL_ROLES);
  await requireLicensed(ctx);
  let visit: EndOfCare['visit'];
  if (input.visitId) {
    const org = await requireOrgDoc(ctx.orgId);
    const endMs = input.time ? zonedLocalToEpochMs(input.date, input.time, org.timezone || 'UTC') : Date.now();
    visit = { id: input.visitId, endMs };
  }
  let assignee: string | null = input.bereavementAssigneeUid ?? null;
  let preloaded: EndOfCare['preloaded'];
  if (assignee) {
    await assertActiveMembers(ctx.orgId, [assignee]);
  } else {
    const patient = await loadPatient(ctx.orgId, input.patientId);
    const team = await careTeamRefs(ctx.orgId, patient.careTeamUids ?? []);
    preloaded = { patient, team };
    // C1: org default coordinator (if active), else the care team's first SW.
    assignee = await resolveBereavementCoordinator(ctx.orgId, team);
  }
  const planRef = colRef(carePaths.bereavementPlans(ctx.orgId)).doc();

  const patient = await endOfCare({
    ctx,
    patientId: input.patientId,
    event: 'death',
    date: input.date,
    cancelReason: 'Patient deceased',
    preloaded,
    visit,
    channelMessage: `Patient death recorded by ${ctx.member.displayName || 'a care team member'}. This channel will be archived in 72 hours.`,
    write: (tx, patient) => {
      const death = {
        date: input.date,
        time: input.time ?? null,
        pronouncedBy: input.pronouncedBy ?? null,
        location: input.location ?? null,
        notes: input.notes ?? null,
      };
      const contacts: BereavementContact[] = buildBereavementSchedule(input.date, input.bereavementRisk).map((c) => ({
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
        // C1: survivors seeded from the caregiver (bereavement/bereavement.ts edits them).
        survivors: [survivorFromCaregiver(patient.caregiver)].filter((x) => x !== null),
        riskHistory: [],
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
  await alertCareTeam({
    orgId: ctx.orgId,
    patientId: input.patientId,
    careTeamUids: patient.careTeamUids ?? [],
    activeUids: preloaded?.team.map((m) => m.uid),
    actorUid: ctx.uid,
    alertId: `death_${input.patientId}`,
    title: 'Patient death recorded',
    body: `${patientDisplayName(patient)}${input.time ? ` · ${input.date} ${input.time}` : ` · ${input.date}`}`,
  });
  return {};
}

export const dischargePatient = onCall(dischargePatientHandler);
export const recordDeath = onCall(recordDeathHandler);
