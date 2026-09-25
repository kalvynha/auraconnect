import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, setDoc, Timestamp } from 'firebase/firestore';

export const PROJECT_ID = 'demo-auraconnect';
const root = fileURLToPath(new URL('../../../', import.meta.url));

export const ORG = 'org1';
export const OTHER_ORG = 'org2';

/** Users in ORG (plus one in OTHER_ORG). `claims` go on the token, `member` on the doc. */
export const USERS = {
  admin: { uid: 'u-admin', orgId: ORG, role: 'admin', active: true },
  rn: { uid: 'u-rn', orgId: ORG, role: 'clinician', active: true },
  md: { uid: 'u-md', orgId: ORG, role: 'clinician', active: true },
  intake: { uid: 'u-intake', orgId: ORG, role: 'intake', active: true },
  viewer: { uid: 'u-viewer', orgId: ORG, role: 'viewer', active: true },
  inactive: { uid: 'u-inactive', orgId: ORG, role: 'clinician', active: false },
  outsider: { uid: 'u-outsider', orgId: OTHER_ORG, role: 'admin', active: true },
};

export const CHANNEL = 'ch-care';
/** rn, intake, viewer and inactive are channel members; admin and md are not. */
export const CHANNEL_MEMBERS = [USERS.rn.uid, USERS.intake.uid, USERS.viewer.uid, USERS.inactive.uid];

export async function createEnv({ storage = false } = {}) {
  const config = {
    projectId: PROJECT_ID,
    firestore: { rules: readFileSync(`${root}firestore.rules`, 'utf8') },
  };
  if (storage) config.storage = { rules: readFileSync(`${root}storage.rules`, 'utf8') };
  return initializeTestEnvironment(config);
}

/** Authenticated context carrying the user's custom claims. */
export function as(env, user) {
  return env.authenticatedContext(user.uid, { orgId: user.orgId, role: user.role });
}

export function memberDoc(user) {
  return {
    uid: user.uid,
    email: `${user.uid}@example.test`,
    displayName: user.uid,
    role: user.role,
    discipline: 'RN',
    title: null,
    phone: null,
    teamIds: [],
    active: user.active,
    fcmTokens: [],
    createdAt: Timestamp.now(),
  };
}

/** Seed a baseline world with rules disabled. */
export async function seed(env) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const now = Timestamp.now();
    for (const orgId of [ORG, OTHER_ORG]) {
      await setDoc(doc(db, `orgs/${orgId}`), {
        name: `Org ${orgId}`,
        timezone: 'America/New_York',
        deadlineLeadDays: 3,
        defaultEscalationPolicyId: null,
        createdBy: 'seed',
        createdAt: now,
      });
      await setDoc(doc(db, `orgs/${orgId}/patients/p1`), { firstName: 'Test', lastName: 'Patient', status: 'admitted' });
    }
    for (const user of Object.values(USERS)) {
      await setDoc(doc(db, `orgs/${user.orgId}/members/${user.uid}`), memberDoc(user));
      await setDoc(doc(db, `userOrgs/${user.uid}`), { orgId: user.orgId, role: user.role });
    }
    await setDoc(doc(db, `orgs/${ORG}/escalationPolicies/policy1`), {
      name: 'Default',
      steps: [{ target: { kind: 'original' }, waitMinutes: 5 }],
    });
    await setDoc(doc(db, `orgs/${ORG}/channels/${CHANNEL}`), {
      type: 'group',
      name: 'Care',
      memberUids: CHANNEL_MEMBERS,
      patientId: null,
      teamId: null,
      createdBy: USERS.rn.uid,
      createdAt: now,
      lastMessage: null,
      lastMessageAt: now,
      archived: false,
    });
    await setDoc(doc(db, `orgs/${ORG}/channels/${CHANNEL}/messages/m1`), {
      senderUid: USERS.rn.uid,
      senderName: 'rn',
      body: 'hello',
      priority: 'normal',
      attachments: [],
      roleTarget: null,
      createdAt: now,
      alertId: null,
    });
    await setDoc(doc(db, `orgs/${ORG}/channels/${CHANNEL}/reads/${USERS.rn.uid}`), { lastReadAt: now });
    await setDoc(doc(db, `orgs/${ORG}/alerts/a1`), {
      title: 'Urgent message',
      body: 'Urgent message',
      priority: 'urgent',
      source: { type: 'manual', patientId: null },
      targetUids: [USERS.rn.uid],
      currentTargetUids: [USERS.rn.uid],
      policyId: null,
      level: 0,
      exhausted: false,
      status: 'open',
      createdBy: USERS.md.uid,
      createdAt: now,
      ackedBy: null,
      ackedAt: null,
      history: [],
    });
    await setDoc(doc(db, `orgs/${ORG}/auditLogs/log1`), {
      actorUid: USERS.admin.uid,
      action: 'org.create',
      resourceType: 'org',
      resourceId: ORG,
      patientId: null,
      at: now,
      metadata: {},
    });
    await setDoc(doc(db, `orgs/${ORG}/referrals/r-existing`), {
      fileName: 'a.pdf',
      contentType: 'application/pdf',
      storagePath: `orgs/${ORG}/referrals/r-existing/a.pdf`,
      source: 'upload',
      status: 'needs_review',
      extracted: null,
      error: null,
      model: null,
      patientId: null,
      uploadedBy: USERS.intake.uid,
      reviewedBy: null,
      rejectionReason: null,
      createdAt: now,
      updatedAt: now,
    });
    await setDoc(doc(db, `orgs/${ORG}/invites/i1`), { email: 'x@example.test', status: 'pending' });
  });
}
