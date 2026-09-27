// v3 rules: capabilities, discipline-based messaging and volunteer
// minimum-necessary access (docs/PERSONA_REVIEW.md L3, C2, S3).
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import {
  addDoc, collection, deleteDoc, deleteField, doc, getDoc, getDocs, query, serverTimestamp,
  setDoc, Timestamp, updateDoc, where,
} from 'firebase/firestore';
import { getMetadata, ref as sRef, uploadBytes } from 'firebase/storage';
import { as, CHANNEL, CHANNEL_MEMBERS, createEnv, ORG, seed, seedV3, USERS, V3_USERS } from './fixtures.js';

let env;
beforeAll(async () => { env = await createEnv({ storage: true }); });
afterAll(async () => { await env?.cleanup(); });

const V = V3_USERS;
const SMALL = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"
const PDF = { contentType: 'application/pdf' };
const DOC_FILE = (pid) => `orgs/${ORG}/patients/${pid}/documents/d-v3/consent.pdf`;
const VOLUNTEER_BLOCKED = ['visits', 'tasks', 'triageCalls', 'idgMeetings'];

beforeEach(async () => {
  await env.clearFirestore();
  await env.clearStorage();
  await seed(env);
  await seedV3(env);
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const now = Timestamp.now();
    // Aide and LPN are members of the care channel.
    await updateDoc(doc(db, `orgs/${ORG}/channels/${CHANNEL}`), {
      memberUids: [...CHANNEL_MEMBERS, V.aide.uid, V.lpn.uid, V.volunteer.uid],
    });
    // p1: no volunteers. p2: assigned to V.volunteer.
    await setDoc(doc(db, `orgs/${ORG}/patients/p2`), {
      firstName: 'Assigned', lastName: 'Patient', status: 'admitted', volunteerUids: [V.volunteer.uid],
    });
    for (const pid of ['p1', 'p2']) {
      await setDoc(doc(db, `orgs/${ORG}/patients/${pid}/events/e1`), { type: 'admission', createdAt: now });
      await setDoc(doc(db, `orgs/${ORG}/patients/${pid}/documents/d1`), { name: 'Consent', createdAt: now });
    }
    for (const c of VOLUNTEER_BLOCKED) await setDoc(doc(db, `orgs/${ORG}/${c}/x1`), { seeded: true });
    await setDoc(doc(db, `orgs/${ORG}/metrics/2026-09-25`), { date: '2026-09-25', computedAt: now });
    await setDoc(doc(db, `orgs/${ORG}/shifts/s-existing`), validShift());
    await setDoc(doc(db, `orgs/${ORG}/onCallRoles/oncall-rn`), validOnCall());
    await setDoc(doc(db, `orgs/${ORG}/volunteerAssignments/va-vol`), validAssignment(USERS.admin, { volunteerUid: V.volunteer.uid, patientId: 'p2', createdAt: now }));
    await setDoc(doc(db, `orgs/${ORG}/volunteerAssignments/va-vol2`), validAssignment(USERS.admin, { volunteerUid: V.volunteer2.uid, createdAt: now }));
    await setDoc(doc(db, `orgs/${ORG}/volunteerLogs/vl-vol`), validLog(V.volunteer, { createdAt: now }));
    await setDoc(doc(db, `orgs/${ORG}/volunteerLogs/vl-rn`), validLog(USERS.rn, { createdAt: now }));
    const s = ctx.storage();
    for (const pid of ['p1', 'p2']) await uploadBytes(sRef(s, DOC_FILE(pid)), SMALL, PDF);
  });
});

const db = (user) => as(env, user).firestore();
const storage = (user) => as(env, user).storage();
const orgRef = (user) => doc(db(user), `orgs/${ORG}`);
const memberRef = (user, uid) => doc(db(user), `orgs/${ORG}/members/${uid}`);
const msgCol = (user) => collection(db(user), `orgs/${ORG}/channels/${CHANNEL}/messages`);

function validMessage(user, overrides = {}) {
  return {
    senderUid: user.uid, senderName: user.uid, body: 'Vitals taken.', priority: 'normal',
    attachments: [], roleTarget: null, createdAt: serverTimestamp(), alertId: null, ...overrides,
  };
}

function validShift(overrides = {}) {
  return {
    roleKey: 'oncall-rn', uid: USERS.rn.uid,
    start: Timestamp.fromDate(new Date('2026-10-01T08:00:00Z')),
    end: Timestamp.fromDate(new Date('2026-10-01T20:00:00Z')),
    notes: null, ...overrides,
  };
}

