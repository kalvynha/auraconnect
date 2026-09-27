/**
 * v4 pins and channel management.
 *  - `pinMessage`: any channel member who can post (in a broadcast, only its sender). At most
 *    `MAX_PINS` pins, newest first, each with a ≤ 140-char snippet. Audited.
 *  - `renameChannel`: group and team channels, by the creator or an admin.
 *  - `leaveChannel`: group and team channels (never patient channels), unless the caller is the last
 *    member. Adding/removing others stays with `updateChannelMembers`.
 */
import { Timestamp } from 'firebase-admin/firestore';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { truncateText } from '../domain/channels';
import { writeAudit } from '../lib/audit';
import { parse, requireOrg } from '../lib/context';
import { db, docRef, paths } from '../lib/db';
import { requireCanPost } from '../lib/permissions';
import { id } from '../lib/schemas';
import type { Channel, LeaveChannelRequest, Message, PinMessageRequest, PinnedMessage, RenameChannelRequest } from '../shared/types';
import { assertChannelMember } from './access';
import { earliestCoverageEnd } from './coverage';

export const MAX_PINS = 10;
export const PIN_SNIPPET_MAX = 140;

const pinSchema = z.object({ orgId: id, channelId: id, messageId: id, pinned: z.boolean() });
const renameSchema = z.object({ orgId: id, channelId: id, name: z.string().trim().min(1).max(100) });
const leaveSchema = z.object({ orgId: id, channelId: id });

/** Pin snippet: the message text (or "Attachment"), whitespace-collapsed, ≤ 140 chars. */
export function pinSnippet(message: Pick<Message, 'body' | 'attachments'>): string {
  return truncateText(message.body ?? '', PIN_SNIPPET_MAX) || (message.attachments?.length ? 'Attachment' : '');
}

export async function pinMessageHandler(request: CallableRequest<PinMessageRequest>): Promise<Record<string, never>> {
  const input = parse(pinSchema, request.data);
  const ctx = await requireOrg(request, input.orgId);
  requireCanPost(ctx);
  const channelRef = docRef(paths.channel(ctx.orgId, input.channelId));
  const msgRef = docRef(paths.message(ctx.orgId, input.channelId, input.messageId));

  await db().runTransaction(async (tx) => {
    const [cSnap, mSnap] = await Promise.all([tx.get(channelRef), tx.get(msgRef)]);
    if (!cSnap.exists) throw new HttpsError('not-found', 'Channel not found.');
    const channel = cSnap.data() as Channel;
    assertChannelMember(channel, ctx.uid);
    if (channel.type === 'broadcast' && channel.createdBy !== ctx.uid) {
      throw new HttpsError('permission-denied', 'Only the sender can pin in a broadcast.');
    }
    if (channel.archived) throw new HttpsError('failed-precondition', 'This conversation is archived.');
    const pins = channel.pinned ?? [];
    const isPinned = pins.some((p) => p.messageId === input.messageId);

    if (!input.pinned) {
      if (!isPinned) return;
      tx.update(channelRef, { pinned: pins.filter((p) => p.messageId !== input.messageId) });
    } else {
      if (isPinned) return;
      if (!mSnap.exists) throw new HttpsError('not-found', 'Message not found.');
      const message = mSnap.data() as Message;
      if (message.recalledAt) throw new HttpsError('failed-precondition', 'A recalled message cannot be pinned.');
      if (pins.length >= MAX_PINS) {
        throw new HttpsError('failed-precondition', `At most ${MAX_PINS} messages can be pinned; unpin one first.`);
      }
      const pin: PinnedMessage = { messageId: input.messageId, snippet: pinSnippet(message), pinnedBy: ctx.uid, pinnedAt: Timestamp.now() };
      tx.update(channelRef, { pinned: [pin, ...pins] });
    }
    await writeAudit(
      ctx.orgId,
      {
        actorUid: ctx.uid,
        action: input.pinned ? 'message.pin' : 'message.unpin',
        resourceType: 'message',
        resourceId: `${input.channelId}/${input.messageId}`,
        patientId: channel.patientId ?? null,
      },
      tx,
    );
  });
  return {};
}

export async function renameChannelHandler(request: CallableRequest<RenameChannelRequest>): Promise<Record<string, never>> {
  const input = parse(renameSchema, request.data);
  const ctx = await requireOrg(request, input.orgId);
  const ref = docRef(paths.channel(ctx.orgId, input.channelId));
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Channel not found.');
    const channel = snap.data() as Channel;
    if (channel.type !== 'group' && channel.type !== 'team') {
      throw new HttpsError('failed-precondition', 'Only group and team conversations can be renamed.');
    }
    if (channel.createdBy !== ctx.uid && ctx.role !== 'admin') {
      throw new HttpsError('permission-denied', 'Only the creator or an admin can rename this conversation.');
    }
    if (channel.archived) throw new HttpsError('failed-precondition', 'This conversation is archived.');
    if (channel.name === input.name) return;
    tx.update(ref, { name: input.name });
    await writeAudit(ctx.orgId, { actorUid: ctx.uid, action: 'channel.rename', resourceType: 'channel', resourceId: input.channelId }, tx);
  });
  return {};
}

export async function leaveChannelHandler(request: CallableRequest<LeaveChannelRequest>): Promise<Record<string, never>> {
  const input = parse(leaveSchema, request.data);
  const ctx = await requireOrg(request, input.orgId);
  const ref = docRef(paths.channel(ctx.orgId, input.channelId));
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Channel not found.');
    const channel = snap.data() as Channel;
    assertChannelMember(channel, ctx.uid);
    if (channel.type !== 'group' && channel.type !== 'team') {
      throw new HttpsError('failed-precondition', 'You can only leave group and team conversations.');
    }
    const next = channel.memberUids.filter((u) => u !== ctx.uid);
    if (next.length === 0) throw new HttpsError('failed-precondition', 'You are the last member of this conversation.');
    const update: Record<string, unknown> = { memberUids: next };
    const coverage = channel.coverageMembers ?? [];
    if (coverage.some((c) => c.uid === ctx.uid)) {
      const kept = coverage.filter((c) => c.uid !== ctx.uid);
      update.coverageMembers = kept;
      update.coverageExpiresAt = earliestCoverageEnd(kept);
    }
    tx.update(ref, update);
    await writeAudit(ctx.orgId, { actorUid: ctx.uid, action: 'channel.leave', resourceType: 'channel', resourceId: input.channelId, patientId: channel.patientId ?? null }, tx);
  });
  return {};
}

export const pinMessage = onCall(pinMessageHandler);
export const renameChannel = onCall(renameChannelHandler);
export const leaveChannel = onCall(leaveChannelHandler);
