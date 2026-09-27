// v4 messaging helpers: templates, quick replies, mentions, presence, prefs.
// Runtime mirrors of the v4 constants in @shared/types (which we may only import as types).
import { createContext, useContext, useMemo, useState } from 'react';
import { addDoc, orderBy, query, serverTimestamp, Timestamp, where } from 'firebase/firestore';
import type {
  BroadcastAck,
  Channel,
  ChannelNotifyMode,
  Member,
  MessageTemplate,
  NoReplyReminder,
  OnCallRole,
  Patient,
  PresenceState,
  Priority,
  Shift,
  TemplateCategory,
  TemplateField,
} from '@shared/types';
import { orgCol, type WithId } from './firestore';
import { useLiveQuery } from './hooks';
import { patientName } from './patient';
import { tsMillis, tsToDate } from './format';
import type { OrgSession } from './session';

export const MAX_BODY = 8000;

/** Mirror of DEFAULT_QUICK_REPLIES. */
export const DEFAULT_QUICK_REPLIES: readonly string[] = [
  'Acknowledged', 'On my way', 'Call me', 'Will visit within 1 hour', 'Calling the family now', 'Please call the MD',
];

/** Mirror of ALLOWED_REACTIONS. */
export const ALLOWED_REACTIONS: readonly string[] = ['👍', '✅', '❤️', '🙏', '👀', '❗'];

export const TEMPLATE_CATEGORIES: readonly TemplateCategory[] = [
  'escalation', 'clinical', 'visit', 'end_of_life', 'orders', 'family', 'logistics', 'quick_reply',
];
export const TEMPLATE_CATEGORY_LABELS: Record<TemplateCategory, string> = {
  escalation: 'Escalation',
  clinical: 'Clinical',
  visit: 'Visits',
  end_of_life: 'End of life',
  orders: 'Orders & supplies',
  family: 'Family',
  logistics: 'Logistics',
  quick_reply: 'Quick replies',
};
export const TEMPLATE_FIELD_KINDS: readonly TemplateField['kind'][] = ['text', 'multiline', 'choice', 'number'];

/** Built-in placeholders filled from channel context. */
export const BUILTIN_PLACEHOLDERS: readonly { key: string; label: string }[] = [
  { key: 'patient', label: 'Patient full name' },
  { key: 'patientFirst', label: 'Patient first name' },
  { key: 'codeStatus', label: 'Code status' },
  { key: 'caregiver', label: 'Caregiver name' },
  { key: 'caregiverPhone', label: 'Caregiver phone' },
  { key: 'me', label: 'My name' },
  { key: 'myDiscipline', label: 'My discipline' },
  { key: 'time', label: 'Current time' },
  { key: 'date', label: "Today's date" },
];

export const NOTIFY_MODE_LABELS: Record<ChannelNotifyMode, string> = {
  all: 'All messages',
  mentions: 'Mentions only',
  urgent_only: 'Urgent only',
};

export const PRESENCE_LABELS: Record<PresenceState, string> = {
  available: 'Available',
  in_visit: 'In a visit',
  busy: 'Busy',
  off: 'Off',
};
export const PRESENCE_STATES: readonly PresenceState[] = ['available', 'in_visit', 'busy', 'off'];

export const REMINDER_MINUTES = [15, 30, 60, 120] as const;
export const EDIT_WINDOW_MS = 15 * 60 * 1000;

export function uidOf(m: WithId<Member>): string {
  return m.uid ?? m.id;
}

export function isVolunteerSession(s: OrgSession): boolean {
  return !s.isAdmin && s.member?.discipline === 'Volunteer';
}

export function myName(s: OrgSession): string {
  return (s.member?.displayName || s.user.displayName || s.user.email || 'Unknown').slice(0, 200);
}

/** Whether the current user may post in this channel (rules: not viewer, not archived, broadcast = creator only). */
export function canPostIn(channel: Channel, s: OrgSession): boolean {
  if (s.role === 'viewer' || channel.archived) return false;
  if (channel.type === 'broadcast' && channel.createdBy !== s.user.uid) return false;
  return true;
}

/**
 * Create a message with the exact client create shape (MESSAGE_CREATE_KEYS, plus `threadParentId`
 * only on thread replies). v4 fields are backend-written.
 */