function validOnCall(overrides = {}) {
  return { label: 'On-call RN', discipline: 'RN', teamId: null, fallbackUids: [], ...overrides };
}

function validAssignment(user, overrides = {}) {
  return {
    volunteerUid: V.volunteer2.uid, patientId: 'p1', patientName: 'Patient, Test', activity: 'companionship',
    status: 'active', startDate: '2026-09-01', endDate: null, notes: null,
    createdBy: user.uid, createdAt: serverTimestamp(), ...overrides,
  };
}

function validLog(user, overrides = {}) {
  return {
    volunteerUid: user.uid, patientId: 'p1', date: '2026-09-25', minutes: 60,
    activity: 'companionship', note: null, createdAt: serverTimestamp(), ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Member capabilities
// ---------------------------------------------------------------------------

describe('member capabilities (admin grants)', () => {
  it('admin can grant known capabilities, including all six', async () => {
    await assertSucceeds(updateDoc(memberRef(USERS.admin, USERS.rn.uid), { capabilities: ['scheduling', 'reports'] }));
    await assertSucceeds(updateDoc(memberRef(USERS.admin, USERS.rn.uid), {
      capabilities: ['reports', 'audit', 'staffing', 'scheduling', 'volunteers', 'bereavement'],
    }));
    await assertSucceeds(updateDoc(memberRef(USERS.admin, USERS.rn.uid), { capabilities: [] }));
  });
  it('admin can revoke by removing the field', async () => {
    await assertSucceeds(updateDoc(memberRef(USERS.admin, V.scheduler.uid), { capabilities: deleteField() }));
  });
  it('an unknown capability string is denied', async () => {
    await assertFails(updateDoc(memberRef(USERS.admin, USERS.rn.uid), { capabilities: ['superpowers'] }));
    await assertFails(updateDoc(memberRef(USERS.admin, USERS.rn.uid), { capabilities: ['reports', 'admin'] }));
  });
  it('more than 6 entries, or a non-list, is denied', async () => {
    await assertFails(updateDoc(memberRef(USERS.admin, USERS.rn.uid), {
      capabilities: ['reports', 'audit', 'staffing', 'scheduling', 'volunteers', 'bereavement', 'reports'],
    }));
    await assertFails(updateDoc(memberRef(USERS.admin, USERS.rn.uid), { capabilities: 'reports' }));
    await assertFails(updateDoc(memberRef(USERS.admin, USERS.rn.uid), { capabilities: { reports: true } }));
  });
  it('capability spoofing through self-update is denied', async () => {
    await assertFails(updateDoc(memberRef(USERS.rn, USERS.rn.uid), { capabilities: ['audit'] }));
    await assertFails(updateDoc(memberRef(V.scheduler, V.scheduler.uid), {
      capabilities: ['scheduling', 'reports'],
    }));
    await assertFails(updateDoc(memberRef(V.scheduler, V.scheduler.uid), { capabilities: deleteField() }));
  });
  it('self-update still cannot change role, discipline or active', async () => {
    await assertFails(updateDoc(memberRef(V.aide, V.aide.uid), { role: 'clinician' }));
    await assertFails(updateDoc(memberRef(V.aide, V.aide.uid), { discipline: 'RN' }));
    await assertFails(updateDoc(memberRef(V.volunteer, V.volunteer.uid), { discipline: 'SW' }));
    await assertFails(updateDoc(memberRef(V.aide, V.aide.uid), { active: false }));
    await assertSucceeds(updateDoc(memberRef(V.aide, V.aide.uid), { displayName: 'Aide A.' }));
  });
  it('a capability holder cannot grant capabilities to others', async () => {
    await assertFails(updateDoc(memberRef(V.coordinator, USERS.rn.uid), { capabilities: ['volunteers'] }));
  });
});

// ---------------------------------------------------------------------------
// Messaging: Aide/LPN viewers
// ---------------------------------------------------------------------------

describe('messaging by field staff', () => {
  it('an aide viewer can post', async () => {
    await assertSucceeds(addDoc(msgCol(V.aide), validMessage(V.aide)));
  });
  it('an LPN viewer can post and reply in a thread', async () => {
    await assertSucceeds(addDoc(msgCol(V.lpn), validMessage(V.lpn, { threadParentId: 'm1' })));
  });
  it('a plain viewer still cannot post', async () => {
    await assertFails(addDoc(msgCol(USERS.viewer), validMessage(USERS.viewer)));
  });
  it('a volunteer viewer cannot post', async () => {
    await assertFails(addDoc(msgCol(V.volunteer), validMessage(V.volunteer)));
  });
  it('aide posting still requires channel membership and own senderUid', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), `orgs/${ORG}/channels/${CHANNEL}`), { memberUids: CHANNEL_MEMBERS });
    });
    await assertFails(addDoc(msgCol(V.aide), validMessage(V.aide)));
  });
  it('aide cannot impersonate another sender', async () => {
    await assertFails(addDoc(msgCol(V.aide), validMessage(V.aide, { senderUid: USERS.rn.uid })));
  });
  it('aide maintains own read receipt', async () => {
    await assertSucceeds(setDoc(doc(db(V.aide), `orgs/${ORG}/channels/${CHANNEL}/reads/${V.aide.uid}`), { lastReadAt: serverTimestamp() }));
  });
  it('aide viewer can upload a channel attachment; plain viewer cannot', async () => {
    const path = (f) => `orgs/${ORG}/channels/${CHANNEL}/attachments/${f}`;
    await assertSucceeds(uploadBytes(sRef(storage(V.aide), path('wound.png')), SMALL, { contentType: 'image/png' }));
    await assertSucceeds(uploadBytes(sRef(storage(V.lpn), path('vitals.pdf')), SMALL, PDF));
    await assertFails(uploadBytes(sRef(storage(USERS.viewer), path('x.png')), SMALL, { contentType: 'image/png' }));
    await assertFails(uploadBytes(sRef(storage(V.volunteer), path('y.png')), SMALL, { contentType: 'image/png' }));
  });
});

