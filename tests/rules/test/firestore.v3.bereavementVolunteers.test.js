// v3 rules for the volunteer program and bereavement (docs/PERSONA_REVIEW.md C1, C2):
// staffHours overrides, function-only `voided*` on volunteer logs, coordinator-entered
// logs, volunteer patient access via `volunteerUids`, and the default coordinator setting.
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import {
  addDoc, collection, deleteDoc, doc, getDoc, getDocs, query, serverTimestamp, setDoc, Timestamp, updateDoc, where,
} from 'firebase/firestore';
import { as, createEnv, ORG, seed, seedV3, USERS, V3_USERS } from './fixtures.js';

let env;
beforeAll(async () => { env = await createEnv(); });
afterAll(async () => { await env?.cleanup(); });

const V = V3_USERS;
const db = (user) => as(env, user).firestore();
const hoursRef = (user, month = '2026-09') => doc(db(user), `orgs/${ORG}/staffHours/${month}`);
const logs = (user) => collection(db(user), `orgs/${ORG}/volunteerLogs`);

function hours(user, overrides = {}) {
  return { paidCareHours: 1234.5, updatedBy: user.uid, updatedAt: serverTimestamp(), ...overrides };
}

function log(volunteer, overrides = {}) {
  return {
    volunteerUid: volunteer.uid, patientId: null, date: '2026-09-25', minutes: 60,
    activity: 'companionship', note: null, createdAt: serverTimestamp(), ...overrides,
  };
}

beforeEach(async () => {
  await env.clearFirestore();
  await seed(env);
  await seedV3(env);
  await env.withSecurityRulesDisabled(async (ctx) => {
    const fs = ctx.firestore();
    const now = Timestamp.now();
    await setDoc(doc(fs, `orgs/${ORG}/staffHours/2026-08`), { paidCareHours: 900, updatedBy: USERS.admin.uid, updatedAt: now });
    await setDoc(doc(fs, `orgs/${ORG}/volunteerLogs/vl1`), { ...log(V.volunteer), createdAt: now });
    await setDoc(doc(fs, `orgs/${ORG}/patients/p2`), { firstName: 'A', lastName: 'B', status: 'admitted', volunteerUids: [V.volunteer.uid] });
    await setDoc(doc(fs, `orgs/${ORG}/bereavementPlans/bp1`), { patientId: 'p1', status: 'active', contacts: [] });
  });
});

describe('staffHours/{YYYY-MM}', () => {
  it('admin and the reports capability read and write the exact shape', async () => {
    await assertSucceeds(getDoc(hoursRef(USERS.admin, '2026-08')));
    await assertSucceeds(getDoc(hoursRef(V.reporter, '2026-08')));
    await assertSucceeds(setDoc(hoursRef(USERS.admin), hours(USERS.admin)));
    await assertSucceeds(setDoc(hoursRef(V.reporter, '2026-10'), hours(V.reporter, { paidCareHours: 0 })));
    await assertSucceeds(updateDoc(hoursRef(V.reporter, '2026-08'), { paidCareHours: 950, updatedBy: V.reporter.uid, updatedAt: serverTimestamp() }));
    await assertSucceeds(deleteDoc(hoursRef(V.reporter, '2026-08')));
  });

  it('denies everyone else, including the volunteers capability', async () => {
    for (const u of [USERS.rn, USERS.viewer, V.coordinator, V.volunteer]) {
      await assertFails(getDoc(hoursRef(u, '2026-08')));
      await assertFails(setDoc(hoursRef(u), hours(u)));
    }
    await assertFails(getDoc(hoursRef(USERS.outsider, '2026-08')));
  });

  it('rejects bad shapes and ids', async () => {
    const a = USERS.admin;
    await assertFails(setDoc(hoursRef(a, '2026-13'), hours(a)));
    await assertFails(setDoc(hoursRef(a, 'sept'), hours(a)));
    await assertFails(setDoc(hoursRef(a), hours(a, { paidCareHours: -1 })));
    await assertFails(setDoc(hoursRef(a), hours(a, { paidCareHours: 100001 })));
    await assertFails(setDoc(hoursRef(a), hours(a, { paidCareHours: '100' })));
    await assertFails(setDoc(hoursRef(a), hours(a, { updatedBy: V.reporter.uid })));
    await assertFails(setDoc(hoursRef(a), hours(a, { updatedAt: Timestamp.fromDate(new Date('2026-01-01')) })));
    await assertFails(setDoc(hoursRef(a), hours(a, { note: 'extra' })));
    await assertFails(setDoc(hoursRef(a), { paidCareHours: 10 }));
  });
});

