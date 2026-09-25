import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { firstCheckMinutes } from '../domain/escalation';
import { getDocData, paths } from '../lib/db';
import { alertPushTitle, messagePushTitle, pushToMembers } from '../lib/notify';
import { enqueueEscalationCheck } from '../lib/tasks';
import type { Alert, EscalationPolicy, PushData } from '../shared/types';
import { FIRESTORE_TRIGGER_REGION } from '../lib/regions';

/** Generic, PHI-free push title for an alert. */
export function alertNotificationTitle(alert: Pick<Alert, 'priority' | 'source'>): string {
  if (alert.source.type === 'message') return messagePushTitle(alert.priority);
  if (alert.source.type === 'deadline') return 'Deadline reminder';
  return alertPushTitle(alert.priority);
}

export function alertPushData(orgId: string, alertId: string, alert: Pick<Alert, 'priority' | 'source'>): PushData {
  const data: PushData = { type: 'alert', orgId, alertId, priority: alert.priority };
  if (alert.source.type === 'message') data.channelId = alert.source.channelId;
  return data;
}

/** Pushes to the level-0 recipients and schedules the first escalation check. */
export async function handleAlertCreated(orgId: string, alertId: string, alert: Alert): Promise<void> {
  if (alert.status !== 'open') return;
  await pushToMembers(orgId, alert.currentTargetUids, alertNotificationTitle(alert), alertPushData(orgId, alertId, alert));
  if (!alert.policyId || alert.exhausted) return;
  const policy = await getDocData<EscalationPolicy>(paths.escalationPolicy(orgId, alert.policyId));
  const minutes = firstCheckMinutes(policy);
  if (minutes === null) return;
  await enqueueEscalationCheck({ orgId, alertId, expectedLevel: 0 }, minutes * 60);
}

export const onAlertCreated = onDocumentCreated({ document: 'orgs/{orgId}/alerts/{alertId}', region: FIRESTORE_TRIGGER_REGION }, async (event) => {
  if (!event.data) return;
  await handleAlertCreated(event.params.orgId, event.params.alertId, event.data.data() as Alert);
});
