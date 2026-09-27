// v3 rules for on-call, messaging and IDG (docs/PERSONA_REVIEW.md S6, F5, H3, M4):
// patientChannelRetentionDays, messageRecalls, rateLimits and idgMeetings/{id}/notes.
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { collection, deleteDoc, deleteField, doc, getDoc, getDocs, setDoc, Timestamp, updateDoc } from 'firebase/firestore';
import { as, createEnv, ORG, seed, seedV3, USERS, V3_USERS } from './fixtures.js';

let env;
beforeAll(async () => { env = await createEnv(); });
afterAll(async () => { await env?.cleanup(); });

const V = V3_USERS;
const db = (user) => as(env, user).firestore();
const orgRef = (user) => doc(db(user), `orgs/${ORG}`);
const recallPath = `orgs/${ORG}/messageRecalls/ch-care_m1`;
const notePath = `orgs/${ORG}/idgMeetings/mt1/notes/p1_RN`;
const prepPath = `orgs/${ORG}/idgMeetings/mt1/notes/p1_aiPrep`;
const bucketPath = `orgs/${ORG}/rateLimits/${USERS.rn.uid}_searchMessages`;

beforeEach(async () => {
  await env.clearFirestore();
  await seed(env);
  await seedV3(env);
  await env.withSecurityRulesDisabled(async (ctx) => {
    const fs = ctx.firestore();
    const now = Timestamp.now();
    await setDoc(doc(fs, recallPath), {
      channelId: 'ch-care', messageId: 'm1', patientId: null, senderUid: USERS.rn.uid, senderName: 'rn', body: 'wrong patient',
      priority: 'normal', attachments: [], threadParentId: null, messageCreatedAt: now, recalledBy: USERS.rn.uid, recalledAt: now,
    });
    await setDoc(doc(fs, `orgs/${ORG}/idgMeetings/mt1`), { title: 'IDG', status: 'scheduled', patientIds: ['p1'] });
    await setDoc(doc(fs, notePath), { kind: 'discipline', meetingId: 'mt1', patientId: 'p1', discipline: 'RN', text: 'Stable', updatedBy: USERS.rn.uid, updatedAt: now });
    await setDoc(doc(fs, prepPath), { kind: 'ai_prep', meetingId: 'mt1', patientId: 'p1', text: 'Prep', model: 'm', generatedBy: USERS.rn.uid, generatedAt: now });
    await setDoc(doc(fs, bucketPath), { uid: USERS.rn.uid, action: 'searchMessages', tokens: 3, refilledAtMs: 0 });
  });
});

describe('org.patientChannelRetentionDays (S6)', () => {
  it('admins may set null or an int 2190–36500, and remove it', async () => {
    await assertSucceeds(updateDoc(orgRef(USERS.admin), { patientChannelRetentionDays: 2190 }));
    await assertSucceeds(updateDoc(orgRef(USERS.admin), { patientChannelRetentionDays: 36500 }));
    await assertSucceeds(updateDoc(orgRef(USERS.admin), { patientChannelRetentionDays: null }));
    await assertSucceeds(updateDoc(orgRef(USERS.admin), { patientChannelRetentionDays: deleteField() }));
  });

  it('rejects values under 6 years, over 100 years, non-integers and non-admins', async () => {
    for (const bad of [2189, 365, 36501, 2190.5, '2190', true]) {
      await assertFails(updateDoc(orgRef(USERS.admin), { patientChannelRetentionDays: bad }));
    }
    await assertFails(updateDoc(orgRef(USERS.rn), { patientChannelRetentionDays: 2190 }));
    await assertFails(updateDoc(orgRef(V.auditor), { patientChannelRetentionDays: 2190 }));
  });
});

describe('messageRecalls (S6)', () => {
  it('readable by admins and the audit capability only', async () => {
    await assertSucceeds(getDoc(doc(db(USERS.admin), recallPath)));
    await assertSucceeds(getDoc(doc(db(V.auditor), recallPath)));
    await assertSucceeds(getDocs(collection(db(V.auditor), `orgs/${ORG}/messageRecalls`)));
    // Not even the original sender.
    await assertFails(getDoc(doc(db(USERS.rn), recallPath)));
    await assertFails(getDoc(doc(db(V.reporter), recallPath)));
    await assertFails(getDoc(doc(db(USERS.outsider), recallPath)));
  });

  it('no client writes', async () => {
    await assertFails(setDoc(doc(db(USERS.admin), `orgs/${ORG}/messageRecalls/x`), { body: 'x' }));
    await assertFails(updateDoc(doc(db(USERS.admin), recallPath), { body: '' }));
    await assertFails(deleteDoc(doc(db(V.auditor), recallPath)));
  });
});

describe('rateLimits (M4)', () => {
  it('no client access at all, even for the bucket owner or an admin', async () => {
    await assertFails(getDoc(doc(db(USERS.rn), bucketPath)));
    await assertFails(getDoc(doc(db(USERS.admin), bucketPath)));
    await assertFails(setDoc(doc(db(USERS.rn), bucketPath), { uid: USERS.rn.uid, action: 'searchMessages', tokens: 30, refilledAtMs: Date.now() }));
    await assertFails(deleteDoc(doc(db(USERS.rn), bucketPath)));
  });
});

describe('idgMeetings/{id}/notes (F5, H3)', () => {
  it('staff read discipline notes and AI prep; volunteers do not', async () => {
    for (const user of [USERS.rn, USERS.viewer, USERS.admin, V.aide]) {
      await assertSucceeds(getDoc(doc(db(user), notePath)));
      await assertSucceeds(getDoc(doc(db(user), prepPath)));
    }
    await assertSucceeds(getDocs(collection(db(USERS.rn), `orgs/${ORG}/idgMeetings/mt1/notes`)));
    await assertFails(getDoc(doc(db(V.volunteer), notePath)));
    await assertFails(getDoc(doc(db(V.volunteer), prepPath)));
    await assertFails(getDocs(collection(db(V.volunteer), `orgs/${ORG}/idgMeetings/mt1/notes`)));
    await assertFails(getDoc(doc(db(USERS.inactive), notePath)));
    await assertFails(getDoc(doc(db(USERS.outsider), notePath)));
  });

  it('written only by functions', async () => {
    await assertFails(setDoc(doc(db(USERS.rn), `orgs/${ORG}/idgMeetings/mt1/notes/p1_SW`), { text: 'x' }));
    await assertFails(updateDoc(doc(db(USERS.admin), notePath), { text: 'changed' }));
    await assertFails(deleteDoc(doc(db(USERS.admin), prepPath)));
  });
});
