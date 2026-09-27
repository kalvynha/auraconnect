/**
 * `sendBroadcast` — resolves recipients from a {@link BroadcastTarget}, creates
 * a `broadcast` channel (members = recipients + sender; only the sender may
 * post, enforced by the rules) and posts the message. `onMessageCreated`
 * then pushes to the recipients.
 *
 * Targets: `team` → the team's active members; `role` → who is on call now
 * (shifts, else fallbackUids); `discipline` → active members with that
 * discipline; `all` → every active member. The sender is never a recipient.
 *
 * v4: `requireAck: true` sets `channel.requireAck`; recipients acknowledge by writing
 * `channels/{id}/acks/{uid}` themselves, and `broadcastAckReport` lists acked and pending.
 */
import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { normalizeUids } from '../domain/channels';
import { writeAudit } from '../lib/audit';
import { parse, requireOrg, WRITER_ROLES } from '../lib/context';
import { enforceRateLimit } from '../lib/rateLimit';
import { colRef, db, getDocData, paths } from '../lib/db';
import { loadActiveMembers } from '../lib/members';
import { discipline, id, priority } from '../lib/schemas';
import { resolveOnCall } from '../scheduling/resolveOnCall';
import type { BroadcastTarget, Member, SendBroadcastRequest, SendBroadcastResponse, Team } from '../shared/types';
import { newChannelDoc } from './createChannel';

/** Keeps the channel doc (memberUids) and push fan-out bounded. */
export const MAX_BROADCAST_RECIPIENTS = 1000;

const target = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('team'), teamId: id }),
  z.object({ kind: z.literal('role'), roleKey: id }),
  z.object({ kind: z.literal('discipline'), discipline }),
  z.object({ kind: z.literal('all') }),
]);

const schema = z.object({
  orgId: id,
  name: z.string().trim().min(1).max(100),
  target,
  body: z.string().trim().min(1).max(8000),
  priority,
  requireAck: z.boolean().optional().default(false),
});

/** Resolves broadcast recipients (active members only), excluding the sender. Sorted. */
export async function resolveBroadcastRecipients(orgId: string, t: BroadcastTarget, senderUid: string): Promise<string[]> {
  let uids: string[];
  switch (t.kind) {
    case 'team': {
      const team = await getDocData<Team>(paths.team(orgId, t.teamId));
      if (!team) throw new HttpsError('not-found', 'Team not found.');
      uids = [...(await loadActiveMembers(orgId, team.memberUids ?? [])).keys()];
      break;
    }
    case 'role': {
      const r = await resolveOnCall(orgId, t.roleKey, { excludeUid: senderUid });
      if (!r.role) throw new HttpsError('not-found', 'Unknown on-call role.');
      uids = r.uids;
      break;
    }
    case 'discipline':
    case 'all': {
      let q = colRef(paths.members(orgId)).where('active', '==', true);
      if (t.kind === 'discipline') q = q.where('discipline', '==', t.discipline);
      const snap = await q.limit(MAX_BROADCAST_RECIPIENTS + 2).get();
      uids = snap.docs.map((d) => (d.data() as Member).uid ?? d.id);
      break;
    }
  }
  const out = normalizeUids(uids).filter((u) => u !== senderUid);
  if (out.length > MAX_BROADCAST_RECIPIENTS) {
    throw new HttpsError('failed-precondition', `A broadcast can reach at most ${MAX_BROADCAST_RECIPIENTS} people; narrow the target.`);
  }
  return out;
}

export async function sendBroadcastHandler(request: CallableRequest<SendBroadcastRequest>): Promise<SendBroadcastResponse> {
  const input = parse(schema, request.data);
  const ctx = await requireOrg(request, input.orgId, WRITER_ROLES);
  // M4: critical broadcasts page everyone at the loudest level; admins only.
  if (input.priority === 'critical' && ctx.role !== 'admin') {
    throw new HttpsError('permission-denied', 'Only an administrator can send a critical broadcast.');
  }
  await enforceRateLimit(ctx.orgId, ctx.uid, 'sendBroadcast');
  const sender = ctx.member;

  const recipients = await resolveBroadcastRecipients(ctx.orgId, input.target as BroadcastTarget, ctx.uid);
  if (recipients.length === 0) throw new HttpsError('failed-precondition', 'Nobody matches this broadcast target.');

  const channelRef = colRef(paths.channels(ctx.orgId)).doc();
  const msgRef = colRef(paths.messages(ctx.orgId, channelRef.id)).doc();
  const batch = db().batch();
  batch.set(channelRef, {
    ...newChannelDoc({
      type: 'broadcast',
      name: input.name,
      memberUids: [...recipients, ctx.uid],
      createdBy: ctx.uid,
      teamId: input.target.kind === 'team' ? input.target.teamId : null,
    }),
    requireAck: input.requireAck,
  });
  batch.set(msgRef, {
    senderUid: ctx.uid,
    senderName: sender.displayName,
    body: input.body,
    priority: input.priority,
    attachments: [],
    roleTarget: input.target.kind === 'role' ? input.target.roleKey : null,
    createdAt: FieldValue.serverTimestamp(),
    alertId: null,
    threadParentId: null,
  });
  await writeAudit(
    ctx.orgId,
    {
      actorUid: ctx.uid,
      action: 'broadcast.send',
      resourceType: 'channel',
      resourceId: channelRef.id,
      metadata: { target: input.target.kind, recipients: recipients.length, priority: input.priority, requireAck: input.requireAck },
    },
    batch,
  );
  await batch.commit();
  return { channelId: channelRef.id, messageId: msgRef.id, recipientCount: recipients.length };
}

export const sendBroadcast = onCall(sendBroadcastHandler);
