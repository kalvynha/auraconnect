/** Member lookups shared by callables. */
import { HttpsError } from 'firebase-functions/v2/https';
import type { Member } from '../shared/types';
import { getMany, paths } from './db';

/** Active members among `uids`, keyed by uid. */
export async function loadActiveMembers(orgId: string, uids: readonly string[]): Promise<Map<string, Member>> {
  const docs = await getMany<Member>(uids.map((u) => paths.member(orgId, u)));
  const out = new Map<string, Member>();
  for (const m of docs.values()) if (m.active) out.set(m.uid, m);
  return out;
}

/** Throws `invalid-argument` unless every uid is an active member of the org. */
export async function assertActiveMembers(orgId: string, uids: readonly string[]): Promise<Map<string, Member>> {
  const unique = [...new Set(uids)];
  const found = await loadActiveMembers(orgId, unique);
  const missing = unique.filter((u) => !found.has(u));
  if (missing.length > 0) {
    throw new HttpsError('invalid-argument', `${missing.length} user(s) are not active members of this organization.`);
  }
  return found;
}
