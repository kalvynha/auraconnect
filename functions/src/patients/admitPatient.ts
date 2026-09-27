/**
 * `admitPatient` — admits a new or referral-status patient, re-admits a discharged one
 * (`readmission: true`), or updates an admitted patient's admission record (`update: true`).
 *
 * v3 (H2, I5, I6):
 *  - An admitted patient is never overwritten by a second wizard: without `update: true`
 *    the call fails with `already-exists`; with it, only an admin or care-team member may
 *    change demographics, consents, admission dates and visit frequencies. The care team
 *    and level of care are left alone (`updateCareTeam` / `changeLevelOfCare` own those).
 *  - The patient doc is always merge-updated, so server-maintained fields (completions,
 *    IDG dates, death/discharge history, volunteerUids, referral metadata…) survive.
 *  - The caller joins the care-team channel only on a new admission and only when
 *    `joinChannel` (default: RN/NP/MD callers yes, intake and others no).
 *  - Readmission from `discharged` appends an admission event that archives the prior
 *    milestones, recomputes them, clears the discharge and un-archives the channel.
 */
import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { normalizeUids, patientChannelName } from '../domain/channels';
import { todayInTimeZone } from '../domain/dates';
import { nextIdgDue } from '../domain/idg';
import { benefitPeriodStartError, computeMilestones, DEFAULT_PERIOD_COUNT } from '../domain/milestones';
import { writeAudit } from '../lib/audit';
import { appendPatientEvent, orgSettings, patientDisplayName, prepareTemplateTasks, txWriteTemplateTasks } from '../lib/care';
import { CLINICAL_ROLES, parse, requireOrg } from '../lib/context';
import { colRef, db, docRef, getDocData, paths } from '../lib/db';
import { assertActiveMembers } from '../lib/members';
import { consents, discipline, id, isoDate, patientInput, uidList } from '../lib/schemas';
import { LICENSED_DISCIPLINES, type AdmitPatientRequest, type AdmitPatientResponse, type Member, type Org, type Patient } from '../shared/types';
import { newChannelDoc } from '../messaging/createChannel';

const visitFrequencies = z
  .array(z.object({ discipline, perWeek: z.number().positive().max(28), notes: z.string().trim().max(4000).nullable().default(null) }))
  .max(20)
  .refine((fs) => new Set(fs.map((f) => f.discipline)).size === fs.length, 'one entry per discipline');

const schema = z.object({
  orgId: id,
  patientId: id.optional(),
  patient: patientInput.refine((p) => p.dob !== null, { message: 'dob is required for admission', path: ['dob'] }),
  admissionDate: isoDate,
  startingBenefitPeriod: z.number().int().min(1).max(100).default(1),
  levelOfCare: z.enum(['routine', 'continuous', 'respite', 'gip']),
  careTeamUids: uidList(100).min(1, 'at least one care team member is required'),
  consents,
  update: z.boolean().default(false),
  readmission: z.boolean().default(false),
  joinChannel: z.boolean().optional(),
  benefitPeriodStart: isoDate.nullable().optional(),
  visitFrequencies: visitFrequencies.optional(),
});

/** Default for `joinChannel`: licensed clinicians (RN/NP/MD) join; intake and everyone else don't. */
export function defaultJoinChannel(member: Pick<Member, 'role' | 'discipline'>): boolean {
  return member.role !== 'intake' && LICENSED_DISCIPLINES.includes(member.discipline);
}

type Mode = 'new' | 'readmission' | 'update';

