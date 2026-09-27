/**
 * v4 notification delivery filtering and member availability. Pure module: no Firebase imports.
 *
 * Normal-priority messages only; urgent and critical always push. A recipient is skipped when any of:
 *  - their channel prefs are `mutedUntil > now`
 *  - their channel mode is `mentions` and they aren't mentioned
 *  - their channel mode is `urgent_only`
 *  - they are in quiet hours (org time zone)
 *  - `offShiftQuiet` is on, they have on-call shifts, and none covers now
 *  - they are out of office, unless mentioned
 * Direct messages always push unless the channel is muted.
 */
import type {
  ChannelNotifyMode, ChannelPrefs, ChannelType, Member, NotificationSettings, Priority, TimestampLike,
} from '../shared/types';
import { isValidTimeZone } from './dates';

export type SkipReason = 'muted' | 'mentions_only' | 'urgent_only' | 'quiet_hours' | 'off_shift' | 'out_of_office';

export type DeliveryDecision = { push: true } | { push: false; reason: SkipReason };

export interface RecipientState {
  /** The member's `channels/{cid}/prefs/{uid}` doc, if any. */
  prefs: Pick<ChannelPrefs, 'mode' | 'mutedUntil'> | null;
  /** `member.notificationSettings`, if any. */
  settings: NotificationSettings | null;
  /** `member.outOfOffice.until` in epoch ms, or null. */
  outOfOfficeUntilMs: number | null;
  /** The member holds on-call shifts (only consulted when `offShiftQuiet` is on). */
  hasShifts: boolean;
  /** One of those shifts covers now. */
  onShiftNow: boolean;
  mentioned: boolean;
}

export interface DeliveryContext {
  priority: Priority;
  channelType: ChannelType;
  nowMs: number;
  /** Org IANA time zone (quiet hours are local to it). */
  timeZone: string;
}

export function toMs(t: TimestampLike | Date | null | undefined): number | null {
  if (!t) return null;
  if (t instanceof Date) return t.getTime();
  if (typeof t.toMillis === 'function') return t.toMillis();
  if (typeof t.seconds !== 'number') return null;
  return t.seconds * 1000 + Math.floor((t.nanoseconds ?? 0) / 1e6);
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Minutes after midnight for an `HH:mm` string, or null when malformed. */
export function parseHHmm(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const m = HHMM.exec(v);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Local minute of the day (0–1439) of `nowMs` in `timeZone` (UTC for an invalid zone). */
export function localMinuteOfDay(nowMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: isValidTimeZone(timeZone) ? timeZone : 'UTC',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(nowMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return get('hour') * 60 + get('minute');
}

/**
 * True when local time is inside `[start, end)`. A window whose start is after its end wraps past
 * midnight (22:00–07:00). `start == end` or a malformed value means no quiet hours.
 */
export function isInQuietHours(nowMs: number, timeZone: string, quietHours: NotificationSettings['quietHours'] | null | undefined): boolean {
  if (!quietHours) return false;
  const start = parseHHmm(quietHours.start);
  const end = parseHHmm(quietHours.end);
  if (start === null || end === null || start === end) return false;
  const now = localMinuteOfDay(nowMs, timeZone);
  return start < end ? now >= start && now < end : now >= start || now < end;
}

/** `outOfOffice.until > now`. */
export function isOutOfOffice(member: Pick<Member, 'outOfOffice'> | null | undefined, nowMs: number): boolean {
  const until = toMs(member?.outOfOffice?.until ?? null);
  return until !== null && until > nowMs;
}

/** Status `off` that hasn't auto-cleared (`until` null or in the future). */
export function isOff(member: Pick<Member, 'status'> | null | undefined, nowMs: number): boolean {
  const s = member?.status;
  if (!s || s.state !== 'off') return false;
  const until = toMs(s.until ?? null);
  return until === null || until > nowMs;
}

/** Role routing skips members who are off or out of office. */
export function isUnavailable(member: Pick<Member, 'status' | 'outOfOffice'> | null | undefined, nowMs: number): boolean {
  return isOff(member, nowMs) || isOutOfOffice(member, nowMs);
}

function channelMode(prefs: RecipientState['prefs']): ChannelNotifyMode {
  const m = prefs?.mode;
  return m === 'mentions' || m === 'urgent_only' ? m : 'all';
}

export function decideDelivery(r: RecipientState, ctx: DeliveryContext): DeliveryDecision {
  if (ctx.priority === 'urgent' || ctx.priority === 'critical') return { push: true };
  const mutedUntil = toMs(r.prefs?.mutedUntil ?? null);
  if (mutedUntil !== null && mutedUntil > ctx.nowMs) return { push: false, reason: 'muted' };
  if (ctx.channelType === 'direct') return { push: true };
  const mode = channelMode(r.prefs);
  if (mode === 'urgent_only') return { push: false, reason: 'urgent_only' };
  if (mode === 'mentions' && !r.mentioned) return { push: false, reason: 'mentions_only' };
  if (isInQuietHours(ctx.nowMs, ctx.timeZone, r.settings?.quietHours)) return { push: false, reason: 'quiet_hours' };
  if (r.settings?.offShiftQuiet === true && r.hasShifts && !r.onShiftNow) return { push: false, reason: 'off_shift' };
  if (r.outOfOfficeUntilMs !== null && r.outOfOfficeUntilMs > ctx.nowMs && !r.mentioned) {
    return { push: false, reason: 'out_of_office' };
  }
  return { push: true };
}

/** Out-of-office auto-reply text: "{name} is out of office until {date}. Contact {delegate} instead." */
export function outOfOfficeReply(p: { name: string; untilMs: number; timeZone: string; delegateName: string | null }): string {
  const date = new Intl.DateTimeFormat('en-US', {
    timeZone: isValidTimeZone(p.timeZone) ? p.timeZone : 'UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(p.untilMs));
  const base = `${p.name} is out of office until ${date}.`;
  return p.delegateName ? `${base} Contact ${p.delegateName} instead.` : base;
}
