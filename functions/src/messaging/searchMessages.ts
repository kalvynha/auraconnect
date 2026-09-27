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
import { Timestamp, type QueryDocumentSnapshot } from 'firebase-admin/firestore';
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
/**
 * Per-channel read pages (they add up to SEARCH_MAX_PER_CHANNEL); see {@link scanChannels}.
 * A small first page lets common terms stop early; rare terms cost one extra round trip.
 */
export const SEARCH_PAGE_SIZES = [50, 250] as const;
const CHANNEL_CONCURRENCY = 16;

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

type Hit = MessageSearchHit & { ms: number };

interface ChannelScan {
  id: string;
  c: Channel;
  hits: Hit[];
  scanned: number;
  last: QueryDocumentSnapshot | null;
  /** createdAt (ms) of the oldest message scanned so far; unscanned messages are no newer. */
  frontierMs: number;
  done: boolean;
}

/**
 * Scans each channel's newest messages (≤ {@link SEARCH_MAX_PER_CHANNEL} since `since`)
 * for `query` and returns every hit that can be in the newest {@link SEARCH_MAX_HITS},
 * sorted newest first, plus whether any channel hit the per-channel cap.
 *
 * Channels are read in pages ({@link SEARCH_PAGE_SIZES}). Once more than
 * SEARCH_MAX_HITS hits are known, a channel whose oldest scanned message is older
 * than the (SEARCH_MAX_HITS + 1)-th newest hit is not read further: nothing left in
 * it can reach the result, and the result is already known to be truncated. So
 * the hits, their order and `truncated` are exactly those of reading every
 * channel's newest SEARCH_MAX_PER_CHANNEL messages, but common terms stop early.
 */
export async function scanChannels(
  orgId: string,
  channels: ReadonlyArray<{ id: string; c: Channel }>,
  since: Timestamp,
  query: string,
): Promise<{ hits: Hit[]; capped: boolean }> {
  const scans: ChannelScan[] = channels.map(({ id: channelId, c }) => ({ id: channelId, c, hits: [], scanned: 0, last: null, frontierMs: Infinity, done: false }));
  let capped = false;
  // Stable sort over hits concatenated in channel order, as a single full scan would produce.
  const sorted = () => scans.flatMap((s) => s.hits).sort((a, b) => b.ms - a.ms);

  for (const pageSize of SEARCH_PAGE_SIZES) {
    const found = sorted();
    if (found.length > SEARCH_MAX_HITS) {
      const threshold = found[SEARCH_MAX_HITS]!.ms;
      for (const s of scans) if (!s.done && s.frontierMs < threshold) s.done = true;
    }
    const open = scans.filter((s) => !s.done);
    if (open.length === 0) break;
    await inBatches(open, CHANNEL_CONCURRENCY, async (s) => {
      const limit = Math.min(pageSize, SEARCH_MAX_PER_CHANNEL - s.scanned);
      let q = colRef(paths.messages(orgId, s.id)).where('createdAt', '>=', since).orderBy('createdAt', 'desc');
      if (s.last) q = q.startAfter(s.last);
      const snap = await q.limit(limit).get();
      for (const d of snap.docs) {
        const m = d.data() as Message;
        s.frontierMs = millis(m.createdAt);
        if (m.recalledAt) continue;
        const idx = findMatch(m.body ?? '', query);
        if (idx < 0) continue;
        s.hits.push({
          channelId: s.id,
          channelName: s.c.name ?? null,
          messageId: d.id,
          senderName: m.senderName ?? '',
          snippet: makeSnippet(m.body, idx, query.length),
          // Plain {seconds, nanoseconds} so the callable response matches TimestampLike.
          createdAt: { seconds: m.createdAt?.seconds ?? 0, nanoseconds: m.createdAt?.nanoseconds ?? 0 },
          ms: millis(m.createdAt),
        });
      }
      s.scanned += snap.size;
      s.last = snap.docs[snap.docs.length - 1] ?? s.last;
      if (s.scanned >= SEARCH_MAX_PER_CHANNEL) capped = true;
      if (snap.size < limit || s.scanned >= SEARCH_MAX_PER_CHANNEL) s.done = true;
    });
  }
  return { hits: sorted(), capped };
}

async function inBatches<T, R>(items: readonly T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

export async function searchMessagesHandler(request: CallableRequest<SearchMessagesRequest>): Promise<SearchMessagesResponse> {
  const input = parse(schema, request.data);
  const ctx = await requireOrg(request, input.orgId);
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
  const { hits: all, capped } = await scanChannels(ctx.orgId, channels, since, input.query);
  if (capped || all.length > SEARCH_MAX_HITS) truncated = true;
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
