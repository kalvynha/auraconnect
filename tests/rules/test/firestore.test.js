import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import {
  addDoc, collection, deleteDoc, doc, getDoc, getDocs, query, serverTimestamp,
  setDoc, Timestamp, updateDoc, where, orderBy,
} from 'firebase/firestore';
import { as, CHANNEL, createEnv, ORG, OTHER_ORG, seed, USERS } from './fixtures.js';

let env;
beforeAll(async () => { env = await createEnv(); });
afterAll(async () => { await env?.cleanup(); });
beforeEach(async () => {
  await env.clearFirestore();
  await seed(env);
});

const db = (user) => as(env, user).firestore();
const chPath = `orgs/${ORG}/channels/${CHANNEL}`;

function validMessage(user, overrides = {}) {
  return {
    senderUid: user.uid,
    senderName: user.uid,
    body: 'Patient resting comfortably.',
    priority: 'normal',
    attachments: [],
    roleTarget: null,
    createdAt: serverTimestamp(),
    alertId: null,
    ...overrides,
  };
}

function validReferral(user, id, overrides = {}) {
  return {
    fileName: 'referral.pdf',
    contentType: 'application/pdf',
    storagePath: `orgs/${ORG}/referrals/${id}/referral.pdf`,
    source: 'scan',
    status: 'uploaded',
    extracted: null,
    error: null,
    model: null,
    patientId: null,
    uploadedBy: user.uid,
    reviewedBy: null,
    rejectionReason: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...overrides,
  };
}

describe('unauthenticated + default deny', () => {
  it('denies unauthenticated reads', async () => {
    const anon = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(anon, `orgs/${ORG}`)));
    await assertFails(getDoc(doc(anon, `orgs/${ORG}/members/${USERS.rn.uid}`)));
  });
  it('denies unknown collections', async () => {
    await assertFails(getDoc(doc(db(USERS.admin), 'somethingElse/x')));
    await assertFails(setDoc(doc(db(USERS.admin), `orgs/${ORG}/unknown/x`), { a: 1 }));
  });
});

describe('userOrgs', () => {
  it('self read ok, others denied, no writes', async () => {
    await assertSucceeds(getDoc(doc(db(USERS.rn), `userOrgs/${USERS.rn.uid}`)));
    await assertFails(getDoc(doc(db(USERS.rn), `userOrgs/${USERS.md.uid}`)));
    await assertFails(setDoc(doc(db(USERS.rn), `userOrgs/${USERS.rn.uid}`), { orgId: ORG, role: 'admin' }));
  });
});

describe('org doc', () => {
  it('members can read; other orgs cannot', async () => {
    await assertSucceeds(getDoc(doc(db(USERS.viewer), `orgs/${ORG}`)));
    await assertFails(getDoc(doc(db(USERS.outsider), `orgs/${ORG}`)));
  });
  it('inactive member is denied even with valid claims', async () => {
    await assertFails(getDoc(doc(db(USERS.inactive), `orgs/${ORG}`)));
  });
  it('admin can update allowed keys', async () => {
    await assertSucceeds(updateDoc(doc(db(USERS.admin), `orgs/${ORG}`), {
      name: 'Renamed', timezone: 'America/Chicago', deadlineLeadDays: 5, defaultEscalationPolicyId: 'policy1',
    }));
  });
  it('admin cannot update other keys or set bad types', async () => {
    await assertFails(updateDoc(doc(db(USERS.admin), `orgs/${ORG}`), { createdBy: 'me' }));
    await assertFails(updateDoc(doc(db(USERS.admin), `orgs/${ORG}`), { deadlineLeadDays: 'five' }));
    await assertFails(updateDoc(doc(db(USERS.admin), `orgs/${ORG}`), { defaultEscalationPolicyId: 'missing' }));
  });
  it('non-admin cannot update; nobody can create/delete', async () => {
    await assertFails(updateDoc(doc(db(USERS.rn), `orgs/${ORG}`), { name: 'x' }));
    await assertFails(deleteDoc(doc(db(USERS.admin), `orgs/${ORG}`)));
    await assertFails(setDoc(doc(db(USERS.admin), 'orgs/new-org'), { name: 'x' }));
  });
});

