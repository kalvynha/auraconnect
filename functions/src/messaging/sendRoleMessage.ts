import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { normalizeUids, sameMembers } from '../domain/channels';
import { writeAudit } from '../lib/audit';
import { parse, requireOrg, WRITER_ROLES } from '../lib/context';
import { colRef, db, getDocData, paths } from '../lib/db';
import { id, priority } from '../lib/schemas';
import { resolveOnCall } from '../scheduling/resolveOnCall';
import type { Channel, Member, SendRoleMessageRequest, SendRoleMessageResponse } from '../shared/types';
import { ensureDirectChannel, newChannelDoc } from './createChannel';

const schema = z.object({
  orgId: id,
  roleKey: id,
  body: z.string().trim().min(1).max(8000),
  priority,
});

/** Finds a group channel with this exact name and member set, or creates one. */
async function ensureGroupChannel(orgId: string, name: string, members: string[], createdBy: string): Promise<string> {
  const existing = await colRef(paths.channels(orgId))
    .where('type', '==', 'group')
    .where('name', '==', name)
    .where('memberUids', 'array-contains', createdBy)
    .limit(50)
    .get();
  const match = existing.docs.find((d) => {
    const c = d.data() as Channel;
    return !c.archived && sameMembers(c.memberUids, members);
  });
  if (match) return match.id;
  const ref = colRef(paths.channels(orgId)).doc();
  const batch = db().batch();
  batch.set(ref, newChannelDoc({ type: 'group', name, memberUids: members, createdBy }));
  await writeAudit(orgId, { actorUid: createdBy, action: 'channel.create', resourceType: 'channel', resourceId: ref.id, metadata: { type: 'group', viaRole: true } }, batch);
  await batch.commit();
  return ref.id;
}

export async function sendRoleMessageHandler(request: CallableRequest<SendRoleMessageRequest>): Promise<SendRoleMessageResponse> {
  const input = parse(schema, request.data);
  const ctx = requireOrg(request, input.orgId, WRITER_ROLES);

  const sender = await getDocData<Member>(paths.member(ctx.orgId, ctx.uid));
  if (!sender?.active) throw new HttpsError('permission-denied', 'Your membership is not active.');

  const resolved = await resolveOnCall(ctx.orgId, input.roleKey, { excludeUid: ctx.uid });
  if (!resolved.role) throw new HttpsError('not-found', 'Unknown on-call role.');
  if (resolved.uids.length === 0) throw new HttpsError('failed-precondition', 'Nobody is on call for this role right now.');

  const channelId =
    resolved.uids.length === 1
      ? (await ensureDirectChannel(ctx.orgId, ctx.uid, resolved.uids[0]!, ctx.uid)).channelId
      : await ensureGroupChannel(ctx.orgId, resolved.role.label, normalizeUids([...resolved.uids, ctx.uid]), ctx.uid);

  const msgRef = colRef(paths.messages(ctx.orgId, channelId)).doc();
  await msgRef.set({
    senderUid: ctx.uid,
    senderName: sender.displayName,
    body: input.body,
    priority: input.priority,
    attachments: [],
    roleTarget: input.roleKey,
    createdAt: FieldValue.serverTimestamp(),
    alertId: null,
  });
  return { channelId, messageId: msgRef.id, resolvedUids: resolved.uids };
}

export const sendRoleMessage = onCall(sendRoleMessageHandler);
