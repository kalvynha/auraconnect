import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { writeAudit } from '../lib/audit';
import { CLINICAL_ROLES, parse, requireOrg } from '../lib/context';
import { colRef, db, docRef, paths } from '../lib/db';
import { id, patientInput } from '../lib/schemas';
import type {
  AcceptReferralRequest,
  AcceptReferralResponse,
  Referral,
  RejectReferralRequest,
  RetryReferralRequest,
} from '../shared/types';
import { runExtraction, type RunExtractionDeps } from './runExtraction';

const acceptSchema = z.object({ orgId: id, referralId: id, patient: patientInput });
const rejectSchema = z.object({ orgId: id, referralId: id, reason: z.string().trim().min(1).max(1000) });
const retrySchema = z.object({ orgId: id, referralId: id });

export async function acceptReferralHandler(request: CallableRequest<AcceptReferralRequest>): Promise<AcceptReferralResponse> {
  const input = parse(acceptSchema, request.data);
  const ctx = requireOrg(request, input.orgId, CLINICAL_ROLES);
  const ref = docRef(paths.referral(ctx.orgId, input.referralId));

  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Referral not found.');
    const r = snap.data() as Referral;
    if (r.status === 'accepted' && r.patientId) return { patientId: r.patientId };
    if (r.status !== 'needs_review' && r.status !== 'failed') {
      throw new HttpsError('failed-precondition', `Referral cannot be accepted from status "${r.status}".`);
    }
    const patientRef = colRef(paths.patients(ctx.orgId)).doc();
    const now = FieldValue.serverTimestamp();
    tx.create(patientRef, {
      ...input.patient,
      status: 'referral',
      referralId: input.referralId,
      admissionDate: null,
      startingBenefitPeriod: 1,
      levelOfCare: 'routine',
      careTeamUids: [],
      channelId: null,
      consents: null,
      milestones: null,
      remindedMilestones: [],
      createdBy: ctx.uid,
      createdAt: now,
      updatedAt: now,
    });
    tx.update(ref, { status: 'accepted', patientId: patientRef.id, reviewedBy: ctx.uid, updatedAt: now });
    await writeAudit(
      ctx.orgId,
      { actorUid: ctx.uid, action: 'referral.accept', resourceType: 'referral', resourceId: input.referralId, patientId: patientRef.id },
      tx,
    );
    return { patientId: patientRef.id };
  });
}

export async function rejectReferralHandler(request: CallableRequest<RejectReferralRequest>): Promise<Record<string, never>> {
  const input = parse(rejectSchema, request.data);
  const ctx = requireOrg(request, input.orgId, CLINICAL_ROLES);
  const ref = docRef(paths.referral(ctx.orgId, input.referralId));
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Referral not found.');
    const r = snap.data() as Referral;
    if (r.status === 'rejected') return;
    if (r.status === 'accepted') throw new HttpsError('failed-precondition', 'An accepted referral cannot be rejected.');
    tx.update(ref, { status: 'rejected', rejectionReason: input.reason, reviewedBy: ctx.uid, updatedAt: FieldValue.serverTimestamp() });
    await writeAudit(ctx.orgId, { actorUid: ctx.uid, action: 'referral.reject', resourceType: 'referral', resourceId: input.referralId }, tx);
  });
  return {};
}

export async function retryReferralExtractionHandler(
  request: CallableRequest<RetryReferralRequest>,
  deps: RunExtractionDeps = {},
): Promise<Record<string, never>> {
  const input = parse(retrySchema, request.data);
  const ctx = requireOrg(request, input.orgId, CLINICAL_ROLES);
  const snap = await docRef(paths.referral(ctx.orgId, input.referralId)).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Referral not found.');
  const status = (snap.data() as Referral).status;
  if (status !== 'failed' && status !== 'needs_review' && status !== 'uploaded') {
    throw new HttpsError('failed-precondition', `Extraction cannot be retried from status "${status}".`);
  }
  const res = await runExtraction(ctx.orgId, input.referralId, ['failed', 'needs_review', 'uploaded'], deps);
  if (res === 'skipped') throw new HttpsError('aborted', 'The referral changed; reload and try again.');
  return {};
}

export const acceptReferral = onCall(acceptReferralHandler);
export const rejectReferral = onCall(rejectReferralHandler);
export const retryReferralExtraction = onCall(
  { timeoutSeconds: 300, memory: '1GiB' },
  (req: CallableRequest<RetryReferralRequest>) => retryReferralExtractionHandler(req),
);