describe('members', () => {
  it('same-org read allowed, cross-org denied', async () => {
    await assertSucceeds(getDoc(doc(db(USERS.viewer), `orgs/${ORG}/members/${USERS.rn.uid}`)));
    await assertSucceeds(getDocs(collection(db(USERS.rn), `orgs/${ORG}/members`)));
    await assertFails(getDoc(doc(db(USERS.outsider), `orgs/${ORG}/members/${USERS.rn.uid}`)));
    await assertFails(getDocs(collection(db(USERS.outsider), `orgs/${ORG}/members`)));
  });
  it('self may update fcmTokens and profile fields', async () => {
    const ref = doc(db(USERS.rn), `orgs/${ORG}/members/${USERS.rn.uid}`);
    await assertSucceeds(updateDoc(ref, { fcmTokens: ['tok-1'] }));
    await assertSucceeds(updateDoc(ref, { displayName: 'Nurse Ray', phone: '555-0100', title: 'RN Case Manager' }));
  });
  it('self may not escalate role, change active or exceed token limit', async () => {
    const ref = doc(db(USERS.rn), `orgs/${ORG}/members/${USERS.rn.uid}`);
    await assertFails(updateDoc(ref, { role: 'admin' }));
    await assertFails(updateDoc(ref, { active: false }));
    await assertFails(updateDoc(ref, { teamIds: ['t1'] }));
    await assertFails(updateDoc(ref, { fcmTokens: Array.from({ length: 21 }, (_, i) => `t${i}`) }));
    await assertFails(updateDoc(ref, { fcmTokens: 'tok' }));
  });
  it('cannot update another member unless admin', async () => {
    await assertFails(updateDoc(doc(db(USERS.rn), `orgs/${ORG}/members/${USERS.md.uid}`), { fcmTokens: [] }));
    await assertSucceeds(updateDoc(doc(db(USERS.admin), `orgs/${ORG}/members/${USERS.md.uid}`), { role: 'viewer' }));
    await assertSucceeds(updateDoc(doc(db(USERS.admin), `orgs/${ORG}/members/${USERS.md.uid}`), { active: false }));
    await assertFails(updateDoc(doc(db(USERS.admin), `orgs/${ORG}/members/${USERS.md.uid}`), { role: 'superuser' }));
  });
  it('admin of another org cannot change members', async () => {
    await assertFails(updateDoc(doc(db(USERS.outsider), `orgs/${ORG}/members/${USERS.md.uid}`), { role: 'admin' }));
  });
  it('no client create or delete', async () => {
    await assertFails(setDoc(doc(db(USERS.admin), `orgs/${ORG}/members/new`), { uid: 'new', role: 'admin' }));
    await assertFails(deleteDoc(doc(db(USERS.admin), `orgs/${ORG}/members/${USERS.md.uid}`)));
  });
  it('a demoted admin (member doc) loses admin rights before claims refresh', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), `orgs/${ORG}/members/${USERS.admin.uid}`), { role: 'clinician' });
    });
    await assertFails(getDoc(doc(db(USERS.admin), `orgs/${ORG}/auditLogs/log1`)));
  });
});

describe('invites', () => {
  it('admin read only; no writes', async () => {
    await assertSucceeds(getDoc(doc(db(USERS.admin), `orgs/${ORG}/invites/i1`)));
    await assertFails(getDoc(doc(db(USERS.rn), `orgs/${ORG}/invites/i1`)));
    await assertFails(setDoc(doc(db(USERS.admin), `orgs/${ORG}/invites/i2`), { email: 'a@b.c' }));
  });
});

