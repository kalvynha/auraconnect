/**
 * AuraConnect Cloud Functions entry point (region us-central1).
 * See docs/DATA_MODEL.md for the contract implemented here.
 */
import { initializeApp, getApps } from 'firebase-admin/app';
import { setGlobalOptions } from 'firebase-functions/v2';

if (getApps().length === 0) initializeApp();
setGlobalOptions({ region: 'us-central1', maxInstances: 20 });

export { createOrg } from './org/createOrg';
export { inviteMember } from './org/inviteMember';
export { acceptInvite } from './org/acceptInvite';
export { listMyInvites } from './org/listMyInvites';
export { onMemberWritten } from './org/onMemberWritten';

export { createChannel } from './messaging/createChannel';
export { updateChannelMembers } from './messaging/updateChannelMembers';
export { sendRoleMessage } from './messaging/sendRoleMessage';
export { onMessageCreated } from './messaging/onMessageCreated';
export { recallMessage } from './messaging/recallMessage';
export { searchMessages } from './messaging/searchMessages';
export { sendBroadcast } from './messaging/sendBroadcast';
export { purgeExpiredMessages } from './messaging/purgeExpiredMessages';

export { createAlert } from './alerts/createAlert';
export { ackAlert, resolveAlert } from './alerts/alertActions';
export { onAlertCreated } from './alerts/onAlertCreated';
export { escalateAlert } from './alerts/escalateAlert';

export { admitPatient } from './patients/admitPatient';
export { checkDeadlines } from './patients/checkDeadlines';

// v2 care workflows
export { completeMilestone, reopenMilestone } from './lifecycle/milestones';
export { changeLevelOfCare } from './lifecycle/changeLevelOfCare';
export { recordRecertification } from './lifecycle/recordRecertification';
export { dischargePatient, recordDeath } from './lifecycle/endOfCare';
export { setVisitFrequencies, scheduleVisit, updateVisit, completeVisit, cancelVisit } from './visits/visits';
export { checkMissedVisits } from './visits/checkMissedVisits';
export { createTask, updateTask, saveTaskTemplate } from './tasks/tasks';
export { updateBereavementContact, updateBereavementPlan } from './bereavement/bereavement';
export { createIdgMeeting, updateIdgMeeting, saveIdgNote, completeIdgMeeting } from './idg/idg';
export { logTriageCall, assignTriageCall, resolveTriageCall } from './triage/triage';

export { onReferralUploaded } from './referrals/onReferralUploaded';
export { acceptReferral, rejectReferral, retryReferralExtraction } from './referrals/reviewReferral';

// v2 Tier 3–4: AI and dashboards
export { summarizeChannel } from './ai/summarizeChannel';
export { generateHandoff } from './ai/generateHandoff';
export { generateIdgPrep } from './ai/generateIdgPrep';
export { computeDailyMetrics, computeMetrics } from './metrics/computeMetrics';
