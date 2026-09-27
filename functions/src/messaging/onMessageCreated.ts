import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { truncateText } from '../domain/channels';
import { todayInTimeZone } from '../domain/dates';
import { isOutOfOffice, outOfOfficeReply } from '../domain/delivery';
import { mayContainMentions } from '../domain/mentions';
import { stripTemplateMarker } from '../domain/templates';
import { colRef, db, docRef, getDocData, paths } from '../lib/db';
import { writeAudit } from '../lib/audit';
import { logger } from 'firebase-functions/v2';
import { messagePushTitle, pushToMembers } from '../lib/notify';
import { raiseAlert } from '../alerts/raiseAlert';
import { SYSTEM_SENDER_UID } from '../lifecycle/notifyCareTeam';
import type { Alert, Channel, Member, Message, NoReplyReminder, Org, PushData, TimestampLike } from '../shared/types';
import { FIRESTORE_TRIGGER_REGION } from '../lib/regions';
import { filterRecipients, loadRecipientDocs, type RecipientDocs } from './delivery';
import { EMPTY_MENTIONS, nonMemberNoteText, resolveMentions } from './mentions';
import { isSilentSystemNote, postSilentNote, silentNoteId } from './systemNotes';

function toMillis(t: TimestampLike | null | undefined): number {
  if (!t) return 0;
  return typeof t.toMillis === 'function' ? t.toMillis() : t.seconds * 1000 + Math.floor((t.nanoseconds ?? 0) / 1e6);
}

/** Deterministic alert id so a retried trigger never raises two alerts. */
export function messageAlertId(channelId: string, messageId: string): string {
  return `msg_${channelId}_${messageId}`;
}

/**
 * 1. Top-level message: updates channel.lastMessage/lastMessageAt (only if
 *    this message is newer).
 *    Thread reply (`threadParentId` set): increments the parent's
 *    `replyCount` and advances its `lastReplyAt`; the channel preview is left
 *    unchanged, but the reply is still pushed / alerted like any message.
 * 2. normal: pushes "New message" to the other members.
 *    urgent/critical: raises a `message` alert to the other members with the
 *    org default policy and sets message.alertId. The alert's push (sent by
 *    onAlertCreated, titled "Urgent/Critical message", carrying channelId) is
 *    the only push for that message, so recipients are not notified twice.
 * 3. Broadcast channels: only messages from the channel creator are fanned
 *    out, and they are pushed at their priority without an escalating alert
 *    (a broadcast is an announcement, not an ack-required page to everyone).
 *
 * v4:
 *  - a leading `[[tpl:{id}]]` marker is stripped from the body and `templateId` set;
 *  - @mentions are parsed into `mentions` / `mentionRoles` (role mentions → on call now); mentioned
 *    people outside the channel get no push and the sender gets a silent system note;
 *  - normal-priority pushes are filtered by channel prefs, quiet hours, off-shift quiet and out of
 *    office (`messaging/delivery.ts`); urgent and critical always push;
 *  - a DM to someone out of office gets a silent auto-reply (once per day per absence);
 *  - a message from someone else cancels pending "remind me if no reply" reminders in the channel;
 *  - silent system notes (`sysnote_*`) are ignored entirely.
 */
