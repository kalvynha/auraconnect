/** v4 notify.ts: preloaded member docs are not re-read; categories reach FCM. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('firebase-admin/firestore', () => import('../fakes/firestore'));
const sent: Array<{ tokens: string[]; apns: any; data: Record<string, string> }> = [];
vi.mock('firebase-admin/messaging', () => ({
  getMessaging: () => ({
    sendEachForMulticast: async (m: { tokens: string[]; apns: any; data: Record<string, string> }) => {
      sent.push(m);
      return { successCount: m.tokens.length, failureCount: 0, responses: m.tokens.map(() => ({ success: true })) };
    },
  }),
}));

import { fakeDb } from '../fakes/firestore';
import { pushToMembers } from '../../src/lib/notify';
import type { Member } from '../../src/shared/types';
import { member, ORG, seedOrg } from './helpers';

beforeEach(() => {
  seedOrg();
  sent.length = 0;
});

describe('pushToMembers (v4)', () => {
  it('uses preloaded member docs and reads only the missing ones', async () => {
    const preloaded = new Map<string, Member>([['b', member('b', 'clinician', { fcmTokens: ['preloaded-b'] }) as unknown as Member]]);
    fakeDb.reads = 0;
    const r = await pushToMembers(ORG, ['b', 'c'], 'New message', { type: 'message', orgId: ORG, channelId: 'ch', messageId: 'm', priority: 'normal' }, { members: preloaded });
    expect(fakeDb.reads).toBe(1); // only c
    expect(r.sent).toBe(2);
    expect(sent[0]!.tokens.sort()).toEqual(['preloaded-b', 'tok-c']);
    expect(sent[0]!.apns.payload.aps.category).toBe('AURA_MESSAGE');
    expect(sent[0]!.data.messageId).toBe('m');
  });

  it('skips inactive preloaded members', async () => {
    const preloaded = new Map<string, Member>([['b', member('b', 'clinician', { active: false }) as unknown as Member]]);
    const r = await pushToMembers(ORG, ['b'], 'New alert', { type: 'alert', orgId: ORG, alertId: 'x', priority: 'urgent' }, { members: preloaded });
    expect(r.sent).toBe(0);
    expect(sent).toHaveLength(0);
  });
});
