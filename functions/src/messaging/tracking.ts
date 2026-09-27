/**
 * v4 delivery tracking.
 *  - `messageReadStatus`: read/unread channel members for a message, from
 *    `reads/{uid}.lastReadAt >= message.createdAt`. Any channel member may ask.
 *  - `nudgeUnread`: re-pushes a generic "Reminder: unread message" to the unread members. The sender
 *    or an admin (both channel members); 1 nudge per message per 10 minutes (`lib/rateLimit`).
 *  - `remindIfNoReply`: creates `reminders/{id}` and a Cloud Task. When it fires and nobody else has
 *    posted in the channel since the message, a normal self-alert "No reply yet" is raised. A later
 *    reply from someone else cancels the reminder (`onMessageCreated`), as does `cancelReminder`.
 */
import { Timestamp } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';
import { z } from 'zod';
import { NO_REPLY_ALERT_TITLE } from '../alerts/onAlertCreated';
import { raiseAlert } from '../alerts/raiseAlert';
import { writeAudit } from '../lib/audit';
import { parse, requireOrg } from '../lib/context';
import { colRef, db, docRef, getDocData, getMany, paths } from '../lib/db';
import { pushToMembers } from '../lib/notify';
import { enforceRateLimit } from '../lib/rateLimit';
import { id } from '../lib/schemas';
import { enqueueReminderTask, type ReminderTaskPayload } from '../lib/tasks';
import { SYSTEM_SENDER_UID } from '../lifecycle/notifyCareTeam';
import type {
  CancelReminderRequest, Channel, IdResponse, Member, Message, MessageReadStatusRequest, MessageReadStatusResponse,
  NoReplyReminder, NudgeUnreadRequest, NudgeUnreadResponse, ReadReceipt, RemindIfNoReplyRequest,
} from '../shared/types';
import { loadMemberChannel, loadMessage, plainTs, tsMs } from './access';

export const NUDGE_PUSH_TITLE = 'Reminder: unread message';
export const NO_REPLY_ALERT_BODY = 'No reply yet to your message.';
export const REMINDER_MINUTES = [15, 30, 60, 120] as const;

const messageSchema = z.object({ orgId: id, channelId: id, messageId: id });
const remindSchema = messageSchema.extend({
  minutes: z.number().int().refine((m) => (REMINDER_MINUTES as readonly number[]).includes(m), 'must be 15, 30, 60 or 120'),
});
const cancelSchema = z.object({ orgId: id, reminderId: id });

interface ReadSplit {
  read: MessageReadStatusResponse['read'];
  unread: MessageReadStatusResponse['unread'];
}

/** Active channel members other than the sender, split by whether they have read up to the message. */
export async function readSplit(orgId: string, channelId: string, channel: Channel, message: Message): Promise<ReadSplit> {
  const others = channel.memberUids.filter((u) => u !== message.senderUid);
  const memberPaths = others.map((u) => paths.member(orgId, u));
  const readPaths = others.map((u) => paths.read(orgId, channelId, u));
  const docs = await getMany<Member | ReadReceipt>([...memberPaths, ...readPaths]);
  const createdMs = tsMs(message.createdAt);
  const out: ReadSplit = { read: [], unread: [] };
  others.forEach((uid, i) => {
    const m = docs.get(memberPaths[i]!) as Member | undefined;
    if (!m?.active) return;
    const r = docs.get(readPaths[i]!) as ReadReceipt | undefined;
    if (r?.lastReadAt && tsMs(r.lastReadAt) >= createdMs) out.read.push({ uid, name: m.displayName, at: plainTs(r.lastReadAt) });
    else out.unread.push({ uid, name: m.displayName });
  });
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  out.read.sort(byName);
  out.unread.sort(byName);
  return out;
}

export async function messageReadStatusHandler(request: CallableRequest<MessageReadStatusRequest>): Promise<MessageReadStatusResponse> {
  const input = parse(messageSchema, request.data);
  const ctx = await requireOrg(request, input.orgId);
  const channel = await loadMemberChannel(ctx, input.channelId);
  const message = await loadMessage(ctx.orgId, input.channelId, input.messageId);
  return readSplit(ctx.orgId, input.channelId, channel, message);
}

export async function nudgeUnreadHandler(request: CallableRequest<NudgeUnreadRequest>): Promise<NudgeUnreadResponse> {
  const input = parse(messageSchema, request.data);
  const ctx = await requireOrg(request, input.orgId);
  const channel = await loadMemberChannel(ctx, input.channelId);
  const message = await loadMessage(ctx.orgId, input.channelId, input.messageId);
  if (message.senderUid !== ctx.uid && ctx.role !== 'admin') {
    throw new HttpsError('permission-denied', 'Only the sender or an admin can nudge unread members.');
  }
  if (message.recalledAt) throw new HttpsError('failed-precondition', 'This message was recalled.');
  const { unread } = await readSplit(ctx.orgId, input.channelId, channel, message);
  if (unread.length === 0) return { nudged: 0 };
  // Keyed per message, whoever nudges.
  await enforceRateLimit(ctx.orgId, `${input.channelId}_${input.messageId}`, 'nudgeUnread');
  const uids = unread.map((u) => u.uid);
  await pushToMembers(ctx.orgId, uids, NUDGE_PUSH_TITLE, {
    type: 'message', orgId: ctx.orgId, channelId: input.channelId, messageId: input.messageId, priority: 'normal',
  });
  await writeAudit(ctx.orgId, {
    actorUid: ctx.uid, action: 'message.nudge', resourceType: 'message', resourceId: `${input.channelId}/${input.messageId}`,
    patientId: channel.patientId ?? null, metadata: { nudged: uids.length },
  });
  return { nudged: uids.length };
}

