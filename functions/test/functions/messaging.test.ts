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

import { fakeDb, Timestamp } from '../fakes/firestore';
import { pushToMembers } from '../../src/lib/notify';
import { handleMessageCreated, messageAlertId } from '../../src/messaging/onMessageCreated';
import { createChannelHandler } from '../../src/messaging/createChannel';
import { sendRoleMessageHandler } from '../../src/messaging/sendRoleMessage';
import type { Message } from '../../src/shared/types';
import { docsIn, ORG, req, seedOrg } from './helpers';

function msg(over: Partial<Message> = {}): Message {
  return {
    senderUid: 'b',
    senderName: 'User B',
    body: 'Patient in room 4 needs a PRN dose review '.repeat(6),
    priority: 'normal',
    attachments: [],
    roleTarget: null,
    createdAt: Timestamp.now(),
    alertId: null,
    ...over,
  };
}

beforeEach(() => {
  seedOrg();
  vi.mocked(pushToMembers).mockClear();
  fakeDb.seed(`orgs/${ORG}/channels/ch1`, {
    type: 'group', name: 'North', memberUids: ['a', 'b', 'c'], patientId: null, teamId: null,
    createdBy: 'a', createdAt: Timestamp.fromMillis(0), lastMessage: null, lastMessageAt: Timestamp.fromMillis(0), archived: false,
  });
});

describe('onMessageCreated', () => {
  it('normal: updates lastMessage (truncated) and pushes PHI-free to other members', async () => {
    const m = msg();
    fakeDb.seed(`orgs/${ORG}/channels/ch1/messages/m1`, m);
    await handleMessageCreated(ORG, 'ch1', 'm1', m);
    const ch = fakeDb.read<any>(`orgs/${ORG}/channels/ch1`)!;
    expect(ch.lastMessage.text.length).toBeLessThanOrEqual(140);
    expect(ch.lastMessage.senderUid).toBe('b');
    expect(ch.lastMessageAt.toMillis()).toBe((m.createdAt as Timestamp).toMillis());
    expect(pushToMembers).toHaveBeenCalledWith(ORG, ['a', 'c'], 'New message', { type: 'message', orgId: ORG, channelId: 'ch1', priority: 'normal' });
    expect(docsIn(`orgs/${ORG}/alerts`)).toHaveLength(0);
  });

  it('urgent: raises a message alert to the other members with the default policy and sets message.alertId', async () => {
    const m = msg({ priority: 'urgent' });
    fakeDb.seed(`orgs/${ORG}/channels/ch1/messages/m2`, m);
    await handleMessageCreated(ORG, 'ch1', 'm2', m);
    const alertId = messageAlertId('ch1', 'm2');
    const alert = fakeDb.read<any>(`orgs/${ORG}/alerts/${alertId}`)!;
    expect(alert).toMatchObject({
      targetUids: ['a', 'c'],
      currentTargetUids: ['a', 'c'],
      policyId: 'pol',
      level: 0,
      status: 'open',
      priority: 'urgent',
      source: { type: 'message', channelId: 'ch1', messageId: 'm2' },
      createdBy: 'b',
    });
    expect(alert.body).not.toContain('PRN'); // no message text in the alert
    expect(fakeDb.read<any>(`orgs/${ORG}/channels/ch1/messages/m2`)!.alertId).toBe(alertId);
    // the alert push (onAlertCreated) replaces the message push
    expect(pushToMembers).not.toHaveBeenCalled();
    expect(docsIn(`orgs/${ORG}/auditLogs`).some((d) => d.data.action === 'alert.create')).toBe(true);
  });

  it('does not raise a second alert when retried or when alertId is already set', async () => {
    const m = msg({ priority: 'critical' });
    fakeDb.seed(`orgs/${ORG}/channels/ch1/messages/m3`, m);
    await handleMessageCreated(ORG, 'ch1', 'm3', m);
    await handleMessageCreated(ORG, 'ch1', 'm3', m);
    await handleMessageCreated(ORG, 'ch1', 'm3', { ...m, alertId: 'already' });
    expect(docsIn(`orgs/${ORG}/alerts`)).toHaveLength(1);
  });

  it('does not overwrite lastMessage with an older message', async () => {
    const newer = msg({ body: 'newer', createdAt: Timestamp.fromMillis(2_000_000) });
    const older = msg({ body: 'older', createdAt: Timestamp.fromMillis(1_000_000) });
    await handleMessageCreated(ORG, 'ch1', 'n', newer);
    await handleMessageCreated(ORG, 'ch1', 'o', older);
    expect(fakeDb.read<any>(`orgs/${ORG}/channels/ch1`)!.lastMessage.text).toBe('newer');
  });
});

