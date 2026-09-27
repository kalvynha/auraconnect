/**
 * I5: phone referrals (no file) and non-admits.
 *
 *  - `createManualReferral` writes a `source: 'phone'` referral with no file straight
 *    into `needs_review`; the entered data is stored as `extracted` (confidence map empty)
 *    so review, duplicate detection and accept work exactly as for scanned referrals.
 *  - `closeReferralNonAdmit` closes a referral (from `needs_review`, `failed` or
 *    `accepted`) without admission. For an accepted referral whose patient is still
 *    `referral`, the patient becomes `non_admit`; open visits/tasks for them are cancelled.
 *    `died_before_admission` records the date of death but never creates a bereavement
 *    plan (the family was never under hospice care).
 */
import { FieldValue, Timestamp, type DocumentReference } from 'firebase-admin/firestore';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { todayInTimeZone } from '../domain/dates';
import { writeAudit } from '../lib/audit';
import { orgSettings, requireOrgDoc, txPrepareCancelOpenWork } from '../lib/care';
import { CLINICAL_ROLES, parse, requireOrg } from '../lib/context';
import { colRef, db, docRef, paths } from '../lib/db';
import { id, isoDate, patientInput } from '../lib/schemas';
import {
  NON_ADMIT_REASONS,
  type CloseReferralNonAdmitRequest,
  type CreateManualReferralRequest,
  type IdResponse,
  type Patient,
  type Referral,
} from '../shared/types';
import { assertClaimAllows } from './claim';
import { findPossibleDuplicates } from './duplicates';
import { referralMeta } from './reviewReferral';

const manualSchema = z.object({ orgId: id, patient: patientInput, ...referralMeta });

export async function createManualReferralHandler(request: CallableRequest<CreateManualReferralRequest>): Promise<IdResponse> {
  const input = parse(manualSchema, request.data);
  const ctx = await requireOrg(request, input.orgId, CLINICAL_ROLES);
  const ref = colRef(`orgs/${ctx.orgId}/referrals`).doc();
  const possibleDuplicates = await findPossibleDuplicates(ctx.orgId, { patient: input.patient, referralId: ref.id });
  const now = FieldValue.serverTimestamp();
  const batch = db().batch();
  batch.create(ref, {
    fileName: null,
    contentType: null,
    storagePath: null,
    source: 'phone',
    status: 'needs_review',
    extracted: {
      patient: input.patient,
      referralDate: input.referralDate ?? null,
      referralSource: input.referralSource ?? null,
      reasonForReferral: input.reasonForReferral ?? null,
      fieldConfidence: {},
      warnings: [],
    },
    error: null,
    model: null,
    patientId: null,
    uploadedBy: ctx.uid,
    reviewedBy: null,
    rejectionReason: null,
    extractionStartedAt: null,
    retryRequestedAt: null,
    // The person taking the call is reviewing it.
    claimedBy: ctx.uid,
    claimedAt: Timestamp.now(),
    possibleDuplicates,
    nonAdmit: null,
    createdAt: now,
    updatedAt: now,
  });
  await writeAudit(
    ctx.orgId,
    { actorUid: ctx.uid, action: 'referral.create', resourceType: 'referral', resourceId: ref.id, metadata: { source: 'phone', possibleDuplicates: possibleDuplicates.length } },
    batch,
  );
  await batch.commit();
  return { id: ref.id };
}

const nonAdmitSchema = z.object({
  orgId: id,
  referralId: id,
  reason: z.enum(NON_ADMIT_REASONS as unknown as [string, ...string[]]),
  note: z.string().trim().max(2000).nullable().optional().transform((v) => v || null),
  deathDate: isoDate.nullable().optional(),
});

export async function closeReferralNonAdmitHandler(
  request: CallableRequest<CloseReferralNonAdmitRequest>,
  deps: { now?: () => number } = {},
): Promise<Record<string, never>> {
  const input = parse(nonAdmitSchema, request.data);
  const ctx = await requireOrg(request, input.orgId, CLINICAL_ROLES);
  const nowMs = (deps.now ?? Date.now)();
  const org = await requireOrgDoc(ctx.orgId);
  const today = todayInTimeZone(new Date(nowMs), orgSettings(org).timezone);
  const died = input.reason === 'died_before_admission';
  const deathDate = died ? input.deathDate ?? today : null;
  if (deathDate && deathDate > today) throw new HttpsError('invalid-argument', 'The date of death cannot be in the future.');
  if (input.reason === 'other' && !input.note) throw new HttpsError('invalid-argument', 'Add a note explaining the reason.');
  const ref = docRef(paths.referral(ctx.orgId, input.referralId));

  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Referral not found.');
    const r = snap.data() as Referral;
    if (r.status === 'non_admit') return; // idempotent retry
    if (r.status !== 'needs_review' && r.status !== 'failed' && r.status !== 'accepted') {
      throw new HttpsError('failed-precondition', `A referral that is "${r.status}" can't be closed as a non-admit.`);
    }
    if (r.status !== 'accepted') assertClaimAllows(r, ctx.uid, nowMs);

    let patient: { ref: DocumentReference; data: Patient } | null = null;
    if (r.status === 'accepted' && r.patientId) {
      const pRef = docRef(paths.patient(ctx.orgId, r.patientId));
      const pSnap = await tx.get(pRef);
      if (pSnap.exists) patient = { ref: pRef, data: pSnap.data() as Patient };
      if (patient && patient.data.status !== 'referral') {
        throw new HttpsError(
          'failed-precondition',
          patient.data.status === 'non_admit'
            ? 'This patient is already closed as a non-admit.'
            : `The patient is already "${patient.data.status}". Use discharge or death instead.`,
        );
      }
    }
    const cancel = patient ? await txPrepareCancelOpenWork(tx, ctx.orgId, patient.ref.id, new Date(nowMs)) : null;

    const record = { reason: input.reason, note: input.note, deathDate, closedBy: ctx.uid, closedAt: Timestamp.fromMillis(nowMs) };
    const now = FieldValue.serverTimestamp();
    tx.update(ref, { status: 'non_admit', nonAdmit: record, reviewedBy: ctx.uid, claimedBy: null, claimedAt: null, updatedAt: now });
    if (patient) {
      const update: Record<string, unknown> = { status: 'non_admit', nonAdmit: record, updatedAt: now };
      // Recorded for the chart only: no bereavement plan for a patient never admitted.
      if (deathDate) update.death = { date: deathDate, time: null, pronouncedBy: null, location: null, notes: null };
      tx.update(patient.ref, update);
      cancel?.apply(died ? 'Died before admission' : 'Not admitted');
    }
    await writeAudit(
      ctx.orgId,
      {
        actorUid: ctx.uid,
        action: 'referral.non_admit',
        resourceType: 'referral',
        resourceId: input.referralId,
        patientId: patient?.ref.id ?? null,
        metadata: {
          reason: input.reason,
          fromStatus: r.status,
          patientClosed: patient !== null,
          cancelledVisits: cancel?.visits ?? 0,
          cancelledTasks: cancel?.tasks ?? 0,
        },
      },
      tx,
    );
  });
  return {};
}

export const createManualReferral = onCall((req: CallableRequest<CreateManualReferralRequest>) => createManualReferralHandler(req));
export const closeReferralNonAdmit = onCall((req: CallableRequest<CloseReferralNonAdmitRequest>) => closeReferralNonAdmitHandler(req));