export async function remindIfNoReplyHandler(request: CallableRequest<RemindIfNoReplyRequest>): Promise<IdResponse> {
  const input = parse(remindSchema, request.data);
  const ctx = await requireOrg(request, input.orgId);
  const channel = await loadMemberChannel(ctx, input.channelId);
  if (channel.archived) throw new HttpsError('failed-precondition', 'This conversation is archived.');
  const message = await loadMessage(ctx.orgId, input.channelId, input.messageId);
  if (message.recalledAt) throw new HttpsError('failed-precondition', 'This message was recalled.');

  const ref = colRef(paths.reminders(ctx.orgId)).doc();
  const dueAt = Timestamp.fromMillis(Date.now() + input.minutes * 60_000);
  const doc: NoReplyReminder = { channelId: input.channelId, messageId: input.messageId, ownerUid: ctx.uid, dueAt, status: 'pending' };
  await ref.set(doc);
  try {
    await enqueueReminderTask({ orgId: ctx.orgId, reminderId: ref.id }, input.minutes * 60);
  } catch (e) {
    await ref.update({ status: 'cancelled' });
    throw e;
  }
  return { id: ref.id };
}

export async function cancelReminderHandler(request: CallableRequest<CancelReminderRequest>): Promise<Record<string, never>> {
  const input = parse(cancelSchema, request.data);
  const ctx = await requireOrg(request, input.orgId);
  const ref = docRef(paths.reminder(ctx.orgId, input.reminderId));
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Reminder not found.');
    const r = snap.data() as NoReplyReminder;
    if (r.ownerUid !== ctx.uid) throw new HttpsError('permission-denied', 'Only the owner can cancel this reminder.');
    if (r.status === 'pending') tx.update(ref, { status: 'cancelled' });
  });
  return {};
}

export type ReminderOutcome = 'fired' | 'replied' | 'noop';

/** Cloud Task body: raise the self-alert unless someone else has replied (or the reminder is no longer pending). */
export async function handleNoReplyReminder(payload: ReminderTaskPayload): Promise<ReminderOutcome> {
  const { orgId, reminderId } = payload;
  const ref = docRef(paths.reminder(orgId, reminderId));
  const reminder = await getDocData<NoReplyReminder>(paths.reminder(orgId, reminderId));
  if (!reminder || reminder.status !== 'pending') return 'noop';
  const [channel, message] = await Promise.all([
    getDocData<Channel>(paths.channel(orgId, reminder.channelId)),
    getDocData<Message>(paths.message(orgId, reminder.channelId, reminder.messageId)),
  ]);
  if (!channel || !message || message.recalledAt || !channel.memberUids.includes(reminder.ownerUid)) {
    await ref.update({ status: 'cancelled' });
    return 'noop';
  }
  const later = await colRef(paths.messages(orgId, reminder.channelId))
    .where('createdAt', '>', message.createdAt)
    .orderBy('createdAt', 'asc')
    .limit(100)
    .get();
  const replied = later.docs.some((d) => {
    const m = d.data() as Message;
    return m.senderUid !== reminder.ownerUid && m.senderUid !== SYSTEM_SENDER_UID;
  });
  if (replied) {
    await ref.update({ status: 'cancelled' });
    return 'replied';
  }
  // The alert id is deterministic, so a retried or duplicate dispatch never raises it twice.
  await raiseAlert({
    orgId,
    alertId: `rem_${reminderId}`,
    title: NO_REPLY_ALERT_TITLE,
    body: NO_REPLY_ALERT_BODY,
    priority: 'normal',
    source: { type: 'message', channelId: reminder.channelId, messageId: reminder.messageId },
    targetUids: [reminder.ownerUid],
    policyId: null,
    createdBy: SYSTEM_SENDER_UID,
  });
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists && (snap.data() as NoReplyReminder).status === 'pending') tx.update(ref, { status: 'fired' });
  });
  return 'fired';
}

const taskSchema = z.object({ orgId: z.string().min(1), reminderId: z.string().min(1) });

export const fireNoReplyReminder = onTaskDispatched(
  { retryConfig: { maxAttempts: 5, minBackoffSeconds: 30 }, rateLimits: { maxConcurrentDispatches: 50 } },
  async (req) => {
    const parsed = taskSchema.safeParse(req.data);
    if (!parsed.success) {
      logger.error('invalid reminder payload');
      return;
    }
    await handleNoReplyReminder(parsed.data);
  },
);

export const messageReadStatus = onCall(messageReadStatusHandler);
export const nudgeUnread = onCall(nudgeUnreadHandler);
export const remindIfNoReply = onCall(remindIfNoReplyHandler);
export const cancelReminder = onCall(cancelReminderHandler);
