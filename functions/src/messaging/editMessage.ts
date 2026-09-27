/**
 * v4 `editMessage` — the sender edits their own message within 15 minutes of sending, unless it was
 * recalled. The prior body goes to the admin/`audit`-only `messageEdits/{id}`
 * (`{channelId, messageId, previousBody, editedBy, editedAt}`); the message gets the new `body`,
 * `editedAt` and re-parsed `mentions` / `mentionRoles`. The channel preview and pin snippet follow
 * the edit. No push is sent.
 */
import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { truncateText } from '../domain/channels';
import { writeAudit } from '../lib/audit';
import { parse, requireOrg } from '../lib/context';
import { colRef, db, docRef, paths } from '../lib/db';
import { id } from '../lib/schemas';
import type { Channel, EditMessageRequest, Message, TimestampLike } from '../shared/types';
import { assertChannelMember, loadChannel, tsMs } from './access';
import { pinSnippet } from './channelActions';
import { resolveMentions } from './mentions';

export const EDIT_WINDOW_MS = 15 * 60_000;

const schema = z.object({
  orgId: id,
  channelId: id,
  messageId: id,
  body: z.string().max(8000).refine((b) => b.trim().length > 0, 'must not be empty'),
});

function sameInstant(a: TimestampLike | null | undefined, b: TimestampLike | null | undefined): boolean {
  if (!a || !b) return false;
  return a.seconds === b.seconds && (a.nanoseconds ?? 0) === (b.nanoseconds ?? 0);
}

export async function editMessageHandler(request: CallableRequest<EditMessageRequest>, now: Date = new Date()): Promise<Record<string, never>> {
  const input = parse(schema, request.data);
  const ctx = await requireOrg(request, input.orgId);
  const pre = await loadChannel(ctx.orgId, input.channelId);
  assertChannelMember(pre, ctx.uid);
  // Mentions need queries, so they are resolved before the transaction (against the current members).
  const mentions = await resolveMentions({ orgId: ctx.orgId, body: input.body, senderUid: ctx.uid, channelMemberUids: pre.memberUids, now });

  const channelRef = docRef(paths.channel(ctx.orgId, input.channelId));
  const msgRef = docRef(paths.message(ctx.orgId, input.channelId, input.messageId));
  const editRef = colRef(paths.messageEdits(ctx.orgId)).doc();
  await db().runTransaction(async (tx) => {
    const [cSnap, mSnap] = await Promise.all([tx.get(channelRef), tx.get(msgRef)]);
    if (!cSnap.exists) throw new HttpsError('not-found', 'Channel not found.');
    const channel = cSnap.data() as Channel;
    assertChannelMember(channel, ctx.uid);
    if (channel.archived) throw new HttpsError('failed-precondition', 'This conversation is archived.');
    if (!mSnap.exists) throw new HttpsError('not-found', 'Message not found.');
    const message = mSnap.data() as Message;
    if (message.senderUid !== ctx.uid) throw new HttpsError('permission-denied', 'Only the sender can edit a message.');
    if (message.recalledAt) throw new HttpsError('failed-precondition', 'A recalled message cannot be edited.');
    if (now.getTime() - tsMs(message.createdAt) > EDIT_WINDOW_MS) {
      throw new HttpsError('failed-precondition', 'Messages can only be edited within 15 minutes of sending.');
    }
    if (message.body === input.body) return;

    tx.set(editRef, {
      channelId: input.channelId,
      messageId: input.messageId,
      previousBody: message.body ?? '',
      editedBy: ctx.uid,
      editedAt: FieldValue.serverTimestamp(),
    });
    tx.update(msgRef, {
      body: input.body,
      editedAt: FieldValue.serverTimestamp(),
      mentions: mentions.mentions,
      mentionRoles: mentions.mentionRoles,
    });
    const channelUpdate: Record<string, unknown> = {};
    const last = channel.lastMessage;
    if (!message.threadParentId && last && last.senderUid === message.senderUid && sameInstant(last.at, message.createdAt)) {
      channelUpdate['lastMessage.text'] = truncateText(input.body);
    }
    const pins = channel.pinned ?? [];
    if (pins.some((p) => p.messageId === input.messageId)) {
      channelUpdate.pinned = pins.map((p) => (p.messageId === input.messageId ? { ...p, snippet: pinSnippet({ ...message, body: input.body }) } : p));
    }
    if (Object.keys(channelUpdate).length) tx.update(channelRef, channelUpdate);
    await writeAudit(
      ctx.orgId,
      {
        actorUid: ctx.uid,
        action: 'message.edit',
        resourceType: 'message',
        resourceId: `${input.channelId}/${input.messageId}`,
        patientId: channel.patientId ?? null,
        metadata: { editId: editRef.id },
      },
      tx,
    );
  });
  return {};
}

export const editMessage = onCall((request: CallableRequest<EditMessageRequest>) => editMessageHandler(request));