describe('admin-managed config', () => {
  const start = Timestamp.fromDate(new Date('2026-10-01T12:00:00Z'));
  const end = Timestamp.fromDate(new Date('2026-10-02T00:00:00Z'));

  it('members read teams/onCallRoles/shifts/policies', async () => {
    for (const c of ['teams', 'onCallRoles', 'shifts', 'escalationPolicies']) {
      await assertSucceeds(getDocs(collection(db(USERS.viewer), `orgs/${ORG}/${c}`)));
      await assertFails(getDocs(collection(db(USERS.outsider), `orgs/${ORG}/${c}`)));
    }
  });
  it('admin writes shifts with valid shape; invalid or non-admin denied', async () => {
    const shift = { roleKey: 'oncall-rn-north', uid: USERS.rn.uid, start, end, notes: null };
    await assertSucceeds(setDoc(doc(db(USERS.admin), `orgs/${ORG}/shifts/s1`), shift));
    await assertFails(setDoc(doc(db(USERS.admin), `orgs/${ORG}/shifts/s2`), { ...shift, start: end, end: start }));
    await assertFails(setDoc(doc(db(USERS.admin), `orgs/${ORG}/shifts/s3`), { ...shift, extra: 1 }));
    await assertFails(setDoc(doc(db(USERS.rn), `orgs/${ORG}/shifts/s4`), shift));
    await assertSucceeds(deleteDoc(doc(db(USERS.admin), `orgs/${ORG}/shifts/s1`)));
  });
  it('escalation policy steps must be 1..10', async () => {
    const step = { target: { kind: 'original' }, waitMinutes: 5 };
    await assertSucceeds(setDoc(doc(db(USERS.admin), `orgs/${ORG}/escalationPolicies/p2`), { name: 'P', steps: [step] }));
    await assertFails(setDoc(doc(db(USERS.admin), `orgs/${ORG}/escalationPolicies/p3`), { name: 'P', steps: [] }));
    await assertFails(setDoc(doc(db(USERS.admin), `orgs/${ORG}/escalationPolicies/p4`), { name: 'P', steps: Array(11).fill(step) }));
  });
  it('admin writes teams and onCallRoles', async () => {
    await assertSucceeds(setDoc(doc(db(USERS.admin), `orgs/${ORG}/teams/t1`), {
      name: 'North Team', description: null, memberUids: [USERS.rn.uid], createdAt: Timestamp.now(),
    }));
    await assertSucceeds(setDoc(doc(db(USERS.admin), `orgs/${ORG}/onCallRoles/oncall-md`), {
      label: 'On-call MD', discipline: 'MD', teamId: null, fallbackUids: [USERS.md.uid],
    }));
    await assertFails(setDoc(doc(db(USERS.rn), `orgs/${ORG}/teams/t2`), {
      name: 'X', description: null, memberUids: [], createdAt: Timestamp.now(),
    }));
  });
});

