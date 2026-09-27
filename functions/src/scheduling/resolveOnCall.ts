/** Loads shifts + on-call role config and resolves who is on duty now. */
import { Timestamp } from 'firebase-admin/firestore';
import { isUnavailable } from '../domain/delivery';
import { resolveOnCall as resolveDomain, type ResolveOnCallResult } from '../domain/roleRouting';
import { colRef, getDocData, paths } from '../lib/db';
import { loadActiveMembers } from '../lib/members';
import type { OnCallRole, Shift, TimestampLike } from '../shared/types';

export interface OnCallResolution extends ResolveOnCallResult {
  role: OnCallRole | null;
}

function millis(t: TimestampLike | undefined | null): number {
  if (!t) return NaN;
  if (typeof t.toMillis === 'function') return t.toMillis();
  return t.seconds * 1000 + Math.floor((t.nanoseconds ?? 0) / 1e6);
}

export type OnCallAvailability = 'skip' | 'prefer';

/**
 * Resolves the on-call uids for `roleKey` at `now`, restricted to active
 * members and excluding `excludeUid`. Returns `role: null` when the role
 * doesn't exist. Query needs a composite index on shifts (roleKey ASC, end ASC).
 *
 * v4: members who are off (`status.state == 'off'`) or out of office are skipped and routing falls
 * through to the next shift holder or fallback (`availability: 'skip'`, the default, used by
 * sendRoleMessage, triage, broadcasts and @role mentions). Alert escalation passes `'prefer'`: it
 * still skips them, but pages them anyway when nobody else is left.
 */
export async function resolveOnCall(
  orgId: string,
  roleKey: string,
  opts: { now?: Date; excludeUid?: string | null; availability?: OnCallAvailability } = {},
): Promise<OnCallResolution> {
  const now = opts.now ?? new Date();
  const role = await getDocData<OnCallRole>(paths.onCallRole(orgId, roleKey));
  if (!role) return { role: null, uids: [], source: 'none' };
  const snap = await colRef(paths.shifts(orgId))
    .where('roleKey', '==', roleKey)
    .where('end', '>', Timestamp.fromDate(now))
    .limit(200)
    .get();
  const shifts = snap.docs.map((d) => d.data() as Shift);
  const candidates = [...shifts.map((s) => s.uid), ...(role.fallbackUids ?? [])];
  const active = await loadActiveMembers(orgId, candidates);
  const unavailable = new Set([...active.values()].filter((m) => isUnavailable(m, now.getTime())).map((m) => m.uid));
  const result = resolveDomain({
    shifts: shifts.map((s) => ({ uid: s.uid, startMs: millis(s.start), endMs: millis(s.end) })),
    fallbackUids: role.fallbackUids ?? [],
    nowMs: now.getTime(),
    excludeUid: opts.excludeUid ?? null,
    eligibleUids: new Set(active.keys()),
    unavailableUids: unavailable,
    fallbackToUnavailable: opts.availability === 'prefer',
  });
  return { ...result, role };
}
