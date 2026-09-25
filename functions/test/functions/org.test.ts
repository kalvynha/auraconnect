import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('firebase-admin/firestore', () => import('../fakes/firestore'));

const claims = new Map<string, Record<string, unknown>>();
const revoked: string[] = [];
vi.mock('firebase-admin/auth', () => ({
  getAuth: () => ({
    getUser: async (uid: string) => ({ uid, customClaims: claims.get(uid) }),
    setCustomUserClaims: async (uid: string, c: Record<string, unknown>) => void claims.set(uid, c),
    revokeRefreshTokens: async (uid: string) => void revoked.push(uid),
  }),
}));

import { fakeDb, Timestamp } from '../fakes/firestore';
import { createOrgHandler } from '../../src/org/createOrg';
import { inviteMemberHandler } from '../../src/org/inviteMember';
import { acceptInviteHandler } from '../../src/org/acceptInvite';
import { listMyInvitesHandler } from '../../src/org/listMyInvites';
import { handleMemberWritten } from '../../src/org/onMemberWritten';
import { docsIn, member, ORG, req, seedOrg } from './helpers';

beforeEach(() => {
  seedOrg();
  claims.clear();
  revoked.length = 0;
});

describe('createOrg', () => {
  it('creates org, default policy, admin member, userOrgs and claims', async () => {
    const { orgId } = await createOrgHandler(req({ name: 'Sunrise Hospice', timezone: 'America/Chicago', displayName: 'Dana', discipline: 'Admin' }, { uid: 'new', orgId: null, email: 'Dana@Example.org' }));
    const org = fakeDb.read<any>(`orgs/${orgId}`)!;
    expect(org).toMatchObject({ name: 'Sunrise Hospice', timezone: 'America/Chicago', deadlineLeadDays: 3, createdBy: 'new' });
    expect(fakeDb.read<any>(`orgs/${orgId}/escalationPolicies/${org.defaultEscalationPolicyId}`)!.steps).toHaveLength(2);
    expect(fakeDb.read<any>(`orgs/${orgId}/members/new`)).toMatchObject({ role: 'admin', active: true, email: 'dana@example.org', fcmTokens: [] });
    expect(fakeDb.read<any>('userOrgs/new')).toEqual({ orgId, role: 'admin' });
    expect(claims.get('new')).toEqual({ orgId, role: 'admin' });
    await expect(createOrgHandler(req({ name: 'Again', timezone: 'UTC', displayName: 'D', discipline: 'RN' }, { uid: 'new', orgId: null }))).rejects.toMatchObject({ code: 'already-exists' });
  });

  it('validates the time zone', async () => {
    await expect(createOrgHandler(req({ name: 'X', timezone: 'Mars/Base', displayName: 'D', discipline: 'RN' }, { uid: 'n2', orgId: null }))).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});

describe('invites', () => {
  it('admin-only, lower-cases, and dedupes pending invites', async () => {
    fakeDb.seed(`orgs/${ORG}/teams/t1`, { name: 'North', description: null, memberUids: ['b'], createdAt: Timestamp.now() });
    const body = { orgId: ORG, email: 'New.Nurse@Example.org', displayName: 'Nina', role: 'clinician' as const, discipline: 'RN' as const, teamIds: ['t1'] };
    await expect(inviteMemberHandler(req(body, { uid: 'b' }))).rejects.toMatchObject({ code: 'permission-denied' });
    const i1 = await inviteMemberHandler(req(body, { uid: 'a', role: 'admin' }));
    const i2 = await inviteMemberHandler(req({ ...body, role: 'intake' }, { uid: 'a', role: 'admin' }));
    expect(i2.inviteId).toBe(i1.inviteId);
    expect(docsIn(`orgs/${ORG}/invites`)).toHaveLength(1);
    expect(fakeDb.read<any>(`orgs/${ORG}/invites/${i1.inviteId}`)).toMatchObject({ email: 'new.nurse@example.org', role: 'intake', status: 'pending' });

    const listed = await listMyInvitesHandler(req({}, { uid: 'nn', orgId: null, email: 'new.nurse@example.org' }));
    expect(listed.invites).toEqual([{ orgId: ORG, inviteId: i1.inviteId, orgName: 'Test Hospice', role: 'intake' }]);

    await expect(acceptInviteHandler(req({ orgId: ORG, inviteId: i1.inviteId }, { uid: 'evil', orgId: null, email: 'someone@else.org' }), { requireVerified: false })).rejects.toMatchObject({ code: 'permission-denied' });

    const res = await acceptInviteHandler(req({ orgId: ORG, inviteId: i1.inviteId }, { uid: 'nn', orgId: null, email: 'NEW.NURSE@example.org' }), { requireVerified: false });
    expect(res).toEqual({ orgId: ORG, role: 'intake' });
    expect(fakeDb.read<any>(`orgs/${ORG}/members/nn`)).toMatchObject({ role: 'intake', active: true, teamIds: ['t1'], displayName: 'Nina' });
    expect(fakeDb.read<any>(`orgs/${ORG}/teams/t1`)!.memberUids).toEqual(['b', 'nn']);
    expect(fakeDb.read<any>(`orgs/${ORG}/invites/${i1.inviteId}`)).toMatchObject({ status: 'accepted', acceptedBy: 'nn' });
    expect(fakeDb.read<any>('userOrgs/nn')).toEqual({ orgId: ORG, role: 'intake' });
    expect(claims.get('nn')).toEqual({ orgId: ORG, role: 'intake' });
    // idempotent retry
    expect(await acceptInviteHandler(req({ orgId: ORG, inviteId: i1.inviteId }, { uid: 'nn', orgId: null, email: 'new.nurse@example.org' }), { requireVerified: false })).toEqual({ orgId: ORG, role: 'intake' });
  });

  it('refuses users already in another org', async () => {
    fakeDb.seed(`orgs/${ORG}/invites/i9`, { email: 'z@example.org', displayName: 'Z', role: 'viewer', discipline: 'Other', teamIds: [], status: 'pending', createdBy: 'a', createdAt: Timestamp.now(), acceptedBy: null, acceptedAt: null });
    fakeDb.seed('userOrgs/z', { orgId: 'other', role: 'admin' });
    await expect(acceptInviteHandler(req({ orgId: ORG, inviteId: 'i9' }, { uid: 'z', orgId: null, email: 'z@example.org' }), { requireVerified: false })).rejects.toMatchObject({ code: 'failed-precondition' });
  });
});

describe('onMemberWritten', () => {
  it('syncs claims on role change and revokes on deactivation', async () => {
    const before = member('b');
    const after = { ...before, role: 'intake' as const };
    expect(await handleMemberWritten(ORG, 'b', before as any, after as any)).toBe('synced');
    expect(claims.get('b')).toEqual({ orgId: ORG, role: 'intake' });
    expect(fakeDb.read<any>('userOrgs/b')).toEqual({ orgId: ORG, role: 'intake' });

    expect(await handleMemberWritten(ORG, 'b', after as any, { ...after, fcmTokens: ['new'] } as any)).toBe('skipped');

    expect(await handleMemberWritten(ORG, 'b', after as any, { ...after, active: false } as any)).toBe('revoked');
    expect(claims.get('b')).toEqual({});
    expect(fakeDb.read('userOrgs/b')).toBeUndefined();
    expect(revoked).toEqual(['b']);
  });
});
