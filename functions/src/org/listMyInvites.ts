import { onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { requireAuth } from '../lib/context';
import { db, getMany, paths } from '../lib/db';
import type { Invite, ListMyInvitesResponse, Org } from '../shared/types';


/**
 * Pending invites for the caller's email across all orgs.
 * Needs a collection-group index on `invites` (email ASC, status ASC).
 */
export async function listMyInvitesHandler(request: CallableRequest<unknown>): Promise<ListMyInvitesResponse> {
  const auth = requireAuth(request);
  if (!auth.email) return { invites: [] };
  const snap = await db()
    .collectionGroup('invites')
    .where('email', '==', auth.email)
    .where('status', '==', 'pending')
    .limit(50)
    .get();
  const rows = snap.docs
    .map((d) => ({ inviteId: d.id, orgId: d.ref.parent.parent?.id ?? '', invite: d.data() as Invite }))
    .filter((r) => r.orgId);
  const orgs = await getMany<Org>(rows.map((r) => paths.org(r.orgId)));
  return {
    invites: rows
      .filter((r) => orgs.has(paths.org(r.orgId)))
      .map((r) => ({ orgId: r.orgId, inviteId: r.inviteId, orgName: orgs.get(paths.org(r.orgId))!.name, role: r.invite.role })),
  };
}

export const listMyInvites = onCall(listMyInvitesHandler);
