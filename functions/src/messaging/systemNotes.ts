/**
 * v4: silent system notes — system messages (`senderUid: 'system'`) whose id starts with
 * `sysnote_`. `onMessageCreated` ignores them completely: no push, no `lastMessage`/unread bump, no
 * mention parsing, no auto-reply. Used for the out-of-office auto-reply and the "not in this
 * conversation" mention note. Ids are deterministic, so a retried trigger never posts a note twice.
 */
import { FieldValue } from 'firebase-admin/firestore';
import { isAlreadyExists } from '../alerts/raiseAlert';
import { docRef, paths } from '../lib/db';
import { SYSTEM_SENDER_NAME, SYSTEM_SENDER_UID } from '../lifecycle/notifyCareTeam';
import type { Message } from '../shared/types';

export const SILENT_NOTE_PREFIX = 'sysnote_';

export function isSilentSystemNote(messageId: string, message: Pick<Message, 'senderUid'>): boolean {
  return message.senderUid === SYSTEM_SENDER_UID && messageId.startsWith(SILENT_NOTE_PREFIX);
}

/** Note id from parts (unsafe characters replaced). */
export function silentNoteId(...parts: Array<string | number>): string {
  return `${SILENT_NOTE_PREFIX}${parts.join('_')}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 400);
}

/** Creates the note; returns false when a note with this id already exists. */
export async function postSilentNote(orgId: string, channelId: string, noteId: string, body: string, threadParentId: string | null = null): Promise<boolean> {
  try {
    await docRef(paths.message(orgId, channelId, noteId)).create({
      senderUid: SYSTEM_SENDER_UID,
      senderName: SYSTEM_SENDER_NAME,
      body,
      priority: 'normal',
      attachments: [],
      roleTarget: null,
      createdAt: FieldValue.serverTimestamp(),
      alertId: null,
      threadParentId,
    });
    return true;
  } catch (e) {
    if (isAlreadyExists(e)) return false;
    throw e;
  }
}
