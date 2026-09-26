/**
 * `purgeExpiredMessages` — daily job that enforces `org.messageLifespanDays`.
 * For every org with a lifespan (7–3650 days) it deletes messages (including
 * thread replies and recalled messages) whose `createdAt` is older than
 * now − lifespan, deletes their attachment files, and clears a channel's
 * `lastMessage` preview when that message was purged.
 *
 * Messages are selected per channel (`createdAt < cutoff`, oldest first, in
 * pages of {@link PURGE_PAGE_SIZE}), which is bounded to the org and needs only
 * the single-field createdAt index. Deletes are committed in batches of at
 * most {@link PURGE_PAGE_SIZE} (< 500 writes). Each org is capped at
 * {@link MAX_PURGE_PER_ORG_RUN} deletions per run; the rest follow next day.
 */
import { Timestamp } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { colRef, db, docRef, paths } from '../lib/db';
import { deleteStorageObjects, safeAttachmentPaths } from '../lib/storageFiles';
import type { Channel, Message, Org, TimestampLike } from '../shared/types';

export const PURGE_PAGE_SIZE = 300;
export const MAX_PURGE_PER_ORG_RUN = 20_000;
export const MIN_LIFESPAN_DAYS = 7;
export const MAX_LIFESPAN_DAYS = 3650;

function millis(t: TimestampLike | null | undefined): number | null {
  if (!t) return null;
  return typeof t.toMillis === 'function' ? t.toMillis() : t.seconds * 1000 + Math.floor((t.nanoseconds ?? 0) / 1e6);
}

/** Cutoff instant (ms) for an org, or null when messages are kept forever / the setting is invalid. */
export function purgeCutoffMs(nowMs: number, lifespanDays: unknown): number | null {
  if (typeof lifespanDays !== 'number' || !Number.isInteger(lifespanDays)) return null;
  if (lifespanDays < MIN_LIFESPAN_DAYS || lifespanDays > MAX_LIFESPAN_DAYS) return null;
  return nowMs - lifespanDays * 86_400_000;
}

export interface PurgeStats {
  messages: number;
  attachments: number;
  channels: number;
}

export async function purgeOrgMessages(orgId: string, cutoffMs: number, maxDeletes = MAX_PURGE_PER_ORG_RUN): Promise<PurgeStats> {
  const stats: PurgeStats = { messages: 0, attachments: 0, channels: 0 };
  const cutoff = Timestamp.fromMillis(cutoffMs);
  const channels = await colRef(paths.channels(orgId)).get();
  for (const chDoc of channels.docs) {
    if (stats.messages >= maxDeletes) break;
    const channel = chDoc.data() as Channel;
    const createdMs = millis(channel.createdAt);
    if (createdMs !== null && createdMs >= cutoffMs) continue; // nothing in it can be old enough

    let touched = false;
    for (;;) {
      const limit = Math.min(PURGE_PAGE_SIZE, maxDeletes - stats.messages);
      if (limit <= 0) break;
      const page = await colRef(paths.messages(orgId, chDoc.id)).where('createdAt', '<', cutoff).orderBy('createdAt', 'asc').limit(limit).get();
      if (page.empty) break;
      const files: string[] = [];
      const batch = db().batch();
      for (const d of page.docs) {
        files.push(...safeAttachmentPaths(orgId, chDoc.id, (d.data() as Message).attachments));
        batch.delete(d.ref);
      }
      await batch.commit();
      stats.messages += page.size;
      stats.attachments += await deleteStorageObjects(files);
      touched = true;
      if (page.size < limit) break;
    }

    const lastAt = millis(channel.lastMessage?.at);
    if (channel.lastMessage && lastAt !== null && lastAt < cutoffMs) {
      await docRef(paths.channel(orgId, chDoc.id)).update({ lastMessage: null });
      touched = true;
    }
    if (touched) stats.channels++;
  }
  return stats;
}

/** Purges every org that has a message lifespan. */
export async function runMessagePurge(now: Date): Promise<{ orgs: number } & PurgeStats> {
  const orgs = await db().collection('orgs').where('messageLifespanDays', '>=', MIN_LIFESPAN_DAYS).get();
  const total = { orgs: 0, messages: 0, attachments: 0, channels: 0 };
  for (const doc of orgs.docs) {
    const cutoffMs = purgeCutoffMs(now.getTime(), (doc.data() as Org).messageLifespanDays);
    if (cutoffMs === null) continue;
    try {
      const s = await purgeOrgMessages(doc.id, cutoffMs);
      total.orgs++;
      total.messages += s.messages;
      total.attachments += s.attachments;
      total.channels += s.channels;
      if (s.messages > 0) logger.info('purged expired messages', { orgId: doc.id, ...s });
    } catch (e) {
      logger.error('message purge failed for org', { orgId: doc.id, code: (e as { code?: unknown })?.code ?? (e as Error)?.name ?? 'unknown' });
    }
  }
  return total;
}

export const purgeExpiredMessages = onSchedule(
  { schedule: '15 3 * * *', timeZone: 'UTC', timeoutSeconds: 540, memory: '512MiB', retryCount: 1 },
  async () => {
    const res = await runMessagePurge(new Date());
    logger.info('message purge complete', res);
  },
);
