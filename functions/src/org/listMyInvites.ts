import { onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { requireAuth } from '../lib/context';
import { db, getMany, paths } from '../lib/db';
import type { Invite, ListMyInvitesResponse, Org } from '../shared/types';
import { INVITE_REQUIRE_VERIFIED_EMAIL, inviteExpired } from './acceptInvite';

/**
 * Pending, unexpired invites for the caller's email across all orgs.
 * Needs a collection-group index on `invites` (email ASC, status ASC).
 *
 * L2: org names are only revealed to a verified email (same param as `acceptInvite`),
 * otherwise anyone could register an unverified account with someone else's address
 * and enumerate which orgs invited them.
 */
export async function listMyInvitesHandler(
  request: CallableRequest<unknown>,
  opts: { requireVerified?: boolean; now?: () => number } = {},
): Promise<ListMyInvitesResponse> {
  const auth = requireAuth(request);
  if (!auth.email) return { invites: [] };
  const requireVerified = opts.requireVerified ?? INVITE_REQUIRE_VERIFIED_EMAIL.value();
  if (requireVerified && !auth.emailVerified) return { invites: [], verificationRequired: true };
  const nowMs = (opts.now ?? Date.now)();
  const snap = await db()
    .collectionGroup('invites')
    .where('email', '==', auth.email)
    .where('status', '==', 'pending')
    .limit(50)
    .get();
  const rows = snap.docs
    .map((d) => ({ inviteId: d.id, orgId: d.ref.parent.parent?.id ?? '', invite: d.data() as Invite }))
    .filter((r) => r.orgId && !inviteExpired(r.invite, nowMs));
  const orgs = await getMany<Org>(rows.map((r) => paths.org(r.orgId)));
  return {
    invites: rows
      .filter((r) => orgs.has(paths.org(r.orgId)))
      .map((r) => ({ orgId: r.orgId, inviteId: r.inviteId, orgName: orgs.get(paths.org(r.orgId))!.name, role: r.invite.role })),
  };
}

export const listMyInvites = onCall((req: CallableRequest<unknown>) => listMyInvitesHandler(req));
