/**
 * I2: referral review claims ("X is reviewing"). A claim is advisory for viewing but
 * enforced for accept/reject/non-admit: only the claimant may act while the claim is
 * live; an expired claim ({@link REFERRAL_CLAIM_MINUTES}) counts as unclaimed.
 */
import { Timestamp } from 'firebase-admin/firestore';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { writeAudit } from '../lib/audit';
import { CLINICAL_ROLES, parse, requireOrg } from '../lib/context';
import { db, docRef, paths } from '../lib/db';
import { id } from '../lib/schemas';
import {
  REFERRAL_CLAIM_MINUTES,
  type ClaimReferralRequest,
  type ClaimReferralResponse,
  type Referral,
  type TimestampLike,
} from '../shared/types';

function millis(t: TimestampLike | null | undefined): number | null {
  if (!t) return null;
  if (typeof t.toMillis === 'function') return t.toMillis();
  return t.seconds * 1000 + Math.floor((t.nanoseconds ?? 0) / 1e6);
}

/** The uid holding a live claim on `r`, or null when unclaimed or expired. */
export function activeClaimant(r: Pick<Referral, 'claimedBy' | 'claimedAt'>, nowMs: number): string | null {
  if (!r.claimedBy) return null;
  const at = millis(r.claimedAt);
  if (at !== null && nowMs - at > REFERRAL_CLAIM_MINUTES * 60_000) return null;
  return r.claimedBy;
}

/** Throws unless `uid` holds the claim or nobody does. */
export function assertClaimAllows(r: Pick<Referral, 'claimedBy' | 'claimedAt'>, uid: string, nowMs: number): void {
  const holder = activeClaimant(r, nowMs);
  if (holder && holder !== uid) {
    throw new HttpsError('failed-precondition', 'Someone else is reviewing this referral. Take over the review before changing it.');
  }
}

const claimSchema = z.object({ orgId: id, referralId: id, force: z.boolean().default(false), release: z.boolean().default(false) });
const OPEN_STATUSES = ['uploaded', 'extracting', 'needs_review', 'failed'];

export async function claimReferralHandler(
  request: CallableRequest<ClaimReferralRequest>,
  deps: { now?: () => number } = {},
): Promise<ClaimReferralResponse> {
  const input = parse(claimSchema, request.data);
  const ctx = await requireOrg(request, input.orgId, CLINICAL_ROLES);
  const ref = docRef(paths.referral(ctx.orgId, input.referralId));
  const nowMs = (deps.now ?? Date.now)();
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Referral not found.');
    const r = snap.data() as Referral;
    const holder = activeClaimant(r, nowMs);
    if (input.release) {
      if (holder !== ctx.uid) return { claimedBy: holder };
      tx.update(ref, { claimedBy: null, claimedAt: null });
      await writeAudit(ctx.orgId, { actorUid: ctx.uid, action: 'referral.claim', resourceType: 'referral', resourceId: input.referralId, metadata: { released: true } }, tx);
      return { claimedBy: null };
    }
    if (!OPEN_STATUSES.includes(r.status)) {
      throw new HttpsError('failed-precondition', `A referral that is "${r.status}" can't be claimed.`);
    }
    if (holder && holder !== ctx.uid && !input.force) {
      throw new HttpsError('already-exists', 'Someone else is reviewing this referral.');
    }
    // updatedAt is left alone: it is the staleness clock for `uploaded` referrals.
    tx.update(ref, { claimedBy: ctx.uid, claimedAt: Timestamp.fromMillis(nowMs) });
    if (holder !== ctx.uid) {
      const previous = r.claimedBy && r.claimedBy !== ctx.uid ? r.claimedBy : null;
      await writeAudit(
        ctx.orgId,
        {
          actorUid: ctx.uid,
          action: 'referral.claim',
          resourceType: 'referral',
          resourceId: input.referralId,
          metadata: { takeover: previous !== null, previousClaimant: previous, expired: previous !== null && holder === null, force: input.force },
        },
        tx,
      );
    }
    return { claimedBy: ctx.uid };
  });
}

export const claimReferral = onCall((req: CallableRequest<ClaimReferralRequest>) => claimReferralHandler(req));