// ---------------------------------------------------------------------------
// Scheduling capability: shifts + onCallRoles
// ---------------------------------------------------------------------------

describe('scheduling capability', () => {
  it('scheduler creates, updates and deletes shifts', async () => {
    const r = doc(db(V.scheduler), `orgs/${ORG}/shifts/s-new`);
    await assertSucceeds(setDoc(r, validShift()));
    await assertSucceeds(updateDoc(r, { notes: 'Swap with MD' }));
    await assertSucceeds(deleteDoc(r));
    await assertSucceeds(deleteDoc(doc(db(V.scheduler), `orgs/${ORG}/shifts/s-existing`)));
  });
  it('scheduler shift writes still need the exact shape', async () => {
    const r = doc(db(V.scheduler), `orgs/${ORG}/shifts/s-bad`);
    await assertFails(setDoc(r, validShift({ extra: 1 })));
    await assertFails(setDoc(r, validShift({ end: validShift().start })));
  });
  it('scheduler writes onCallRoles', async () => {
    const r = doc(db(V.scheduler), `orgs/${ORG}/onCallRoles/oncall-sw`);
    await assertSucceeds(setDoc(r, validOnCall({ label: 'On-call SW', discipline: 'SW' })));
    await assertSucceeds(updateDoc(doc(db(V.scheduler), `orgs/${ORG}/onCallRoles/oncall-rn`), { fallbackUids: [USERS.md.uid] }));
    await assertSucceeds(deleteDoc(r));
    await assertFails(setDoc(r, validOnCall({ discipline: 'Wizard' })));
  });
  it('members without scheduling cannot write shifts or onCallRoles', async () => {
    for (const u of [USERS.rn, V.coordinator, V.reporter, V.aide]) {
      await assertFails(setDoc(doc(db(u), `orgs/${ORG}/shifts/s-x`), validShift()));
      await assertFails(deleteDoc(doc(db(u), `orgs/${ORG}/shifts/s-existing`)));
      await assertFails(setDoc(doc(db(u), `orgs/${ORG}/onCallRoles/oncall-x`), validOnCall()));
    }
  });
  it('a deactivated scheduler is denied', async () => {
    await assertFails(setDoc(doc(db(V.inactiveScheduler), `orgs/${ORG}/shifts/s-x`), validShift()));
    await assertFails(deleteDoc(doc(db(V.inactiveScheduler), `orgs/${ORG}/onCallRoles/oncall-rn`)));
  });
  it('admin still writes shifts without an explicit capability', async () => {
    await assertSucceeds(setDoc(doc(db(USERS.admin), `orgs/${ORG}/shifts/s-admin`), validShift()));
  });
});

// ---------------------------------------------------------------------------
// Volunteers capability
// ---------------------------------------------------------------------------

