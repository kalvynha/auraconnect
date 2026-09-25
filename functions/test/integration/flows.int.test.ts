/**
 * Emulator integration test: runs the real handlers against the Firestore and
 * Auth emulators (real transactions, serverTimestamps, collection-group
 * queries). FCM and Cloud Tasks are stubbed.
 *
 * From the repo root:
 *   npx firebase-tools emulators:exec --only firestore,auth "npm --prefix functions run test:integration"
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/notify', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/notify')>()),
  pushToMembers: vi.fn(async () => ({ sent: 0, failed: 0, pruned: 0 })),
}));
vi.mock('../../src/lib/tasks', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/tasks')>()),
  enqueueEscalationCheck: vi.fn(async () => undefined),
}));

import type { CallableRequest } from 'firebase-functions/v2/https';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { enqueueEscalationCheck } from '../../src/lib/tasks';
import { createOrgHandler } from '../../src/org/createOrg';
import { inviteMemberHandler } from '../../src/org/inviteMember';
import { listMyInvitesHandler } from '../../src/org/listMyInvites';
import { acceptInviteHandler } from '../../src/org/acceptInvite';
import { createChannelHandler } from '../../src/messaging/createChannel';
import { handleMessageCreated, messageAlertId } from '../../src/messaging/onMessageCreated';
import { handleAlertCreated } from '../../src/alerts/onAlertCreated';
import { handleEscalation } from '../../src/alerts/escalateAlert';
import { alertActionHandler } from '../../src/alerts/alertActions';
import { admitPatientHandler } from '../../src/patients/admitPatient';
import { checkOrgDeadlines } from '../../src/patients/checkDeadlines';
import type { Alert, Message, Org, Role } from '../../src/shared/types';

const PROJECT = process.env.GCLOUD_PROJECT ?? 'demo-auraconnect';
const FS_HOST = process.env.FIRESTORE_EMULATOR_HOST;

function req<T>(data: T, uid: string, email: string, claims: { orgId?: string; role?: Role } = {}): CallableRequest<T> {
  return { data, auth: { uid, token: { email, email_verified: true, ...claims } }, rawRequest: {}, acceptsStreaming: false } as unknown as CallableRequest<T>;
}

beforeAll(async () => {
  if (!FS_HOST) throw new Error('FIRESTORE_EMULATOR_HOST is not set; run via `firebase emulators:exec`.');
  if (!process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error('FIREBASE_AUTH_EMULATOR_HOST is not set; start the auth emulator too.');
  if (getApps().length === 0) initializeApp({ projectId: PROJECT });
  await fetch(`http://${FS_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  for (const [uid, email] of [['admin1', 'admin1@example.org'], ['nurse1', 'nurse1@example.org']]) {
    await getAuth().deleteUser(uid!).catch(() => undefined);
    await getAuth().createUser({ uid, email });
  }
});

describe('end-to-end flows on the emulator', () => {
  let orgId = '';
  let alertId = '';

  it('createOrg → inviteMember → listMyInvites → acceptInvite', async () => {
    ({ orgId } = await createOrgHandler(req({ name: 'Emu Hospice', timezone: 'America/New_York', displayName: 'Ada', discipline: 'Admin' }, 'admin1', 'admin1@example.org')));
    expect((await getAuth().getUser('admin1')).customClaims).toMatchObject({ orgId, role: 'admin' });

    const admin = { orgId, role: 'admin' as Role };
    const { inviteId } = await inviteMemberHandler(
      req({ orgId, email: 'Nurse1@example.org', displayName: 'Nora', role: 'clinician', discipline: 'RN' }, 'admin1', 'admin1@example.org', admin),
    );
    const listed = await listMyInvitesHandler(req({}, 'nurse1', 'nurse1@example.org'));
    expect(listed.invites).toEqual([{ orgId, inviteId, orgName: 'Emu Hospice', role: 'clinician' }]);

    const res = await acceptInviteHandler(req({ orgId, inviteId }, 'nurse1', 'nurse1@example.org'), { requireVerified: false });
    expect(res).toEqual({ orgId, role: 'clinician' });
    expect((await getAuth().getUser('nurse1')).customClaims).toMatchObject({ orgId, role: 'clinician' });
  });

  it('urgent direct message raises an alert that escalates and can be acked', async () => {
    const nurse = { orgId, role: 'clinician' as Role };
    const { channelId } = await createChannelHandler(req({ orgId, type: 'direct', memberUids: ['admin1'] }, 'nurse1', 'nurse1@example.org', nurse));
    expect(channelId).toBe('dm_admin1_nurse1');

    const db = getFirestore();
    const msgRef = db.collection(`orgs/${orgId}/channels/${channelId}/messages`).doc();
    const { FieldValue } = await import('firebase-admin/firestore');
    await msgRef.set({ senderUid: 'nurse1', senderName: 'Nora', body: 'Need help now', priority: 'urgent', attachments: [], roleTarget: null, createdAt: FieldValue.serverTimestamp(), alertId: null });
    const message = (await msgRef.get()).data() as Message;
    await handleMessageCreated(orgId, channelId, msgRef.id, message);

    alertId = messageAlertId(channelId, msgRef.id);
    const alert = (await db.doc(`orgs/${orgId}/alerts/${alertId}`).get()).data() as Alert;
    expect(alert).toMatchObject({ targetUids: ['admin1'], level: 0, status: 'open' });
    expect((await msgRef.get()).data()?.alertId).toBe(alertId);
    expect((await db.doc(`orgs/${orgId}/channels/${channelId}`).get()).data()?.lastMessage.text).toBe('Need help now');

    await handleAlertCreated(orgId, alertId, alert);
    expect(enqueueEscalationCheck).toHaveBeenCalledWith({ orgId, alertId, expectedLevel: 0 }, 600);
    expect(await handleEscalation({ orgId, alertId, expectedLevel: 0 })).toMatchObject({ action: 'advance', level: 1 });

    await alertActionHandler(req({ orgId, alertId }, 'admin1', 'admin1@example.org', { orgId, role: 'admin' }), 'ack');
    expect(await handleEscalation({ orgId, alertId, expectedLevel: 1 })).toEqual({ action: 'noop', reason: 'not_open' });
  });

  it('admitPatient + checkDeadlines', async () => {
    const nurse = { orgId, role: 'clinician' as Role };
    const { patientId, channelId } = await admitPatientHandler(
      req(
        {
          orgId,
          patient: {
            firstName: 'Pat', lastName: 'Emu', dob: '1938-01-02', sex: 'unknown', phone: null,
            address: { line1: null, line2: null, city: null, state: null, zip: null }, mrn: null, medicareMbi: null,
            primaryDiagnosis: null, secondaryDiagnoses: [], referringPhysician: null, attendingPhysician: null,
            codeStatus: 'Unknown', allergies: [], medications: [], caregiver: null, insurance: { payer: null, memberId: null },
          },
          admissionDate: '2026-09-20',
          levelOfCare: 'routine',
          careTeamUids: ['nurse1'],
          consents: { electionStatement: true, hipaaNotice: true, releaseOfInformation: true, patientRights: true, polstOnFile: false },
        },
        'nurse1',
        'nurse1@example.org',
        nurse,
      ),
    );
    const db = getFirestore();
    expect((await db.doc(`orgs/${orgId}/channels/${channelId}`).get()).data()?.type).toBe('patient');
    const org = (await db.doc(`orgs/${orgId}`).get()).data() as Org;
    expect(await checkOrgDeadlines(orgId, org, '2026-09-23')).toBe(2);
    expect(await checkOrgDeadlines(orgId, org, '2026-09-23')).toBe(0);
    const p = (await db.doc(`orgs/${orgId}/patients/${patientId}`).get()).data();
    expect(p?.remindedMilestones).toHaveLength(2);
  });
});