export async function admitPatientHandler(request: CallableRequest<AdmitPatientRequest>): Promise<AdmitPatientResponse> {
  const input = parse(schema, request.data);
  const ctx = await requireOrg(request, input.orgId, CLINICAL_ROLES);
  if (!input.consents.electionStatement || !input.consents.hipaaNotice) {
    throw new HttpsError('invalid-argument', 'The election statement and HIPAA notice must be signed before admission.');
  }
  const bpStart = input.benefitPeriodStart ?? null;
  const bpError = benefitPeriodStartError(input.admissionDate, input.startingBenefitPeriod, bpStart);
  if (bpError) throw new HttpsError('invalid-argument', bpError);

  const careTeam = normalizeUids(input.careTeamUids);
  const joinChannel = input.joinChannel ?? defaultJoinChannel(ctx.member);
  await assertActiveMembers(ctx.orgId, careTeam);

  const org = await getDocData<Org>(paths.org(ctx.orgId));
  if (!org) throw new HttpsError('not-found', 'Organization not found.');
  const today = todayInTimeZone(new Date(), org.timezone);
  const milestones = computeMilestones(input.admissionDate, input.startingBenefitPeriod, today, DEFAULT_PERIOD_COUNT, { benefitPeriodStart: bpStart });
  const { idgCadenceDays } = orgSettings(org);
  const admissionTasks = await prepareTemplateTasks(ctx.orgId, 'admission', input.admissionDate, careTeam);

  const patientRef = input.patientId ? docRef(paths.patient(ctx.orgId, input.patientId)) : colRef(paths.patients(ctx.orgId)).doc();
  const channelName = patientChannelName(input.patient.firstName, input.patient.lastName);

  const result = await db().runTransaction(async (tx) => {
    const snap = await tx.get(patientRef);
    if (input.patientId && !snap.exists) throw new HttpsError('not-found', 'Patient not found.');
    const existing = snap.exists ? (snap.data() as Patient) : null;

    let mode: Mode;
    if (!existing || existing.status === 'referral') {
      mode = 'new';
    } else if (existing.status === 'admitted') {
      if (!input.update) {
        throw new HttpsError('already-exists', 'This patient is already admitted. Reload to see the current record.');
      }
      if (ctx.role !== 'admin' && !(existing.careTeamUids ?? []).includes(ctx.uid)) {
        throw new HttpsError('permission-denied', 'Only an admin or the patient’s care team can update an admitted patient.');
      }
      mode = 'update';
    } else if (existing.status === 'discharged') {
      if (!input.readmission) {
        throw new HttpsError('failed-precondition', 'This patient was discharged. Confirm readmission to admit them again.');
      }
      mode = 'readmission';
    } else {
      throw new HttpsError('failed-precondition', `Cannot admit a patient with status "${existing.status}".`);
    }
    const isNewAdmission = mode !== 'update';
    const channelMembers = isNewAdmission ? normalizeUids(joinChannel ? [...careTeam, ctx.uid] : careTeam) : [];

    // Reads (channel) before any write.
    let chId = existing?.channelId ?? null;
    const chRef = chId ? docRef(paths.channel(ctx.orgId, chId)) : null;
    const chExists = chRef ? (await tx.get(chRef)).exists : false;

    if (chRef && chExists) {
      const chUpdate: Record<string, unknown> = { name: channelName };
      if (channelMembers.length) chUpdate.memberUids = FieldValue.arrayUnion(...channelMembers);
      if (mode === 'readmission') chUpdate.archived = false;
      tx.update(chRef, chUpdate);
    } else {
      const newRef = colRef(paths.channels(ctx.orgId)).doc();
      chId = newRef.id;
      const members = mode === 'update' ? normalizeUids(existing?.careTeamUids ?? careTeam) : channelMembers;
      tx.set(newRef, newChannelDoc({ type: 'patient', name: channelName, memberUids: members, createdBy: ctx.uid, patientId: patientRef.id }));
    }

    const now = FieldValue.serverTimestamp();
    const fields: Record<string, unknown> = {
      ...input.patient,
      status: 'admitted',
      admissionDate: input.admissionDate,
      startingBenefitPeriod: input.startingBenefitPeriod,
      benefitPeriodStart: bpStart,
      consents: input.consents,
      milestones,
      channelId: chId,
      updatedAt: now,
    };
    if (input.visitFrequencies) fields.visitFrequencies = input.visitFrequencies;
    if (isNewAdmission) {
      fields.levelOfCare = input.levelOfCare;
      fields.careTeamUids = careTeam;
      fields.nextIdgDueDate = nextIdgDue(input.admissionDate, idgCadenceDays);
    }
    if (mode === 'readmission') {
      // Prior milestones are archived on the admission event below; completions/reminders restart.
      fields.milestoneCompletions = {};
      fields.remindedMilestones = [];
      fields.lastIdgReviewDate = null;
      fields.dischargeDate = null;
      fields.dischargeReason = null;
    }

    if (!existing) {
      tx.set(patientRef, {
        referralId: null,
        remindedMilestones: [],
        milestoneCompletions: {},
        visitFrequencies: [],
        lastIdgReviewDate: null,
        createdBy: ctx.uid,
        createdAt: now,
        ...fields,
      });
    } else {
      // update() replaces only the listed fields; everything else on the doc is kept.
      if (existing.remindedMilestones === undefined) fields.remindedMilestones ??= [];
      if (existing.milestoneCompletions === undefined) fields.milestoneCompletions ??= {};
      if (existing.visitFrequencies === undefined) fields.visitFrequencies ??= [];
      tx.update(patientRef, fields);
    }

    let templateTasks = 0;
    if (isNewAdmission) {
      const levelLabel = input.levelOfCare === 'gip' ? 'GIP' : input.levelOfCare;
      appendPatientEvent(tx, ctx.orgId, patientRef.id, {
        type: 'admission',
        date: input.admissionDate,
        recordedBy: ctx.uid,
        summary: `${mode === 'readmission' ? 'Readmitted' : 'Admitted'} (${levelLabel}, benefit period ${input.startingBenefitPeriod})`,
        details: {
          levelOfCare: input.levelOfCare,
          startingBenefitPeriod: input.startingBenefitPeriod,
          benefitPeriodStart: bpStart,
          careTeamUids: careTeam,
          readmission: mode === 'readmission',
          ...(mode === 'readmission'
            ? {
                priorAdmissionDate: existing?.admissionDate ?? null,
                priorDischargeDate: existing?.dischargeDate ?? null,
                priorDischargeReason: existing?.dischargeReason ?? null,
                priorMilestones: existing?.milestones ?? null,
                priorMilestoneCompletions: existing?.milestoneCompletions ?? {},
              }
            : {}),
        },
      });
      const name = patientDisplayName(input.patient);
      templateTasks = txWriteTemplateTasks(tx, ctx.orgId, 'admission', admissionTasks, { id: patientRef.id, name }, ctx.uid).length;
    }
    await writeAudit(
      ctx.orgId,
      {
        actorUid: ctx.uid,
        action: mode === 'update' ? 'patient.update' : 'patient.admit',
        resourceType: 'patient',
        resourceId: patientRef.id,
        patientId: patientRef.id,
        metadata: {
          mode,
          readmission: mode === 'readmission',
          channelId: chId,
          careTeam: careTeam.length,
          joinedChannel: isNewAdmission && joinChannel,
          transfer: bpStart !== null,
          tasks: templateTasks,
        },
      },
      tx,
    );
    return chId as string;
  });

  return { patientId: patientRef.id, channelId: result };
}

export const admitPatient = onCall(admitPatientHandler);
