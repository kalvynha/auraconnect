/** v4 messaging: templates, mentions, delivery filtering, out of office, tracking, acks, pins, reactions, edits. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('firebase-admin/firestore', () => import('../fakes/firestore'));
vi.mock('../../src/lib/notify', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/notify')>()),
  pushToMembers: vi.fn(async () => ({ sent: 1, failed: 0, pruned: 0 })),
}));
vi.mock('../../src/lib/tasks', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/tasks')>()),
  enqueueEscalationCheck: vi.fn(async () => undefined),
  enqueueReminderTask: vi.fn(async () => undefined),
}));

import { fakeDb, Timestamp } from '../fakes/firestore';
import { buildMulticast, pushToMembers } from '../../src/lib/notify';
import { enqueueReminderTask } from '../../src/lib/tasks';
import { DEFAULT_TEMPLATES } from '../../src/domain/templates';
import { alertNotificationTitle, alertPushData } from '../../src/alerts/onAlertCreated';
import { handleMessageCreated, messageAlertId } from '../../src/messaging/onMessageCreated';
import { deleteTemplateHandler, saveTemplateHandler, seedDefaultTemplatesHandler } from '../../src/messaging/templates';
import {
  cancelReminderHandler, handleNoReplyReminder, messageReadStatusHandler, NUDGE_PUSH_TITLE, nudgeUnreadHandler, remindIfNoReplyHandler,
} from '../../src/messaging/tracking';
import { sendBroadcastHandler } from '../../src/messaging/sendBroadcast';
import { broadcastAckReportHandler } from '../../src/messaging/broadcastAck';
import { leaveChannelHandler, MAX_PINS, pinMessageHandler, renameChannelHandler } from '../../src/messaging/channelActions';
import { recallMessageHandler } from '../../src/messaging/recallMessage';
import { applyReactionChange, handleReactionWritten } from '../../src/messaging/reactions';
import { editMessageHandler } from '../../src/messaging/editMessage';
import { sendRoleMessageHandler } from '../../src/messaging/sendRoleMessage';
import type { Message, SaveTemplateRequest } from '../../src/shared/types';
import { docsIn, member, ORG, req, seedOrg } from './helpers';

const CH = `orgs/${ORG}/channels`;
const H = 3_600_000;
const push = vi.mocked(pushToMembers);

function msg(over: Partial<Message> = {}): Message {
  return {
    senderUid: 'b', senderName: 'User B', body: 'Visit done, comfortable.', priority: 'normal', attachments: [], roleTarget: null,
    createdAt: Timestamp.now(), alertId: null, ...over,
  };
}

function seedChannel(id: string, over: Record<string, unknown> = {}) {
  fakeDb.seed(`${CH}/${id}`, {
    type: 'group', name: 'North', memberUids: ['a', 'b', 'c'], patientId: null, teamId: null, createdBy: 'a',
    createdAt: Timestamp.fromMillis(0), lastMessage: null, lastMessageAt: Timestamp.fromMillis(0), archived: false, ...over,
  });
}

/** Seeds and runs the trigger for a message; returns the stored doc. */
async function post(channelId: string, id: string, m: Message, now?: Date) {
  fakeDb.seed(`${CH}/${channelId}/messages/${id}`, m);
  await handleMessageCreated(ORG, channelId, id, m, now);
  return fakeDb.read<any>(`${CH}/${channelId}/messages/${id}`)!;
}

function setMember(uid: string, extra: Record<string, unknown>) {
  fakeDb.seed(`orgs/${ORG}/members/${uid}`, { ...fakeDb.read<any>(`orgs/${ORG}/members/${uid}`), ...extra });
}

const pushedTo = () => push.mock.calls.map((c) => c[1]);

beforeEach(() => {
  seedOrg();
  push.mockClear();
  vi.mocked(enqueueReminderTask).mockClear();
  seedChannel('ch1');
});

// ---------------------------------------------------------------------------
// onMessageCreated
// ---------------------------------------------------------------------------

describe('onMessageCreated: templates', () => {
  it('strips the [[tpl:id]] marker, rewrites the body, sets templateId and a clean preview', async () => {
    const m = await post('ch1', 'm1', msg({ body: '[[tpl:default-sbar]]SBAR for patient\nS – Situation: pain 8/10' }));
    expect(m.body).toBe('SBAR for patient\nS – Situation: pain 8/10');
    expect(m.templateId).toBe('default-sbar');
    expect(fakeDb.read<any>(`${CH}/ch1`)!.lastMessage.text).toBe('SBAR for patient S – Situation: pain 8/10');
  });

  it('leaves ordinary messages untouched (no extra fields written)', async () => {
    const m = await post('ch1', 'm1', msg());
    expect(m).not.toHaveProperty('templateId');
    expect(m).not.toHaveProperty('mentions');
  });
});