describe('volunteers capability: assignments', () => {
  const ref = (u, id = 'va-new') => doc(db(u), `orgs/${ORG}/volunteerAssignments/${id}`);

  it('coordinator creates, updates and deletes assignments', async () => {
    await assertSucceeds(setDoc(ref(V.coordinator), validAssignment(V.coordinator)));
    await assertSucceeds(updateDoc(ref(V.coordinator, 'va-vol2'), { status: 'ended', endDate: '2026-09-30' }));
    await assertSucceeds(deleteDoc(ref(V.coordinator, 'va-vol2')));
  });
  it('coordinator writes still need the exact shape and immutable stamps', async () => {
    await assertFails(setDoc(ref(V.coordinator), validAssignment(V.coordinator, { extra: 1 })));
    await assertFails(setDoc(ref(V.coordinator), validAssignment(V.coordinator, { createdBy: USERS.admin.uid })));
    await assertFails(updateDoc(ref(V.coordinator, 'va-vol'), { createdBy: V.coordinator.uid }));
  });
  it('members without the capability cannot write assignments', async () => {
    for (const u of [USERS.rn, V.scheduler, V.volunteer]) {
      await assertFails(setDoc(ref(u), validAssignment(u)));
      await assertFails(deleteDoc(ref(u, 'va-vol')));
    }
  });
  it('coordinator reads all assignments', async () => {
    await assertSucceeds(getDocs(collection(db(V.coordinator), `orgs/${ORG}/volunteerAssignments`)));
  });
});

describe('volunteers capability: logs', () => {
  const col = (u) => collection(db(u), `orgs/${ORG}/volunteerLogs`);

  it('coordinator reads all logs', async () => {
    await assertSucceeds(getDocs(col(V.coordinator)));
    await assertSucceeds(getDoc(doc(db(V.coordinator), `orgs/${ORG}/volunteerLogs/vl-rn`)));
  });
  it('coordinator logs for any volunteer with enteredBy == self', async () => {
    await assertSucceeds(addDoc(col(V.coordinator), validLog(V.volunteer, { enteredBy: V.coordinator.uid })));
    await assertSucceeds(addDoc(col(USERS.admin), validLog(V.volunteer2, { enteredBy: USERS.admin.uid })));
  });
  it('logging for someone else without enteredBy, or with a spoofed enteredBy, is denied', async () => {
    await assertFails(addDoc(col(V.coordinator), validLog(V.volunteer)));
    await assertFails(addDoc(col(V.coordinator), validLog(V.volunteer, { enteredBy: USERS.admin.uid })));
    await assertFails(addDoc(col(V.coordinator), validLog(V.volunteer, { enteredBy: null })));
  });
  it('members without the capability cannot log for others, even with enteredBy', async () => {
    await assertFails(addDoc(col(USERS.rn), validLog(V.volunteer, { enteredBy: USERS.rn.uid })));
    await assertFails(addDoc(col(V.volunteer), validLog(V.volunteer2, { enteredBy: V.volunteer.uid })));
  });
  it('self-log: enteredBy absent or self is allowed; someone else is denied', async () => {
    await assertSucceeds(addDoc(col(V.volunteer), validLog(V.volunteer)));
    await assertSucceeds(addDoc(col(V.volunteer), validLog(V.volunteer, { enteredBy: V.volunteer.uid })));
    await assertFails(addDoc(col(V.volunteer), validLog(V.volunteer, { enteredBy: V.coordinator.uid })));
  });
  it('coordinator logs keep the rest of the shape rules', async () => {
    await assertFails(addDoc(col(V.coordinator), validLog(V.volunteer, { enteredBy: V.coordinator.uid, minutes: 0 })));
    await assertFails(addDoc(col(V.coordinator), validLog(V.volunteer, { enteredBy: V.coordinator.uid, extra: 1 })));
    await assertFails(addDoc(col(V.coordinator), validLog(V.volunteer, { enteredBy: V.coordinator.uid, createdAt: Timestamp.now() })));
    await assertFails(addDoc(col(V.coordinator), validLog({ uid: '' }, { enteredBy: V.coordinator.uid })));
  });
  it('non-capability members still cannot list all logs', async () => {
    await assertFails(getDocs(col(V.scheduler)));
    await assertSucceeds(getDocs(query(col(V.volunteer), where('volunteerUid', '==', V.volunteer.uid))));
  });
});

// ---------------------------------------------------------------------------
// Reports / audit / bereavement
// ---------------------------------------------------------------------------

