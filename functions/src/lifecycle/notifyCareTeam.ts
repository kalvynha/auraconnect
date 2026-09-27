/**
 * Care-team notifications for lifecycle events (death, code-status change): a system message in
 * the patient channel and a normal, non-escalating alert. Pushes stay PHI-free: the alert push
 * title is the generic "New alert" and the message push is "New message"; the patient name is
 * only in the alert body in Firestore.
 */
import { FieldValue, type Transaction } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { raiseAlert } from '../alerts/raiseAlert';
import { colRef, paths } from '../lib/db';
import { loadActiveMembers } from '../lib/members';

export const SYSTEM_SENDER_UID = 'system';
export const SYSTEM_SENDER_NAME = 'AuraConnect';

/** Writes a system message into a channel within a transaction (same shape clients write). */
export function txPostSystemMessage(tx: Transaction, orgId: string, channelId: string, body: string): string {
  const ref = colRef(paths.messages(orgId, channelId)).doc();
  tx.set(ref, {
    senderUid: SYSTEM_SENDER_UID,
    senderName: SYSTEM_SENDER_NAME,
    body,
    priority: 'normal',
    attachments: [],
    roleTarget: null,
    createdAt: FieldValue.serverTimestamp(),
    alertId: null,
    threadParentId: null,
  });
  return ref.id;
}

/**
 * Raises a normal, non-escalating alert to the patient's active care team (minus the actor).
 * Never throws: the lifecycle change is already committed, so a failure is only logged.
 */
export async function alertCareTeam(p: {
  orgId: string;
  patientId: string;
  careTeamUids: readonly string[];
  /** Active care-team uids the caller already loaded (skips re-reading the member docs). */
  activeUids?: readonly string[];
  actorUid: string;
  /** Deterministic id for idempotency; random when omitted. */
  alertId?: string;
  title: string;
  body: string;
}): Promise<string | null> {
  try {
    const others = p.careTeamUids.filter((u) => u !== p.actorUid);
    const targets = p.activeUids
      ? others.filter((u) => p.activeUids!.includes(u))
      : [...(await loadActiveMembers(p.orgId, others)).keys()];
    if (targets.length === 0) return null;
    const { alertId } = await raiseAlert({
      orgId: p.orgId,
      alertId: p.alertId,
      title: p.title,
      body: p.body,
      priority: 'normal',
      source: { type: 'manual', patientId: p.patientId },
      targetUids: targets,
      policyId: null,
      createdBy: p.actorUid,
    });
    return alertId;
  } catch (e) {
    logger.error('care-team alert failed', { orgId: p.orgId, patientId: p.patientId, error: (e as Error).message });
    return null;
  }
}

/**
 * Epoch ms of a local date and `HH:mm` time in an IANA time zone (DST-aware; falls back to UTC
 * for an invalid zone).
 */
export function zonedLocalToEpochMs(date: string, time: string, timeZone: string): number {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  const wall = Date.UTC(y, mo - 1, d, hh, mm);
  const offsetAt = (ms: number): number => {
    let tz = timeZone;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
    } catch {
      tz = 'UTC';
    }
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(new Date(ms));
    const get = (t: string) => Number(parts.find((x) => x.type === t)?.value ?? 0);
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
    return asUtc - Math.floor(ms / 60_000) * 60_000;
  };
  let ms = wall - offsetAt(wall);
  const second = offsetAt(ms);
  if (wall - second !== ms) ms = wall - second;
  return ms;
}