export async function handleMessageCreated(orgId: string, channelId: string, messageId: string, message: Message, now: Date = new Date()): Promise<void> {
  if (isSilentSystemNote(messageId, message)) return;
  const channelRef = docRef(paths.channel(orgId, channelId));
  const msgRef = docRef(paths.message(orgId, channelId, messageId));
  const at = message.createdAt && toMillis(message.createdAt) > 0 ? message.createdAt : Timestamp.now();
  const stripped = stripTemplateMarker(message.body ?? '');
  const body = stripped.body;
  const text = truncateText(body) || (message.attachments?.length ? 'Attachment' : '');
  const parentId = typeof message.threadParentId === 'string' && message.threadParentId && message.threadParentId !== messageId ? message.threadParentId : null;
  const parentRef = parentId ? docRef(paths.message(orgId, channelId, parentId)) : null;

  const channel = await db().runTransaction(async (tx) => {
    const snap = await tx.get(channelRef);
    const parentSnap = parentRef ? await tx.get(parentRef) : null;
    if (!snap.exists) return null;
    const c = snap.data() as Channel;
    if (parentRef) {
      if (parentSnap?.exists) {
        const parent = parentSnap.data() as Message;
        tx.update(parentRef, {
          replyCount: FieldValue.increment(1),
          ...(toMillis(parent.lastReplyAt) <= toMillis(at) ? { lastReplyAt: at } : {}),
        });
      }
    } else if (!c.lastMessage || toMillis(c.lastMessageAt) <= toMillis(at)) {
      tx.update(channelRef, {
        lastMessage: { text, senderUid: message.senderUid, senderName: message.senderName, priority: message.priority, at },
        lastMessageAt: at,
      });
    }
    return c;
  });
  if (!channel) return;
  const fromSystem = message.senderUid === SYSTEM_SENDER_UID;

  if (!fromSystem) {
    // O2: posting in a channel acknowledges the sender's own open alerts for urgent messages there.
    try {
      await ackMessageAlertsOnReply(orgId, channelId, message.senderUid);
    } catch (e) {
      logger.warn('auto-ack on reply failed', { orgId, code: (e as { code?: unknown })?.code ?? (e as Error)?.name ?? 'unknown' });
    }
    // v4: a message from someone else cancels pending no-reply reminders in this channel.
    try {
      await cancelRemindersOnReply(orgId, channelId, message.senderUid);
    } catch (e) {
      logger.warn('reminder cancel on reply failed', { orgId, code: (e as { code?: unknown })?.code ?? (e as Error)?.name ?? 'unknown' });
    }
  }

  const recipients = channel.memberUids.filter((u) => u !== message.senderUid);
  const isBroadcast = channel.type === 'broadcast';
  const fansOut = recipients.length > 0 && (!isBroadcast || message.senderUid === channel.createdBy);
  const hasMentions = !fromSystem && mayContainMentions(body);
  const isDm = channel.type === 'direct' && !fromSystem;
  const filtered = fansOut && message.priority === 'normal';

  // One batched read of recipient member docs (+ prefs when filtering) serves mentions, the
  // out-of-office check, delivery filtering and the push itself.
  const docs: RecipientDocs =
    filtered || hasMentions || isDm
      ? await loadRecipientDocs(orgId, channelId, recipients, filtered)
      : { members: new Map(), prefs: new Map() };

  let orgTz: string | null = null;
  const timeZone = async () => (orgTz ??= (await getDocData<Org>(paths.org(orgId)))?.timezone ?? 'UTC');

  // v4: template marker and mentions.
  let mentioned = EMPTY_MENTIONS;
  if (hasMentions) {
    try {
      mentioned = await resolveMentions({ orgId, body, senderUid: message.senderUid, channelMemberUids: channel.memberUids, members: docs.members, now });
    } catch (e) {
      logger.warn('mention resolution failed', { orgId, code: (e as { code?: unknown })?.code ?? (e as Error)?.name ?? 'unknown' });
    }
  }
  if (stripped.templateId || mentioned.mentions.length || mentioned.mentionRoles.length) {
    await db().runTransaction(async (tx) => {
      const snap = await tx.get(msgRef);
      if (!snap.exists) return;
      const cur = snap.data() as Message;
      // Never resurrect a recalled body or overwrite an edit that already re-parsed mentions.
      if (cur.recalledAt || cur.editedAt) return;
      const update: Record<string, unknown> = {};
      if (stripped.templateId) {
        update.body = body;
        update.templateId = stripped.templateId;
      }
      if (mentioned.mentions.length || mentioned.mentionRoles.length) {
        update.mentions = mentioned.mentions;
        update.mentionRoles = mentioned.mentionRoles;
      }
      tx.update(msgRef, update);
    });
  }
  if (mentioned.nonMembers.length) {
    await postSilentNote(
      orgId,
      channelId,
      silentNoteId('mention', messageId),
      nonMemberNoteText(mentioned.nonMembers.map((m) => m.name)),
      parentId,
    );
  }

  // v4: out-of-office auto-reply on direct messages.
  if (isDm) {
    const other = recipients[0];
    const m = other ? docs.members.get(other) : undefined;
    if (m && m.active && isOutOfOffice(m, now.getTime())) {
      try {
        await postOutOfOfficeReply(orgId, channelId, m, now, docs.members, timeZone);
      } catch (e) {
        logger.warn('out-of-office reply failed', { orgId, code: (e as { code?: unknown })?.code ?? (e as Error)?.name ?? 'unknown' });
      }
    }
  }

  if (!fansOut) return;
  const pushData: PushData = { type: 'message', orgId, channelId, messageId, priority: message.priority };

  if (isBroadcast) {
    const targets = filtered
      ? (await filterRecipients({ orgId, channelType: channel.type, priority: message.priority, recipients, docs, mentioned: new Set(mentioned.mentions), now, timeZone })).push
      : recipients;
    await pushToMembers(orgId, targets, messagePushTitle(message.priority), pushData, filtered ? { members: docs.members } : {});
    return;
  }

  if (message.priority === 'urgent' || message.priority === 'critical') {
    if (message.alertId) return;
    // senderName is client-written; use the member doc for the alert text.
    const sender = fromSystem ? null : await getDocData<Member>(paths.member(orgId, message.senderUid));
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
    await msgRef.update({ alertId });
    return;
  }

  const { push, skipped } = await filterRecipients({
    orgId, channelType: channel.type, priority: message.priority, recipients, docs, mentioned: new Set(mentioned.mentions), now, timeZone,
  });
  if (Object.keys(skipped).length) logger.debug('push filtered', { orgId, channelId, skipped });
  await pushToMembers(orgId, push, messagePushTitle(message.priority), pushData, { members: docs.members });
}

