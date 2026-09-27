/**
 * `recallMessage` — the sender or an admin (both must be channel members)
 * recalls a message: sets `recalledAt`, empties `body` and `attachments`, and
 * deletes the attachment files. When it is the channel's `lastMessage`, the
 * preview becomes "Message recalled". Recalling twice is a no-op.
 */
import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { writeAudit } from '../lib/audit';
import { parse, requireOrg, WRITER_ROLES } from '../lib/context';
import { db, docRef, paths } from '../lib/db';
import { id } from '../lib/schemas';
import { deleteStorageObjects, safeAttachmentPaths } from '../lib/storageFiles';
import type { Channel, Message, RecallMessageRequest, TimestampLike } from '../shared/types';

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

  const toDelete = await db().runTransaction(async (tx) => {
    const [cSnap, mSnap] = await Promise.all([tx.get(channelRef), tx.get(msgRef)]);
    if (!cSnap.exists) throw new HttpsError('not-found', 'Channel not found.');
    const channel = cSnap.data() as Channel;
    if (!channel.memberUids?.includes(ctx.uid)) throw new HttpsError('permission-denied', 'You are not a member of this channel.');
    if (!mSnap.exists) throw new HttpsError('not-found', 'Message not found.');
    const message = mSnap.data() as Message;
    if (message.senderUid !== ctx.uid && ctx.role !== 'admin') {
      throw new HttpsError('permission-denied', 'Only the sender or an admin can recall a message.');
    }
    if (message.recalledAt) return [];

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
    return files;
  });

  await deleteStorageObjects(toDelete);
  return {};
}

export const recallMessage = onCall(recallMessageHandler);
