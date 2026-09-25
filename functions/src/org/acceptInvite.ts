import { FieldValue } from 'firebase-admin/firestore';
import { defineBoolean } from 'firebase-functions/params';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { writeAudit } from '../lib/audit';
import { setOrgClaims } from '../lib/claims';
import { parse, requireAuth } from '../lib/context';
import { db, docRef, paths } from '../lib/db';
import { id } from '../lib/schemas';
import type { AcceptInviteRequest, AcceptInviteResponse, Invite, Member, UserOrg } from '../shared/types';

/**
 * When true, invites can only be accepted from an account whose email is
 * verified. Defaults to true: with email/password sign-up enabled, anyone
 * could otherwise register an unverified account with the invitee's address
 * and claim the invite. Set false only for SSO-only tenants.
 */
export const INVITE_REQUIRE_VERIFIED_EMAIL = defineBoolean('INVITE_REQUIRE_VERIFIED_EMAIL', { default: true });

const schema = z.object({ orgId: id, inviteId: id });

export async function acceptInviteHandler(
  request: CallableRequest<AcceptInviteRequest>,
  opts: { requireVerified?: boolean } = {},
): Promise<AcceptInviteResponse> {
  const auth = requireAuth(request);
  const input = parse(schema, request.data);
  if (!auth.email) throw new HttpsError('failed-precondition', 'Your account has no email address.');
  const requireVerified = opts.requireVerified ?? INVITE_REQUIRE_VERIFIED_EMAIL.value();
  if (requireVerified && !auth.emailVerified) {
    throw new HttpsError('failed-precondition', 'Verify your email address before accepting the invite.');
  }
  if (typeof auth.claims.orgId === 'string' && auth.claims.orgId !== input.orgId) {
    throw new HttpsError('failed-precondition', 'You already belong to another organization.');
  }

  const inviteRef = docRef(paths.invite(input.orgId, input.inviteId));
  const memberRef = docRef(paths.member(input.orgId, auth.uid));
  const userOrgRef = docRef(paths.userOrg(auth.uid));

  const role = await db().runTransaction(async (tx) => {
    const [inviteSnap, memberSnap, userOrgSnap] = await Promise.all([tx.get(inviteRef), tx.get(memberRef), tx.get(userOrgRef)]);
    if (!inviteSnap.exists) throw new HttpsError('not-found', 'Invite not found.');
    const invite = inviteSnap.data() as Invite;
    if (invite.email.toLowerCase() !== auth.email) throw new HttpsError('permission-denied', 'This invite is for a different email.');
    const userOrg = userOrgSnap.exists ? (userOrgSnap.data() as UserOrg) : null;
    if (userOrg && userOrg.orgId !== input.orgId) {
      throw new HttpsError('failed-precondition', 'You already belong to another organization.');
    }
    if (invite.status === 'accepted' && invite.acceptedBy === auth.uid) return invite.role; // idempotent retry
    if (invite.status !== 'pending') throw new HttpsError('failed-precondition', 'This invite is no longer valid.');
    const existing = memberSnap.exists ? (memberSnap.data() as Member) : null;
    if (existing?.active) throw new HttpsError('already-exists', 'You are already a member of this organization.');

    const teamRefs = invite.teamIds.map((t) => docRef(paths.team(input.orgId, t)));
    const teamSnaps = teamRefs.length ? await tx.getAll(...teamRefs) : [];
    const now = FieldValue.serverTimestamp();
    const teamIds = teamSnaps.filter((s) => s.exists).map((s) => s.id);

    tx.set(memberRef, {
      uid: auth.uid,
      email: auth.email,
      displayName: invite.displayName,
      role: invite.role,
      discipline: invite.discipline,
      title: existing?.title ?? null,
      phone: existing?.phone ?? null,
      teamIds,
      active: true,
      fcmTokens: existing?.fcmTokens ?? [],
      createdAt: now,
    });
    for (const snap of teamSnaps) {
      if (snap.exists) tx.update(snap.ref, { memberUids: FieldValue.arrayUnion(auth.uid) });
    }
    tx.update(inviteRef, { status: 'accepted', acceptedBy: auth.uid, acceptedAt: now });
    tx.set(userOrgRef, { orgId: input.orgId, role: invite.role });
    await writeAudit(
      input.orgId,
      { actorUid: auth.uid, action: 'member.join', resourceType: 'member', resourceId: auth.uid, metadata: { inviteId: input.inviteId, role: invite.role } },
      tx,
    );
    return invite.role;
  });

  await setOrgClaims(auth.uid, input.orgId, role);
  return { orgId: input.orgId, role };
}

export const acceptInvite = onCall((req: CallableRequest<AcceptInviteRequest>) => acceptInviteHandler(req));
