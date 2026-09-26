/**
 * Shared extraction pipeline used by the storage trigger and the retry callable:
 * status → extracting, download file, Gemini extraction, normalize, status →
 * needs_review. Any failure → status failed with a PHI-free error message.
 */
import { FieldValue } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { logger } from 'firebase-functions/v2';
import { normalizeExtraction } from '../domain/referralNormalize';
import { writeAudit } from '../lib/audit';
import { db, docRef, paths } from '../lib/db';
import { ExtractionError, getDefaultExtractor, type Extractor } from '../lib/gemini';
import type { Referral, ReferralStatus } from '../shared/types';

export const MAX_REFERRAL_BYTES = 25 * 1024 * 1024;
export const ALLOWED_MIME = /^(application\/pdf|image\/(png|jpe?g|heic|heif|webp|tiff?))$/i;

export interface LoadedFile {
  data: Buffer;
  contentType: string;
  size: number;
}

export type FileLoader = (storagePath: string) => Promise<LoadedFile>;

export const storageFileLoader: FileLoader = async (storagePath) => {
  const file = getStorage().bucket().file(storagePath);
  const [exists] = await file.exists();
  if (!exists) throw new ExtractionError('file_missing', 'The uploaded file could not be found.');
  const [meta] = await file.getMetadata();
  const size = Number(meta.size ?? 0);
  if (size > MAX_REFERRAL_BYTES) throw new ExtractionError('file_too_large', 'The file is larger than 25 MB.');
  const [data] = await file.download();
  return { data, contentType: String(meta.contentType ?? ''), size };
};

export interface RunExtractionDeps {
  extractor?: Extractor;
  loadFile?: FileLoader;
}

export type RunExtractionResult = 'needs_review' | 'failed' | 'skipped';

/**
 * Runs extraction for `referralId` if its status is one of `allowedFrom`.
 * The status check + transition to `extracting` is transactional, so
 * duplicate trigger deliveries don't run the model twice.
 */
export async function runExtraction(
  orgId: string,
  referralId: string,
  allowedFrom: readonly ReferralStatus[] = ['uploaded'],
  deps: RunExtractionDeps = {},
): Promise<RunExtractionResult> {
  const ref = docRef(paths.referral(orgId, referralId));
  const referral = await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const r = snap.data() as Referral;
    if (!allowedFrom.includes(r.status)) return null;
    tx.update(ref, { status: 'extracting', error: null, updatedAt: FieldValue.serverTimestamp() });
    return r;
  });
  if (!referral) return 'skipped';

  try {
    const file = await (deps.loadFile ?? storageFileLoader)(referral.storagePath);
    if (file.size > MAX_REFERRAL_BYTES || file.data.length > MAX_REFERRAL_BYTES) {
      throw new ExtractionError('file_too_large', 'The file is larger than 25 MB.');
    }
    const mimeType = (file.contentType || referral.contentType || '').toLowerCase();
    if (!ALLOWED_MIME.test(mimeType)) throw new ExtractionError('bad_type', 'Only PDF and image files can be extracted.');

    const out = await (deps.extractor ?? getDefaultExtractor()).extract({ data: file.data, mimeType });
    const extracted = normalizeExtraction(out.raw);
    await ref.update({
      status: 'needs_review',
      extracted,
      model: out.model,
      error: null,
      updatedAt: FieldValue.serverTimestamp(),
    });
    await writeAudit(orgId, {
      actorUid: 'system',
      action: 'referral.extract',
      resourceType: 'referral',
      resourceId: referralId,
      metadata: { model: out.model, fields: Object.keys(extracted.fieldConfidence).length, warnings: extracted.warnings.length },
    });
    return 'needs_review';
  } catch (e) {
    const { publicMessage, logFields } = describeExtractionError(e);
    logger.error('referral extraction failed', { orgId, referralId, ...logFields });
    await ref.update({ status: 'failed', error: publicMessage, updatedAt: FieldValue.serverTimestamp() });
    return 'failed';
  }
}

/**
 * Turns an extraction failure into a user-facing message and safe log fields.
 * Vertex AI API errors (ApiError) describe configuration problems and never echo
 * document content, so their status and message are logged; anything else is
 * logged by class name only, because model output can contain PHI.
 */
export function describeExtractionError(e: unknown): { publicMessage: string; logFields: Record<string, unknown> } {
  if (e instanceof ExtractionError) return { publicMessage: e.publicMessage, logFields: { code: e.code } };
  const status = typeof (e as { status?: unknown })?.status === 'number' ? (e as { status: number }).status : null;
  if (status !== null) {
    const message = String((e as Error).message ?? '').slice(0, 300);
    const logFields = { code: 'vertex_api_error', status, message };
    if (status === 401 || status === 403) {
      return {
        logFields,
        publicMessage:
          'AI extraction is not set up: the Cloud Functions service account lacks Vertex AI access (roles/aiplatform.user) or the Vertex AI API is disabled. Enter the referral manually, or ask your admin to fix the setup and retry.',
      };
    }
    if (status === 404) {
      return {
        logFields,
        publicMessage:
          'AI extraction is not set up: the configured Gemini model (GEMINI_MODEL) is not available in VERTEX_LOCATION. Enter the referral manually, or ask your admin to fix the setup and retry.',
      };
    }
    if (status === 429) {
      return { logFields, publicMessage: 'The AI service is busy (quota exceeded). Retry in a minute.' };
    }
    if (status === 400) {
      return { logFields, publicMessage: 'The AI service rejected this file (it may be too large or unreadable). Enter the referral manually.' };
    }
    return { logFields, publicMessage: `The AI service returned an error (${status}). Retry, or enter the referral manually.` };
  }
  return {
    publicMessage: 'Extraction failed. Try again or enter the referral manually.',
    logFields: { code: (e as Error)?.name ?? 'unknown' },
  };
}