describe('channels and messages', () => {
  it('member can read channel and messages', async () => {
    await assertSucceeds(getDoc(doc(db(USERS.rn), chPath)));
    await assertSucceeds(getDocs(collection(db(USERS.viewer), `${chPath}/messages`)));
  });
  it('channel list query constrained to memberUids is allowed', async () => {
    const q = query(collection(db(USERS.rn), `orgs/${ORG}/channels`),
      where('memberUids', 'array-contains', USERS.rn.uid), orderBy('lastMessageAt', 'desc'));
    await assertSucceeds(getDocs(q));
    await assertFails(getDocs(collection(db(USERS.rn), `orgs/${ORG}/channels`)));
  });
  it('non-member (even admin) cannot read channel or messages', async () => {
    await assertFails(getDoc(doc(db(USERS.admin), chPath)));
    await assertFails(getDocs(collection(db(USERS.md), `${chPath}/messages`)));
    await assertFails(getDoc(doc(db(USERS.outsider), `${chPath}/messages/m1`)));
  });
  it('deactivated member of the channel is denied', async () => {
    await assertFails(getDoc(doc(db(USERS.inactive), chPath)));
    await assertFails(getDocs(collection(db(USERS.inactive), `${chPath}/messages`)));
  });
  it('no client writes to channels', async () => {
    await assertFails(updateDoc(doc(db(USERS.rn), chPath), { name: 'x' }));
    await assertFails(setDoc(doc(db(USERS.admin), `orgs/${ORG}/channels/new`), { memberUids: [USERS.admin.uid] }));
  });
  it('valid message create is allowed (all priorities)', async () => {
    for (const priority of ['normal', 'urgent', 'critical']) {
      await assertSucceeds(addDoc(collection(db(USERS.rn), `${chPath}/messages`), validMessage(USERS.rn, { priority })));
    }
    await assertSucceeds(addDoc(collection(db(USERS.intake), `${chPath}/messages`), validMessage(USERS.intake)));
  });
  it('spoofed senderUid denied', async () => {
    await assertFails(addDoc(collection(db(USERS.rn), `${chPath}/messages`), validMessage(USERS.rn, { senderUid: USERS.intake.uid })));
  });
  it('alertId / roleTarget set denied', async () => {
    await assertFails(addDoc(collection(db(USERS.rn), `${chPath}/messages`), validMessage(USERS.rn, { alertId: 'a1' })));
    await assertFails(addDoc(collection(db(USERS.rn), `${chPath}/messages`), validMessage(USERS.rn, { roleTarget: 'oncall-md' })));
  });
  it('client-chosen createdAt, bad priority, long body, extra keys, missing keys denied', async () => {
    const col = collection(db(USERS.rn), `${chPath}/messages`);
    await assertFails(addDoc(col, validMessage(USERS.rn, { createdAt: Timestamp.fromDate(new Date('2020-01-01')) })));
    await assertFails(addDoc(col, validMessage(USERS.rn, { priority: 'emergency' })));
    await assertFails(addDoc(col, validMessage(USERS.rn, { body: 'x'.repeat(8001) })));
    await assertSucceeds(addDoc(col, validMessage(USERS.rn, { body: 'x'.repeat(8000) })));
    await assertFails(addDoc(col, validMessage(USERS.rn, { extra: true })));
    const { alertId, ...missing } = validMessage(USERS.rn);
    await assertFails(addDoc(col, missing));
    await assertFails(addDoc(col, validMessage(USERS.rn, { attachments: Array(11).fill({ storagePath: 'x', contentType: 'image/png', name: 'x', size: 1 }) })));
  });
  it('viewer cannot post', async () => {
    await assertFails(addDoc(collection(db(USERS.viewer), `${chPath}/messages`), validMessage(USERS.viewer)));
  });
  it('non-member cannot post', async () => {
    await assertFails(addDoc(collection(db(USERS.md), `${chPath}/messages`), validMessage(USERS.md)));
    await assertFails(addDoc(collection(db(USERS.inactive), `${chPath}/messages`), validMessage(USERS.inactive)));
  });
  it('cannot post to an archived channel', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), chPath), { archived: true });
    });
    await assertFails(addDoc(collection(db(USERS.rn), `${chPath}/messages`), validMessage(USERS.rn)));
  });
  it('update and delete of messages denied, even by sender', async () => {
    await assertFails(updateDoc(doc(db(USERS.rn), `${chPath}/messages/m1`), { body: 'edited' }));
    await assertFails(deleteDoc(doc(db(USERS.rn), `${chPath}/messages/m1`)));
  });
});

