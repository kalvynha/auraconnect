/** Cloud Tasks enqueueing for escalation checks (handled by `escalateAlert`). */
import { getFunctions } from 'firebase-admin/functions';
import { logger } from 'firebase-functions/v2';

export const ESCALATION_FUNCTION = 'escalateAlert';
export const REGION = 'us-central1';

export interface EscalationTaskPayload {
  orgId: string;
  alertId: string;
  /** The alert level this check was scheduled for; a mismatch makes it a no-op. */
  expectedLevel: number;
}

/** Deterministic task id so a retried enqueue for the same level is deduplicated. */
export function escalationTaskId(p: EscalationTaskPayload): string {
  return `esc-${p.orgId}-${p.alertId}-L${p.expectedLevel}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 480);
}

export async function enqueueEscalationCheck(payload: EscalationTaskPayload, delaySeconds: number): Promise<void> {
  const queue = getFunctions().taskQueue(`locations/${REGION}/functions/${ESCALATION_FUNCTION}`);
  try {
    await queue.enqueue(payload, {
      scheduleDelaySeconds: Math.max(0, Math.round(delaySeconds)),
      id: escalationTaskId(payload),
    });
  } catch (e) {
    if ((e as { code?: string }).code === 'functions/task-already-exists') {
      logger.info('escalation task already enqueued', { alertId: payload.alertId, level: payload.expectedLevel });
      return;
    }
    throw e;
  }
}
