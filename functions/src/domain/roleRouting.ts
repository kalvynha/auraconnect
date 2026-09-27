/**
 * On-call role routing. Pure module: no Firebase imports.
 *
 * A shift covers an instant when `start <= now < end` (end is exclusive, so a
 * hand-off at 19:00 routes to the incoming shift only). Overlapping shifts all
 * count: everyone on duty is returned, ordered by shift start then uid.
 * When no eligible scheduled person remains, the role's `fallbackUids` are used.
 *
 * v4: members who are off or out of office (`unavailableUids`) are skipped, so routing falls through
 * to the next shift holder or the fallback. With `fallbackToUnavailable` (alert escalation), when
 * skipping them would leave nobody the unavailable people are used rather than paging no one.
 */

export interface ShiftSpan {
  uid: string;
  startMs: number;
  endMs: number;
}

export interface ResolveOnCallInput {
  shifts: readonly ShiftSpan[];
  fallbackUids: readonly string[];
  nowMs: number;
  /** Usually the caller: never route a message back to its sender. */
  excludeUid?: string | null;
  /** When provided, only these uids are eligible (e.g. active org members). */
  eligibleUids?: ReadonlySet<string> | null;
  /** v4: members who are off or out of office; skipped. */
  unavailableUids?: ReadonlySet<string> | null;
  /** v4: when skipping unavailable members leaves nobody, resolve again without skipping them. */
  fallbackToUnavailable?: boolean;
}

export interface ResolveOnCallResult {
  uids: string[];
  source: 'shift' | 'fallback' | 'none';
}

export function shiftCovers(shift: ShiftSpan, nowMs: number): boolean {
  return shift.startMs <= nowMs && nowMs < shift.endMs;
}

export function resolveOnCall(input: ResolveOnCallInput): ResolveOnCallResult {
  const eligible = (uid: string) =>
    !!uid && uid !== input.excludeUid && (!input.eligibleUids || input.eligibleUids.has(uid));
  const unavailable = input.unavailableUids;
  const available = (uid: string) => eligible(uid) && !unavailable?.has(uid);
  const res = resolveWith(input, available);
  if (res.uids.length > 0 || !unavailable?.size || !input.fallbackToUnavailable) return res;
  return resolveWith(input, eligible);
}

function resolveWith(input: ResolveOnCallInput, ok: (uid: string) => boolean): ResolveOnCallResult {
  const onShift = input.shifts
    .filter((s) => shiftCovers(s, input.nowMs) && ok(s.uid))
    .sort((a, b) => a.startMs - b.startMs || (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0))
    .map((s) => s.uid);
  const shiftUids = [...new Set(onShift)];
  if (shiftUids.length > 0) return { uids: shiftUids, source: 'shift' };

  const fallback = [...new Set(input.fallbackUids.filter(ok))];
  if (fallback.length > 0) return { uids: fallback, source: 'fallback' };
  return { uids: [], source: 'none' };
}
