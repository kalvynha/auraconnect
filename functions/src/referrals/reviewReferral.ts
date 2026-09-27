import { FieldValue } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { logger } from 'firebase-functions/v2';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { writeAudit } from '../lib/audit';
import { carePaths } from '../lib/care';
import { CLINICAL_ROLES, parse, requireOrg } from '../lib/context';
import { colRef, db, docRef, paths } from '../lib/db';
import { id, isoDate, patientInput } from '../lib/schemas';
import type {
  AcceptReferralRequest,
  AcceptReferralResponse,
  DuplicateMatch,
  Referral,
  RejectReferralRequest,
  RetryReferralRequest,
} from '../shared/types';
import { assertClaimAllows } from './claim';
import { findPossibleDuplicates } from './duplicates';
import { ALLOWED_MIME, isStaleReferral, runExtraction, type RunExtractionDeps } from './runExtraction';

const optText = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => (v === undefined ? undefined : v || null));

/** I3 referral metadata, editable during review (undefined = keep the extracted value). */
export const referralMeta = {
  referralDate: isoDate.nullable().optional(),
  referralSource: optText(300),
  reasonForReferral: optText(2000),
};

const acceptSchema = z.object({
  orgId: id,
  referralId: id,
  patient: patientInput,
  ...referralMeta,
  confirmNotDuplicate: z.boolean().default(false),
});
const rejectSchema = z.object({ orgId: id, referralId: id, reason: z.string().trim().min(1).max(1000) });
const retrySchema = z.object({ orgId: id, referralId: id });

/** Size and content type of an uploaded file, or null when it can't be read. */
export type FileStat = (storagePath: string) => Promise<{ size: number; contentType: string | null } | null>;

export const storageFileStat: FileStat = async (storagePath) => {
  try {
    const [meta] = await getStorage().bucket().file(storagePath).getMetadata();
    return { size: Number(meta.size ?? 0), contentType: meta.contentType ? String(meta.contentType) : null };
  } catch (e) {
    // L5: storage errors can echo object paths; log only the error code.
    logger.warn('referral file metadata unavailable', { code: (e as { code?: unknown })?.code ?? 'unknown' });
    return null;
  }
};

/**
 * The `patients/{pid}/documents` entry pointing at the referral file, or null when
 * the file can't be described with a valid PatientDocument shape (size ≥ 1, PDF/image).
 */
export async function referralDocumentFor(r: Referral, stat: FileStat) {
  if (!r.storagePath || !r.fileName) return null;
  const meta = await stat(r.storagePath);
  const size = Math.floor(meta?.size ?? 0);
  const contentType = meta?.contentType || r.contentType || '';
  if (size < 1 || !ALLOWED_MIME.test(contentType) || !r.fileName || r.fileName.includes('/')) return null;
  return { name: 'Referral', category: 'referral' as const, fileName: r.fileName, storagePath: r.storagePath, contentType, size, uploadedBy: r.uploadedBy };
}

