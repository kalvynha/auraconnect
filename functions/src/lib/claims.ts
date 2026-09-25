/** Custom-claim and userOrgs helpers. */
import { getAuth } from 'firebase-admin/auth';
import type { Role } from '../shared/types';

/** Sets `{ orgId, role }` while preserving any unrelated custom claims. */
export async function setOrgClaims(uid: string, orgId: string, role: Role): Promise<void> {
  const auth = getAuth();
  const user = await auth.getUser(uid);
  const current = user.customClaims ?? {};
  if (current.orgId === orgId && current.role === role) return;
  await auth.setCustomUserClaims(uid, { ...current, orgId, role });
}

/** Removes `orgId`/`role` claims (only if they point at `orgId`) and revokes sessions. */
export async function revokeOrgClaims(uid: string, orgId: string): Promise<void> {
  const auth = getAuth();
  let user;
  try {
    user = await auth.getUser(uid);
  } catch (e) {
    if ((e as { code?: string }).code === 'auth/user-not-found') return;
    throw e;
  }
  const current = { ...(user.customClaims ?? {}) };
  if (current.orgId !== orgId) return;
  delete current.orgId;
  delete current.role;
  await auth.setCustomUserClaims(uid, current);
  // Force existing ID tokens (which still carry the old claims) to be refreshed.
  await auth.revokeRefreshTokens(uid);
}