describe('createChannel', () => {
  it('direct: deterministic id, idempotent, caller included once', async () => {
    const r1 = await createChannelHandler(req({ orgId: ORG, type: 'direct', memberUids: ['c', 'b'] }, { uid: 'b' }));
    const r2 = await createChannelHandler(req({ orgId: ORG, type: 'direct', memberUids: ['b'] }, { uid: 'c' }));
    expect(r1.channelId).toBe('dm_b_c');
    expect(r2.channelId).toBe('dm_b_c');
    expect(fakeDb.read<any>(`orgs/${ORG}/channels/dm_b_c`)).toMatchObject({ type: 'direct', name: null, memberUids: ['b', 'c'] });
  });

  it('rejects inactive members, viewers, other orgs and bad direct sizes', async () => {
    await expect(createChannelHandler(req({ orgId: ORG, type: 'group', name: 'G', memberUids: ['x'] }, { uid: 'b' }))).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(createChannelHandler(req({ orgId: ORG, type: 'group', name: 'G', memberUids: ['b'] }, { uid: 'v', role: 'viewer' }))).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(createChannelHandler(req({ orgId: 'other', type: 'group', name: 'G', memberUids: [] }, { uid: 'b' }))).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(createChannelHandler(req({ orgId: ORG, type: 'direct', memberUids: ['a', 'c'] }, { uid: 'b' }))).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(createChannelHandler(req({ orgId: ORG, type: 'group', memberUids: ['a'] }, { uid: 'b' }))).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(createChannelHandler(req({ orgId: ORG, type: 'group', name: 'G', memberUids: [] }, null))).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('team: uses team.memberUids when memberUids is empty', async () => {
    fakeDb.seed(`orgs/${ORG}/teams/t1`, { name: 'North', description: null, memberUids: ['a', 'c'], createdAt: Timestamp.now() });
    const { channelId } = await createChannelHandler(req({ orgId: ORG, type: 'team', name: 'North team', teamId: 't1', memberUids: [] }, { uid: 'b' }));
    expect(fakeDb.read<any>(`orgs/${ORG}/channels/${channelId}`)).toMatchObject({ type: 'team', teamId: 't1', memberUids: ['a', 'b', 'c'] });
  });
});

describe('sendRoleMessage', () => {
  beforeEach(() => {
    fakeDb.seed(`orgs/${ORG}/onCallRoles/oncall-rn`, { label: 'On-call RN', discipline: 'RN', teamId: null, fallbackUids: ['a'] });
  });

  it('routes to the single on-shift member via a direct channel', async () => {
    const now = Date.now();
    fakeDb.seed(`orgs/${ORG}/shifts/s1`, { roleKey: 'oncall-rn', uid: 'c', start: Timestamp.fromMillis(now - 3600_000), end: Timestamp.fromMillis(now + 3600_000), notes: null });
    const r = await sendRoleMessageHandler(req({ orgId: ORG, roleKey: 'oncall-rn', body: 'hi', priority: 'normal' }, { uid: 'b' }));
    expect(r).toMatchObject({ channelId: 'dm_b_c', resolvedUids: ['c'] });
    expect(fakeDb.read<any>(`orgs/${ORG}/channels/dm_b_c/messages/${r.messageId}`)).toMatchObject({
      senderUid: 'b', senderName: 'User B', roleTarget: 'oncall-rn', alertId: null, attachments: [],
    });
  });

  it('uses a group channel named after the role for several people and reuses it', async () => {
    const now = Date.now();
    for (const uid of ['a', 'c']) {
      fakeDb.seed(`orgs/${ORG}/shifts/s-${uid}`, { roleKey: 'oncall-rn', uid, start: Timestamp.fromMillis(now - 1000), end: Timestamp.fromMillis(now + 3600_000), notes: null });
    }
    const r1 = await sendRoleMessageHandler(req({ orgId: ORG, roleKey: 'oncall-rn', body: 'one', priority: 'normal' }, { uid: 'b' }));
    const r2 = await sendRoleMessageHandler(req({ orgId: ORG, roleKey: 'oncall-rn', body: 'two', priority: 'normal' }, { uid: 'b' }));
    expect(r1.channelId).toBe(r2.channelId);
    expect(fakeDb.read<any>(`orgs/${ORG}/channels/${r1.channelId}`)).toMatchObject({ type: 'group', name: 'On-call RN', memberUids: ['a', 'b', 'c'] });
  });

  it('fails with failed-precondition when nobody is available', async () => {
    await expect(sendRoleMessageHandler(req({ orgId: ORG, roleKey: 'oncall-rn', body: 'x', priority: 'normal' }, { uid: 'a', role: 'admin' }))).rejects.toMatchObject({
      code: 'failed-precondition',
    });
  });
});