describe('reports and audit capabilities', () => {
  it('reports capability reads metrics', async () => {
    await assertSucceeds(getDoc(doc(db(V.reporter), `orgs/${ORG}/metrics/2026-09-25`)));
    await assertSucceeds(getDocs(collection(db(V.reporter), `orgs/${ORG}/metrics`)));
  });
  it('audit capability reads auditLogs', async () => {
    await assertSucceeds(getDoc(doc(db(V.auditor), `orgs/${ORG}/auditLogs/log1`)));
    await assertSucceeds(getDocs(collection(db(V.auditor), `orgs/${ORG}/auditLogs`)));
  });
  it('capabilities do not leak: reports cannot read audit, audit cannot read metrics', async () => {
    await assertFails(getDoc(doc(db(V.reporter), `orgs/${ORG}/auditLogs/log1`)));
    await assertFails(getDoc(doc(db(V.auditor), `orgs/${ORG}/metrics/2026-09-25`)));
    await assertFails(getDoc(doc(db(V.scheduler), `orgs/${ORG}/metrics/2026-09-25`)));
  });
  it('capability holders still cannot write metrics or auditLogs', async () => {
    await assertFails(setDoc(doc(db(V.reporter), `orgs/${ORG}/metrics/2026-09-26`), { date: '2026-09-26' }));
    await assertFails(addDoc(collection(db(V.auditor), `orgs/${ORG}/auditLogs`), { action: 'x' }));
  });
  it('a capability granted after the fact takes effect immediately (member doc read)', async () => {
    await assertFails(getDoc(doc(db(USERS.rn), `orgs/${ORG}/metrics/2026-09-25`)));
    await env.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), `orgs/${ORG}/members/${USERS.rn.uid}`), { capabilities: ['reports'] });
    });
    await assertSucceeds(getDoc(doc(db(USERS.rn), `orgs/${ORG}/metrics/2026-09-25`)));
  });
  it('bereavement capability grants no client writes', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), `orgs/${ORG}/members/${USERS.rn.uid}`), { capabilities: ['bereavement'] });
    });
    await assertFails(setDoc(doc(db(USERS.rn), `orgs/${ORG}/bereavementPlans/b1`), { status: 'active' }));
  });
});

// ---------------------------------------------------------------------------
// Volunteer minimum-necessary
// ---------------------------------------------------------------------------

