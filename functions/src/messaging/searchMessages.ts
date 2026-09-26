/**
 * `searchMessages` — bounded, case-insensitive substring search (NOT full-text
 * search: no stemming, ranking or typo tolerance). It scans the caller's
 * non-archived channels (or one channel they belong to):
 *  - only messages from the last {@link SEARCH_LOOKBACK_DAYS} days,
 *  - at most {@link SEARCH_MAX_PER_CHANNEL} newest messages per channel,
 *  - at most {@link SEARCH_MAX_CHANNELS} most recently active channels,
 *  - returning at most {@link SEARCH_MAX_HITS} hits, newest first.
 * `truncated` is true when any bound was hit, so results may be incomplete.
 * Recalled messages never match. Viewers may search their own channels.
 */
import { Timestamp } from 'firebase-admin/firestore';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { writeAudit } from '../lib/audit';
import { parse, requireOrg } from '../lib/context';
import { colRef, getDocData, paths } from '../lib/db';
import { id } from '../lib/schemas';
import type { Channel, Message, MessageSearchHit, SearchMessagesRequest, SearchMessagesResponse, TimestampLike } from '../shared/types';

export const SEARCH_LOOKBACK_DAYS = 90;
export const SEARCH_MAX_PER_CHANNEL = 300;
export const SEARCH_MAX_HITS = 50;
export const SEARCH_MAX_CHANNELS = 50;
export const SNIPPET_CHARS = 160;
const CHANNEL_CONCURRENCY = 10;

const schema = z.object({
  orgId: id,
  query: z.string().trim().min(2, 'must be at least 2 characters').max(100),
  channelId: id.optional(),
});

function millis(t: TimestampLike | null | undefined): number {
  if (!t) return 0;
  return typeof t.toMillis === 'function' ? t.toMillis() : t.seconds * 1000 + Math.floor((t.nanoseconds ?? 0) / 1e6);
}

/** Case-insensitive substring match; returns the match index in `body` or -1. */
export function findMatch(body: string, query: string): number {
  if (!body || !query) return -1;
  return body.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
}

/** ~`size` chars of `body` centered on the match, with ellipses where cut. */
export function makeSnippet(body: string, index: number, queryLength: number, size = SNIPPET_CHARS): string {
  const flat = body.replace(/\s+/g, ' ');
  if (flat.length <= size) return flat.trim();
  // Position of the match after whitespace collapsing.
  const before = body.slice(0, index).replace(/\s+/g, ' ').length;
  const pad = Math.max(0, Math.floor((size - queryLength) / 2));
  let start = Math.max(0, before - pad);
  const end = Math.min(flat.length, start + size);
  start = Math.max(0, end - size);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end).trim()}${end < flat.length ? '…' : ''}`;
}

async function inBatches<T, R>(items: readonly T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

export async function searchMessagesHandler(request: CallableRequest<SearchMessagesRequest>): Promise<SearchMessagesResponse> {
  const input = parse(schema, request.data);
  const ctx = requireOrg(request, input.orgId);
  const nowMs = Date.now();
  const sinceMs = nowMs - SEARCH_LOOKBACK_DAYS * 86_400_000;
  let truncated = false;

  let channels: Array<{ id: string; c: Channel }>;
  if (input.channelId) {
    const c = await getDocData<Channel>(paths.channel(ctx.orgId, input.channelId));
    if (!c) throw new HttpsError('not-found', 'Channel not found.');
    if (!c.memberUids?.includes(ctx.uid)) throw new HttpsError('permission-denied', 'You are not a member of this channel.');
    channels = [{ id: input.channelId, c }];
  } else {
    // Index: channels (memberUids CONTAINS, lastMessageAt DESC).
    const snap = await colRef(paths.channels(ctx.orgId))
      .where('memberUids', 'array-contains', ctx.uid)
      .orderBy('lastMessageAt', 'desc')
      .limit(SEARCH_MAX_CHANNELS * 4)
      .get();
    const eligible = snap.docs
      .map((d) => ({ id: d.id, c: d.data() as Channel }))
      .filter(({ c }) => !c.archived && millis(c.lastMessageAt) >= sinceMs);
    if (eligible.length > SEARCH_MAX_CHANNELS || snap.size >= SEARCH_MAX_CHANNELS * 4) truncated = true;
    channels = eligible.slice(0, SEARCH_MAX_CHANNELS);
  }

  const since = Timestamp.fromMillis(sinceMs);
  const perChannel = await inBatches(channels, CHANNEL_CONCURRENCY, async ({ id: channelId, c }) => {
    const snap = await colRef(paths.messages(ctx.orgId, channelId))
      .where('createdAt', '>=', since)
      .orderBy('createdAt', 'desc')
      .limit(SEARCH_MAX_PER_CHANNEL)
      .get();
    const hits: Array<MessageSearchHit & { ms: number }> = [];
    for (const d of snap.docs) {
      const m = d.data() as Message;
      if (m.recalledAt) continue;
      const idx = findMatch(m.body ?? '', input.query);
      if (idx < 0) continue;
      hits.push({
        channelId,
        channelName: c.name ?? null,
        messageId: d.id,
        senderName: m.senderName ?? '',
        snippet: makeSnippet(m.body, idx, input.query.length),
        // Plain {seconds, nanoseconds} so the callable response matches TimestampLike.
        createdAt: { seconds: m.createdAt?.seconds ?? 0, nanoseconds: m.createdAt?.nanoseconds ?? 0 },
        ms: millis(m.createdAt),
      });
    }
    return { hits, capped: snap.size >= SEARCH_MAX_PER_CHANNEL };
  });

  const all = perChannel.flatMap((r) => r.hits).sort((a, b) => b.ms - a.ms);
  if (perChannel.some((r) => r.capped) || all.length > SEARCH_MAX_HITS) truncated = true;
  const hits: MessageSearchHit[] = all.slice(0, SEARCH_MAX_HITS).map(({ ms: _ms, ...h }) => h);

  // The query itself may contain PHI, so only its length is audited.
  await writeAudit(ctx.orgId, {
    actorUid: ctx.uid,
    action: 'message.search',
    resourceType: 'channel',
    resourceId: input.channelId ?? '*',
    metadata: { channels: channels.length, hits: hits.length, truncated, queryLength: input.query.length },
  });
  return { hits, truncated };
}

export const searchMessages = onCall(searchMessagesHandler);