describe('onMessageCreated: mentions', () => {
  beforeEach(() => {
    fakeDb.seed(`orgs/${ORG}/onCallRoles/oncall-rn`, { label: 'On-call RN', discipline: 'RN', teamId: null, fallbackUids: ['a'] });
  });

  it('writes mentions for channel members by display name (longest match, case-insensitive)', async () => {
    fakeDb.seed(`orgs/${ORG}/members/c2`, member('c2', 'clinician', { displayName: 'User C Jr' }));
    seedChannel('ch1', { memberUids: ['a', 'b', 'c', 'c2'] });
    const m = await post('ch1', 'm1', msg({ body: 'Can @user c jr and @USER A review?' }));
    expect(m.mentions).toEqual(['c2', 'a']);
    expect(m.mentionRoles).toEqual([]);
  });

  it('resolves @roleKey to whoever is on call now', async () => {
    const now = Date.now();
    fakeDb.seed(`orgs/${ORG}/shifts/s1`, { roleKey: 'oncall-rn', uid: 'c', start: Timestamp.fromMillis(now - H), end: Timestamp.fromMillis(now + H), notes: null });
    const m = await post('ch1', 'm1', msg({ body: '@oncall-rn please call the family' }));
    expect(m.mentions).toEqual(['c']);
    expect(m.mentionRoles).toEqual(['oncall-rn']);
  });

  it('role mentions skip members who are off or out of office', async () => {
    const now = Date.now();
    fakeDb.seed(`orgs/${ORG}/shifts/s1`, { roleKey: 'oncall-rn', uid: 'c', start: Timestamp.fromMillis(now - H), end: Timestamp.fromMillis(now + H), notes: null });
    setMember('c', { outOfOffice: { until: Timestamp.fromMillis(now + 24 * H), delegateUid: null, note: null } });
    expect((await post('ch1', 'm1', msg({ body: '@oncall-rn ?' }))).mentions).toEqual(['a']); // fallback
    setMember('c', { outOfOffice: null, status: { state: 'off', text: null, until: null } });
    expect((await post('ch1', 'm2', msg({ body: '@oncall-rn ?' }))).mentions).toEqual(['a']);
  });

  it('does not add a mentioned non-member; the sender gets a silent system note instead', async () => {
    const m = await post('ch1', 'm1', msg({ body: '@User V can you look?', createdAt: Timestamp.fromMillis(Date.now()) }));
    expect(m).not.toHaveProperty('mentions');
    const note = fakeDb.read<any>(`${CH}/ch1/messages/sysnote_mention_m1`)!;
    expect(note).toMatchObject({ senderUid: 'system', senderName: 'AuraConnect', priority: 'normal' });
    expect(note.body).toBe('User V is not in this conversation and was not notified. Add them to the conversation to include them.');
    expect(pushedTo()).toEqual([['a', 'c']]);

    // The note itself: no push, no preview/unread bump, and a retry doesn't post it twice.
    push.mockClear();
    const before = fakeDb.read<any>(`${CH}/ch1`)!.lastMessage;
    await handleMessageCreated(ORG, 'ch1', 'sysnote_mention_m1', note);
    expect(push).not.toHaveBeenCalled();
    expect(fakeDb.read<any>(`${CH}/ch1`)!.lastMessage).toEqual(before);
    await handleMessageCreated(ORG, 'ch1', 'm1', msg({ body: '@User V can you look?' }));
    expect(docsIn(`${CH}/ch1/messages`).filter((d) => d.id.startsWith('sysnote_'))).toHaveLength(1);
  });

  it('a role mention resolving to a non-member is reported, not added', async () => {
    fakeDb.seed(`orgs/${ORG}/onCallRoles/oncall-sw`, { label: 'SW', discipline: 'SW', teamId: null, fallbackUids: ['v'] });
    const m = await post('ch1', 'm1', msg({ body: '@oncall-sw heads up' }));
    expect(m.mentions).toEqual([]);
    expect(m.mentionRoles).toEqual(['oncall-sw']);
    expect(fakeDb.read<any>(`${CH}/ch1/messages/sysnote_mention_m1`)!.body).toContain('User V');
  });

  it('ignores self-mentions and email addresses', async () => {
    const m = await post('ch1', 'm1', msg({ body: 'I (@User B) emailed c@example.org' }));
    expect(m).not.toHaveProperty('mentions');
    expect(docsIn(`${CH}/ch1/messages`)).toHaveLength(1);
  });
});