/** Posts "{name} is out of office until {date}. Contact {delegate} instead." at most once a day per absence. */
async function postOutOfOfficeReply(
  orgId: string,
  channelId: string,
  away: Member,
  now: Date,
  loaded: ReadonlyMap<string, Member>,
  timeZone: () => Promise<string>,
): Promise<void> {
  const untilMs = toMillis(away.outOfOffice!.until);
  const delegateUid = away.outOfOffice?.delegateUid ?? null;
  let delegateName: string | null = null;
  if (delegateUid && delegateUid !== away.uid) {
    const d = loaded.get(delegateUid) ?? (await getDocData<Member>(paths.member(orgId, delegateUid)));
    if (d?.active) delegateName = d.displayName;
  }
  const tz = await timeZone();
  const body = outOfOfficeReply({ name: away.displayName, untilMs, timeZone: tz, delegateName });
  await postSilentNote(orgId, channelId, silentNoteId('ooo', away.uid, untilMs, todayInTimeZone(now, tz)), body);
}

/** v4: marks pending no-reply reminders in the channel owned by someone other than `replierUid` as cancelled. */
export async function cancelRemindersOnReply(orgId: string, channelId: string, replierUid: string): Promise<number> {
  const snap = await colRef(paths.reminders(orgId)).where('channelId', '==', channelId).where('status', '==', 'pending').limit(50).get();
  const toCancel = snap.docs.filter((d) => (d.data() as NoReplyReminder).ownerUid !== replierUid);
  if (!toCancel.length) return 0;
  const batch = db().batch();
  for (const d of toCancel) batch.update(d.ref, { status: 'cancelled' });
  await batch.commit();
  return toCancel.length;
}

/**
 * O2: acknowledges `uid`'s open alerts raised by urgent/critical messages in `channelId`
 * (source `message`, same channel, `uid` in `currentTargetUids`). Returns the acked alert ids.
 * Index: alerts (source.channelId, currentTargetUids array, status).
 */
export async function ackMessageAlertsOnReply(orgId: string, channelId: string, uid: string): Promise<string[]> {
  const snap = await colRef(paths.alerts(orgId))
    .where('source.channelId', '==', channelId)
    .where('currentTargetUids', 'array-contains', uid)
    .where('status', '==', 'open')
    .limit(20)
    .get();
  const acked: string[] = [];
  for (const d of snap.docs) {
    const done = await db().runTransaction(async (tx) => {
      const cur = await tx.get(d.ref);
      if (!cur.exists) return false;
      const alert = cur.data() as Alert;
      if (alert.status !== 'open' || alert.source.type !== 'message' || alert.source.channelId !== channelId) return false;
      if (!(alert.currentTargetUids ?? []).includes(uid)) return false;
      tx.update(d.ref, { status: 'acked', ackedBy: uid, ackedAt: FieldValue.serverTimestamp() });
      await writeAudit(
        orgId,
        { actorUid: uid, action: 'alert.ack', resourceType: 'alert', resourceId: d.id, patientId: null, metadata: { level: alert.level, via: 'reply' } },
        tx,
      );
      return true;
    });
    if (done) acked.push(d.id);
  }
  return acked;
}

export const onMessageCreated = onDocumentCreated(
  { document: 'orgs/{orgId}/channels/{channelId}/messages/{messageId}', region: FIRESTORE_TRIGGER_REGION },
  async (event) => {
  if (!event.data) return;
  const { orgId, channelId, messageId } = event.params;
  await handleMessageCreated(orgId, channelId, messageId, event.data.data() as Message);
});
