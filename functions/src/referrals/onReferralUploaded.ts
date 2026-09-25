import { FieldValue } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { onObjectFinalized } from 'firebase-functions/v2/storage';
import { getDocData, docRef, paths } from '../lib/db';
import { STORAGE_TRIGGER_REGION } from '../lib/regions';
import type { Referral } from '../shared/types';
import { MAX_REFERRAL_BYTES, runExtraction, type RunExtractionDeps, type RunExtractionResult } from './runExtraction';

const REFERRAL_PATH = /^orgs\/([^/]+)\/referrals\/([^/]+)\/([^/]+)$/;

export function parseReferralPath(name: string): { orgId: string; referralId: string; fileName: string } | null {
  const m = REFERRAL_PATH.exec(name);
  return m ? { orgId: m[1]!, referralId: m[2]!, fileName: m[3]! } : null;
}

export async function handleReferralUploaded(
  object: { name: string; size: number | string; contentType?: string | null },
  deps: RunExtractionDeps = {},
): Promise<RunExtractionResult | 'ignored'> {
  const parsed = parseReferralPath(object.name);
  if (!parsed) return 'ignored';
  const { orgId, referralId } = parsed;
  const referral = await getDocData<Referral>(paths.referral(orgId, referralId));
  if (!referral) {
    logger.warn('referral upload without a referral document', { orgId, referralId });
    return 'ignored';
  }
  if (referral.storagePath !== object.name) {
    logger.warn('uploaded file does not match referral.storagePath; ignoring', { orgId, referralId });
    return 'ignored';
  }
  if (Number(object.size) > MAX_REFERRAL_BYTES) {
    if (referral.status === 'uploaded') {
      await docRef(paths.referral(orgId, referralId)).update({
        status: 'failed',
        error: 'The file is larger than 25 MB.',
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    return 'failed';
  }
  return runExtraction(orgId, referralId, ['uploaded'], deps);
}

export const onReferralUploaded = onObjectFinalized({ region: STORAGE_TRIGGER_REGION, memory: '1GiB', timeoutSeconds: 300 }, async (event) => {
  await handleReferralUploaded({ name: event.data.name, size: event.data.size, contentType: event.data.contentType });
});