describe('read receipts', () => {
  it('self write allowed with lastReadAt == request.time', async () => {
    await assertSucceeds(setDoc(doc(db(USERS.intake), `${chPath}/reads/${USERS.intake.uid}`), { lastReadAt: serverTimestamp() }));
    await assertSucceeds(setDoc(doc(db(USERS.rn), `${chPath}/reads/${USERS.rn.uid}`), { lastReadAt: serverTimestamp() }));
    await assertSucceeds(setDoc(doc(db(USERS.viewer), `${chPath}/reads/${USERS.viewer.uid}`), { lastReadAt: serverTimestamp() }));
  });
  it('writing another user\'s receipt denied', async () => {
    await assertFails(setDoc(doc(db(USERS.intake), `${chPath}/reads/${USERS.rn.uid}`), { lastReadAt: serverTimestamp() }));
  });
  it('bad shape or client time denied; non-member denied', async () => {
    await assertFails(setDoc(doc(db(USERS.rn), `${chPath}/reads/${USERS.rn.uid}`), { lastReadAt: Timestamp.now() }));
    await assertFails(setDoc(doc(db(USERS.rn), `${chPath}/reads/${USERS.rn.uid}`), { lastReadAt: serverTimestamp(), x: 1 }));
    await assertFails(setDoc(doc(db(USERS.md), `${chPath}/reads/${USERS.md.uid}`), { lastReadAt: serverTimestamp() }));
  });
  it('channel members can read receipts; non-members cannot', async () => {
    await assertSucceeds(getDoc(doc(db(USERS.intake), `${chPath}/reads/${USERS.rn.uid}`)));
    await assertFails(getDoc(doc(db(USERS.md), `${chPath}/reads/${USERS.rn.uid}`)));
  });
});

describe('alerts', () => {
  it('readable by target and admin only', async () => {
    await assertSucceeds(getDoc(doc(db(USERS.rn), `orgs/${ORG}/alerts/a1`)));
    await assertSucceeds(getDoc(doc(db(USERS.admin), `orgs/${ORG}/alerts/a1`)));
    await assertFails(getDoc(doc(db(USERS.md), `orgs/${ORG}/alerts/a1`)));
    await assertFails(getDoc(doc(db(USERS.outsider), `orgs/${ORG}/alerts/a1`)));
  });
  it('target query allowed, unconstrained query denied for non-admin', async () => {
    const q = query(collection(db(USERS.md), `orgs/${ORG}/alerts`), where('targetUids', 'array-contains', USERS.md.uid));
    await assertSucceeds(getDocs(q));
    await assertFails(getDocs(collection(db(USERS.md), `orgs/${ORG}/alerts`)));
    await assertSucceeds(getDocs(collection(db(USERS.admin), `orgs/${ORG}/alerts`)));
  });
  it('no client writes (ack goes through ackAlert)', async () => {
    await assertFails(updateDoc(doc(db(USERS.rn), `orgs/${ORG}/alerts/a1`), { status: 'acked' }));
    await assertFails(addDoc(collection(db(USERS.admin), `orgs/${ORG}/alerts`), { title: 'x' }));
  });
});

describe('patients', () => {
  it('same-org read allowed (viewer too), cross-org denied, no writes', async () => {
    await assertSucceeds(getDoc(doc(db(USERS.viewer), `orgs/${ORG}/patients/p1`)));
    await assertSucceeds(getDocs(collection(db(USERS.rn), `orgs/${ORG}/patients`)));
    await assertFails(getDoc(doc(db(USERS.outsider), `orgs/${ORG}/patients/p1`)));
    await assertFails(getDoc(doc(db(USERS.rn), `orgs/${OTHER_ORG}/patients/p1`)));
    await assertFails(updateDoc(doc(db(USERS.admin), `orgs/${ORG}/patients/p1`), { status: 'discharged' }));
  });
});

