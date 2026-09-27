/**
 * Shared extraction pipeline used by the storage trigger and the retry callable:
 * status → extracting (with `extractionStartedAt`), resolve the gs:// file, Gemini extraction,
 * normalize, duplicate check, status → needs_review. Any failure → status failed with a PHI-free error message.
 */
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { logger } from 'firebase-functions/v2';
import { HttpsError } from 'firebase-functions/v2/https';
import { normalizeExtraction } from '../domain/referralNormalize';
import { writeAudit } from '../lib/audit';
import { db, docRef, paths } from '../lib/db';
import { ExtractionError, getDefaultExtractor, type Extractor } from '../lib/gemini';
import {
  REFERRAL_MIME_TYPES,
  REFERRAL_RETRY_COOLDOWN_MINUTES,
  REFERRAL_STALE_MINUTES,
  type Referral,
  type ReferralStatus,
  type TimestampLike,
} from '../shared/types';
import { findPossibleDuplicates } from './duplicates';

export const MAX_REFERRAL_BYTES = 25 * 1024 * 1024;
/** Exactly {@link REFERRAL_MIME_TYPES} (what Gemini accepts; also enforced by the rules). */
export const ALLOWED_MIME = new RegExp(`^(${REFERRAL_MIME_TYPES.map((t) => t.replace(/[/.+]/g, '\\$&')).join('|')})$`, 'i');

export interface ReferralFileRef {
  /** `gs://bucket/path` handed to the model. */
  uri: string;
  contentType: string;
  size: number;
}

/** Resolves the uploaded file's `gs://` URI and metadata without downloading it. */
export type FileLoader = (storagePath: string) => Promise<ReferralFileRef>;

export const storageFileLoader: FileLoader = async (storagePath) => {
  const bucket = getStorage().bucket();
  const file = bucket.file(storagePath);
  const [exists] = await file.exists();
  if (!exists) throw new ExtractionError('file_missing', 'The uploaded file could not be found.');
  const [meta] = await file.getMetadata();
  return { uri: `gs://${bucket.name}/${storagePath}`, contentType: String(meta.contentType ?? ''), size: Number(meta.size ?? 0) };
};

export interface RunExtractionDeps {
  extractor?: Extractor;
  loadFile?: FileLoader;
  /** Clock for staleness/cooldown checks (tests). */
  now?: () => number;
}

export type RunExtractionResult = 'needs_review' | 'failed' | 'skipped';

export interface RunExtractionOptions {
  /** Also allow `uploaded`/`extracting` once older than {@link REFERRAL_STALE_MINUTES}. */
  allowStale?: boolean;
  /** Retry by a person: enforces the per-referral cooldown and records `retryRequestedAt`. */
  retryBy?: string;
}

function millis(t: TimestampLike | null | undefined): number | null {
  if (!t) return null;
  if (typeof t.toMillis === 'function') return t.toMillis();
  return t.seconds * 1000 + Math.floor((t.nanoseconds ?? 0) / 1e6);
}

/** When the referral's current `uploaded`/`extracting` state began. */
export function stuckSinceMs(r: Pick<Referral, 'status' | 'extractionStartedAt' | 'updatedAt' | 'createdAt'>): number | null {
  if (r.status === 'extracting') return millis(r.extractionStartedAt) ?? millis(r.updatedAt) ?? millis(r.createdAt);
  if (r.status === 'uploaded') return millis(r.updatedAt) ?? millis(r.createdAt);
  return null;
}

/** True when an `uploaded`/`extracting` referral has been stuck longer than the stale window. */
export function isStaleReferral(r: Pick<Referral, 'status' | 'extractionStartedAt' | 'updatedAt' | 'createdAt'>, nowMs: number): boolean {
  const since = stuckSinceMs(r);
  return since !== null && nowMs - since > REFERRAL_STALE_MINUTES * 60_000;
}

/**
 * Runs extraction for `referralId` if its status is one of `allowedFrom` (or, with
 * `allowStale`, it is stuck). The status check + transition to `extracting` is
 * transactional, so duplicate trigger deliveries don't run the model twice.
 */
export async function runExtraction(
  orgId: string,
  referralId: string,
  allowedFrom: readonly ReferralStatus[] = ['uploaded'],
  deps: RunExtractionDeps = {},
  opts: RunExtractionOptions = {},
): Promise<RunExtractionResult> {
  const ref = docRef(paths.referral(orgId, referralId));
  const nowMs = (deps.now ?? Date.now)();
  const referral = await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const r = snap.data() as Referral;
    const allowed = allowedFrom.includes(r.status) || (opts.allowStale === true && isStaleReferral(r, nowMs));
    if (!allowed || !r.storagePath) return null;
    if (opts.retryBy) {
      const last = millis(r.retryRequestedAt);
      if (last !== null && nowMs - last < REFERRAL_RETRY_COOLDOWN_MINUTES * 60_000) {
        throw new HttpsError('resource-exhausted', `Extraction was retried recently. Try again in ${REFERRAL_RETRY_COOLDOWN_MINUTES} minutes.`);
      }
    }
    const now = FieldValue.serverTimestamp();
    tx.update(ref, {
      status: 'extracting',
      error: null,
      extractionStartedAt: Timestamp.fromMillis(nowMs),
      ...(opts.retryBy ? { retryRequestedAt: Timestamp.fromMillis(nowMs) } : {}),
      updatedAt: now,
    });
    return r;
  });
  if (!referral) return 'skipped';

  try {
    const file = await (deps.loadFile ?? storageFileLoader)(referral.storagePath as string);
    if (file.size > MAX_REFERRAL_BYTES) throw new ExtractionError('file_too_large', 'The file is larger than 25 MB.');
    const mimeType = (file.contentType || referral.contentType || '').toLowerCase();
    if (!ALLOWED_MIME.test(mimeType)) throw new ExtractionError('bad_type', 'Only PDF, PNG, JPEG, WebP and HEIC files can be extracted.');

    const out = await (deps.extractor ?? getDefaultExtractor()).extract({ fileUri: file.uri, mimeType });
    const extracted = normalizeExtraction(out.raw);
    let possibleDuplicates: Awaited<ReturnType<typeof findPossibleDuplicates>> = [];
    try {
      possibleDuplicates = await findPossibleDuplicates(orgId, { patient: extracted.patient, referralId, now: new Date(nowMs) });
    } catch (e) {
      // Never block review on the duplicate check; acceptReferral re-checks.
      logger.warn('referral duplicate check failed', { orgId, referralId, code: (e as { code?: unknown })?.code ?? 'unknown' });
    }
    await ref.update({
      status: 'needs_review',
      extracted,
      model: out.model,
      error: null,
      possibleDuplicates,
      updatedAt: FieldValue.serverTimestamp(),
    });
    await writeAudit(orgId, {
      actorUid: 'system',
      action: 'referral.extract',
      resourceType: 'referral',
      resourceId: referralId,
      metadata: {
        model: out.model,
        fields: Object.keys(extracted.fieldConfidence).length,
        warnings: extracted.warnings.length,
        possibleDuplicates: possibleDuplicates.length,
      },
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
