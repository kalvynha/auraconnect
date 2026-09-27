/**
 * v4: notification delivery filtering for `onMessageCreated` (the I/O half; decisions are in
 * `domain/delivery.ts`).
 *
 * Reads stay bounded: recipient member docs and their `prefs/{uid}` docs are fetched together in one
 * batched `getAll` (the member docs are then handed to `pushToMembers`, so they aren't read twice).
 * The org doc (time zone) is read only when someone has quiet hours, and shifts only for members with
 * `offShiftQuiet` on.
 */
import { Timestamp } from 'firebase-admin/firestore';
import { decideDelivery, toMs, type SkipReason } from '../domain/delivery';
import { colRef, getMany, paths } from '../lib/db';
import type { ChannelPrefs, ChannelType, Member, Priority, Shift } from '../shared/types';

/** Shifts that ended within this window still count as "has on-call shifts". */
export const OFF_SHIFT_LOOKBACK_MS = 14 * 86_400_000;

export interface RecipientDocs {
  members: Map<string, Member>;
  prefs: Map<string, ChannelPrefs>;
}

/** One batched read of the members' docs and (optionally) their channel prefs. */
export async function loadRecipientDocs(orgId: string, channelId: string, uids: readonly string[], withPrefs: boolean): Promise<RecipientDocs> {
  const memberPaths = uids.map((u) => paths.member(orgId, u));
  const prefPaths = withPrefs ? uids.map((u) => paths.channelPrefs(orgId, channelId, u)) : [];
  const docs = await getMany<Member | ChannelPrefs>([...memberPaths, ...prefPaths]);
  const members = new Map<string, Member>();
  const prefs = new Map<string, ChannelPrefs>();
  uids.forEach((u, i) => {
    const m = docs.get(memberPaths[i]!) as Member | undefined;
    if (m) members.set(u, { ...m, uid: m.uid ?? u });
    if (withPrefs) {
      const p = docs.get(prefPaths[i]!) as ChannelPrefs | undefined;
      if (p) prefs.set(u, p);
    }
  });
  return { members, prefs };
}

export interface ShiftCoverage {
  hasShifts: boolean;
  onShiftNow: boolean;
}

/** For each uid: holds on-call shifts (ending after now − 14 days) and whether one covers now. */
export async function loadShiftCoverage(orgId: string, uids: readonly string[], now: Date): Promise<Map<string, ShiftCoverage>> {
  const out = new Map<string, ShiftCoverage>(uids.map((u) => [u, { hasShifts: false, onShiftNow: false }]));
  const nowMs = now.getTime();
  const since = Timestamp.fromMillis(nowMs - OFF_SHIFT_LOOKBACK_MS);
  for (let i = 0; i < uids.length; i += 30) {
    const chunk = uids.slice(i, i + 30);
    const snap = await colRef(paths.shifts(orgId)).where('uid', 'in', chunk).where('end', '>', since).limit(500).get();
    for (const d of snap.docs) {
      const s = d.data() as Shift;
      const c = out.get(s.uid);
      if (!c) continue;
      c.hasShifts = true;
      const start = toMs(s.start) ?? Infinity;
      const end = toMs(s.end) ?? -Infinity;
      if (start <= nowMs && nowMs < end) c.onShiftNow = true;
    }
  }
  return out;
}

export interface FilterResult {
  push: string[];
  skipped: Partial<Record<SkipReason, number>>;
}

/** Applies the v4 delivery rules to `recipients` (normal priority; urgent/critical pass through). */
export async function filterRecipients(p: {
  orgId: string;
  channelType: ChannelType;
  priority: Priority;
  recipients: readonly string[];
  docs: RecipientDocs;
  mentioned: ReadonlySet<string>;
  now: Date;
  /** Lazily reads the org time zone (only when someone has quiet hours). */
  timeZone: () => Promise<string>;
}): Promise<FilterResult> {
  if (p.priority !== 'normal') return { push: [...p.recipients], skipped: {} };
  const nowMs = p.now.getTime();
  const settingsOf = (u: string) => p.docs.members.get(u)?.notificationSettings ?? null;
  const needsTz = p.channelType !== 'direct' && p.recipients.some((u) => !!settingsOf(u)?.quietHours);
  const timeZone = needsTz ? await p.timeZone() : 'UTC';
  const offShiftUids = p.channelType === 'direct' ? [] : p.recipients.filter((u) => settingsOf(u)?.offShiftQuiet === true);
  const coverage = offShiftUids.length ? await loadShiftCoverage(p.orgId, offShiftUids, p.now) : new Map<string, ShiftCoverage>();

  const push: string[] = [];
  const skipped: FilterResult['skipped'] = {};
  for (const uid of p.recipients) {
    const member = p.docs.members.get(uid);
    const cov = coverage.get(uid);
    const d = decideDelivery(
      {
        prefs: p.docs.prefs.get(uid) ?? null,
        settings: settingsOf(uid),
        outOfOfficeUntilMs: toMs(member?.outOfOffice?.until ?? null),
        hasShifts: cov?.hasShifts ?? false,
        onShiftNow: cov?.onShiftNow ?? false,
        mentioned: p.mentioned.has(uid),
      },
      { priority: p.priority, channelType: p.channelType, nowMs, timeZone },
    );
    if (d.push) push.push(uid);
    else skipped[d.reason] = (skipped[d.reason] ?? 0) + 1;
  }
  return { push, skipped };
}
