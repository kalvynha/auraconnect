/**
 * M4: per-user, per-action token buckets in `orgs/{orgId}/rateLimits/{uid}_{action}`
 * (written only by functions; the rules deny all client access).
 *
 * A bucket holds up to `capacity` tokens and refills continuously at `perMinute`
 * tokens per minute. Each call spends one token; with none left the call fails
 * with `resource-exhausted` and nothing else runs. One small transaction per call
 * (1 read, 1 write).
 */
import { HttpsError } from 'firebase-functions/v2/https';
import { db, docRef, paths } from './db';
import type { RateLimitBucket } from '../shared/types';

export interface RateLimitRule {
  /** Burst size (tokens when full). */
  capacity: number;
  /** Refill rate. */
  perMinute: number;
}

export const RATE_LIMITS = {
  searchMessages: { capacity: 30, perMinute: 30 },
  summarizeChannel: { capacity: 10, perMinute: 10 },
  generateHandoff: { capacity: 10, perMinute: 10 },
  generateIdgPrep: { capacity: 10, perMinute: 10 },
  sendBroadcast: { capacity: 10, perMinute: 10 },
  createAlert: { capacity: 10, perMinute: 10 },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitedAction = keyof typeof RATE_LIMITS;

export function rateLimitPath(orgId: string, uid: string, action: string): string {
  return `${paths.org(orgId)}/rateLimits/${uid}_${action}`;
}

/** Pure bucket step: returns the new token count, or null when the call must be refused. */
export function takeToken(bucket: Pick<RateLimitBucket, 'tokens' | 'refilledAtMs'> | null, rule: RateLimitRule, nowMs: number): number | null {
  const elapsedMin = bucket ? Math.max(0, nowMs - bucket.refilledAtMs) / 60_000 : Infinity;
  const available = bucket ? Math.min(rule.capacity, bucket.tokens + elapsedMin * rule.perMinute) : rule.capacity;
  if (available < 1) return null;
  return available - 1;
}

/** Spends one token for `uid`/`action`; throws `resource-exhausted` when the bucket is empty. */
export async function enforceRateLimit(orgId: string, uid: string, action: RateLimitedAction, now: Date = new Date()): Promise<void> {
  const rule = RATE_LIMITS[action];
  const ref = docRef(rateLimitPath(orgId, uid, action));
  const nowMs = now.getTime();
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const bucket = snap.exists ? (snap.data() as RateLimitBucket) : null;
    const next = takeToken(bucket, rule, nowMs);
    if (next === null) {
      throw new HttpsError('resource-exhausted', 'Too many requests. Wait a minute and try again.');
    }
    const doc: RateLimitBucket = { uid, action, tokens: next, refilledAtMs: nowMs };
    tx.set(ref, doc);
  });
}
