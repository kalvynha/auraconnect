/** Cloud Storage deletes for message attachments (recall and purge). */
import { getStorage } from 'firebase-admin/storage';
import { logger } from 'firebase-functions/v2';
import type { Attachment } from '../shared/types';

export function channelAttachmentPrefix(orgId: string, channelId: string): string {
  return `orgs/${orgId}/channels/${channelId}/attachments/`;
}

/**
 * Attachment paths that are safe to delete: `storagePath` is client-written, so
 * only objects under this channel's attachment folder are accepted (a message
 * must never be able to point a delete at a referral or another channel).
 */
export function safeAttachmentPaths(orgId: string, channelId: string, attachments: readonly Attachment[] | null | undefined): string[] {
  const prefix = channelAttachmentPrefix(orgId, channelId);
  const out = new Set<string>();
  for (const a of attachments ?? []) {
    const p = typeof a?.storagePath === 'string' ? a.storagePath : '';
    if (p.startsWith(prefix) && p.length > prefix.length && !p.includes('..') && !p.slice(prefix.length).includes('//')) out.add(p);
  }
  return [...out];
}

/** Deletes objects (missing ones are ignored). Logs failures by code only. Returns the number deleted. */
export async function deleteStorageObjects(objectPaths: readonly string[]): Promise<number> {
  if (objectPaths.length === 0) return 0;
  const bucket = getStorage().bucket();
  let deleted = 0;
  for (let i = 0; i < objectPaths.length; i += 20) {
    const chunk = objectPaths.slice(i, i + 20);
    const results = await Promise.allSettled(chunk.map((p) => bucket.file(p).delete({ ignoreNotFound: true })));
    for (const r of results) {
      if (r.status === 'fulfilled') deleted++;
      else logger.warn('attachment delete failed', { code: (r.reason as { code?: unknown })?.code ?? 'unknown' });
    }
  }
  return deleted;
}
