import { FieldValue } from 'firebase-admin/firestore';
import { defineBoolean } from 'firebase-functions/params';
import { logger } from 'firebase-functions/v2';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { writeAudit } from '../lib/audit';
import { setOrgClaims } from '../lib/claims';
import { parse, requireAuth } from '../lib/context';
import { db, docRef, paths } from '../lib/db';
import { id } from '../lib/schemas';
import { INVITE_TTL_DAYS, type AcceptInviteRequest, type AcceptInviteResponse, type Invite, type Member, type UserOrg } from '../shared/types';

function ms(t: { toMillis?: () => number; seconds: number; nanoseconds?: number } | null | undefined): number | null {
  if (!t) return null;
  return typeof t.toMillis === 'function' ? t.toMillis() : t.seconds * 1000 + Math.floor((t.nanoseconds ?? 0) / 1e6);
}

/** True once the invite's `expiresAt` (or createdAt + INVITE_TTL_DAYS for older invites) has passed. */
export function inviteExpired(invite: Pick<Invite, 'expiresAt' | 'createdAt'>, nowMs = Date.now()): boolean {
  const exp = ms(invite.expiresAt) ?? (ms(invite.createdAt) ?? nowMs) + INVITE_TTL_DAYS * 86_400_000;
  return nowMs > exp;
}

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

  // Load-test finding: bulk onboarding contended on the shared team docs inside this
  // transaction. Teams are read before it and updated with arrayUnion after it commits.
  const pre = await inviteRef.get();
  const preTeamIds = pre.exists ? ((pre.data() as Invite).teamIds ?? []) : [];
  const preTeams = preTeamIds.length ? await db().getAll(...preTeamIds.map((t) => docRef(paths.team(input.orgId, t)))) : [];
  const existingTeamIds = preTeams.filter((t) => t.exists).map((t) => t.id);

  const result = await db().runTransaction(async (tx) => {
    const [inviteSnap, memberSnap, userOrgSnap] = await Promise.all([tx.get(inviteRef), tx.get(memberRef), tx.get(userOrgRef)]);
    if (!inviteSnap.exists) throw new HttpsError('not-found', 'Invite not found.');
    const invite = inviteSnap.data() as Invite;
    if (invite.email.toLowerCase() !== auth.email) throw new HttpsError('permission-denied', 'This invite is for a different email.');
    const userOrg = userOrgSnap.exists ? (userOrgSnap.data() as UserOrg) : null;
    if (userOrg && userOrg.orgId !== input.orgId) {
      throw new HttpsError('failed-precondition', 'You already belong to another organization.');
    }
    if (invite.status === 'accepted' && invite.acceptedBy === auth.uid) return { role: invite.role, teamIds: [] as string[] }; // idempotent retry
    if (invite.status === 'revoked') throw new HttpsError('failed-precondition', 'This invite was revoked. Ask your administrator for a new one.');
    if (invite.status !== 'pending') throw new HttpsError('failed-precondition', 'This invite is no longer valid.');
    if (inviteExpired(invite)) throw new HttpsError('failed-precondition', 'This invite has expired. Ask your administrator to send it again.');
    const existing = memberSnap.exists ? (memberSnap.data() as Member) : null;
    if (existing?.active) throw new HttpsError('already-exists', 'You are already a member of this organization.');
    const teamIds = (invite.teamIds ?? []).filter((t) => existingTeamIds.includes(t));
    const now = FieldValue.serverTimestamp();
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
    tx.update(inviteRef, { status: 'accepted', acceptedBy: auth.uid, acceptedAt: now });
    tx.set(userOrgRef, { orgId: input.orgId, role: invite.role });
    await writeAudit(
      input.orgId,
      { actorUid: auth.uid, action: 'member.join', resourceType: 'member', resourceId: auth.uid, metadata: { inviteId: input.inviteId, role: invite.role, teams: teamIds.length } },
      tx,
    );
    return { role: invite.role, teamIds };
  });
  const role = result.role;
  // arrayUnion is idempotent and needs no read, so concurrent joins don't conflict.
  await Promise.all(
    result.teamIds.map((t) =>
      docRef(paths.team(input.orgId, t))
        .update({ memberUids: FieldValue.arrayUnion(auth.uid) })
        .catch((e: unknown) => logger.warn('team membership update failed after invite acceptance', { orgId: input.orgId, teamId: t, code: (e as { code?: unknown })?.code ?? 'unknown' })),
    ),
  );
  await setOrgClaims(auth.uid, input.orgId, role);
  return { orgId: input.orgId, role };
}

export const acceptInvite = onCall((req: CallableRequest<AcceptInviteRequest>) => acceptInviteHandler(req));
