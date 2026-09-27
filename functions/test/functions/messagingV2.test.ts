import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('firebase-admin/firestore', () => import('../fakes/firestore'));
vi.mock('../../src/lib/notify', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/notify')>()),
  pushToMembers: vi.fn(async () => ({ sent: 1, failed: 0, pruned: 0 })),
}));
vi.mock('../../src/lib/tasks', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/tasks')>()),
  enqueueEscalationCheck: vi.fn(async () => undefined),
}));
vi.mock('../../src/lib/storageFiles', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/storageFiles')>()),
  deleteStorageObjects: vi.fn(async (p: readonly string[]) => p.length),
}));

import { fakeDb, Timestamp } from '../fakes/firestore';
import { pushToMembers } from '../../src/lib/notify';
import { deleteStorageObjects, safeAttachmentPaths } from '../../src/lib/storageFiles';
import { handleMessageCreated } from '../../src/messaging/onMessageCreated';
import { recallMessageHandler, RECALLED_PREVIEW } from '../../src/messaging/recallMessage';
import { findMatch, makeSnippet, searchMessagesHandler, SEARCH_MAX_HITS, SEARCH_MAX_PER_CHANNEL } from '../../src/messaging/searchMessages';
import { resolveBroadcastRecipients, sendBroadcastHandler } from '../../src/messaging/sendBroadcast';
import { purgeCutoffMs, runMessagePurge } from '../../src/messaging/purgeExpiredMessages';
import type { Message } from '../../src/shared/types';
import { docsIn, member, ORG, req, seedOrg } from './helpers';

const DAY = 86_400_000;
const CH = `orgs/${ORG}/channels/ch1`;

function msg(over: Partial<Message> = {}): Message {
  return {
    senderUid: 'b',
    senderName: 'User B',
    body: 'hello team',
    priority: 'normal',
    attachments: [],
    roleTarget: null,
    createdAt: Timestamp.now(),
    alertId: null,
    ...over,
  };
}

function seedChannel(id = 'ch1', over: Record<string, unknown> = {}) {
  fakeDb.seed(`orgs/${ORG}/channels/${id}`, {
    type: 'group', name: `Channel ${id}`, memberUids: ['a', 'b', 'c'], patientId: null, teamId: null,
    createdBy: 'a', createdAt: Timestamp.fromMillis(0), lastMessage: null, lastMessageAt: Timestamp.now(), archived: false,
    ...over,
  });
}

beforeEach(() => {
  seedOrg();
  vi.mocked(pushToMembers).mockClear();
  vi.mocked(deleteStorageObjects).mockClear();
  seedChannel();
});