describe('volunteer minimum-necessary', () => {
  it('a volunteer reads an assigned patient', async () => {
    await assertSucceeds(getDoc(doc(db(V.volunteer), `orgs/${ORG}/patients/p2`)));
  });
  it('a volunteer cannot read an unassigned patient', async () => {
    await assertFails(getDoc(doc(db(V.volunteer), `orgs/${ORG}/patients/p1`)));
    await assertFails(getDoc(doc(db(V.volunteer2), `orgs/${ORG}/patients/p2`)));
  });
  it('a volunteer list query must filter volunteerUids array-contains uid', async () => {
    const col = collection(db(V.volunteer), `orgs/${ORG}/patients`);
    await assertSucceeds(getDocs(query(col, where('volunteerUids', 'array-contains', V.volunteer.uid))));
    await assertFails(getDocs(col));
    await assertFails(getDocs(query(col, where('status', '==', 'admitted'))));
    await assertFails(getDocs(query(col, where('volunteerUids', 'array-contains', V.volunteer2.uid))));
  });
  it('everyone else still lists patients without the filter', async () => {
    for (const u of [USERS.viewer, USERS.rn, V.aide, V.coordinator, V.volunteerAdmin]) {
      await assertSucceeds(getDocs(collection(db(u), `orgs/${ORG}/patients`)));
    }
  });
  it('a volunteer reads events and documents of an assigned patient only', async () => {
    await assertSucceeds(getDoc(doc(db(V.volunteer), `orgs/${ORG}/patients/p2/events/e1`)));
    await assertSucceeds(getDocs(collection(db(V.volunteer), `orgs/${ORG}/patients/p2/events`)));
    await assertSucceeds(getDoc(doc(db(V.volunteer), `orgs/${ORG}/patients/p2/documents/d1`)));
    await assertSucceeds(getDocs(collection(db(V.volunteer), `orgs/${ORG}/patients/p2/documents`)));
    await assertFails(getDoc(doc(db(V.volunteer), `orgs/${ORG}/patients/p1/events/e1`)));
    await assertFails(getDocs(collection(db(V.volunteer), `orgs/${ORG}/patients/p1/events`)));
    await assertFails(getDoc(doc(db(V.volunteer), `orgs/${ORG}/patients/p1/documents/d1`)));
    await assertFails(getDocs(collection(db(V.volunteer), `orgs/${ORG}/patients/p1/documents`)));
  });
  it('non-volunteers still read events and documents of any patient', async () => {
    await assertSucceeds(getDocs(collection(db(USERS.viewer), `orgs/${ORG}/patients/p1/events`)));
    await assertSucceeds(getDocs(collection(db(V.aide), `orgs/${ORG}/patients/p1/documents`)));
  });
  it('a volunteer reads only own volunteerAssignments', async () => {
    const col = collection(db(V.volunteer), `orgs/${ORG}/volunteerAssignments`);
    await assertSucceeds(getDoc(doc(db(V.volunteer), `orgs/${ORG}/volunteerAssignments/va-vol`)));
    await assertSucceeds(getDocs(query(col, where('volunteerUid', '==', V.volunteer.uid))));
    await assertFails(getDoc(doc(db(V.volunteer), `orgs/${ORG}/volunteerAssignments/va-vol2`)));
    await assertFails(getDocs(col));
  });
  it('a volunteer cannot read visits, tasks, triage calls or IDG meetings at all', async () => {
    for (const c of VOLUNTEER_BLOCKED) {
      await assertFails(getDoc(doc(db(V.volunteer), `orgs/${ORG}/${c}/x1`)));
      await assertFails(getDocs(collection(db(V.volunteer), `orgs/${ORG}/${c}`)));
    }
  });
  it('non-volunteers (viewer, aide) still read those collections', async () => {
    for (const c of VOLUNTEER_BLOCKED) {
      await assertSucceeds(getDocs(collection(db(USERS.viewer), `orgs/${ORG}/${c}`)));
      await assertSucceeds(getDoc(doc(db(V.aide), `orgs/${ORG}/${c}/x1`)));
    }
  });
  it('an admin whose discipline is Volunteer is not restricted', async () => {
    await assertSucceeds(getDoc(doc(db(V.volunteerAdmin), `orgs/${ORG}/patients/p1`)));
    await assertSucceeds(getDocs(collection(db(V.volunteerAdmin), `orgs/${ORG}/patients/p1/events`)));
    await assertSucceeds(getDocs(collection(db(V.volunteerAdmin), `orgs/${ORG}/visits`)));
    await assertSucceeds(getDocs(collection(db(V.volunteerAdmin), `orgs/${ORG}/volunteerAssignments`)));
  });
  it('unassigning (backend removes uid from volunteerUids) revokes access immediately', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), `orgs/${ORG}/patients/p2`), { volunteerUids: [] });
    });
    await assertFails(getDoc(doc(db(V.volunteer), `orgs/${ORG}/patients/p2`)));
    await assertFails(getDoc(doc(db(V.volunteer), `orgs/${ORG}/patients/p2/events/e1`)));
  });
  it('patient document files: volunteer reads assigned patient only; others unaffected', async () => {
    await assertSucceeds(getMetadata(sRef(storage(V.volunteer), DOC_FILE('p2'))));
    await assertFails(getMetadata(sRef(storage(V.volunteer), DOC_FILE('p1'))));
    await assertSucceeds(getMetadata(sRef(storage(USERS.viewer), DOC_FILE('p1'))));
    await assertSucceeds(getMetadata(sRef(storage(V.volunteerAdmin), DOC_FILE('p1'))));
  });
  it('clients cannot write volunteerUids on a patient', async () => {
    await assertFails(updateDoc(doc(db(USERS.admin), `orgs/${ORG}/patients/p1`), { volunteerUids: [V.volunteer.uid] }));
  });
});

// ---------------------------------------------------------------------------
// Org v3 settings
// ---------------------------------------------------------------------------