describe('onMessageCreated: delivery filtering', () => {
  const prefs = (uid: string, p: Record<string, unknown>) =>
    fakeDb.seed(`${CH}/ch1/prefs/${uid}`, { mode: 'all', mutedUntil: null, updatedAt: Timestamp.now(), ...p });

  it('skips muted and mentions-only members; mentions override mentions-only', async () => {
    prefs('a', { mutedUntil: Timestamp.fromMillis(Date.now() + H) });
    prefs('c', { mode: 'mentions' });
    await post('ch1', 'm1', msg());
    expect(pushedTo()).toEqual([[]]);
    push.mockClear();
    await post('ch1', 'm2', msg({ body: '@User C and @User A please see' }));
    expect(pushedTo()).toEqual([['c']]); // a is muted even when mentioned
  });

  it('urgent_only skips normal; urgent and critical always reach everyone (as an alert)', async () => {
    prefs('a', { mode: 'urgent_only' });
    prefs('c', { mutedUntil: Timestamp.fromMillis(Date.now() + H) });
    await post('ch1', 'm1', msg());
    expect(pushedTo()).toEqual([[]]);
    push.mockClear();
    await post('ch1', 'm2', msg({ priority: 'urgent' }));
    expect(push).not.toHaveBeenCalled();
    expect(fakeDb.read<any>(`orgs/${ORG}/alerts/${messageAlertId('ch1', 'm2')}`)!.targetUids).toEqual(['a', 'c']);
  });

  it('quiet hours in the org time zone', async () => {
    fakeDb.seed(`orgs/${ORG}`, { ...fakeDb.read<any>(`orgs/${ORG}`), timezone: 'America/New_York' });
    setMember('c', { notificationSettings: { quietHours: { start: '22:00', end: '07:00' }, offShiftQuiet: false } });
    await post('ch1', 'm1', msg(), new Date(Date.UTC(2026, 8, 27, 4, 0))); // 00:00 in New York
    expect(pushedTo()).toEqual([['a']]);
    push.mockClear();
    await post('ch1', 'm2', msg(), new Date(Date.UTC(2026, 8, 27, 16, 0))); // noon
    expect(pushedTo()).toEqual([['a', 'c']]);
  });

  it('off-shift quiet: members with shifts only hear normal messages while on shift', async () => {
    const now = Date.now();
    setMember('c', { notificationSettings: { quietHours: null, offShiftQuiet: true } });
    setMember('a', { notificationSettings: { quietHours: null, offShiftQuiet: true } }); // a has no shifts → still pushed
    fakeDb.seed(`orgs/${ORG}/shifts/s1`, { roleKey: 'oncall-rn', uid: 'c', start: Timestamp.fromMillis(now + 2 * H), end: Timestamp.fromMillis(now + 10 * H), notes: null });
    await post('ch1', 'm1', msg());
    expect(pushedTo()).toEqual([['a']]);
    push.mockClear();
    fakeDb.seed(`orgs/${ORG}/shifts/s2`, { roleKey: 'oncall-rn', uid: 'c', start: Timestamp.fromMillis(now - H), end: Timestamp.fromMillis(now + H), notes: null });
    await post('ch1', 'm2', msg());
    expect(pushedTo()).toEqual([['a', 'c']]);
  });

  it('out of office skips unless mentioned', async () => {
    setMember('c', { outOfOffice: { until: Timestamp.fromMillis(Date.now() + 24 * H), delegateUid: 'a', note: null } });
    await post('ch1', 'm1', msg());
    expect(pushedTo()).toEqual([['a']]);
    push.mockClear();
    await post('ch1', 'm2', msg({ body: '@User C when you are back' }));
    expect(pushedTo()).toEqual([['a', 'c']]);
    // No auto-reply outside direct messages.
    expect(docsIn(`${CH}/ch1/messages`).some((d) => d.id.startsWith('sysnote_ooo'))).toBe(false);
  });

  it('broadcasts are filtered too; only the creator fans out', async () => {
    seedChannel('bc', { type: 'broadcast', createdBy: 'a', memberUids: ['a', 'b', 'c'] });
    fakeDb.seed(`${CH}/bc/prefs/b`, { mode: 'urgent_only', mutedUntil: null, updatedAt: Timestamp.now() });
    await post('bc', 'm1', msg({ senderUid: 'a' }));
    expect(pushedTo()).toEqual([['c']]);
  });

  it('push data carries messageId (IDs only) and reuses the member docs it already read', async () => {
    await post('ch1', 'm1', msg());
    const [orgId, uids, title, data, opts] = push.mock.calls[0]!;
    expect([orgId, uids, title, data]).toEqual([ORG, ['a', 'c'], 'New message', { type: 'message', orgId: ORG, channelId: 'ch1', messageId: 'm1', priority: 'normal' }]);
    expect([...(opts!.members!.keys())].sort()).toEqual(['a', 'c']);
  });

  it('keeps reads bounded: members + prefs in one batch, nothing per recipient beyond that', async () => {
    const uids = Array.from({ length: 12 }, (_, i) => `r${i}`);
    for (const u of uids) fakeDb.seed(`orgs/${ORG}/members/${u}`, member(u));
    seedChannel('big', { memberUids: ['b', ...uids] });
    fakeDb.reads = 0;
    await post('big', 'm1', msg());
    // channel tx (1) + alerts auto-ack query (1) + reminders query (1) + 12 members + 12 prefs.
    expect(fakeDb.reads).toBeLessThanOrEqual(3 + 2 * uids.length);
    expect(pushedTo()).toEqual([uids]);
  });
});

describe('onMessageCreated: out-of-office auto-reply on DMs', () => {
  beforeEach(() => {
    seedChannel('dm_b_c', { type: 'direct', name: null, memberUids: ['b', 'c'], createdBy: 'b' });
    setMember('c', { outOfOffice: { until: Timestamp.fromMillis(Date.UTC(2026, 9, 3, 12)), delegateUid: 'a', note: 'Vacation' } });
  });

  it('posts one silent auto-reply per day naming the delegate, and still pushes the DM', async () => {
    const now = new Date(Date.UTC(2026, 8, 27, 15));
    await post('dm_b_c', 'm1', msg(), now);
    const notes = docsIn(`${CH}/dm_b_c/messages`).filter((d) => d.id.startsWith('sysnote_ooo'));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.data).toMatchObject({ senderUid: 'system', body: 'User C is out of office until Oct 3, 2026. Contact User A instead.' });
    expect(notes[0]!.data.body).not.toContain('Vacation');
    expect(pushedTo()).toEqual([['c']]);

    await post('dm_b_c', 'm2', msg(), new Date(now.getTime() + H));
    expect(docsIn(`${CH}/dm_b_c/messages`).filter((d) => d.id.startsWith('sysnote_ooo'))).toHaveLength(1);
    await post('dm_b_c', 'm3', msg(), new Date(now.getTime() + 24 * H));
    expect(docsIn(`${CH}/dm_b_c/messages`).filter((d) => d.id.startsWith('sysnote_ooo'))).toHaveLength(2);
    // The auto-reply never triggers another auto-reply or push.
    push.mockClear();
    await handleMessageCreated(ORG, 'dm_b_c', notes[0]!.id, notes[0]!.data as Message, now);
    expect(push).not.toHaveBeenCalled();
  });

  it('no auto-reply once the absence is over; a muted DM does not push', async () => {
    await post('dm_b_c', 'm1', msg(), new Date(Date.UTC(2026, 9, 4)));
    expect(docsIn(`${CH}/dm_b_c/messages`)).toHaveLength(1);
    push.mockClear();
    fakeDb.seed(`${CH}/dm_b_c/prefs/c`, { mode: 'all', mutedUntil: Timestamp.fromMillis(Date.UTC(2026, 9, 5)), updatedAt: Timestamp.now() });
    await post('dm_b_c', 'm2', msg(), new Date(Date.UTC(2026, 9, 4)));
    expect(pushedTo()).toEqual([[]]);
  });
});

