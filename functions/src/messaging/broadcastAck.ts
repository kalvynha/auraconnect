/**
 * v4 `broadcastAckReport` — who has acknowledged an ack-required broadcast and who is pending.
 * Allowed for the broadcast's sender, admins and the `reports` capability. Acks are the recipients'
 * self-written `channels/{id}/acks/{uid}` docs whose `messageId` matches.
 */
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { writeAudit } from '../lib/audit';
import { parse, requireOrg } from '../lib/context';
import { colRef, getMany, paths } from '../lib/db';
import { memberHasCapability } from '../lib/permissions';
import { id } from '../lib/schemas';
import type { BroadcastAck, BroadcastAckReportRequest, BroadcastAckReportResponse, Member } from '../shared/types';
import { loadChannel, plainTs, tsMs } from './access';

const schema = z.object({ orgId: id, channelId: id, messageId: id });

export async function broadcastAckReportHandler(request: CallableRequest<BroadcastAckReportRequest>): Promise<BroadcastAckReportResponse> {
  const input = parse(schema, request.data);
  const ctx = await requireOrg(request, input.orgId);
  const channel = await loadChannel(ctx.orgId, input.channelId);
  if (channel.createdBy !== ctx.uid && !memberHasCapability(ctx.member, 'reports')) {
    throw new HttpsError('permission-denied', 'Only the sender, an admin or someone with the reports permission can see acknowledgements.');
  }
  if (channel.type !== 'broadcast' || channel.requireAck !== true) {
    throw new HttpsError('failed-precondition', 'This is not an ack-required broadcast.');
  }
  const recipients = channel.memberUids.filter((u) => u !== channel.createdBy);
  const [ackSnap, members] = await Promise.all([
    colRef(paths.acks(ctx.orgId, input.channelId)).where('messageId', '==', input.messageId).get(),
    getMany<Member>(recipients.map((u) => paths.member(ctx.orgId, u))),
  ]);
  const acks = new Map(ackSnap.docs.map((d) => [d.id, d.data() as BroadcastAck]));
  const nameOf = (uid: string) => members.get(paths.member(ctx.orgId, uid))?.displayName ?? 'Former member';

  const acked: BroadcastAckReportResponse['acked'] = [];
  const pending: BroadcastAckReportResponse['pending'] = [];
  for (const uid of recipients) {
    const ack = acks.get(uid);
    if (ack) acked.push({ uid, name: nameOf(uid), ackedAt: plainTs(ack.ackedAt) });
    else pending.push({ uid, name: nameOf(uid) });
  }
  acked.sort((a, b) => tsMs(a.ackedAt) - tsMs(b.ackedAt) || a.name.localeCompare(b.name));
  pending.sort((a, b) => a.name.localeCompare(b.name));

  await writeAudit(ctx.orgId, {
    actorUid: ctx.uid, action: 'broadcast.ack_report', resourceType: 'channel', resourceId: input.channelId,
    metadata: { total: recipients.length, acked: acked.length },
  });
  return { total: recipients.length, acked, pending };
}

export const broadcastAckReport = onCall(broadcastAckReportHandler);