describe('recallMessage', () => {
  const att = (name: string, path = `orgs/${ORG}/channels/ch1/attachments/${name}`) => ({ storagePath: path, contentType: 'image/png', name, size: 10 });

  it('lets the sender recall: empties body/attachments, deletes files, updates the preview, audits', async () => {
    const m = msg({ body: 'wrong patient', attachments: [att('x.png'), att('evil', `orgs/${ORG}/referrals/r1/scan.pdf`)] });
    fakeDb.seed(`${CH}/messages/m1`, m);
    await handleMessageCreated(ORG, 'ch1', 'm1', m);
    expect(fakeDb.read<any>(CH)!.lastMessage.text).toBe('wrong patient');

    await recallMessageHandler(req({ orgId: ORG, channelId: 'ch1', messageId: 'm1' }, { uid: 'b' }));
    const stored = fakeDb.read<any>(`${CH}/messages/m1`)!;
    expect(stored).toMatchObject({ body: '', attachments: [] });
    expect(stored.recalledAt).toBeInstanceOf(Timestamp);
    expect(fakeDb.read<any>(CH)!.lastMessage.text).toBe(RECALLED_PREVIEW);
    // v3 (S6, soft recall): files are kept and the original is copied to the admin-only messageRecalls
    expect(deleteStorageObjects).not.toHaveBeenCalled();
    expect(fakeDb.read<any>(`orgs/${ORG}/messageRecalls/ch1_m1`)).toMatchObject({ body: 'wrong patient', recalledBy: 'b', senderUid: 'b' });
    const audit = docsIn(`orgs/${ORG}/auditLogs`).find((l) => l.data.action === 'message.recall')!;
    expect(audit.data.metadata).toEqual({ bySender: true, attachments: 1 });
    expect(JSON.stringify(audit.data)).not.toContain('wrong patient');

    // recalling again is a no-op
    await recallMessageHandler(req({ orgId: ORG, channelId: 'ch1', messageId: 'm1' }, { uid: 'b' }));
    expect(docsIn(`orgs/${ORG}/auditLogs`).filter((l) => l.data.action === 'message.recall')).toHaveLength(1);
  });

  it('rejects other members and viewers but allows an admin member', async () => {
    fakeDb.seed(`${CH}/messages/m1`, msg());
    await expect(recallMessageHandler(req({ orgId: ORG, channelId: 'ch1', messageId: 'm1' }, { uid: 'c' }))).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(recallMessageHandler(req({ orgId: ORG, channelId: 'ch1', messageId: 'm1' }, { uid: 'v', role: 'viewer' }))).rejects.toMatchObject({ code: 'permission-denied' });
    expect(fakeDb.read<any>(`${CH}/messages/m1`)!.body).toBe('hello team');
    await recallMessageHandler(req({ orgId: ORG, channelId: 'ch1', messageId: 'm1' }, { uid: 'a', role: 'admin' }));
    expect(fakeDb.read<any>(`${CH}/messages/m1`)!.recalledAt).toBeDefined();
  });

  it('requires channel membership, even for the sender or an admin', async () => {
    seedChannel('ch2', { memberUids: ['c'] });
    fakeDb.seed(`orgs/${ORG}/channels/ch2/messages/m1`, msg());
    await expect(recallMessageHandler(req({ orgId: ORG, channelId: 'ch2', messageId: 'm1' }, { uid: 'b' }))).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(recallMessageHandler(req({ orgId: ORG, channelId: 'ch2', messageId: 'm1' }, { uid: 'a', role: 'admin' }))).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(recallMessageHandler(req({ orgId: ORG, channelId: 'ch1', messageId: 'nope' }, { uid: 'b' }))).rejects.toMatchObject({ code: 'not-found' });
  });

  it('leaves the preview alone when the recalled message is not the last one', async () => {
    const old = msg({ body: 'old', createdAt: Timestamp.fromMillis(1_000) });
    const latest = msg({ body: 'latest', createdAt: Timestamp.fromMillis(2_000) });
    fakeDb.seed(`${CH}/messages/old`, old);
    await handleMessageCreated(ORG, 'ch1', 'old', old);
    await handleMessageCreated(ORG, 'ch1', 'latest', latest);
    await recallMessageHandler(req({ orgId: ORG, channelId: 'ch1', messageId: 'old' }, { uid: 'b' }));
    expect(fakeDb.read<any>(CH)!.lastMessage.text).toBe('latest');
  });

  it('safeAttachmentPaths rejects traversal and foreign paths', () => {
    expect(
      safeAttachmentPaths(ORG, 'ch1', [
        att('a.png'),
        att('b', `orgs/${ORG}/channels/ch1/attachments/../../../referrals/r1/x.pdf`),
        att('c', `orgs/${ORG}/channels/ch10/attachments/c.png`),
        att('d', `orgs/${ORG}/channels/ch1/attachments/`),
      ]),
    ).toEqual([`orgs/${ORG}/channels/ch1/attachments/a.png`]);
  });
});

