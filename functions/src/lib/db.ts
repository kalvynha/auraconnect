/**
 * Firestore access and typed path helpers. Firestore is resolved lazily so
 * tests can mock `firebase-admin/firestore` before first use.
 */
import { getFirestore, type DocumentReference, type CollectionReference, type Firestore } from 'firebase-admin/firestore';

export function db(): Firestore {
  return getFirestore();
}

export const paths = {
  org: (orgId: string) => `orgs/${orgId}`,
  members: (orgId: string) => `orgs/${orgId}/members`,
  member: (orgId: string, uid: string) => `orgs/${orgId}/members/${uid}`,
  invites: (orgId: string) => `orgs/${orgId}/invites`,
  invite: (orgId: string, id: string) => `orgs/${orgId}/invites/${id}`,
  teams: (orgId: string) => `orgs/${orgId}/teams`,
  team: (orgId: string, id: string) => `orgs/${orgId}/teams/${id}`,
  onCallRole: (orgId: string, roleKey: string) => `orgs/${orgId}/onCallRoles/${roleKey}`,
  shifts: (orgId: string) => `orgs/${orgId}/shifts`,
  escalationPolicies: (orgId: string) => `orgs/${orgId}/escalationPolicies`,
  escalationPolicy: (orgId: string, id: string) => `orgs/${orgId}/escalationPolicies/${id}`,
  channels: (orgId: string) => `orgs/${orgId}/channels`,
  channel: (orgId: string, id: string) => `orgs/${orgId}/channels/${id}`,
  messages: (orgId: string, channelId: string) => `orgs/${orgId}/channels/${channelId}/messages`,
  message: (orgId: string, channelId: string, id: string) => `orgs/${orgId}/channels/${channelId}/messages/${id}`,
  alerts: (orgId: string) => `orgs/${orgId}/alerts`,
  alert: (orgId: string, id: string) => `orgs/${orgId}/alerts/${id}`,
  patients: (orgId: string) => `orgs/${orgId}/patients`,
  patient: (orgId: string, id: string) => `orgs/${orgId}/patients/${id}`,
  referral: (orgId: string, id: string) => `orgs/${orgId}/referrals/${id}`,
  auditLogs: (orgId: string) => `orgs/${orgId}/auditLogs`,
  userOrg: (uid: string) => `userOrgs/${uid}`,
} as const;

export function docRef(path: string): DocumentReference {
  return db().doc(path);
}

export function colRef(path: string): CollectionReference {
  return db().collection(path);
}

/** Reads a document and returns its data typed as T, or null when missing. */
export async function getDocData<T>(path: string): Promise<T | null> {
  const snap = await docRef(path).get();
  return snap.exists ? (snap.data() as T) : null;
}

/** Firestore `getAll` limit-friendly batched read of many docs by path. */
export async function getMany<T>(pathsList: readonly string[]): Promise<Map<string, T>> {
  const out = new Map<string, T>();
  const unique = [...new Set(pathsList)];
  for (let i = 0; i < unique.length; i += 100) {
    const refs = unique.slice(i, i + 100).map((p) => docRef(p));
    if (refs.length === 0) continue;
    const snaps = await db().getAll(...refs);
    for (const s of snaps) if (s.exists) out.set(s.ref.path, s.data() as T);
  }
  return out;
}
