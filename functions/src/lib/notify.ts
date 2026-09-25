/**
 * FCM push to org members. Pushes are PHI-free: the notification text is a
 * generic label ("Urgent message", "Deadline reminder") and the data payload
 * is {@link PushData} only. Clients fetch content after authenticating.
 */
import { FieldValue } from 'firebase-admin/firestore';
import { getMessaging, type MulticastMessage } from 'firebase-admin/messaging';
import { logger } from 'firebase-functions/v2';
import type { Member, Priority, PushData } from '../shared/types';
import { docRef, getMany, paths } from './db';

const INVALID_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

export function messagePushTitle(priority: Priority): string {
  return priority === 'critical' ? 'Critical message' : priority === 'urgent' ? 'Urgent message' : 'New message';
}

export function alertPushTitle(priority: Priority): string {
  return priority === 'critical' ? 'Critical alert' : priority === 'urgent' ? 'Urgent alert' : 'New alert';
}

/** Converts PushData into FCM's string-only data map, dropping undefined keys. */
export function toFcmData(data: PushData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) if (v !== undefined && v !== null) out[k] = String(v);
  return out;
}

/** Builds the platform-specific payload for one batch of tokens. */
export function buildMulticast(tokens: string[], title: string, data: PushData): MulticastMessage {
  const priority = data.priority;
  const interruptionLevel = priority === 'critical' ? 'critical' : priority === 'urgent' ? 'time-sensitive' : 'active';
  const threadId = data.channelId ?? data.alertId ?? data.type;
  return {
    tokens,
    notification: { title },
    data: toFcmData(data),
    apns: {
      headers: {
        'apns-priority': priority === 'normal' ? '5' : '10',
        'apns-push-type': 'alert',
      },
      payload: {
        aps: {
          alert: { title },
          sound: priority === 'critical' ? { critical: true, name: 'default', volume: 1.0 } : 'default',
          'interruption-level': interruptionLevel,
          'thread-id': threadId,
          'mutable-content': true,
        },
      },
    },
    android: { priority: priority === 'normal' ? 'normal' : 'high' },
    webpush: {
      headers: { Urgency: priority === 'normal' ? 'normal' : 'high' },
      notification: { title, requireInteraction: priority !== 'normal', tag: threadId },
    },
  };
}

export interface PushResult {
  sent: number;
  failed: number;
  pruned: number;
}

/**
 * Sends a push to every FCM token of the given org members (inactive members
 * are skipped) and prunes tokens FCM reports as invalid.
 */
export async function pushToMembers(orgId: string, uids: readonly string[], title: string, data: PushData): Promise<PushResult> {
  const result: PushResult = { sent: 0, failed: 0, pruned: 0 };
  const unique = [...new Set(uids)].filter(Boolean);
  if (unique.length === 0) return result;
  const members = await getMany<Member>(unique.map((u) => paths.member(orgId, u)));
  const owners: Array<{ token: string; uid: string }> = [];
  for (const m of members.values()) {
    if (!m.active) continue;
    for (const t of new Set(m.fcmTokens ?? [])) if (typeof t === 'string' && t) owners.push({ token: t, uid: m.uid });
  }
  if (owners.length === 0) return result;

  const stale = new Map<string, string[]>();
  for (let i = 0; i < owners.length; i += 500) {
    const chunk = owners.slice(i, i + 500);
    const res = await getMessaging().sendEachForMulticast(buildMulticast(chunk.map((c) => c.token), title, data));
    result.sent += res.successCount;
    result.failed += res.failureCount;
    res.responses.forEach((r, idx) => {
      const code = r.error?.code;
      if (!r.success && code && INVALID_TOKEN_CODES.has(code)) {
        const owner = chunk[idx]!;
        stale.set(owner.uid, [...(stale.get(owner.uid) ?? []), owner.token]);
      }
    });
  }
  await Promise.all(
    [...stale.entries()].map(async ([uid, tokens]) => {
      result.pruned += tokens.length;
      await docRef(paths.member(orgId, uid)).update({ fcmTokens: FieldValue.arrayRemove(...tokens) });
    }),
  );
  if (result.failed > 0) logger.info('push had failures', { orgId, ...result });
  return result;
}