describe('referrals', () => {
  it('intake/clinician/admin can create a valid referral', async () => {
    await assertSucceeds(setDoc(doc(db(USERS.intake), `orgs/${ORG}/referrals/r1`), validReferral(USERS.intake, 'r1')));
    await assertSucceeds(setDoc(doc(db(USERS.rn), `orgs/${ORG}/referrals/r2`), validReferral(USERS.rn, 'r2', { source: 'upload' })));
    await assertSucceeds(setDoc(doc(db(USERS.admin), `orgs/${ORG}/referrals/r3`), validReferral(USERS.admin, 'r3', {
      fileName: 'fax.png', contentType: 'image/png', storagePath: `orgs/${ORG}/referrals/r3/fax.png`, source: 'fax',
    })));
  });
  it('wrong storagePath / status / uploader / source / nulls denied', async () => {
    const ref = doc(db(USERS.intake), `orgs/${ORG}/referrals/r1`);
    await assertFails(setDoc(ref, validReferral(USERS.intake, 'r1', { storagePath: `orgs/${ORG}/referrals/other/referral.pdf` })));
    await assertFails(setDoc(ref, validReferral(USERS.intake, 'r1', { storagePath: `orgs/${OTHER_ORG}/referrals/r1/referral.pdf` })));
    await assertFails(setDoc(ref, validReferral(USERS.intake, 'r1', { status: 'needs_review' })));
    await assertFails(setDoc(ref, validReferral(USERS.intake, 'r1', { uploadedBy: USERS.rn.uid })));
    await assertFails(setDoc(ref, validReferral(USERS.intake, 'r1', { source: 'email' })));
    await assertFails(setDoc(ref, validReferral(USERS.intake, 'r1', { patientId: 'p1' })));
    await assertFails(setDoc(ref, validReferral(USERS.intake, 'r1', { extracted: { patient: {} } })));
    await assertFails(setDoc(ref, validReferral(USERS.intake, 'r1', { contentType: 'text/html' })));
    await assertFails(setDoc(ref, validReferral(USERS.intake, 'r1', {
      fileName: 'a/b.pdf', storagePath: `orgs/${ORG}/referrals/r1/a/b.pdf`,
    })));
    await assertFails(setDoc(ref, validReferral(USERS.intake, 'r1', { createdAt: Timestamp.now() })));
  });
  it('viewer cannot create or read', async () => {
    await assertFails(setDoc(doc(db(USERS.viewer), `orgs/${ORG}/referrals/r1`), validReferral(USERS.viewer, 'r1')));
    await assertFails(getDoc(doc(db(USERS.viewer), `orgs/${ORG}/referrals/r-existing`)));
  });
  it('cross-org create/read denied', async () => {
    await assertFails(setDoc(doc(db(USERS.outsider), `orgs/${ORG}/referrals/r1`), validReferral(USERS.outsider, 'r1')));
    await assertFails(getDoc(doc(db(USERS.outsider), `orgs/${ORG}/referrals/r-existing`)));
  });
  it('allowed roles can read; update and delete denied', async () => {
    await assertSucceeds(getDoc(doc(db(USERS.rn), `orgs/${ORG}/referrals/r-existing`)));
    await assertSucceeds(getDoc(doc(db(USERS.intake), `orgs/${ORG}/referrals/r-existing`)));
    await assertFails(updateDoc(doc(db(USERS.intake), `orgs/${ORG}/referrals/r-existing`), { status: 'accepted' }));
    await assertFails(deleteDoc(doc(db(USERS.admin), `orgs/${ORG}/referrals/r-existing`)));
  });
});

describe('auditLogs', () => {
  it('admin read ok, clinician denied, any write denied', async () => {
    await assertSucceeds(getDoc(doc(db(USERS.admin), `orgs/${ORG}/auditLogs/log1`)));
    await assertSucceeds(getDocs(collection(db(USERS.admin), `orgs/${ORG}/auditLogs`)));
    await assertFails(getDoc(doc(db(USERS.rn), `orgs/${ORG}/auditLogs/log1`)));
    await assertFails(getDoc(doc(db(USERS.outsider), `orgs/${ORG}/auditLogs/log1`)));
    await assertFails(addDoc(collection(db(USERS.admin), `orgs/${ORG}/auditLogs`), { action: 'org.create' }));
    await assertFails(updateDoc(doc(db(USERS.admin), `orgs/${ORG}/auditLogs/log1`), { action: 'x' }));
    await assertFails(deleteDoc(doc(db(USERS.admin), `orgs/${ORG}/auditLogs/log1`)));
  });
});
