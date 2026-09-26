import { FieldValue } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { logger } from 'firebase-functions/v2';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { writeAudit } from '../lib/audit';
import { carePaths } from '../lib/care';
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
import { ALLOWED_MIME, runExtraction, type RunExtractionDeps } from './runExtraction';

const acceptSchema = z.object({ orgId: id, referralId: id, patient: patientInput });
const rejectSchema = z.object({ orgId: id, referralId: id, reason: z.string().trim().min(1).max(1000) });
const retrySchema = z.object({ orgId: id, referralId: id });

/** Size and content type of an uploaded file, or null when it can't be read. */
export type FileStat = (storagePath: string) => Promise<{ size: number; contentType: string | null } | null>;

export const storageFileStat: FileStat = async (storagePath) => {
  try {
    const [meta] = await getStorage().bucket().file(storagePath).getMetadata();
    return { size: Number(meta.size ?? 0), contentType: meta.contentType ? String(meta.contentType) : null };
  } catch (e) {
    logger.warn('referral file metadata unavailable', { error: (e as Error).message });
    return null;
  }
};

/**
 * The `patients/{pid}/documents` entry pointing at the referral file, or null when
 * the file can't be described with a valid PatientDocument shape (size ≥ 1, PDF/image).
 */
export async function referralDocumentFor(r: Referral, stat: FileStat) {
  const meta = await stat(r.storagePath);
  const size = Math.floor(meta?.size ?? 0);
  const contentType = meta?.contentType || r.contentType;
  if (size < 1 || !ALLOWED_MIME.test(contentType) || !r.fileName || r.fileName.includes('/')) return null;
  return { name: 'Referral', category: 'referral' as const, fileName: r.fileName, storagePath: r.storagePath, contentType, size, uploadedBy: r.uploadedBy };
}

export async function acceptReferralHandler(
  request: CallableRequest<AcceptReferralRequest>,
  deps: { statFile?: FileStat } = {},
): Promise<AcceptReferralResponse> {
  const input = parse(acceptSchema, request.data);
  const ctx = requireOrg(request, input.orgId, CLINICAL_ROLES);
  const ref = docRef(paths.referral(ctx.orgId, input.referralId));
  // Storage metadata is read before the transaction (no I/O inside it besides Firestore).
  const pre = await ref.get();
  const fileDoc = pre.exists ? await referralDocumentFor(pre.data() as Referral, deps.statFile ?? storageFileStat) : null;

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
    // The referral file stays where it was uploaded; the patient's documents list points at it.
    const docRefForFile = fileDoc && fileDoc.storagePath === r.storagePath ? colRef(carePaths.documents(ctx.orgId, patientRef.id)).doc() : null;
    if (docRefForFile) tx.set(docRefForFile, { ...fileDoc, createdAt: now });
    else logger.warn('referral accepted without a patient document', { referralId: input.referralId });
    await writeAudit(
      ctx.orgId,
      { actorUid: ctx.uid, action: 'referral.accept', resourceType: 'referral', resourceId: input.referralId, patientId: patientRef.id },
      tx,
    );
    if (docRefForFile) await writeAudit(
      ctx.orgId,
      {
        actorUid: ctx.uid,
        action: 'document.upload',
        resourceType: 'document',
        resourceId: docRefForFile.id,
        patientId: patientRef.id,
        metadata: { category: 'referral', referralId: input.referralId },
      },
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

export const acceptReferral = onCall((req: CallableRequest<AcceptReferralRequest>) => acceptReferralHandler(req));
export const rejectReferral = onCall(rejectReferralHandler);
export const retryReferralExtraction = onCall(
  { timeoutSeconds: 300, memory: '1GiB' },
  (req: CallableRequest<RetryReferralRequest>) => retryReferralExtractionHandler(req),
);
