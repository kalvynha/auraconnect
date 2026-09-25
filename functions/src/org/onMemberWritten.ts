import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { logger } from 'firebase-functions/v2';
import { revokeOrgClaims, setOrgClaims } from '../lib/claims';
import { db, docRef, paths } from '../lib/db';
import type { Member, UserOrg } from '../shared/types';
import { FIRESTORE_TRIGGER_REGION } from '../lib/regions';

/**
 * Keeps custom claims `{ orgId, role }` and `userOrgs/{uid}` in sync with the
 * member doc. Deactivation (`active: false`) or deletion removes the claims,
 * deletes userOrgs and revokes refresh tokens. Changes that don't touch
 * role/active (e.g. fcmTokens) are ignored.
 */
export async function handleMemberWritten(
  orgId: string,
  uid: string,
  before: Member | null,
  after: Member | null,
): Promise<'synced' | 'revoked' | 'skipped'> {
  const wasActive = !!before?.active;
  const isActive = !!after?.active;
  if (before && after && before.role === after.role && wasActive === isActive) return 'skipped';

  const userOrgRef = docRef(paths.userOrg(uid));
  if (!after || !isActive) {
    await db().runTransaction(async (tx) => {
      const snap = await tx.get(userOrgRef);
      if (snap.exists && (snap.data() as UserOrg).orgId === orgId) tx.delete(userOrgRef);
    });
    await revokeOrgClaims(uid, orgId);
    return 'revoked';
  }

  const conflict = await db().runTransaction(async (tx) => {
    const snap = await tx.get(userOrgRef);
    const cur = snap.exists ? (snap.data() as UserOrg) : null;
    if (cur && cur.orgId !== orgId) return true;
    if (!cur || cur.role !== after.role) tx.set(userOrgRef, { orgId, role: after.role });
    return false;
  });
  if (conflict) {
    logger.warn('member belongs to another org; claims not changed', { orgId, uid });
    return 'skipped';
  }
  await setOrgClaims(uid, orgId, after.role);
  return 'synced';
}

export const onMemberWritten = onDocumentWritten({ document: 'orgs/{orgId}/members/{uid}', region: FIRESTORE_TRIGGER_REGION }, async (event) => {
  const before = event.data?.before.exists ? (event.data.before.data() as Member) : null;
  const after = event.data?.after.exists ? (event.data.after.data() as Member) : null;
  await handleMemberWritten(event.params.orgId, event.params.uid, before, after);
});
