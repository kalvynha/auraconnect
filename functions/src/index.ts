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

export { createAlert } from './alerts/createAlert';
export { ackAlert, resolveAlert } from './alerts/alertActions';
export { onAlertCreated } from './alerts/onAlertCreated';
export { escalateAlert } from './alerts/escalateAlert';

export { admitPatient } from './patients/admitPatient';
export { checkDeadlines } from './patients/checkDeadlines';

export { onReferralUploaded } from './referrals/onReferralUploaded';
export { acceptReferral, rejectReferral, retryReferralExtraction } from './referrals/reviewReferral';