describe('org v3 settings', () => {
  it('admin sets deadlineLeadDaysByKind with all kinds, bounds 0 and 90', async () => {
    await assertSucceeds(updateDoc(orgRef(USERS.admin), {
      deadlineLeadDaysByKind: {
        noe: 0, recert: 90, f2f: 10, hope_admission: 3, hope_huv1: 5, hope_huv2: 5, aide_supervision: 2,
      },
    }));
    await assertSucceeds(updateDoc(orgRef(USERS.admin), { deadlineLeadDaysByKind: { recert: 14 } }));
    await assertSucceeds(updateDoc(orgRef(USERS.admin), { deadlineLeadDaysByKind: {} }));
    await assertSucceeds(updateDoc(orgRef(USERS.admin), { deadlineLeadDaysByKind: deleteField() }));
  });
  it('bad deadlineLeadDaysByKind denied', async () => {
    for (const bad of [
      { unknown_kind: 3 }, { noe: -1 }, { noe: 91 }, { recert: 2.5 }, { f2f: '3' }, { aide_supervision: null },
    ]) {
      await assertFails(updateDoc(orgRef(USERS.admin), { deadlineLeadDaysByKind: bad }));
    }
    await assertFails(updateDoc(orgRef(USERS.admin), { deadlineLeadDaysByKind: 5 }));
    await assertFails(updateDoc(orgRef(USERS.admin), { deadlineLeadDaysByKind: [1, 2] }));
  });
  it('missedVisitAlertMode accepts the four modes only', async () => {
    for (const mode of ['assignee', 'assignee_admins', 'digest', 'off']) {
      await assertSucceeds(updateDoc(orgRef(USERS.admin), { missedVisitAlertMode: mode }));
    }
    await assertSucceeds(updateDoc(orgRef(USERS.admin), { missedVisitAlertMode: deleteField() }));
    for (const bad of ['all', '', null, 1]) {
      await assertFails(updateDoc(orgRef(USERS.admin), { missedVisitAlertMode: bad }));
    }
  });
  it('defaultBereavementCoordinatorUid is null or a 1-128 char string', async () => {
    await assertSucceeds(updateDoc(orgRef(USERS.admin), { defaultBereavementCoordinatorUid: USERS.rn.uid }));
    await assertSucceeds(updateDoc(orgRef(USERS.admin), { defaultBereavementCoordinatorUid: null }));
    await assertSucceeds(updateDoc(orgRef(USERS.admin), { defaultBereavementCoordinatorUid: 'x'.repeat(128) }));
    await assertFails(updateDoc(orgRef(USERS.admin), { defaultBereavementCoordinatorUid: '' }));
    await assertFails(updateDoc(orgRef(USERS.admin), { defaultBereavementCoordinatorUid: 'x'.repeat(129) }));
    await assertFails(updateDoc(orgRef(USERS.admin), { defaultBereavementCoordinatorUid: 42 }));
  });
  it('non-admins (even capability holders) cannot change v3 settings', async () => {
    await assertFails(updateDoc(orgRef(USERS.rn), { missedVisitAlertMode: 'off' }));
    await assertFails(updateDoc(orgRef(V.scheduler), { deadlineLeadDaysByKind: { noe: 1 } }));
    await assertFails(updateDoc(orgRef(V.coordinator), { defaultBereavementCoordinatorUid: V.coordinator.uid }));
  });
  it('unknown org keys are still denied', async () => {
    await assertFails(updateDoc(orgRef(USERS.admin), { bogusSetting: true }));
  });
});

// ---------------------------------------------------------------------------
// Security review: M1, M6, L1, attachment content types
// ---------------------------------------------------------------------------

const ATT_PREFIX = `orgs/${ORG}/channels/${CHANNEL}/attachments/`;
function att(overrides = {}) {
  return { storagePath: `${ATT_PREFIX}photo.png`, contentType: 'image/png', name: 'photo.png', size: 1024, ...overrides };
}

describe('M1 senderName spoofing', () => {
  it('senderName must equal the caller member displayName', async () => {
    await assertSucceeds(addDoc(msgCol(USERS.rn), validMessage(USERS.rn, { senderName: USERS.rn.uid })));
    await assertFails(addDoc(msgCol(USERS.rn), validMessage(USERS.rn, { senderName: 'Dr. Medical Director' })));
    await assertFails(addDoc(msgCol(V.aide), validMessage(V.aide, { senderName: USERS.rn.uid })));
  });
  it('after a displayName change the new name is required', async () => {
    await assertSucceeds(updateDoc(memberRef(USERS.rn, USERS.rn.uid), { displayName: 'Rita N.' }));
    await assertFails(addDoc(msgCol(USERS.rn), validMessage(USERS.rn)));
    await assertSucceeds(addDoc(msgCol(USERS.rn), validMessage(USERS.rn, { senderName: 'Rita N.' })));
  });
});

describe('M6 bereavementPlans', () => {
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), `orgs/${ORG}/bereavementPlans/b1`), { status: 'active' });
    });
  });
  it('volunteers cannot read bereavement plans', async () => {
    await assertFails(getDoc(doc(db(V.volunteer), `orgs/${ORG}/bereavementPlans/b1`)));
    await assertFails(getDocs(collection(db(V.volunteer), `orgs/${ORG}/bereavementPlans`)));
  });
  it('staff (viewer, aide, volunteer-discipline admin) still read them', async () => {
    await assertSucceeds(getDocs(collection(db(USERS.viewer), `orgs/${ORG}/bereavementPlans`)));
    await assertSucceeds(getDoc(doc(db(V.aide), `orgs/${ORG}/bereavementPlans/b1`)));
    await assertSucceeds(getDoc(doc(db(V.volunteerAdmin), `orgs/${ORG}/bereavementPlans/b1`)));
  });
});

