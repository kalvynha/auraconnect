/** `revokeInvite` (admin): a pending invite can no longer be accepted or listed. */
import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { writeAudit } from '../lib/audit';
import { parse, requireOrg } from '../lib/context';
import { db, docRef, paths } from '../lib/db';
import { id } from '../lib/schemas';
import type { Invite, RevokeInviteRequest } from '../shared/types';

const schema = z.object({ orgId: id, inviteId: id });

export async function revokeInviteHandler(request: CallableRequest<RevokeInviteRequest>): Promise<Record<string, never>> {
  const input = parse(schema, request.data);
  const ctx = await requireOrg(request, input.orgId, ['admin']);
  const ref = docRef(paths.invite(ctx.orgId, input.inviteId));
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Invite not found.');
    const invite = snap.data() as Invite;
    if (invite.status === 'revoked') return;
    if (invite.status !== 'pending') throw new HttpsError('failed-precondition', 'Only a pending invite can be revoked.');
    tx.update(ref, { status: 'revoked', revokedBy: ctx.uid, revokedAt: FieldValue.serverTimestamp() });
    await writeAudit(ctx.orgId, { actorUid: ctx.uid, action: 'invite.revoke', resourceType: 'invite', resourceId: input.inviteId, metadata: { role: invite.role } }, tx);
  });
  return {};
}

export const revokeInvite = onCall(revokeInviteHandler);