export async function acceptReferralHandler(
  request: CallableRequest<AcceptReferralRequest>,
  deps: { statFile?: FileStat; now?: () => number } = {},
): Promise<AcceptReferralResponse> {
  const input = parse(acceptSchema, request.data);
  const ctx = await requireOrg(request, input.orgId, CLINICAL_ROLES);
  const ref = docRef(paths.referral(ctx.orgId, input.referralId));
  const nowMs = (deps.now ?? Date.now)();
  // Storage metadata and the duplicate check are read before the transaction.
  const pre = await ref.get();
  if (!pre.exists) throw new HttpsError('not-found', 'Referral not found.');
  const preRef = pre.data() as Referral;
  if (preRef.status === 'accepted') {
    throw new HttpsError('already-exists', 'This referral was already accepted. Open the patient instead.');
  }
  const fileDoc = await referralDocumentFor(preRef, deps.statFile ?? storageFileStat);
  const duplicates: DuplicateMatch[] = await findPossibleDuplicates(ctx.orgId, { patient: input.patient, referralId: input.referralId, now: new Date(nowMs) });
  if (duplicates.length > 0 && !input.confirmNotDuplicate) {
    await ref.update({ possibleDuplicates: duplicates });
    throw new HttpsError(
      'failed-precondition',
      `This referral may duplicate ${duplicates.length} existing record(s). Review them and confirm it is not a duplicate.`,
    );
  }

  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Referral not found.');
    const r = snap.data() as Referral;
    if (r.status === 'accepted') {
      throw new HttpsError('already-exists', 'This referral was already accepted. Open the patient instead.');
    }
    if (r.status !== 'needs_review' && r.status !== 'failed') {
      throw new HttpsError('failed-precondition', `Referral cannot be accepted from status "${r.status}".`);
    }
    assertClaimAllows(r, ctx.uid, nowMs);
    const patientRef = colRef(paths.patients(ctx.orgId)).doc();
    const now = FieldValue.serverTimestamp();
    const ex = r.extracted;
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
      referralDate: input.referralDate !== undefined ? input.referralDate : ex?.referralDate ?? null,
      referralSource: input.referralSource !== undefined ? input.referralSource : ex?.referralSource ?? null,
      reasonForReferral: input.reasonForReferral !== undefined ? input.reasonForReferral : ex?.reasonForReferral ?? null,
      referralReceivedAt: r.createdAt ?? null,
      createdBy: ctx.uid,
      createdAt: now,
      updatedAt: now,
    });
    tx.update(ref, { status: 'accepted', patientId: patientRef.id, reviewedBy: ctx.uid, possibleDuplicates: duplicates, updatedAt: now });
    // The referral file stays where it was uploaded; the patient's documents list points at it.
    const docRefForFile = fileDoc && fileDoc.storagePath === r.storagePath ? colRef(carePaths.documents(ctx.orgId, patientRef.id)).doc() : null;
    if (docRefForFile) tx.set(docRefForFile, { ...fileDoc, createdAt: now });
    else if (r.storagePath) logger.warn('referral accepted without a patient document', { referralId: input.referralId });
    await writeAudit(
      ctx.orgId,
      {
        actorUid: ctx.uid,
        action: 'referral.accept',
        resourceType: 'referral',
        resourceId: input.referralId,
        patientId: patientRef.id,
        metadata: { possibleDuplicates: duplicates.length, confirmedNotDuplicate: duplicates.length > 0 },
      },
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

export async function rejectReferralHandler(
  request: CallableRequest<RejectReferralRequest>,
  deps: { now?: () => number } = {},
): Promise<Record<string, never>> {
  const input = parse(rejectSchema, request.data);
  const ctx = await requireOrg(request, input.orgId, CLINICAL_ROLES);
  const ref = docRef(paths.referral(ctx.orgId, input.referralId));
  const nowMs = (deps.now ?? Date.now)();
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Referral not found.');
    const r = snap.data() as Referral;
    if (r.status === 'rejected') return;
    if (r.status === 'accepted' || r.status === 'non_admit') {
      throw new HttpsError('failed-precondition', `A referral that is "${r.status}" cannot be rejected.`);
    }
    // A fresh upload may still be extracting; only a stuck one can be rejected before review.
    if ((r.status === 'uploaded' || r.status === 'extracting') && !isStaleReferral(r, nowMs)) {
      throw new HttpsError('failed-precondition', 'Extraction is still running. Wait for it to finish, or reject it once it is stuck.');
    }
    assertClaimAllows(r, ctx.uid, nowMs);
    tx.update(ref, { status: 'rejected', rejectionReason: input.reason, reviewedBy: ctx.uid, updatedAt: FieldValue.serverTimestamp() });
    await writeAudit(ctx.orgId, { actorUid: ctx.uid, action: 'referral.reject', resourceType: 'referral', resourceId: input.referralId, metadata: { fromStatus: r.status } }, tx);
  });
  return {};
}

/**
 * Re-runs extraction. Allowed from `failed`/`needs_review`, and from `uploaded`/`extracting`
 * once stuck for more than REFERRAL_STALE_MINUTES. At most one retry per referral every
 * REFERRAL_RETRY_COOLDOWN_MINUTES (`resource-exhausted`).
 */
export async function retryReferralExtractionHandler(
  request: CallableRequest<RetryReferralRequest>,
  deps: RunExtractionDeps = {},
): Promise<Record<string, never>> {
  const input = parse(retrySchema, request.data);
  const ctx = await requireOrg(request, input.orgId, CLINICAL_ROLES);
  const snap = await docRef(paths.referral(ctx.orgId, input.referralId)).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Referral not found.');
  const r = snap.data() as Referral;
  const nowMs = (deps.now ?? Date.now)();
  if (!r.storagePath) throw new HttpsError('failed-precondition', 'This referral has no file to extract.');
  const stuck = r.status === 'uploaded' || r.status === 'extracting';
  if (stuck && !isStaleReferral(r, nowMs)) {
    throw new HttpsError('failed-precondition', 'Extraction is still running. Retry is available once it has been stuck for a few minutes.');
  }
  if (!stuck && r.status !== 'failed' && r.status !== 'needs_review') {
    throw new HttpsError('failed-precondition', `Extraction cannot be retried from status "${r.status}".`);
  }
  const res = await runExtraction(ctx.orgId, input.referralId, ['failed', 'needs_review'], deps, { allowStale: true, retryBy: ctx.uid });
  if (res === 'skipped') throw new HttpsError('aborted', 'The referral changed; reload and try again.');
  await writeAudit(ctx.orgId, { actorUid: ctx.uid, action: 'referral.retry', resourceType: 'referral', resourceId: input.referralId, metadata: { fromStatus: r.status, result: res } });
  return {};
}

export const acceptReferral = onCall((req: CallableRequest<AcceptReferralRequest>) => acceptReferralHandler(req));
export const rejectReferral = onCall((req: CallableRequest<RejectReferralRequest>) => rejectReferralHandler(req));
export const retryReferralExtraction = onCall(
  { timeoutSeconds: 300, memory: '512MiB' },
  (req: CallableRequest<RetryReferralRequest>) => retryReferralExtractionHandler(req),
);
