import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { normalizeUids, patientChannelName } from '../domain/channels';
import { todayInTimeZone } from '../domain/dates';
import { computeMilestones } from '../domain/milestones';
import { writeAudit } from '../lib/audit';
import { CLINICAL_ROLES, parse, requireOrg } from '../lib/context';
import { colRef, db, docRef, getDocData, paths } from '../lib/db';
import { assertActiveMembers } from '../lib/members';
import { consents, id, isoDate, patientInput, uidList } from '../lib/schemas';
import type { AdmitPatientRequest, AdmitPatientResponse, Org, Patient } from '../shared/types';
import { newChannelDoc } from '../messaging/createChannel';

const schema = z.object({
  orgId: id,
  patientId: id.optional(),
  patient: patientInput.refine((p) => p.dob !== null, { message: 'dob is required for admission', path: ['dob'] }),
  admissionDate: isoDate,
  startingBenefitPeriod: z.number().int().min(1).max(100).default(1),
  levelOfCare: z.enum(['routine', 'continuous', 'respite', 'gip']),
  careTeamUids: uidList(100).min(1, 'at least one care team member is required'),
  consents,
});

export async function admitPatientHandler(request: CallableRequest<AdmitPatientRequest>): Promise<AdmitPatientResponse> {
  const input = parse(schema, request.data);
  const ctx = requireOrg(request, input.orgId, CLINICAL_ROLES);
  if (!input.consents.electionStatement || !input.consents.hipaaNotice) {
    throw new HttpsError('invalid-argument', 'The election statement and HIPAA notice must be signed before admission.');
  }
  const careTeam = normalizeUids(input.careTeamUids);
  await assertActiveMembers(ctx.orgId, normalizeUids([...careTeam, ctx.uid]));

  const org = await getDocData<Org>(paths.org(ctx.orgId));
  if (!org) throw new HttpsError('not-found', 'Organization not found.');
  const today = todayInTimeZone(new Date(), org.timezone);
  const milestones = computeMilestones(input.admissionDate, input.startingBenefitPeriod, today);

  const patientRef = input.patientId ? docRef(paths.patient(ctx.orgId, input.patientId)) : colRef(paths.patients(ctx.orgId)).doc();
  const channelMembers = normalizeUids([...careTeam, ctx.uid]);
  const channelName = patientChannelName(input.patient.firstName, input.patient.lastName);

  const channelId = await db().runTransaction(async (tx) => {
    const snap = await tx.get(patientRef);
    if (input.patientId && !snap.exists) throw new HttpsError('not-found', 'Patient not found.');
    const existing = snap.exists ? (snap.data() as Patient) : null;
    if (existing && existing.status !== 'referral' && existing.status !== 'admitted') {
      throw new HttpsError('failed-precondition', `Cannot admit a patient with status "${existing.status}".`);
    }
    const now = FieldValue.serverTimestamp();

    let chId = existing?.channelId ?? null;
    if (chId) {
      const chRef = docRef(paths.channel(ctx.orgId, chId));
      const chSnap = await tx.get(chRef);
      if (chSnap.exists) {
        tx.update(chRef, { name: channelName, memberUids: FieldValue.arrayUnion(...channelMembers) });
      } else {
        chId = null;
      }
    }
    if (!chId) {
      const chRef = colRef(paths.channels(ctx.orgId)).doc();
      chId = chRef.id;
      tx.set(chRef, newChannelDoc({ type: 'patient', name: channelName, memberUids: channelMembers, createdBy: ctx.uid, patientId: patientRef.id }));
    }

    tx.set(
      patientRef,
      {
        ...input.patient,
        status: 'admitted',
        referralId: existing?.referralId ?? null,
        admissionDate: input.admissionDate,
        startingBenefitPeriod: input.startingBenefitPeriod,
        levelOfCare: input.levelOfCare,
        careTeamUids: careTeam,
        channelId: chId,
        consents: input.consents,
        milestones,
        remindedMilestones: existing?.remindedMilestones ?? [],
        createdBy: existing?.createdBy ?? ctx.uid,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      },
      { merge: false },
    );
    await writeAudit(
      ctx.orgId,
      {
        actorUid: ctx.uid,
        action: 'patient.admit',
        resourceType: 'patient',
        resourceId: patientRef.id,
        patientId: patientRef.id,
        metadata: { readmission: existing?.status === 'admitted', channelId: chId, careTeam: careTeam.length },
      },
      tx,
    );
    return chId;
  });

  return { patientId: patientRef.id, channelId };
}

export const admitPatient = onCall(admitPatientHandler);
