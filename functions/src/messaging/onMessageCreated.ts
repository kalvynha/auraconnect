import { Timestamp } from 'firebase-admin/firestore';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { truncateText } from '../domain/channels';
import { db, docRef, getDocData, paths } from '../lib/db';
import { messagePushTitle, pushToMembers } from '../lib/notify';
import { raiseAlert } from '../alerts/raiseAlert';
import type { Channel, Member, Message, TimestampLike } from '../shared/types';
import { FIRESTORE_TRIGGER_REGION } from '../lib/regions';

function toMillis(t: TimestampLike | null | undefined): number {
  if (!t) return 0;
  return typeof t.toMillis === 'function' ? t.toMillis() : t.seconds * 1000 + Math.floor((t.nanoseconds ?? 0) / 1e6);
}

/** Deterministic alert id so a retried trigger never raises two alerts. */
export function messageAlertId(channelId: string, messageId: string): string {
  return `msg_${channelId}_${messageId}`;
}

/**
 * 1. Updates channel.lastMessage/lastMessageAt (only if this message is newer).
 * 2. normal: pushes "New message" to the other members.
 *    urgent/critical: raises a `message` alert to the other members with the
 *    org default policy and sets message.alertId. The alert's push (sent by
 *    onAlertCreated, titled "Urgent/Critical message", carrying channelId) is
 *    the only push for that message, so recipients are not notified twice.
 */
export async function handleMessageCreated(orgId: string, channelId: string, messageId: string, message: Message): Promise<void> {
  const channelRef = docRef(paths.channel(orgId, channelId));
  const at = message.createdAt && toMillis(message.createdAt) > 0 ? message.createdAt : Timestamp.now();
  const text = truncateText(message.body ?? '') || (message.attachments?.length ? 'Attachment' : '');

  const channel = await db().runTransaction(async (tx) => {
    const snap = await tx.get(channelRef);
    if (!snap.exists) return null;
    const c = snap.data() as Channel;
    if (!c.lastMessage || toMillis(c.lastMessageAt) <= toMillis(at)) {
      tx.update(channelRef, {
        lastMessage: { text, senderUid: message.senderUid, senderName: message.senderName, priority: message.priority, at },
        lastMessageAt: at,
      });
    }
    return c;
  });
  if (!channel) return;

  const recipients = channel.memberUids.filter((u) => u !== message.senderUid);
  if (recipients.length === 0) return;

  if (message.priority === 'urgent' || message.priority === 'critical') {
    if (message.alertId) return;
    // senderName is client-written; use the member doc for the alert text.
    const sender = await getDocData<Member>(paths.member(orgId, message.senderUid));
    const { alertId } = await raiseAlert({
      orgId,
      alertId: messageAlertId(channelId, messageId),
      title: messagePushTitle(message.priority),
      body: `From ${sender?.displayName ?? message.senderName}`,
      priority: message.priority,
      source: { type: 'message', channelId, messageId },
      targetUids: recipients,
      policyId: 'default',
      createdBy: message.senderUid,
    });
    await docRef(paths.message(orgId, channelId, messageId)).update({ alertId });
    return;
  }

  await pushToMembers(orgId, recipients, messagePushTitle(message.priority), {
    type: 'message',
    orgId,
    channelId,
    priority: message.priority,
  });
}

export const onMessageCreated = onDocumentCreated(
  { document: 'orgs/{orgId}/channels/{channelId}/messages/{messageId}', region: FIRESTORE_TRIGGER_REGION },
  async (event) => {
  if (!event.data) return;
  const { orgId, channelId, messageId } = event.params;
  await handleMessageCreated(orgId, channelId, messageId, event.data.data() as Message);
});
