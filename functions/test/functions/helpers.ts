import type { CallableRequest } from 'firebase-functions/v2/https';
import { fakeDb, Timestamp } from '../fakes/firestore';
import type { Role } from '../../src/shared/types';

export const ORG = 'o1';

export function req<T>(data: T, auth: { uid: string; role?: Role; orgId?: string | null; email?: string } | null): CallableRequest<T> {
  return {
    data,
    auth: auth
      ? {
          uid: auth.uid,
          token: {
            ...(auth.orgId === null ? {} : { orgId: auth.orgId ?? ORG, role: auth.role ?? 'clinician' }),
            email: auth.email ?? `${auth.uid}@example.org`,
            email_verified: false,
          },
        }
      : undefined,
    rawRequest: {},
    acceptsStreaming: false,
  } as unknown as CallableRequest<T>;
}

export function member(uid: string, role: Role = 'clinician', extra: Record<string, unknown> = {}) {
  return {
    uid,
    email: `${uid}@example.org`,
    displayName: `User ${uid.toUpperCase()}`,
    role,
    discipline: 'RN',
    title: null,
    phone: null,
    teamIds: [],
    active: true,
    fcmTokens: [`tok-${uid}`],
    createdAt: Timestamp.now(),
    ...extra,
  };
}

/** Seeds org o1 with a 3-step default policy and members a(admin), b, c (clinicians), v (viewer), x (inactive). */
export function seedOrg(): void {
  fakeDb.reset();
  fakeDb.seed(`orgs/${ORG}`, {
    name: 'Test Hospice',
    timezone: 'UTC',
    deadlineLeadDays: 3,
    defaultEscalationPolicyId: 'pol',
    createdBy: 'a',
    createdAt: Timestamp.now(),
  });
  fakeDb.seed(`orgs/${ORG}/escalationPolicies/pol`, {
    name: 'Standard',
    steps: [
      { target: { kind: 'original' }, waitMinutes: 10 },
      { target: { kind: 'uid', uid: 'a' }, waitMinutes: 15 },
    ],
  });
  fakeDb.seed(`orgs/${ORG}/members/a`, member('a', 'admin'));
  fakeDb.seed(`orgs/${ORG}/members/b`, member('b'));
  fakeDb.seed(`orgs/${ORG}/members/c`, member('c'));
  fakeDb.seed(`orgs/${ORG}/members/v`, member('v', 'viewer'));
  fakeDb.seed(`orgs/${ORG}/members/x`, member('x', 'clinician', { active: false }));
}

export function docsIn(collectionPath: string): Array<{ id: string; data: Record<string, any> }> {
  const out: Array<{ id: string; data: Record<string, any> }> = [];
  for (const [path, data] of fakeDb.store) {
    const segs = path.split('/');
    if (segs.slice(0, -1).join('/') === collectionPath) out.push({ id: segs[segs.length - 1]!, data });
  }
  return out;
}
