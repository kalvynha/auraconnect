import { onDocumentWrittenWithAuthContext } from 'firebase-functions/v2/firestore';
import { logger } from 'firebase-functions/v2';
import { writeAudit } from '../lib/audit';
import { revokeOrgClaims, setOrgClaims } from '../lib/claims';
import { colRef, db, docRef, paths } from '../lib/db';
import type { Member, UserOrg } from '../shared/types';
import { FIRESTORE_TRIGGER_REGION } from '../lib/regions';

/** Member fields whose changes are audited (profile and device-token edits are not). */
export const AUDITED_MEMBER_FIELDS = ['role', 'discipline', 'active', 'capabilities', 'teamIds'] as const;

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Audits admin-level member changes: `member.deactivate` (active → inactive) or `member.update`. */
async function auditMemberChange(orgId: string, uid: string, before: Member, after: Member | null, actorUid: string, extra: Record<string, unknown> = {}): Promise<void> {
  const next = (after ?? { ...before, active: false }) as Member;
  const fields = AUDITED_MEMBER_FIELDS.filter((f) => !same(before[f], next[f]));
  if (fields.length === 0 && Object.keys(extra).length === 0) return;
  const changes: Record<string, unknown> = {};
  for (const f of fields) changes[f] = { from: before[f] ?? null, to: next[f] ?? null };
  await writeAudit(orgId, {
    actorUid,
    action: before.active && !next.active ? 'member.deactivate' : 'member.update',
    resourceType: 'member',
    resourceId: uid,
    metadata: { fields, changes, ...(after ? {} : { deleted: true }), ...extra },
  });
}

/** True when the org has no active admin left (the member doc write already happened). */
async function noActiveAdmins(orgId: string): Promise<boolean> {
  const snap = await colRef(paths.members(orgId)).where('role', '==', 'admin').where('active', '==', true).limit(1).get();
  return snap.empty;
}

/**
 * Keeps custom claims `{ orgId, role }` and `userOrgs/{uid}` in sync with the
 * member doc. Deactivation (`active: false`) or deletion removes the claims,
 * deletes userOrgs and revokes refresh tokens. Changes that don't touch
 * role/active (e.g. fcmTokens) are ignored.
 *
 * v3 (S6/S7 admin guardrails):
 *  - role, discipline, active, capabilities and teamIds changes are audited
 *    (`member.update`, or `member.deactivate` when a member is deactivated);
 *  - a change that would leave the org with zero active admins is reverted
 *    (the member stays an active admin; claims are untouched) → `'reverted'`.
 */
export async function handleMemberWritten(
  orgId: string,
  uid: string,
  before: Member | null,
  after: Member | null,
  actorUid = 'system',
): Promise<'synced' | 'revoked' | 'skipped' | 'reverted'> {
  const wasActive = !!before?.active;
  const isActive = !!after?.active;

  const lostAdmin = !!before && before.role === 'admin' && wasActive && (!after || after.role !== 'admin' || !isActive);
  if (lostAdmin && (await noActiveAdmins(orgId))) {
    const ref = docRef(paths.member(orgId, uid));
    if (after) await ref.update({ role: 'admin', active: true });
    else await ref.set(before);
    await writeAudit(orgId, {
      actorUid,
      action: 'member.update',
      resourceType: 'member',
      resourceId: uid,
      metadata: { reverted: true, reason: 'last_active_admin', attempted: after ? { role: after.role, active: after.active } : { deleted: true } },
    });
    logger.warn('reverted a change that would leave no active admin', { orgId, uid });
    return 'reverted';
  }

  if (before) await auditMemberChange(orgId, uid, before, after, actorUid);

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

export const onMemberWritten = onDocumentWrittenWithAuthContext({ document: 'orgs/{orgId}/members/{uid}', region: FIRESTORE_TRIGGER_REGION }, async (event) => {
  const before = event.data?.before.exists ? (event.data.before.data() as Member) : null;
  const after = event.data?.after.exists ? (event.data.after.data() as Member) : null;
  const actor = event.authId && event.authType !== 'service_account' && event.authType !== 'system' ? event.authId : 'system';
  await handleMemberWritten(event.params.orgId, event.params.uid, before, after, actor);
});
