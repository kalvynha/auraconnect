import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('firebase-admin/firestore', () => import('../fakes/firestore'));

import { fakeDb } from '../fakes/firestore';
import { requireOrg } from '../../src/lib/context';

const req = (claims: Record<string, unknown>) =>
  ({ auth: { uid: 'u1', token: { orgId: 'o1', role: 'admin', ...claims } } }) as never;

describe('requireOrg re-checks the member doc (stale tokens)', () => {
  beforeEach(() => fakeDb.reset());

  it('allows an active member and uses the member-doc role', async () => {
    fakeDb.seed('orgs/o1/members/u1', { uid: 'u1', role: 'clinician', active: true, discipline: 'RN' });
    const ctx = await requireOrg(req({}), 'o1');
    expect(ctx.role).toBe('clinician');
    expect(ctx.member.discipline).toBe('RN');
  });

  it('rejects a deactivated member whose token still says admin', async () => {
    fakeDb.seed('orgs/o1/members/u1', { uid: 'u1', role: 'admin', active: false });
    await expect(requireOrg(req({}), 'o1')).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('rejects a demoted member for admin-only actions even with an admin token', async () => {
    fakeDb.seed('orgs/o1/members/u1', { uid: 'u1', role: 'viewer', active: true });
    await expect(requireOrg(req({}), 'o1', ['admin'])).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('rejects when the member doc is missing', async () => {
    await expect(requireOrg(req({}), 'o1')).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('rejects a different org', async () => {
    fakeDb.seed('orgs/o2/members/u1', { uid: 'u1', role: 'admin', active: true });
    await expect(requireOrg(req({}), 'o2')).rejects.toMatchObject({ code: 'permission-denied' });
  });
});
