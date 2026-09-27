/** v4: shared channel/message access checks for messaging callables. */
import { HttpsError } from 'firebase-functions/v2/https';
import { getDocData, paths } from '../lib/db';
import type { OrgContext } from '../lib/context';
import type { Channel, Message, TimestampLike } from '../shared/types';

export async function loadChannel(orgId: string, channelId: string): Promise<Channel> {
  const channel = await getDocData<Channel>(paths.channel(orgId, channelId));
  if (!channel) throw new HttpsError('not-found', 'Channel not found.');
  return channel;
}

export function assertChannelMember(channel: Channel, uid: string): void {
  if (!channel.memberUids?.includes(uid)) throw new HttpsError('permission-denied', 'You are not a member of this channel.');
}

export async function loadMemberChannel(ctx: Pick<OrgContext, 'orgId' | 'uid'>, channelId: string): Promise<Channel> {
  const channel = await loadChannel(ctx.orgId, channelId);
  assertChannelMember(channel, ctx.uid);
  return channel;
}

export async function loadMessage(orgId: string, channelId: string, messageId: string): Promise<Message> {
  const message = await getDocData<Message>(paths.message(orgId, channelId, messageId));
  if (!message) throw new HttpsError('not-found', 'Message not found.');
  return message;
}

/** Plain `{seconds, nanoseconds}` for callable responses. */
export function plainTs(t: TimestampLike | null | undefined): TimestampLike {
  return { seconds: t?.seconds ?? 0, nanoseconds: t?.nanoseconds ?? 0 };
}

export function tsMs(t: TimestampLike | null | undefined): number {
  if (!t) return 0;
  return typeof t.toMillis === 'function' ? t.toMillis() : t.seconds * 1000 + Math.floor((t.nanoseconds ?? 0) / 1e6);
}
