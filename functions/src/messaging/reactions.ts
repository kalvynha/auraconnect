/**
 * v4 reactions: members write `messages/{mid}/reactions/{uid}` (`{emoji, at}`, one reaction per
 * member). This trigger keeps `message.reactionCounts` in step, in a transaction: the old emoji is
 * decremented (removed at 0) and the new one incremented. Counts never go below zero.
 */
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { db, docRef, paths } from '../lib/db';
import { FIRESTORE_TRIGGER_REGION } from '../lib/regions';
import { ALLOWED_REACTIONS, type Message, type Reaction } from '../shared/types';

/** Applies one reaction change to a counts map (pure). */
export function applyReactionChange(
  counts: Readonly<Record<string, number>> | null | undefined,
  before: string | null,
  after: string | null,
): Record<string, number> {
  const next: Record<string, number> = {};
  for (const [k, v] of Object.entries(counts ?? {})) if (typeof v === 'number' && v > 0) next[k] = v;
  if (before === after) return next;
  if (before && next[before]) {
    next[before] -= 1;
    if (next[before]! <= 0) delete next[before];
  }
  if (after) next[after] = (next[after] ?? 0) + 1;
  return next;
}

function emojiOf(r: Partial<Reaction> | undefined | null): string | null {
  const e = r?.emoji;
  return typeof e === 'string' && ALLOWED_REACTIONS.includes(e) ? e : null;
}

export async function handleReactionWritten(
  orgId: string,
  channelId: string,
  messageId: string,
  before: Partial<Reaction> | undefined | null,
  after: Partial<Reaction> | undefined | null,
): Promise<void> {
  const b = emojiOf(before);
  const a = emojiOf(after);
  if (b === a) return;
  const ref = docRef(paths.message(orgId, channelId, messageId));
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const message = snap.data() as Message;
    tx.update(ref, { reactionCounts: applyReactionChange(message.reactionCounts, b, a) });
  });
}

export const onReactionWritten = onDocumentWritten(
  { document: 'orgs/{orgId}/channels/{channelId}/messages/{messageId}/reactions/{uid}', region: FIRESTORE_TRIGGER_REGION },
  async (event) => {
    const { orgId, channelId, messageId } = event.params;
    const before = event.data?.before?.exists ? (event.data.before.data() as Reaction) : null;
    const after = event.data?.after?.exists ? (event.data.after.data() as Reaction) : null;
    await handleReactionWritten(orgId, channelId, messageId, before, after);
  },
);