describe('onMessageCreated threads and broadcasts', () => {
  it('increments the parent replyCount/lastReplyAt, keeps the channel preview, still pushes', async () => {
    const parent = msg({ body: 'parent', createdAt: Timestamp.fromMillis(1_000) });
    fakeDb.seed(`${CH}/messages/p1`, parent);
    await handleMessageCreated(ORG, 'ch1', 'p1', parent);
    vi.mocked(pushToMembers).mockClear();

    const r1 = msg({ senderUid: 'c', senderName: 'User C', body: 'reply 1', threadParentId: 'p1', createdAt: Timestamp.fromMillis(5_000) });
    const r2 = msg({ senderUid: 'a', senderName: 'User A', body: 'reply 2', threadParentId: 'p1', createdAt: Timestamp.fromMillis(3_000) });
    await handleMessageCreated(ORG, 'ch1', 'r1', r1);
    await handleMessageCreated(ORG, 'ch1', 'r2', r2);

    const p = fakeDb.read<any>(`${CH}/messages/p1`)!;
    expect(p.replyCount).toBe(2);
    expect(p.lastReplyAt.toMillis()).toBe(5_000); // an older reply doesn't move it back
    expect(fakeDb.read<any>(CH)!.lastMessage.text).toBe('parent');
    expect(pushToMembers).toHaveBeenCalledTimes(2);
    expect(pushToMembers).toHaveBeenCalledWith(ORG, ['a', 'b'], 'New message', { type: 'message', orgId: ORG, channelId: 'ch1', priority: 'normal' });
  });

  it('ignores a missing parent without failing', async () => {
    await handleMessageCreated(ORG, 'ch1', 'r1', msg({ threadParentId: 'gone' }));
    expect(fakeDb.read<any>(`${CH}/messages/gone`)).toBeUndefined();
    expect(pushToMembers).toHaveBeenCalledTimes(1);
  });

  it('broadcast: pushes at priority with no escalating alert; ignores non-creator senders', async () => {
    seedChannel('bc', { type: 'broadcast', createdBy: 'a', memberUids: ['a', 'b', 'c'] });
    await handleMessageCreated(ORG, 'bc', 'm1', msg({ senderUid: 'a', priority: 'critical' }));
    expect(pushToMembers).toHaveBeenCalledWith(ORG, ['b', 'c'], 'Critical message', { type: 'message', orgId: ORG, channelId: 'bc', priority: 'critical' });
    expect(docsIn(`orgs/${ORG}/alerts`)).toHaveLength(0);
    vi.mocked(pushToMembers).mockClear();
    await handleMessageCreated(ORG, 'bc', 'm2', msg({ senderUid: 'b' }));
    expect(pushToMembers).not.toHaveBeenCalled();
  });
});