export async function postMessage(
  s: OrgSession,
  channelId: string,
  body: string,
  priority: Priority,
  threadParentId?: string | null,
): Promise<void> {
  const data: Record<string, unknown> = {
    senderUid: s.user.uid,
    senderName: myName(s),
    body,
    priority,
    attachments: [],
    roleTarget: null,
    createdAt: serverTimestamp(),
    alertId: null,
  };
  if (threadParentId) data.threadParentId = threadParentId;
  await addDoc(orgCol(s.orgId, 'channels', channelId, 'messages'), data);
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export function templateMarker(id: string): string {
  return `[[tpl:${id}]]`;
}

export function sortTemplates<T extends MessageTemplate>(list: T[]): T[] {
  return [...list].sort(
    (a, b) =>
      TEMPLATE_CATEGORIES.indexOf(a.category) - TEMPLATE_CATEGORIES.indexOf(b.category) ||
      (a.order ?? 0) - (b.order ?? 0) ||
      a.title.localeCompare(b.title),
  );
}

/** Active org templates (staff only; volunteers can't read them, so the query is skipped). */
export function useOrgTemplates(s: OrgSession) {
  const skip = isVolunteerSession(s);
  const res = useLiveQuery<MessageTemplate>(
    skip ? null : query(orgCol(s.orgId, 'messageTemplates'), where('active', '==', true)),
    [s.orgId, skip],
  );
  const data = useMemo(() => sortTemplates(res.data), [res.data]);
  return { ...res, data };
}

export function usePersonalTemplates(s: OrgSession) {
  const res = useLiveQuery<MessageTemplate>(query(orgCol(s.orgId, 'members', s.user.uid, 'templates')), [s.orgId, s.user.uid]);
  const data = useMemo(() => sortTemplates(res.data.filter((t) => t.active !== false)), [res.data]);
  return { ...res, data };
}

export interface TemplateContext {
  patient: Patient | null;
  me: Member | null;
  meName: string;
}

/** Values for the built-in placeholders; keys with no value are omitted so they stay visible. */
export function builtinValues(ctx: TemplateContext, now = new Date()): Record<string, string> {
  const v: Record<string, string> = {
    me: ctx.meName,
    time: now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
    date: now.toLocaleDateString(undefined, { dateStyle: 'medium' }),
  };
  if (ctx.me?.discipline) v.myDiscipline = ctx.me.discipline;
  const p = ctx.patient;
  if (p) {
    v.patient = patientName(p);
    if (p.firstName) v.patientFirst = p.firstName;
    if (p.codeStatus) v.codeStatus = p.codeStatus;
    if (p.caregiver?.name) v.caregiver = p.caregiver.relationship ? `${p.caregiver.name} (${p.caregiver.relationship})` : p.caregiver.name;
    if (p.caregiver?.phone) v.caregiverPhone = p.caregiver.phone;
  }
  return v;
}

/** Replace `{{key}}` placeholders; unknown keys are left in place for the sender to fill. */
export function fillPlaceholders(body: string, values: Record<string, string>): string {
  return body.replace(/\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g, (m, k: string) => (k in values ? values[k]! : m));
}

// ---------------------------------------------------------------------------
// Mentions
// ---------------------------------------------------------------------------

export interface MentionCandidate {
  /** Text inserted after `@`. */
  insert: string;
  label: string;
  sub: string;
  kind: 'member' | 'role';
  uid?: string;
}

export type BodySegment = { text: string; mention?: { kind: 'member' | 'role'; uid?: string; roleKey?: string } };

/**
 * Split a body into text and @mention segments. Matches `@Display Name` (longest match,
 * case-insensitive) or `@role-key`, mirroring the server parser closely enough for display.
 */
export function splitMentions(
  body: string,
  members: { uid: string; name: string }[],
  roleKeys: string[],
): BodySegment[] {
  if (!body.includes('@')) return [{ text: body }];
  const cands = [
    ...members.filter((m) => m.name).map((m) => ({ key: m.name.toLowerCase(), len: m.name.length, uid: m.uid, roleKey: undefined as string | undefined })),
    ...roleKeys.map((r) => ({ key: r.toLowerCase(), len: r.length, uid: undefined as string | undefined, roleKey: r })),
  ].sort((a, b) => b.len - a.len);
  const lower = body.toLowerCase();
  const out: BodySegment[] = [];
  let buf = '';
  let i = 0;
  while (i < body.length) {
    const ch = body[i]!;
    const prev = i > 0 ? body[i - 1]! : ' ';
    if (ch === '@' && !/[\p{L}\p{N}_]/u.test(prev)) {
      const rest = lower.slice(i + 1);
      const hit = cands.find((c) => rest.startsWith(c.key) && !/[\p{L}\p{N}_-]/u.test(rest.charAt(c.len)));
      if (hit) {
        if (buf) out.push({ text: buf });
        buf = '';
        out.push({
          text: body.slice(i, i + 1 + hit.len),
          mention: hit.uid ? { kind: 'member', uid: hit.uid } : { kind: 'role', roleKey: hit.roleKey },
        });
        i += 1 + hit.len;
        continue;
      }
    }
    buf += ch;
    i += 1;
  }
  if (buf) out.push({ text: buf });
  return out;
}

// ---------------------------------------------------------------------------
// Presence, on-call
// ---------------------------------------------------------------------------

export interface Presence {
  /** CSS modifier: available | in_visit | busy | off | ooo | unknown */
  tone: PresenceState | 'ooo' | 'unknown';
  label: string;
  text: string | null;
  oooUntil: Date | null;
}

export function presenceOf(m: Member | null | undefined, now = Date.now()): Presence {
  const oooUntil = m?.outOfOffice ? tsToDate(m.outOfOffice.until) : null;
  const ooo = !!oooUntil && oooUntil.getTime() > now;
  const st = m?.status;
  const live = !!st && (!st.until || tsMillis(st.until) > now);
  if (ooo) return { tone: 'ooo', label: 'Out of office', text: live ? st!.text : null, oooUntil };
  if (live && st) return { tone: st.state, label: PRESENCE_LABELS[st.state] ?? st.state, text: st.text, oooUntil: null };
  return { tone: 'unknown', label: 'No status', text: null, oooUntil: null };
}

export function useOnCallRoles(orgId: string) {
  return useLiveQuery<OnCallRole>(query(orgCol(orgId, 'onCallRoles'), orderBy('label')), [orgId]);
}

/** Shifts covering now, keyed by uid → role keys (single-field range on `end`; start filtered client-side). */
export function useOnCallNow(orgId: string): { byUid: Map<string, string[]>; byRole: Map<string, string[]>; error: string | null } {
  const [now] = useState(() => new Date());
  const shifts = useLiveQuery<Shift>(
    query(orgCol(orgId, 'shifts'), where('end', '>', Timestamp.fromDate(now)), orderBy('end')),
    [orgId, now.getTime()],
  );
  return useMemo(() => {
    const t = Date.now();
    const byUid = new Map<string, string[]>();
    const byRole = new Map<string, string[]>();
    for (const sh of shifts.data) {
      if (tsMillis(sh.start) > t || tsMillis(sh.end) <= t) continue;
      byUid.set(sh.uid, [...(byUid.get(sh.uid) ?? []), sh.roleKey]);
      byRole.set(sh.roleKey, [...(byRole.get(sh.roleKey) ?? []), sh.uid]);
    }
    return { byUid, byRole, error: shifts.error };
  }, [shifts.data, shifts.error]);
}

// ---------------------------------------------------------------------------
// Chat context (shared by the bubbles of one open channel)
// ---------------------------------------------------------------------------

export interface ChatContextValue {
  channel: WithId<Channel>;
  patient: WithId<Patient> | null;
  orgTemplates: WithId<MessageTemplate>[];
  personalTemplates: WithId<MessageTemplate>[];
  roles: WithId<OnCallRole>[];
  /** Other members' lastReadAt (ms) by uid. */
  readAt: Map<string, number>;
  reminders: WithId<NoReplyReminder>[];
  myAck: WithId<BroadcastAck> | null;
  /** True until my ack doc has loaded (never offer a create over an existing ack). */
  myAckLoading: boolean;
  /** The broadcast message recipients acknowledge (first message by the channel creator). */
  ackMessageId: string | null;
  canPost: boolean;
  /** Members (uid + display name) for mention parsing. */
  mentionNames: { uid: string; name: string }[];
  roleKeys: string[];
}

export const ChatContext = createContext<ChatContextValue | null>(null);

export function useChat(): ChatContextValue {
  const c = useContext(ChatContext);
  if (!c) throw new Error('useChat must be used inside a ChatContext');
  return c;
}

/** Local "until tomorrow" = tomorrow 08:00. */
export function tomorrowMorning(now = new Date()): Date {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(8, 0, 0, 0);
  return d;
}
