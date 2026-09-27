/** v3 invite list extras for the Members page: expiry, renew (re-invite) and revoke. */
import { useState } from 'react';
import type { Invite, InviteMemberRequest, InviteMemberResponse, RevokeInviteRequest } from '@shared/types';
import { call } from '../lib/firebase';
import type { WithId } from '../lib/firestore';
import { errorMessage, formatInstant, tsMillis } from '../lib/format';
import { sendInvitationEmail } from '../lib/invites';
import { Badge, Button } from './ui';

const INVITE_TTL_MS = 14 * 86_400_000;

/** `expiresAt`, or createdAt + 14 days for invites made before expiry existed (matches the server). */
export function inviteExpiresAtMs(i: Pick<Invite, 'expiresAt' | 'createdAt'>): number {
  return i.expiresAt ? tsMillis(i.expiresAt) : tsMillis(i.createdAt) + INVITE_TTL_MS;
}

export function InviteExpiry({ invite }: { invite: Invite }) {
  const exp = inviteExpiresAtMs(invite);
  if (exp < Date.now()) return <Badge tone="danger">expired</Badge>;
  return <span className="small">{formatInstant(invite.expiresAt ?? { seconds: Math.floor(exp / 1000), nanoseconds: 0 })}</span>;
}

/** Renew re-sends the invite (resetting its 14-day expiry) and emails the link again; Revoke cancels it. */
export function InviteActions({ orgId, invite }: { orgId: string; invite: WithId<Invite> }) {
  const [busy, setBusy] = useState<'renew' | 'revoke' | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function renew() {
    setBusy('renew');
    setNote(null);
    try {
      await call<InviteMemberRequest, InviteMemberResponse>('inviteMember', {
        orgId,
        email: invite.email,
        displayName: invite.displayName,
        role: invite.role,
        discipline: invite.discipline,
        teamIds: invite.teamIds,
      });
      await sendInvitationEmail(invite.email);
      setNote('Sent');
    } catch (err) {
      setNote(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function revoke() {
    if (!window.confirm(`Revoke the invitation for ${invite.email}? The link will stop working.`)) return;
    setBusy('revoke');
    setNote(null);
    try {
      await call<RevokeInviteRequest, Record<string, never>>('revokeInvite', { orgId, inviteId: invite.id });
    } catch (err) {
      setNote(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="row gap-sm">
      <Button small variant="ghost" busy={busy === 'renew'} disabled={!!busy} onClick={() => void renew()}>
        Resend
      </Button>
      <Button small variant="danger" busy={busy === 'revoke'} disabled={!!busy} onClick={() => void revoke()}>
        Revoke
      </Button>
      {note && <span className="muted small">{note}</span>}
    </div>
  );
}
