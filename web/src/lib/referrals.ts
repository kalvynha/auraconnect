import { useEffect, useState } from 'react';
import type { Referral } from '@shared/types';
import { REFERRAL_CLAIM_MINUTES, REFERRAL_MIME_TYPES, REFERRAL_STALE_MINUTES } from './constants';
import { tsMillis } from './format';

export const MAX_REFERRAL_BYTES = 25 * 1024 * 1024;

/** Re-renders every `ms` so time-based states (stale, claim expiry) update on their own. */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}

function ms(t: Referral['updatedAt'] | null | undefined): number | null {
  const v = tsMillis(t ?? null);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** Mirrors the server's `isStaleReferral`: `uploaded`/`extracting` for more than REFERRAL_STALE_MINUTES. */
export function isStaleReferral(r: Pick<Referral, 'status' | 'extractionStartedAt' | 'updatedAt' | 'createdAt'>, now: number): boolean {
  let since: number | null = null;
  if (r.status === 'extracting') since = ms(r.extractionStartedAt) ?? ms(r.updatedAt) ?? ms(r.createdAt);
  else if (r.status === 'uploaded') since = ms(r.updatedAt) ?? ms(r.createdAt);
  return since !== null && now - since > REFERRAL_STALE_MINUTES * 60_000;
}

/** The uid holding a live review claim, or null (mirrors the server's `activeClaimant`). */
export function activeClaimant(r: Pick<Referral, 'claimedBy' | 'claimedAt'>, now: number): string | null {
  if (!r.claimedBy) return null;
  const at = ms(r.claimedAt);
  if (at !== null && now - at > REFERRAL_CLAIM_MINUTES * 60_000) return null;
  return r.claimedBy;
}

/** Returns an error message for a file the server would refuse, or null when it's acceptable. */
export function referralFileError(file: File): string | null {
  if (!REFERRAL_MIME_TYPES.includes(file.type)) {
    return `${file.name}: only PDF, PNG, JPEG, WebP or HEIC files can be uploaded${file.type ? ` (this is ${file.type})` : ''}.`;
  }
  if (file.size > MAX_REFERRAL_BYTES) return `${file.name}: the file is larger than 25 MB.`;
  if (file.size === 0) return `${file.name}: the file is empty.`;
  return null;
}

export function safeFileName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+/, '');
  const out = cleaned.slice(-120);
  return !out || /^\.+$/.test(out) ? 'referral' : out;
}