describe('L1 message attachments', () => {
  it('valid attachments (1 and 10) accepted', async () => {
    await assertSucceeds(addDoc(msgCol(USERS.rn), validMessage(USERS.rn, { attachments: [att()] })));
    await assertSucceeds(addDoc(msgCol(USERS.rn), validMessage(USERS.rn, {
      body: '', attachments: Array.from({ length: 10 }, (_, i) => att({ storagePath: `${ATT_PREFIX}f${i}.pdf`, contentType: 'application/pdf', name: `f${i}.pdf` })),
    })));
    await assertSucceeds(addDoc(msgCol(USERS.rn), validMessage(USERS.rn, { attachments: [att({ size: 25 * 1024 * 1024 })] })));
  });
  it('worst case fits the expression limit: aide viewer, thread reply, 10 max-size attachments', async () => {
    await assertSucceeds(addDoc(msgCol(V.aide), validMessage(V.aide, {
      threadParentId: 'm1',
      attachments: Array.from({ length: 10 }, (_, i) => att({
        storagePath: `${ATT_PREFIX}${i}-${'x'.repeat(200)}.pdf`, contentType: 'application/pdf',
        name: 'n'.repeat(200), size: 25 * 1024 * 1024,
      })),
    })));
  });
  it('more than 10 attachments denied', async () => {
    await assertFails(addDoc(msgCol(USERS.rn), validMessage(USERS.rn, { attachments: Array.from({ length: 11 }, () => att()) })));
  });
  it('extra or missing attachment keys, or non-map entries, denied', async () => {
    await assertFails(addDoc(msgCol(USERS.rn), validMessage(USERS.rn, { attachments: [att({ url: 'https://evil.test' })] })));
    const { size, ...noSize } = att();
    await assertFails(addDoc(msgCol(USERS.rn), validMessage(USERS.rn, { attachments: [noSize] })));
    await assertFails(addDoc(msgCol(USERS.rn), validMessage(USERS.rn, { attachments: ['photo.png'] })));
    // A bad entry in the last slot is caught too.
    await assertFails(addDoc(msgCol(USERS.rn), validMessage(USERS.rn, {
      attachments: [...Array.from({ length: 9 }, () => att()), att({ extra: 1 })],
    })));
  });
  it('storagePath must be under this channel\'s attachments', async () => {
    for (const storagePath of [
      `orgs/${ORG}/channels/other/attachments/photo.png`,
      `orgs/org2/channels/${CHANNEL}/attachments/photo.png`,
      `orgs/${ORG}/patients/p1/documents/d1/consent.pdf`,
      ATT_PREFIX,
      `${ATT_PREFIX}nested/photo.png`,
      `x/${ATT_PREFIX}photo.png`,
    ]) {
      await assertFails(addDoc(msgCol(USERS.rn), validMessage(USERS.rn, { attachments: [att({ storagePath })] })));
    }
  });
  it('size must be an int from 1 to 25 MB; name 1-200 chars', async () => {
    for (const bad of [
      { size: 0 }, { size: 25 * 1024 * 1024 + 1 }, { size: 10.5 }, { size: '1024' },
      { name: '' }, { name: 'x'.repeat(201) }, { name: 7 }, { name: ['a'] }, { contentType: 42 },
    ]) {
      await assertFails(addDoc(msgCol(USERS.rn), validMessage(USERS.rn, { attachments: [att(bad)] })));
    }
    await assertSucceeds(addDoc(msgCol(USERS.rn), validMessage(USERS.rn, { attachments: [att({ name: 'x'.repeat(200), size: 1 })] })));
  });
});

describe('storage: channel attachment content types', () => {
  const path = (f) => `orgs/${ORG}/channels/${CHANNEL}/attachments/${f}`;
  it('images, PDF, plain text and office documents accepted', async () => {
    for (const [f, ct] of [
      ['a.jpg', 'image/jpeg'], ['b.png', 'image/png'], ['c.pdf', 'application/pdf'], ['d.txt', 'text/plain'],
      ['e.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      ['f.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
      ['g.doc', 'application/msword'],
    ]) {
      await assertSucceeds(uploadBytes(sRef(storage(USERS.rn), path(f)), SMALL, { contentType: ct }));
    }
  });
  it('HTML, SVG and other types denied', async () => {
    for (const [f, ct] of [
      ['x.html', 'text/html'], ['x.svg', 'image/svg+xml'], ['x.js', 'application/javascript'],
      ['x.bin', 'application/octet-stream'], ['x.xhtml', 'application/xhtml+xml'],
    ]) {
      await assertFails(uploadBytes(sRef(storage(USERS.rn), path(f)), SMALL, { contentType: ct }));
    }
  });
});