describe('volunteerLogs: voided* is function-only', () => {
  it('no client can create a pre-voided log', async () => {
    await assertFails(addDoc(logs(V.volunteer), log(V.volunteer, { voidedAt: serverTimestamp() })));
    await assertFails(addDoc(logs(V.volunteer), log(V.volunteer, { voidedBy: V.volunteer.uid, voidReason: 'x' })));
    await assertFails(addDoc(logs(USERS.admin), log(V.volunteer, { enteredBy: USERS.admin.uid, voidedAt: null })));
  });

  it('no client (volunteer, coordinator or admin) can void or edit a log', async () => {
    for (const u of [V.volunteer, V.coordinator, USERS.admin]) {
      const ref = doc(db(u), `orgs/${ORG}/volunteerLogs/vl1`);
      await assertFails(updateDoc(ref, { voidedAt: serverTimestamp(), voidedBy: u.uid, voidReason: 'dup' }));
      await assertFails(deleteDoc(ref));
    }
  });

  it('coordinators log for a volunteer only with enteredBy == themselves', async () => {
    await assertSucceeds(addDoc(logs(V.coordinator), log(V.volunteer, { enteredBy: V.coordinator.uid })));
    await assertFails(addDoc(logs(V.coordinator), log(V.volunteer)));
    await assertFails(addDoc(logs(V.coordinator), log(V.volunteer, { enteredBy: V.volunteer.uid })));
    await assertFails(addDoc(logs(USERS.rn), log(V.volunteer, { enteredBy: USERS.rn.uid })));
    await assertSucceeds(addDoc(logs(V.volunteer), log(V.volunteer)));
  });

  it('volunteers list only their own logs; coordinators list all', async () => {
    await assertSucceeds(getDocs(query(logs(V.volunteer), where('volunteerUid', '==', V.volunteer.uid))));
    await assertFails(getDocs(logs(V.volunteer)));
    await assertSucceeds(getDocs(logs(V.coordinator)));
  });
});

describe('volunteer minimum-necessary access', () => {
  it('a volunteer lists only assigned patients and never reads bereavement plans', async () => {
    const patients = collection(db(V.volunteer), `orgs/${ORG}/patients`);
    await assertSucceeds(getDocs(query(patients, where('volunteerUids', 'array-contains', V.volunteer.uid))));
    await assertFails(getDocs(patients));
    await assertFails(getDoc(doc(db(V.volunteer), `orgs/${ORG}/patients/p1`)));
    await assertFails(getDoc(doc(db(V.volunteer), `orgs/${ORG}/bereavementPlans/bp1`)));
    await assertSucceeds(getDoc(doc(db(USERS.rn), `orgs/${ORG}/bereavementPlans/bp1`)));
  });

  it('clients cannot write volunteerUids or bereavement plans', async () => {
    await assertFails(updateDoc(doc(db(USERS.admin), `orgs/${ORG}/patients/p1`), { volunteerUids: [V.volunteer.uid] }));
    await assertFails(updateDoc(doc(db(USERS.admin), `orgs/${ORG}/bereavementPlans/bp1`), { status: 'closed' }));
  });
});

describe('org defaultBereavementCoordinatorUid', () => {
  it('admins set or clear it; others cannot', async () => {
    await assertSucceeds(updateDoc(doc(db(USERS.admin), `orgs/${ORG}`), { defaultBereavementCoordinatorUid: USERS.rn.uid }));
    await assertSucceeds(updateDoc(doc(db(USERS.admin), `orgs/${ORG}`), { defaultBereavementCoordinatorUid: null }));
    await assertFails(updateDoc(doc(db(USERS.admin), `orgs/${ORG}`), { defaultBereavementCoordinatorUid: 42 }));
    await assertFails(updateDoc(doc(db(USERS.rn), `orgs/${ORG}`), { defaultBereavementCoordinatorUid: USERS.rn.uid }));
  });
});
