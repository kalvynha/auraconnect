import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { normalizeUids } from '../domain/channels';
import { writeAudit } from '../lib/audit';
import { parse, requireOrg, WRITER_ROLES } from '../lib/context';
import { db, docRef, paths } from '../lib/db';
import { assertActiveMembers } from '../lib/members';
import { id, uidList } from '../lib/schemas';
import type { Channel, UpdateChannelMembersRequest } from '../shared/types';

const schema = z
  .object({ orgId: id, channelId: id, add: uidList(500).default([]), remove: uidList(500).default([]) })
  .refine((v) => v.add.length + v.remove.length > 0, 'add or remove is required');

export async function updateChannelMembersHandler(request: CallableRequest<UpdateChannelMembersRequest>): Promise<Record<string, never>> {
  const input = parse(schema, request.data);
  const ctx = requireOrg(request, input.orgId, WRITER_ROLES);
  if (input.add.length) await assertActiveMembers(ctx.orgId, input.add);
  const ref = docRef(paths.channel(ctx.orgId, input.channelId));

  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Channel not found.');
    const channel = snap.data() as Channel;
    if (!channel.memberUids.includes(ctx.uid)) throw new HttpsError('permission-denied', 'You are not a member of this channel.');
    if (channel.type === 'direct') throw new HttpsError('failed-precondition', 'Direct channel members cannot change.');
    const removeSet = new Set(input.remove);
    const next = normalizeUids([...channel.memberUids, ...input.add]).filter((u) => !removeSet.has(u));
    if (next.length === 0) throw new HttpsError('failed-precondition', 'A channel needs at least one member.');
    tx.update(ref, { memberUids: next });
    await writeAudit(
      ctx.orgId,
      {
        actorUid: ctx.uid,
        action: 'channel.members.update',
        resourceType: 'channel',
        resourceId: input.channelId,
        patientId: channel.patientId,
        metadata: { added: input.add, removed: input.remove },
      },
      tx,
    );
  });
  return {};
}

export const updateChannelMembers = onCall(updateChannelMembersHandler);