describe('onMessageCreated: reminders', () => {
  it('a reply from someone else cancels pending reminders; the owner’s own messages do not', async () => {
    fakeDb.seed(`orgs/${ORG}/reminders/r1`, { channelId: 'ch1', messageId: 'm0', ownerUid: 'b', dueAt: Timestamp.fromMillis(Date.now() + H), status: 'pending' });
    fakeDb.seed(`orgs/${ORG}/reminders/r2`, { channelId: 'other', messageId: 'm0', ownerUid: 'b', dueAt: Timestamp.fromMillis(Date.now() + H), status: 'pending' });
    await post('ch1', 'm1', msg({ senderUid: 'b' }));
    expect(fakeDb.read<any>(`orgs/${ORG}/reminders/r1`)!.status).toBe('pending');
    await post('ch1', 'm2', msg({ senderUid: 'c', senderName: 'User C' }));
    expect(fakeDb.read<any>(`orgs/${ORG}/reminders/r1`)!.status).toBe('cancelled');
    expect(fakeDb.read<any>(`orgs/${ORG}/reminders/r2`)!.status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// Push payloads (iOS categories)
// ---------------------------------------------------------------------------

describe('push payloads', () => {
  it('sets aps.category AURA_MESSAGE / AURA_ALERT and carries messageId in data', () => {
    const m = buildMulticast(['t'], 'New message', { type: 'message', orgId: ORG, channelId: 'ch1', messageId: 'm1', priority: 'normal' });
    expect((m.apns!.payload!.aps as any).category).toBe('AURA_MESSAGE');
    expect(m.data).toEqual({ type: 'message', orgId: ORG, channelId: 'ch1', messageId: 'm1', priority: 'normal' });
    const a = buildMulticast(['t'], 'Urgent alert', { type: 'alert', orgId: ORG, alertId: 'x', priority: 'urgent' });
    expect((a.apns!.payload!.aps as any).category).toBe('AURA_ALERT');
  });

  it('message-sourced alert pushes carry channelId and messageId; the no-reply alert has its own title', () => {
    const source = { type: 'message' as const, channelId: 'ch1', messageId: 'm1' };
    expect(alertPushData(ORG, 'al', { priority: 'urgent', source })).toEqual({ type: 'alert', orgId: ORG, alertId: 'al', channelId: 'ch1', messageId: 'm1', priority: 'urgent' });
    expect(alertNotificationTitle({ priority: 'normal', source, title: 'No reply yet' })).toBe('No reply yet');
    expect(alertNotificationTitle({ priority: 'urgent', source, title: 'Urgent message' })).toBe('Urgent message');
  });
});

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

function tplReq(over: Partial<SaveTemplateRequest> = {}, t: Partial<SaveTemplateRequest['template']> = {}): SaveTemplateRequest {
  return {
    orgId: ORG,
    scope: 'org',
    template: {
      title: 'Wound check', category: 'clinical', body: 'Wound check for {{patient}}: {{status}}',
      fields: [{ key: 'status', label: 'Status', kind: 'choice', options: ['Healing', 'Worse'], required: true }],
      defaultPriority: 'normal', patientContext: true, order: 5, active: true, ...t,
    },
    ...over,
  };
}

describe('saveTemplate / deleteTemplate', () => {
  it('org scope: admin only, audited; update keeps the id', async () => {
    const { id } = await saveTemplateHandler(req(tplReq(), { uid: 'a', role: 'admin' }));
    expect(fakeDb.read<any>(`orgs/${ORG}/messageTemplates/${id}`)).toMatchObject({ title: 'Wound check', createdBy: 'a', active: true });
    await saveTemplateHandler(req(tplReq({ templateId: id }, { title: 'Wound check v2' }), { uid: 'a', role: 'admin' }));
    expect(fakeDb.read<any>(`orgs/${ORG}/messageTemplates/${id}`)!.title).toBe('Wound check v2');
    expect(docsIn(`orgs/${ORG}/auditLogs`).filter((l) => l.data.action === 'template.save')).toHaveLength(2);
    await expect(saveTemplateHandler(req(tplReq(), { uid: 'b' }))).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(deleteTemplateHandler(req({ orgId: ORG, templateId: id, scope: 'org' }, { uid: 'b' }))).rejects.toMatchObject({ code: 'permission-denied' });
    await deleteTemplateHandler(req({ orgId: ORG, templateId: id, scope: 'org' }, { uid: 'a', role: 'admin' }));
    expect(fakeDb.read(`orgs/${ORG}/messageTemplates/${id}`)).toBeUndefined();
    await expect(deleteTemplateHandler(req({ orgId: ORG, templateId: id, scope: 'org' }, { uid: 'a', role: 'admin' }))).rejects.toMatchObject({ code: 'not-found' });
  });

  it('personal scope: saved under the caller, not audited, others cannot touch it', async () => {
    const { id } = await saveTemplateHandler(req(tplReq({ scope: 'personal' }), { uid: 'b' }));
    expect(fakeDb.read<any>(`orgs/${ORG}/members/b/templates/${id}`)).toMatchObject({ title: 'Wound check', createdBy: 'b' });
    expect(docsIn(`orgs/${ORG}/auditLogs`)).toHaveLength(0);
    // c's "delete" targets c's own collection, where it doesn't exist.
    await expect(deleteTemplateHandler(req({ orgId: ORG, templateId: id, scope: 'personal' }, { uid: 'c' }))).rejects.toMatchObject({ code: 'not-found' });
    await deleteTemplateHandler(req({ orgId: ORG, templateId: id, scope: 'personal' }, { uid: 'b' }));
    expect(fakeDb.read(`orgs/${ORG}/members/b/templates/${id}`)).toBeUndefined();
  });

  it('validates the template shape and placeholders', async () => {
    const admin = { uid: 'a', role: 'admin' as const };
    await expect(saveTemplateHandler(req(tplReq({}, { body: 'Hi {{nope}}' }), admin))).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(saveTemplateHandler(req(tplReq({}, { fields: [{ key: 'x', label: 'X', kind: 'choice', required: true }] }), admin))).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(saveTemplateHandler(req(tplReq({}, { category: 'bogus' as never }), admin))).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(saveTemplateHandler(req(tplReq({ templateId: 'a/b' }), admin))).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(saveTemplateHandler(req(tplReq({}, { extra: 1 } as never), admin))).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});

describe('seedDefaultTemplates', () => {
  it('admin adds only the missing defaults and never overwrites edits', async () => {
    fakeDb.seed(`orgs/${ORG}/messageTemplates/default-sbar`, { title: 'Our SBAR', edited: true });
    const r1 = await seedDefaultTemplatesHandler(req({ orgId: ORG }, { uid: 'a', role: 'admin' }));
    expect(r1).toEqual({ created: DEFAULT_TEMPLATES.length - 1, existing: 1 });
    expect(fakeDb.read<any>(`orgs/${ORG}/messageTemplates/default-sbar`)!.title).toBe('Our SBAR');
    expect(docsIn(`orgs/${ORG}/messageTemplates`)).toHaveLength(DEFAULT_TEMPLATES.length);
    expect(await seedDefaultTemplatesHandler(req({ orgId: ORG }, { uid: 'a', role: 'admin' }))).toEqual({ created: 0, existing: DEFAULT_TEMPLATES.length });
    await expect(seedDefaultTemplatesHandler(req({ orgId: ORG }, { uid: 'b' }))).rejects.toMatchObject({ code: 'permission-denied' });
  });
});

// ---------------------------------------------------------------------------
// Delivery tracking
// ---------------------------------------------------------------------------

describe('messageReadStatus / nudgeUnread', () => {
  const created = Timestamp.fromMillis(Date.now() - 60_000);
  beforeEach(() => {
    fakeDb.seed(`${CH}/ch1/messages/m1`, msg({ createdAt: created }));
    fakeDb.seed(`${CH}/ch1/reads/a`, { lastReadAt: Timestamp.fromMillis(created.toMillis() + 1000) });
    fakeDb.seed(`${CH}/ch1/reads/c`, { lastReadAt: Timestamp.fromMillis(created.toMillis() - 1000) });
  });

  it('splits the other members by lastReadAt >= createdAt', async () => {
    const r = await messageReadStatusHandler(req({ orgId: ORG, channelId: 'ch1', messageId: 'm1' }, { uid: 'c' }));
    expect(r.read.map((x) => [x.uid, x.name])).toEqual([['a', 'User A']]);
    expect(r.read[0]!.at).toEqual({ seconds: expect.any(Number), nanoseconds: expect.any(Number) });
    expect(r.unread).toEqual([{ uid: 'c', name: 'User C' }]);
    await expect(messageReadStatusHandler(req({ orgId: ORG, channelId: 'ch1', messageId: 'm1' }, { uid: 'v', role: 'viewer' }))).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(messageReadStatusHandler(req({ orgId: ORG, channelId: 'ch1', messageId: 'nope' }, { uid: 'b' }))).rejects.toMatchObject({ code: 'not-found' });
  });

  it('nudges unread members with a generic push; sender or admin; 1 per message per 10 minutes', async () => {
    const r = await nudgeUnreadHandler(req({ orgId: ORG, channelId: 'ch1', messageId: 'm1' }, { uid: 'b' }));
    expect(r).toEqual({ nudged: 1 });
    expect(push).toHaveBeenCalledWith(ORG, ['c'], NUDGE_PUSH_TITLE, { type: 'message', orgId: ORG, channelId: 'ch1', messageId: 'm1', priority: 'normal' });
    await expect(nudgeUnreadHandler(req({ orgId: ORG, channelId: 'ch1', messageId: 'm1' }, { uid: 'a', role: 'admin' }))).rejects.toMatchObject({ code: 'resource-exhausted' });
    await expect(nudgeUnreadHandler(req({ orgId: ORG, channelId: 'ch1', messageId: 'm1' }, { uid: 'c' }))).rejects.toMatchObject({ code: 'permission-denied' });
    // The bucket refills after 10 minutes.
    const bucket = `orgs/${ORG}/rateLimits/ch1_m1_nudgeUnread`;
    fakeDb.seed(bucket, { ...fakeDb.read<any>(bucket), refilledAtMs: Date.now() - 10 * 60_000 });
    expect(await nudgeUnreadHandler(req({ orgId: ORG, channelId: 'ch1', messageId: 'm1' }, { uid: 'a', role: 'admin' }))).toEqual({ nudged: 1 });
    expect(docsIn(`orgs/${ORG}/auditLogs`).filter((l) => l.data.action === 'message.nudge')).toHaveLength(2);
  });

  it('nothing unread: no push and no rate-limit token spent', async () => {
    fakeDb.seed(`${CH}/ch1/reads/c`, { lastReadAt: Timestamp.now() });
    expect(await nudgeUnreadHandler(req({ orgId: ORG, channelId: 'ch1', messageId: 'm1' }, { uid: 'b' }))).toEqual({ nudged: 0 });
    expect(push).not.toHaveBeenCalled();
    expect(fakeDb.read(`orgs/${ORG}/rateLimits/ch1_m1_nudgeUnread`)).toBeUndefined();
  });
});

describe('remindIfNoReply / cancelReminder / fireNoReplyReminder', () => {
  const created = Timestamp.fromMillis(Date.now() - 60_000);
  beforeEach(() => fakeDb.seed(`${CH}/ch1/messages/m1`, msg({ createdAt: created })));

  async function remind(uid = 'b', minutes = 30) {
    return (await remindIfNoReplyHandler(req({ orgId: ORG, channelId: 'ch1', messageId: 'm1', minutes: minutes as 30 }, { uid }))).id;
  }

  it('creates a pending reminder and a Cloud Task', async () => {
    const id = await remind();
    expect(fakeDb.read<any>(`orgs/${ORG}/reminders/${id}`)).toMatchObject({ channelId: 'ch1', messageId: 'm1', ownerUid: 'b', status: 'pending' });
    expect(enqueueReminderTask).toHaveBeenCalledWith({ orgId: ORG, reminderId: id }, 1800);
    await expect(remindIfNoReplyHandler(req({ orgId: ORG, channelId: 'ch1', messageId: 'm1', minutes: 45 as never }, { uid: 'b' }))).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(remindIfNoReplyHandler(req({ orgId: ORG, channelId: 'ch1', messageId: 'm1', minutes: 15 }, { uid: 'v', role: 'viewer' }))).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('fires a normal self-alert "No reply yet" when nobody else posted (own and system messages do not count)', async () => {
    const id = await remind();
    fakeDb.seed(`${CH}/ch1/messages/own`, msg({ createdAt: Timestamp.now() }));
    fakeDb.seed(`${CH}/ch1/messages/sys`, msg({ senderUid: 'system', senderName: 'AuraConnect', createdAt: Timestamp.now() }));
    expect(await handleNoReplyReminder({ orgId: ORG, reminderId: id })).toBe('fired');
    expect(fakeDb.read<any>(`orgs/${ORG}/alerts/rem_${id}`)).toMatchObject({
      title: 'No reply yet', priority: 'normal', targetUids: ['b'], policyId: null, createdBy: 'system',
      source: { type: 'message', channelId: 'ch1', messageId: 'm1' },
    });
    expect(fakeDb.read<any>(`orgs/${ORG}/reminders/${id}`)!.status).toBe('fired');
    expect(await handleNoReplyReminder({ orgId: ORG, reminderId: id })).toBe('noop');
    expect(docsIn(`orgs/${ORG}/alerts`)).toHaveLength(1);
  });

  it('a reply from someone else means no alert', async () => {
    const id = await remind();
    fakeDb.seed(`${CH}/ch1/messages/reply`, msg({ senderUid: 'c', createdAt: Timestamp.now() }));
    expect(await handleNoReplyReminder({ orgId: ORG, reminderId: id })).toBe('replied');
    expect(fakeDb.read<any>(`orgs/${ORG}/reminders/${id}`)!.status).toBe('cancelled');
    expect(docsIn(`orgs/${ORG}/alerts`)).toHaveLength(0);
  });

  it('cancelReminder: owner only; a cancelled reminder never fires', async () => {
    const id = await remind();
    await expect(cancelReminderHandler(req({ orgId: ORG, reminderId: id }, { uid: 'c' }))).rejects.toMatchObject({ code: 'permission-denied' });
    await cancelReminderHandler(req({ orgId: ORG, reminderId: id }, { uid: 'b' }));
    expect(fakeDb.read<any>(`orgs/${ORG}/reminders/${id}`)!.status).toBe('cancelled');
    expect(await handleNoReplyReminder({ orgId: ORG, reminderId: id })).toBe('noop');
    await expect(cancelReminderHandler(req({ orgId: ORG, reminderId: 'nope' }, { uid: 'b' }))).rejects.toMatchObject({ code: 'not-found' });
  });

  it('end to end: a later reply through onMessageCreated cancels the reminder', async () => {
    const id = await remind();
    await post('ch1', 'reply', msg({ senderUid: 'a', senderName: 'User A' }));
    expect(fakeDb.read<any>(`orgs/${ORG}/reminders/${id}`)!.status).toBe('cancelled');
    expect(await handleNoReplyReminder({ orgId: ORG, reminderId: id })).toBe('noop');
  });
});

// ---------------------------------------------------------------------------
// Ack-required broadcasts
// ---------------------------------------------------------------------------

describe('sendBroadcast requireAck / broadcastAckReport', () => {
  it('sets channel.requireAck and reports acked vs pending', async () => {
    const r = await sendBroadcastHandler(req({ orgId: ORG, name: 'Policy update', target: { kind: 'all' }, body: 'Please read the new policy.', priority: 'normal', requireAck: true }, { uid: 'b' }));
    const ch = fakeDb.read<any>(`${CH}/${r.channelId}`)!;
    expect(ch.requireAck).toBe(true);
    fakeDb.seed(`${CH}/${r.channelId}/acks/c`, { messageId: r.messageId, ackedAt: Timestamp.now() });
    fakeDb.seed(`${CH}/${r.channelId}/acks/a`, { messageId: 'other', ackedAt: Timestamp.now() });

    const report = await broadcastAckReportHandler(req({ orgId: ORG, channelId: r.channelId, messageId: r.messageId }, { uid: 'b' }));
    expect(report.total).toBe(r.recipientCount);
    expect(report.acked.map((x) => x.uid)).toEqual(['c']);
    expect(report.pending.map((x) => x.uid).sort()).toEqual(['a', 'v']);
    // Admin and the reports capability may see it; another clinician may not.
    await broadcastAckReportHandler(req({ orgId: ORG, channelId: r.channelId, messageId: r.messageId }, { uid: 'a', role: 'admin' }));
    fakeDb.seed(`orgs/${ORG}/members/rep`, member('rep', 'viewer', { capabilities: ['reports'] }));
    await broadcastAckReportHandler(req({ orgId: ORG, channelId: r.channelId, messageId: r.messageId }, { uid: 'rep', role: 'viewer' }));
    await expect(broadcastAckReportHandler(req({ orgId: ORG, channelId: r.channelId, messageId: r.messageId }, { uid: 'c' }))).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('defaults requireAck to false; the report refuses non-ack channels', async () => {
    const r = await sendBroadcastHandler(req({ orgId: ORG, name: 'FYI', target: { kind: 'all' }, body: 'FYI', priority: 'normal' }, { uid: 'b' }));
    expect(fakeDb.read<any>(`${CH}/${r.channelId}`)!.requireAck).toBe(false);
    await expect(broadcastAckReportHandler(req({ orgId: ORG, channelId: r.channelId, messageId: r.messageId }, { uid: 'b' }))).rejects.toMatchObject({ code: 'failed-precondition' });
  });
});

// ---------------------------------------------------------------------------
// Pins and channel management
// ---------------------------------------------------------------------------

describe('pinMessage', () => {
  beforeEach(() => {
    for (let i = 0; i <= MAX_PINS; i++) fakeDb.seed(`${CH}/ch1/messages/p${i}`, msg({ body: `Pin ${i} ${'x'.repeat(300)}` }));
  });
  const pin = (messageId: string, pinned = true, uid = 'b', role: 'clinician' | 'viewer' | 'admin' = 'clinician') =>
    pinMessageHandler(req({ orgId: ORG, channelId: 'ch1', messageId, pinned }, { uid, role }));

  it('pins newest first with a ≤140-char snippet, caps at 10, unpins, and audits', async () => {
    for (let i = 0; i < MAX_PINS; i++) await pin(`p${i}`);
    let pins = fakeDb.read<any>(`${CH}/ch1`)!.pinned;
    expect(pins).toHaveLength(MAX_PINS);
    expect(pins[0]).toMatchObject({ messageId: `p${MAX_PINS - 1}`, pinnedBy: 'b' });
    expect(pins[0].snippet.length).toBeLessThanOrEqual(140);
    await expect(pin(`p${MAX_PINS}`)).rejects.toMatchObject({ code: 'failed-precondition' });
    await pin('p0'); // already pinned: no-op
    await pin('p0', false);
    pins = fakeDb.read<any>(`${CH}/ch1`)!.pinned;
    expect(pins.map((p: any) => p.messageId)).not.toContain('p0');
    expect(docsIn(`orgs/${ORG}/auditLogs`).filter((l) => l.data.action === 'message.pin')).toHaveLength(MAX_PINS);
    expect(docsIn(`orgs/${ORG}/auditLogs`).filter((l) => l.data.action === 'message.unpin')).toHaveLength(1);
  });

  it('needs a channel member who can post; recalled messages cannot be pinned; recall unpins', async () => {
    await expect(pin('p0', true, 'v', 'viewer')).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(pinMessageHandler(req({ orgId: ORG, channelId: 'ch1', messageId: 'p0', pinned: true }, { uid: 'a', role: 'admin' }))).resolves.toEqual({});
    seedChannel('ch2', { memberUids: ['a'] });
    fakeDb.seed(`${CH}/ch2/messages/q`, msg());
    await expect(pinMessageHandler(req({ orgId: ORG, channelId: 'ch2', messageId: 'q', pinned: true }, { uid: 'b' }))).rejects.toMatchObject({ code: 'permission-denied' });

    await recallMessageHandler(req({ orgId: ORG, channelId: 'ch1', messageId: 'p0' }, { uid: 'b' }));
    expect(fakeDb.read<any>(`${CH}/ch1`)!.pinned).toEqual([]);
    await expect(pin('p0')).rejects.toMatchObject({ code: 'failed-precondition' });
  });
});

describe('renameChannel / leaveChannel', () => {
  it('rename: group/team only, by the creator or an admin', async () => {
    seedChannel('g', { createdBy: 'b' });
    await renameChannelHandler(req({ orgId: ORG, channelId: 'g', name: '  North IDG  ' }, { uid: 'b' }));
    expect(fakeDb.read<any>(`${CH}/g`)!.name).toBe('North IDG');
    await renameChannelHandler(req({ orgId: ORG, channelId: 'g', name: 'By admin' }, { uid: 'a', role: 'admin' }));
    await expect(renameChannelHandler(req({ orgId: ORG, channelId: 'g', name: 'X' }, { uid: 'c' }))).rejects.toMatchObject({ code: 'permission-denied' });
    seedChannel('pc', { type: 'patient', patientId: 'p1', createdBy: 'b' });
    await expect(renameChannelHandler(req({ orgId: ORG, channelId: 'pc', name: 'X' }, { uid: 'b' }))).rejects.toMatchObject({ code: 'failed-precondition' });
    await expect(renameChannelHandler(req({ orgId: ORG, channelId: 'g', name: '' }, { uid: 'b' }))).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(docsIn(`orgs/${ORG}/auditLogs`).filter((l) => l.data.action === 'channel.rename')).toHaveLength(2);
  });

  it('leave: group/team members only, never patient channels or the last member', async () => {
    fakeDb.seed(`${CH}/ch1`, {
      ...fakeDb.read<any>(`${CH}/ch1`),
      coverageMembers: [{ uid: 'c', until: Timestamp.fromMillis(Date.now() + H), reason: 'r', roleKey: null, grantedAt: Timestamp.now() }],
      coverageExpiresAt: Timestamp.fromMillis(Date.now() + H),
    });
    await leaveChannelHandler(req({ orgId: ORG, channelId: 'ch1' }, { uid: 'c' }));
    expect(fakeDb.read<any>(`${CH}/ch1`)).toMatchObject({ memberUids: ['a', 'b'], coverageMembers: [], coverageExpiresAt: null });
    await expect(leaveChannelHandler(req({ orgId: ORG, channelId: 'ch1' }, { uid: 'c' }))).rejects.toMatchObject({ code: 'permission-denied' });
    seedChannel('pc', { type: 'patient', patientId: 'p1' });
    await expect(leaveChannelHandler(req({ orgId: ORG, channelId: 'pc' }, { uid: 'b' }))).rejects.toMatchObject({ code: 'failed-precondition' });
    seedChannel('solo', { memberUids: ['b'] });
    await expect(leaveChannelHandler(req({ orgId: ORG, channelId: 'solo' }, { uid: 'b' }))).rejects.toMatchObject({ code: 'failed-precondition' });
    seedChannel('dm_a_b', { type: 'direct', memberUids: ['a', 'b'] });
    await expect(leaveChannelHandler(req({ orgId: ORG, channelId: 'dm_a_b' }, { uid: 'b' }))).rejects.toMatchObject({ code: 'failed-precondition' });
  });
});

// ---------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------

describe('reactions', () => {
  it('applyReactionChange increments, decrements, removes zeros and never goes negative', () => {
    expect(applyReactionChange(undefined, null, '👍')).toEqual({ '👍': 1 });
    expect(applyReactionChange({ '👍': 1 }, '👍', '✅')).toEqual({ '✅': 1 });
    expect(applyReactionChange({ '👍': 2 }, '👍', null)).toEqual({ '👍': 1 });
    expect(applyReactionChange({}, '👍', null)).toEqual({});
    expect(applyReactionChange({ '👍': 1, bad: -2 } as never, null, null)).toEqual({ '👍': 1 });
  });

  it('the trigger maintains message.reactionCounts', async () => {
    fakeDb.seed(`${CH}/ch1/messages/m1`, msg());
    const counts = () => fakeDb.read<any>(`${CH}/ch1/messages/m1`)!.reactionCounts;
    await handleReactionWritten(ORG, 'ch1', 'm1', null, { emoji: '👍' });
    await handleReactionWritten(ORG, 'ch1', 'm1', null, { emoji: '👍' });
    expect(counts()).toEqual({ '👍': 2 });
    await handleReactionWritten(ORG, 'ch1', 'm1', { emoji: '👍' }, { emoji: '🙏' });
    expect(counts()).toEqual({ '👍': 1, '🙏': 1 });
    await handleReactionWritten(ORG, 'ch1', 'm1', { emoji: '🙏' }, null);
    expect(counts()).toEqual({ '👍': 1 });
    await handleReactionWritten(ORG, 'ch1', 'm1', null, { emoji: '💩' }); // not allowed: ignored
    expect(counts()).toEqual({ '👍': 1 });
    await handleReactionWritten(ORG, 'ch1', 'gone', null, { emoji: '👍' }); // missing message: no-op
    expect(fakeDb.read(`${CH}/ch1/messages/gone`)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

describe('editMessage', () => {
  const createdMs = Date.now() - 5 * 60_000;
  beforeEach(async () => {
    await post('ch1', 'm1', msg({ body: 'BP 120/80', createdAt: Timestamp.fromMillis(createdMs) }));
    push.mockClear();
  });
  const edit = (body: string, uid = 'b', now?: Date) => editMessageHandler(req({ orgId: ORG, channelId: 'ch1', messageId: 'm1', body }, { uid }), now);

  it('saves the prior body to messageEdits, sets body/editedAt, re-parses mentions, updates preview; no push', async () => {
    await edit('BP 110/70, @User C please review');
    const m = fakeDb.read<any>(`${CH}/ch1/messages/m1`)!;
    expect(m).toMatchObject({ body: 'BP 110/70, @User C please review', mentions: ['c'], mentionRoles: [] });
    expect(m.editedAt).toBeInstanceOf(Timestamp);
    const edits = docsIn(`orgs/${ORG}/messageEdits`);
    expect(edits).toHaveLength(1);
    expect(edits[0]!.data).toMatchObject({ channelId: 'ch1', messageId: 'm1', previousBody: 'BP 120/80', editedBy: 'b' });
    expect(fakeDb.read<any>(`${CH}/ch1`)!.lastMessage.text).toBe('BP 110/70, @User C please review');
    expect(push).not.toHaveBeenCalled();
    expect(docsIn(`orgs/${ORG}/auditLogs`).find((l) => l.data.action === 'message.edit')!.data.metadata).toEqual({ editId: edits[0]!.id });

    await edit('BP 110/70');
    expect(fakeDb.read<any>(`${CH}/ch1/messages/m1`)!.mentions).toEqual([]);
  });

  it('updates the pin snippet of a pinned message', async () => {
    await pinMessageHandler(req({ orgId: ORG, channelId: 'ch1', messageId: 'm1', pinned: true }, { uid: 'c' }));
    await edit('Corrected: BP 118/76');
    expect(fakeDb.read<any>(`${CH}/ch1`)!.pinned[0].snippet).toBe('Corrected: BP 118/76');
  });

  it('sender only, within 15 minutes, not recalled, not empty', async () => {
    await expect(edit('x', 'c')).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(edit('x', 'b', new Date(createdMs + 16 * 60_000))).rejects.toMatchObject({ code: 'failed-precondition' });
    await expect(edit('   ')).rejects.toMatchObject({ code: 'invalid-argument' });
    await recallMessageHandler(req({ orgId: ORG, channelId: 'ch1', messageId: 'm1' }, { uid: 'b' }));
    await expect(edit('x')).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(docsIn(`orgs/${ORG}/messageEdits`)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Role routing skips off / out-of-office members
// ---------------------------------------------------------------------------

describe('sendRoleMessage (v4 availability)', () => {
  it('skips an out-of-office shift holder and falls through to the fallback', async () => {
    const now = Date.now();
    fakeDb.seed(`orgs/${ORG}/onCallRoles/oncall-rn`, { label: 'On-call RN', discipline: 'RN', teamId: null, fallbackUids: ['a'] });
    fakeDb.seed(`orgs/${ORG}/shifts/s1`, { roleKey: 'oncall-rn', uid: 'c', start: Timestamp.fromMillis(now - H), end: Timestamp.fromMillis(now + H), notes: null });
    setMember('c', { outOfOffice: { until: Timestamp.fromMillis(now + H), delegateUid: null, note: null } });
    const r = await sendRoleMessageHandler(req({ orgId: ORG, roleKey: 'oncall-rn', body: 'hi', priority: 'normal' }, { uid: 'b' }));
    expect(r.resolvedUids).toEqual(['a']);
    setMember('a', { status: { state: 'off', text: null, until: null } });
    await expect(sendRoleMessageHandler(req({ orgId: ORG, roleKey: 'oncall-rn', body: 'hi', priority: 'normal' }, { uid: 'b' }))).rejects.toMatchObject({ code: 'failed-precondition' });
  });
});
