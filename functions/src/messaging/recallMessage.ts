/**
 * `recallMessage` — the sender or an admin (both must be channel members)
 * recalls a message: sets `recalledAt` and empties `body` and `attachments`.
 * When it is the channel's `lastMessage`, the preview becomes "Message
 * recalled". Recalling twice is a no-op.
 *
 * v3 (S6, soft recall): the original is first copied to the admin-only
 * `messageRecalls/{channelId}_{messageId}` in the same transaction, and the
 * attachment files are kept in Storage (the copy still references them).
 */
import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { writeAudit } from '../lib/audit';
import { parse, requireOrg, WRITER_ROLES } from '../lib/context';
import { db, docRef, paths } from '../lib/db';
import { id } from '../lib/schemas';
import { safeAttachmentPaths } from '../lib/storageFiles';
import type { Channel, Message, MessageRecall, RecallMessageRequest, TimestampLike } from '../shared/types';

export const RECALLED_PREVIEW = 'Message recalled';

const schema = z.object({ orgId: id, channelId: id, messageId: id });

function sameInstant(a: TimestampLike | null | undefined, b: TimestampLike | null | undefined): boolean {
  if (!a || !b) return false;
  return a.seconds === b.seconds && (a.nanoseconds ?? 0) === (b.nanoseconds ?? 0);
}

export async function recallMessageHandler(request: CallableRequest<RecallMessageRequest>): Promise<Record<string, never>> {
  const input = parse(schema, request.data);
  const ctx = await requireOrg(request, input.orgId, WRITER_ROLES);
  const channelRef = docRef(paths.channel(ctx.orgId, input.channelId));
  const msgRef = docRef(paths.message(ctx.orgId, input.channelId, input.messageId));

  const recallRef = docRef(`${paths.org(ctx.orgId)}/messageRecalls/${input.channelId}_${input.messageId}`);
  await db().runTransaction(async (tx) => {
    const [cSnap, mSnap] = await Promise.all([tx.get(channelRef), tx.get(msgRef)]);
    if (!cSnap.exists) throw new HttpsError('not-found', 'Channel not found.');
    const channel = cSnap.data() as Channel;
    if (!channel.memberUids?.includes(ctx.uid)) throw new HttpsError('permission-denied', 'You are not a member of this channel.');
    if (!mSnap.exists) throw new HttpsError('not-found', 'Message not found.');
    const message = mSnap.data() as Message;
    if (message.senderUid !== ctx.uid && ctx.role !== 'admin') {
      throw new HttpsError('permission-denied', 'Only the sender or an admin can recall a message.');
    }
    if (message.recalledAt) return;

    const copy: Omit<MessageRecall, 'recalledAt'> & { recalledAt: unknown } = {
      channelId: input.channelId,
      messageId: input.messageId,
      patientId: channel.patientId ?? null,
      senderUid: message.senderUid,
      senderName: message.senderName ?? '',
      body: message.body ?? '',
      priority: message.priority ?? 'normal',
      attachments: message.attachments ?? [],
      threadParentId: message.threadParentId ?? null,
      messageCreatedAt: message.createdAt ?? null,
      recalledBy: ctx.uid,
      recalledAt: FieldValue.serverTimestamp(),
    };
    tx.set(recallRef, copy);
    tx.update(msgRef, { recalledAt: FieldValue.serverTimestamp(), body: '', attachments: [] });
    const last = channel.lastMessage;
    if (!message.threadParentId && last && last.senderUid === message.senderUid && sameInstant(last.at, message.createdAt)) {
      tx.update(channelRef, { 'lastMessage.text': RECALLED_PREVIEW });
    }
    const files = safeAttachmentPaths(ctx.orgId, input.channelId, message.attachments);
    await writeAudit(
      ctx.orgId,
      {
        actorUid: ctx.uid,
        action: 'message.recall',
        resourceType: 'message',
        resourceId: `${input.channelId}/${input.messageId}`,
        patientId: channel.patientId ?? null,
        metadata: { bySender: message.senderUid === ctx.uid, attachments: files.length },
      },
      tx,
    );
  });
  return {};
}

export const recallMessage = onCall(recallMessageHandler);