describe('searchMessages', () => {
  it('matches case-insensitively in member channels only, skipping archived channels, recalled and old messages', async () => {
    const now = Date.now();
    seedChannel('secret', { memberUids: ['a', 'c'] });
    seedChannel('arch', { archived: true });
    fakeDb.seed(`${CH}/messages/m1`, msg({ body: 'Morphine given at 14:00', createdAt: Timestamp.fromMillis(now - 1000) }));
    fakeDb.seed(`${CH}/messages/m2`, msg({ body: 'nothing here', createdAt: Timestamp.fromMillis(now - 2000) }));
    fakeDb.seed(`${CH}/messages/m3`, msg({ body: '', recalledAt: Timestamp.now(), createdAt: Timestamp.fromMillis(now - 3000) } as Partial<Message>));
    fakeDb.seed(`${CH}/messages/old`, msg({ body: 'morphine long ago', createdAt: Timestamp.fromMillis(now - 91 * DAY) }));
    fakeDb.seed(`orgs/${ORG}/channels/secret/messages/s1`, msg({ body: 'MORPHINE secret' }));
    fakeDb.seed(`orgs/${ORG}/channels/arch/messages/x1`, msg({ body: 'morphine archived' }));

    const res = await searchMessagesHandler(req({ orgId: ORG, query: 'MORPHINE' }, { uid: 'b', role: 'viewer' }));
    expect(res.truncated).toBe(false);
    expect(res.hits.map((h) => h.messageId)).toEqual(['m1']);
    expect(res.hits[0]).toMatchObject({ channelId: 'ch1', channelName: 'Channel ch1', senderName: 'User B', snippet: 'Morphine given at 14:00' });
    expect(res.hits[0]!.createdAt).toEqual({ seconds: expect.any(Number), nanoseconds: expect.any(Number) });

    const audit = docsIn(`orgs/${ORG}/auditLogs`).find((l) => l.data.action === 'message.search')!;
    expect(JSON.stringify(audit.data)).not.toMatch(/morphine/i);
  });

  it('enforces membership for a specific channel and validates the query', async () => {
    seedChannel('secret', { memberUids: ['a', 'c'] });
    await expect(searchMessagesHandler(req({ orgId: ORG, query: 'abc', channelId: 'secret' }, { uid: 'b' }))).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(searchMessagesHandler(req({ orgId: ORG, query: 'a' }, { uid: 'b' }))).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(searchMessagesHandler(req({ orgId: 'other', query: 'abc' }, { uid: 'b' }))).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('caps reads per channel and hits, and reports truncation', async () => {
    const now = Date.now();
    for (let i = 0; i < SEARCH_MAX_PER_CHANNEL + 20; i++) {
      fakeDb.seed(`${CH}/messages/m${String(i).padStart(3, '0')}`, msg({ body: `pain score ${i}`, createdAt: Timestamp.fromMillis(now - i * 1000) }));
    }
    const res = await searchMessagesHandler(req({ orgId: ORG, query: 'pain', channelId: 'ch1' }, { uid: 'b' }));
    expect(res.hits).toHaveLength(SEARCH_MAX_HITS);
    expect(res.truncated).toBe(true);
    expect(res.hits[0]!.messageId).toBe('m000'); // newest first
    // the oldest 20 are beyond the per-channel read cap
    const none = await searchMessagesHandler(req({ orgId: ORG, query: `pain score ${SEARCH_MAX_PER_CHANNEL + 5}`, channelId: 'ch1' }, { uid: 'b' }));
    expect(none.hits).toHaveLength(0);
  });

  it('builds ~160 char snippets around the match', () => {
    const body = `${'a'.repeat(300)} NEEDLE ${'b'.repeat(300)}`;
    const idx = findMatch(body, 'needle');
    const s = makeSnippet(body, idx, 6);
    expect(s).toContain('NEEDLE');
    expect(s.startsWith('…') && s.endsWith('…')).toBe(true);
    expect(s.length).toBeLessThanOrEqual(162);
  });
});

describe('sendBroadcast', () => {
  beforeEach(() => {
    fakeDb.seed(`orgs/${ORG}/members/sw`, member('sw', 'clinician', { discipline: 'SW' }));
    fakeDb.seed(`orgs/${ORG}/members/sw2`, member('sw2', 'clinician', { discipline: 'SW', active: false }));
    fakeDb.seed(`orgs/${ORG}/teams/t1`, { name: 'North', description: null, memberUids: ['b', 'c', 'x'], createdAt: Timestamp.now() });
    fakeDb.seed(`orgs/${ORG}/onCallRoles/oncall-rn`, { label: 'On-call RN', discipline: 'RN', teamId: null, fallbackUids: ['c'] });
  });

  it('resolves team / role / discipline / all to active members, excluding the sender', async () => {
    expect(await resolveBroadcastRecipients(ORG, { kind: 'team', teamId: 't1' }, 'b')).toEqual(['c']);
    expect(await resolveBroadcastRecipients(ORG, { kind: 'role', roleKey: 'oncall-rn' }, 'b')).toEqual(['c']);
    expect(await resolveBroadcastRecipients(ORG, { kind: 'discipline', discipline: 'SW' }, 'b')).toEqual(['sw']);
    expect(await resolveBroadcastRecipients(ORG, { kind: 'all' }, 'b')).toEqual(['a', 'c', 'sw', 'v']);
    await expect(resolveBroadcastRecipients(ORG, { kind: 'team', teamId: 'nope' }, 'b')).rejects.toMatchObject({ code: 'not-found' });
    await expect(resolveBroadcastRecipients(ORG, { kind: 'role', roleKey: 'nope' }, 'b')).rejects.toMatchObject({ code: 'not-found' });
  });

  it('creates a broadcast channel with recipients + sender and posts the message', async () => {
    const res = await sendBroadcastHandler(req({ orgId: ORG, name: 'Snow day', target: { kind: 'all' }, body: 'Office closed', priority: 'urgent' }, { uid: 'b' }));
    expect(res.recipientCount).toBe(4);
    expect(fakeDb.read<any>(`orgs/${ORG}/channels/${res.channelId}`)).toMatchObject({
      type: 'broadcast', name: 'Snow day', createdBy: 'b', memberUids: ['a', 'b', 'c', 'sw', 'v'], archived: false,
    });
    expect(fakeDb.read<any>(`orgs/${ORG}/channels/${res.channelId}/messages/${res.messageId}`)).toMatchObject({
      senderUid: 'b', senderName: 'User B', body: 'Office closed', priority: 'urgent', alertId: null, attachments: [],
    });
    expect(docsIn(`orgs/${ORG}/auditLogs`).find((l) => l.data.action === 'broadcast.send')?.data.metadata).toEqual({ target: 'all', recipients: 4, priority: 'urgent' });
  });

  it('rejects viewers, empty targets and bad input', async () => {
    // Untyped payloads, as a client could send them.
    const call = (data: Record<string, unknown>, auth: Parameters<typeof req>[1]) => sendBroadcastHandler(req(data as never, auth));
    const body = { orgId: ORG, name: 'x', target: { kind: 'all' }, body: 'hi', priority: 'normal' };
    await expect(call(body, { uid: 'v', role: 'viewer' })).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(call({ ...body, target: { kind: 'discipline', discipline: 'MD' } }, { uid: 'b' })).rejects.toMatchObject({ code: 'failed-precondition' });
    await expect(call({ ...body, target: { kind: 'bogus' } }, { uid: 'b' })).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});

describe('purgeExpiredMessages', () => {
  it('computes cutoffs only for valid lifespans', () => {
    expect(purgeCutoffMs(100 * DAY, 30)).toBe(70 * DAY);
    expect(purgeCutoffMs(100 * DAY, null)).toBeNull();
    expect(purgeCutoffMs(100 * DAY, 3)).toBeNull();
    expect(purgeCutoffMs(100 * DAY, 7.5)).toBeNull();
  });

  it('deletes only messages older than the org lifespan, with attachments, and clears stale previews', async () => {
    const now = Date.now();
    fakeDb.seed(`orgs/${ORG}`, { ...fakeDb.read<any>(`orgs/${ORG}`), messageLifespanDays: 30 });
    fakeDb.seed(`orgs/o2`, { name: 'Keep forever', timezone: 'UTC', deadlineLeadDays: 3, defaultEscalationPolicyId: null, createdBy: 'z', createdAt: Timestamp.now() });
    const oldAt = Timestamp.fromMillis(now - 40 * DAY);
    seedChannel('ch1', { lastMessage: { text: 'old', senderUid: 'b', senderName: 'B', priority: 'normal', at: oldAt }, lastMessageAt: oldAt });
    seedChannel('ch2', { createdAt: Timestamp.fromMillis(now - DAY) });
    fakeDb.seed(`${CH}/messages/old1`, msg({ createdAt: oldAt, attachments: [{ storagePath: `orgs/${ORG}/channels/ch1/attachments/f.png`, contentType: 'image/png', name: 'f', size: 1 }] }));
    fakeDb.seed(`${CH}/messages/old2`, msg({ createdAt: Timestamp.fromMillis(now - 31 * DAY), threadParentId: 'old1' }));
    fakeDb.seed(`${CH}/messages/new1`, msg({ createdAt: Timestamp.fromMillis(now - 29 * DAY) }));
    fakeDb.seed(`orgs/${ORG}/channels/ch2/messages/n`, msg({ createdAt: Timestamp.fromMillis(now - DAY) }));
    fakeDb.seed(`orgs/o2/channels/k/messages/ancient`, msg({ createdAt: Timestamp.fromMillis(now - 400 * DAY) }));
    fakeDb.seed(`orgs/o2/channels/k`, { type: 'group', memberUids: ['z'], createdAt: Timestamp.fromMillis(0), lastMessage: null, lastMessageAt: Timestamp.fromMillis(0), archived: false });

    const res = await runMessagePurge(new Date(now));
    expect(res).toMatchObject({ orgs: 1, messages: 2, attachments: 1 });
    expect(docsIn(`${CH}/messages`).map((d) => d.id)).toEqual(['new1']);
    expect(docsIn(`orgs/${ORG}/channels/ch2/messages`)).toHaveLength(1);
    expect(docsIn(`orgs/o2/channels/k/messages`)).toHaveLength(1);
    expect(fakeDb.read<any>(CH)!.lastMessage).toBeNull();
    expect(deleteStorageObjects).toHaveBeenCalledWith([`orgs/${ORG}/channels/ch1/attachments/f.png`]);
  });
});
