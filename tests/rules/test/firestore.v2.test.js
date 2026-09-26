// v2 rules: care-workflow collections, patient documents, volunteers,
// org settings, threads and broadcast channels (docs/DATA_MODEL.md "v2").
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import {
  addDoc, collection, deleteDoc, deleteField, doc, getDoc, getDocs, query, serverTimestamp,
  setDoc, Timestamp, updateDoc, where,
} from 'firebase/firestore';
import { as, CHANNEL, CHANNEL_MEMBERS, createEnv, ORG, OTHER_ORG, seed, USERS } from './fixtures.js';

let env;
beforeAll(async () => { env = await createEnv(); });
afterAll(async () => { await env?.cleanup(); });

const BROADCAST = 'ch-broadcast';
const SERVER_ONLY = ['visits', 'tasks', 'taskTemplates', 'bereavementPlans', 'idgMeetings', 'triageCalls'];

beforeEach(async () => {
  await env.clearFirestore();
  await seed(env);
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const now = Timestamp.now();
    for (const c of SERVER_ONLY) await setDoc(doc(db, `orgs/${ORG}/${c}/x1`), { seeded: true });
    await setDoc(doc(db, `orgs/${ORG}/patients/p1/events/e1`), {
      type: 'admission', date: '2026-09-01', recordedBy: USERS.rn.uid, createdAt: now, summary: 'Admitted', details: {},
    });
    await setDoc(doc(db, `orgs/${ORG}/patients/p1/documents/d-existing`), validDocument(USERS.rn, 'p1', 'd-existing', { createdAt: now }));
    await setDoc(doc(db, `orgs/${ORG}/metrics/2026-09-25`), { date: '2026-09-25', computedAt: now });
    await setDoc(doc(db, `orgs/${ORG}/volunteerAssignments/va1`), validAssignment(USERS.admin, { createdAt: now }));
    await setDoc(doc(db, `orgs/${ORG}/volunteerLogs/vl-rn`), validLog(USERS.rn, { createdAt: now }));
    await setDoc(doc(db, `orgs/${ORG}/volunteerLogs/vl-intake`), validLog(USERS.intake, { createdAt: now }));
    await setDoc(doc(db, `orgs/${ORG}/channels/${BROADCAST}`), {
      type: 'broadcast',
      name: 'All staff',
      memberUids: CHANNEL_MEMBERS,
      patientId: null,
      teamId: null,
      createdBy: USERS.intake.uid,
      createdAt: now,
      lastMessage: null,
      lastMessageAt: now,
      archived: false,
    });
  });
});

const db = (user) => as(env, user).firestore();
const chPath = `orgs/${ORG}/channels/${CHANNEL}`;
const bcPath = `orgs/${ORG}/channels/${BROADCAST}`;
const orgRef = (user) => doc(db(user), `orgs/${ORG}`);

function validMessage(user, overrides = {}) {
  return {
    senderUid: user.uid,
    senderName: user.uid,
    body: 'Reply in thread.',
    priority: 'normal',
    attachments: [],
    roleTarget: null,
    createdAt: serverTimestamp(),
    alertId: null,
    ...overrides,
  };
}

function validDocument(user, patientId, docId, overrides = {}) {
  const fileName = overrides.fileName ?? 'consent.pdf';
  return {
    name: 'Signed election statement',
    category: 'consent',
    fileName,
    storagePath: `orgs/${ORG}/patients/${patientId}/documents/${docId}/${fileName}`,
    contentType: 'application/pdf',
    size: 12345,
    uploadedBy: user.uid,
    createdAt: serverTimestamp(),
    ...overrides,
  };
}

function validAssignment(user, overrides = {}) {
  return {
    volunteerUid: USERS.viewer.uid,
    patientId: 'p1',
    patientName: 'Patient, Test',
    activity: 'companionship',
    status: 'active',
    startDate: '2026-09-01',
    endDate: null,
    notes: null,
    createdBy: user.uid,
    createdAt: serverTimestamp(),
    ...overrides,
  };
}

function validLog(user, overrides = {}) {
  return {
    volunteerUid: user.uid,
    patientId: 'p1',
    date: '2026-09-25',
    minutes: 90,
    activity: 'companionship',
    note: null,
    createdAt: serverTimestamp(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Server-written collections
// ---------------------------------------------------------------------------

describe('v2 server-written collections', () => {
  it('any active member (viewer too) can read visits, tasks, templates, bereavement, IDG, triage', async () => {
    for (const c of SERVER_ONLY) {
      await assertSucceeds(getDoc(doc(db(USERS.viewer), `orgs/${ORG}/${c}/x1`)));
      await assertSucceeds(getDocs(collection(db(USERS.rn), `orgs/${ORG}/${c}`)));
    }
  });
  it('other-org users cannot read them', async () => {
    for (const c of SERVER_ONLY) {
      await assertFails(getDoc(doc(db(USERS.outsider), `orgs/${ORG}/${c}/x1`)));
      await assertFails(getDocs(collection(db(USERS.outsider), `orgs/${ORG}/${c}`)));
    }
  });
  it('deactivated members cannot read them', async () => {
    for (const c of SERVER_ONLY) {
      await assertFails(getDoc(doc(db(USERS.inactive), `orgs/${ORG}/${c}/x1`)));
    }
  });
  it('unauthenticated users cannot read them', async () => {
    const anon = env.unauthenticatedContext().firestore();
    for (const c of SERVER_ONLY) await assertFails(getDoc(doc(anon, `orgs/${ORG}/${c}/x1`)));
  });
  it('no client create, even by admin', async () => {
    for (const c of SERVER_ONLY) {
      await assertFails(setDoc(doc(db(USERS.admin), `orgs/${ORG}/${c}/new`), { a: 1 }));
      await assertFails(addDoc(collection(db(USERS.rn), `orgs/${ORG}/${c}`), { a: 1 }));
    }
  });
  it('no client update or delete, even by admin', async () => {
    for (const c of SERVER_ONLY) {
      await assertFails(updateDoc(doc(db(USERS.admin), `orgs/${ORG}/${c}/x1`), { seeded: false }));
      await assertFails(deleteDoc(doc(db(USERS.admin), `orgs/${ORG}/${c}/x1`)));
    }
  });
});

describe('patient events', () => {
  it('members read; other orgs and inactive denied', async () => {
    await assertSucceeds(getDoc(doc(db(USERS.viewer), `orgs/${ORG}/patients/p1/events/e1`)));
    await assertSucceeds(getDocs(collection(db(USERS.rn), `orgs/${ORG}/patients/p1/events`)));
    await assertFails(getDoc(doc(db(USERS.outsider), `orgs/${ORG}/patients/p1/events/e1`)));
    await assertFails(getDoc(doc(db(USERS.inactive), `orgs/${ORG}/patients/p1/events/e1`)));
  });
  it('no client writes', async () => {
    await assertFails(addDoc(collection(db(USERS.admin), `orgs/${ORG}/patients/p1/events`), { type: 'death' }));
    await assertFails(updateDoc(doc(db(USERS.admin), `orgs/${ORG}/patients/p1/events/e1`), { summary: 'x' }));
    await assertFails(deleteDoc(doc(db(USERS.admin), `orgs/${ORG}/patients/p1/events/e1`)));
  });
});

describe('metrics', () => {
  it('admin reads', async () => {
    await assertSucceeds(getDoc(doc(db(USERS.admin), `orgs/${ORG}/metrics/2026-09-25`)));
    await assertSucceeds(getDocs(collection(db(USERS.admin), `orgs/${ORG}/metrics`)));
  });
  it('non-admins and other-org admins denied', async () => {
    for (const u of [USERS.rn, USERS.intake, USERS.viewer, USERS.outsider]) {
      await assertFails(getDoc(doc(db(u), `orgs/${ORG}/metrics/2026-09-25`)));
    }
  });
  it('no client writes, even by admin', async () => {
    await assertFails(setDoc(doc(db(USERS.admin), `orgs/${ORG}/metrics/2026-09-26`), { date: '2026-09-26' }));
    await assertFails(deleteDoc(doc(db(USERS.admin), `orgs/${ORG}/metrics/2026-09-25`)));
  });
});

// ---------------------------------------------------------------------------
// Patient documents
// ---------------------------------------------------------------------------

describe('patient documents', () => {
  const docRef = (user, id = 'd1', pid = 'p1') => doc(db(user), `orgs/${ORG}/patients/${pid}/documents/${id}`);

  it('clinical roles can create a valid document record', async () => {
    await assertSucceeds(setDoc(docRef(USERS.rn, 'd1'), validDocument(USERS.rn, 'p1', 'd1')));
    await assertSucceeds(setDoc(docRef(USERS.intake, 'd2'), validDocument(USERS.intake, 'p1', 'd2', { category: 'referral' })));
    await assertSucceeds(setDoc(docRef(USERS.admin, 'd3'), validDocument(USERS.admin, 'p1', 'd3', {
      fileName: 'polst.jpg', contentType: 'image/jpeg', category: 'polst',
    })));
  });
  it('viewer, inactive and other-org users cannot create', async () => {
    await assertFails(setDoc(docRef(USERS.viewer), validDocument(USERS.viewer, 'p1', 'd1')));
    await assertFails(setDoc(docRef(USERS.inactive), validDocument(USERS.inactive, 'p1', 'd1')));
    await assertFails(setDoc(docRef(USERS.outsider), validDocument(USERS.outsider, 'p1', 'd1')));
  });
  it('storagePath must match org, patient, doc id and fileName', async () => {
    const r = docRef(USERS.rn, 'd1');
    await assertFails(setDoc(r, validDocument(USERS.rn, 'p1', 'd1', { storagePath: `orgs/${ORG}/patients/p1/documents/other/consent.pdf` })));
    await assertFails(setDoc(r, validDocument(USERS.rn, 'p1', 'd1', { storagePath: `orgs/${ORG}/patients/p2/documents/d1/consent.pdf` })));
    await assertFails(setDoc(r, validDocument(USERS.rn, 'p1', 'd1', { storagePath: `orgs/${OTHER_ORG}/patients/p1/documents/d1/consent.pdf` })));
    await assertFails(setDoc(r, validDocument(USERS.rn, 'p1', 'd1', { storagePath: `orgs/${ORG}/patients/p1/documents/d1/other.pdf` })));
  });
  it('fileName must be a single path segment', async () => {
    const r = docRef(USERS.rn, 'd1');
    await assertFails(setDoc(r, validDocument(USERS.rn, 'p1', 'd1', { fileName: 'a/b.pdf' })));
    await assertFails(setDoc(r, validDocument(USERS.rn, 'p1', 'd1', { fileName: '..' })));
    await assertFails(setDoc(r, validDocument(USERS.rn, 'p1', 'd1', { fileName: '' })));
  });
  it('uploadedBy must be the caller and createdAt the server time', async () => {
    const r = docRef(USERS.rn, 'd1');
    await assertFails(setDoc(r, validDocument(USERS.rn, 'p1', 'd1', { uploadedBy: USERS.md.uid })));
    await assertFails(setDoc(r, validDocument(USERS.rn, 'p1', 'd1', { createdAt: Timestamp.now() })));
  });
  it('bad category, content type, size, extra or missing keys denied', async () => {
    const r = docRef(USERS.rn, 'd1');
    await assertFails(setDoc(r, validDocument(USERS.rn, 'p1', 'd1', { category: 'misc' })));
    await assertFails(setDoc(r, validDocument(USERS.rn, 'p1', 'd1', { contentType: 'text/html' })));
    await assertFails(setDoc(r, validDocument(USERS.rn, 'p1', 'd1', { size: 25 * 1024 * 1024 })));
    await assertFails(setDoc(r, validDocument(USERS.rn, 'p1', 'd1', { size: 0 })));
    await assertFails(setDoc(r, validDocument(USERS.rn, 'p1', 'd1', { extra: true })));
    const { name, ...missing } = validDocument(USERS.rn, 'p1', 'd1');
    await assertFails(setDoc(r, missing));
  });
  it('the patient must exist', async () => {
    await assertFails(setDoc(docRef(USERS.rn, 'd1', 'ghost'), validDocument(USERS.rn, 'ghost', 'd1')));
  });
  it('members (viewer too) read; other orgs denied', async () => {
    await assertSucceeds(getDoc(docRef(USERS.viewer, 'd-existing')));
    await assertSucceeds(getDocs(collection(db(USERS.viewer), `orgs/${ORG}/patients/p1/documents`)));
    await assertFails(getDoc(docRef(USERS.outsider, 'd-existing')));
    await assertFails(getDoc(docRef(USERS.inactive, 'd-existing')));
  });
  it('no update or delete, even by the uploader or admin', async () => {
    await assertFails(updateDoc(docRef(USERS.rn, 'd-existing'), { name: 'Renamed' }));
    await assertFails(deleteDoc(docRef(USERS.rn, 'd-existing')));
    await assertFails(deleteDoc(docRef(USERS.admin, 'd-existing')));
  });
});

// ---------------------------------------------------------------------------
// Volunteers
// ---------------------------------------------------------------------------

describe('volunteerAssignments', () => {
  const ref = (user, id = 'va2') => doc(db(user), `orgs/${ORG}/volunteerAssignments/${id}`);

  it('members read; other orgs denied', async () => {
    await assertSucceeds(getDoc(ref(USERS.viewer, 'va1')));
    await assertSucceeds(getDocs(collection(db(USERS.rn), `orgs/${ORG}/volunteerAssignments`)));
    await assertFails(getDoc(ref(USERS.outsider, 'va1')));
  });
  it('admin creates with the exact shape', async () => {
    await assertSucceeds(setDoc(ref(USERS.admin), validAssignment(USERS.admin)));
    await assertSucceeds(setDoc(ref(USERS.admin, 'va3'), validAssignment(USERS.admin, {
      activity: 'vigil', status: 'ended', endDate: '2026-09-20', notes: 'Covered nights',
    })));
  });
  it('non-admins cannot create, update or delete', async () => {
    await assertFails(setDoc(ref(USERS.rn), validAssignment(USERS.rn)));
    await assertFails(setDoc(ref(USERS.viewer), validAssignment(USERS.viewer)));
    await assertFails(updateDoc(ref(USERS.rn, 'va1'), { status: 'ended' }));
    await assertFails(deleteDoc(ref(USERS.rn, 'va1')));
    await assertFails(setDoc(ref(USERS.outsider), validAssignment(USERS.outsider)));
  });
  it('bad shape on create denied', async () => {
    const r = ref(USERS.admin);
    await assertFails(setDoc(r, validAssignment(USERS.admin, { extra: 1 })));
    await assertFails(setDoc(r, validAssignment(USERS.admin, { activity: 'gardening' })));
    await assertFails(setDoc(r, validAssignment(USERS.admin, { status: 'paused' })));
    await assertFails(setDoc(r, validAssignment(USERS.admin, { startDate: '09/01/2026' })));
    await assertFails(setDoc(r, validAssignment(USERS.admin, { endDate: '2026-08-01' })));
    await assertFails(setDoc(r, validAssignment(USERS.admin, { createdBy: USERS.rn.uid })));
    await assertFails(setDoc(r, validAssignment(USERS.admin, { createdAt: Timestamp.now() })));
    const { notes, ...missing } = validAssignment(USERS.admin);
    await assertFails(setDoc(r, missing));
  });
  it('admin updates keep createdBy/createdAt; admin deletes', async () => {
    await assertSucceeds(updateDoc(ref(USERS.admin, 'va1'), { status: 'ended', endDate: '2026-09-30' }));
    await assertFails(updateDoc(ref(USERS.admin, 'va1'), { createdBy: USERS.md.uid }));
    await assertFails(updateDoc(ref(USERS.admin, 'va1'), { createdAt: Timestamp.now() }));
    await assertFails(updateDoc(ref(USERS.admin, 'va1'), { bogus: true }));
    await assertSucceeds(deleteDoc(ref(USERS.admin, 'va1')));
  });
});

describe('volunteerLogs', () => {
  const col = (user) => collection(db(user), `orgs/${ORG}/volunteerLogs`);
  const ref = (user, id) => doc(db(user), `orgs/${ORG}/volunteerLogs/${id}`);

  it('any active member (viewer too) can log their own time', async () => {
    await assertSucceeds(addDoc(col(USERS.viewer), validLog(USERS.viewer)));
    await assertSucceeds(addDoc(col(USERS.rn), validLog(USERS.rn, { patientId: null, activity: 'admin', note: 'Mailings' })));
  });
  it('minutes must be an integer from 1 to 1440', async () => {
    await assertSucceeds(addDoc(col(USERS.rn), validLog(USERS.rn, { minutes: 1 })));
    await assertSucceeds(addDoc(col(USERS.rn), validLog(USERS.rn, { minutes: 1440 })));
    await assertFails(addDoc(col(USERS.rn), validLog(USERS.rn, { minutes: 0 })));
    await assertFails(addDoc(col(USERS.rn), validLog(USERS.rn, { minutes: 1441 })));
    await assertFails(addDoc(col(USERS.rn), validLog(USERS.rn, { minutes: 30.5 })));
    await assertFails(addDoc(col(USERS.rn), validLog(USERS.rn, { minutes: '60' })));
  });
  it('cannot log for someone else, with client time, or with a bad shape', async () => {
    await assertFails(addDoc(col(USERS.rn), validLog(USERS.rn, { volunteerUid: USERS.md.uid })));
    await assertFails(addDoc(col(USERS.rn), validLog(USERS.rn, { createdAt: Timestamp.now() })));
    await assertFails(addDoc(col(USERS.rn), validLog(USERS.rn, { date: '2026-9-5' })));
    await assertFails(addDoc(col(USERS.rn), validLog(USERS.rn, { activity: 'gardening' })));
    await assertFails(addDoc(col(USERS.rn), validLog(USERS.rn, { extra: 1 })));
    const { note, ...missing } = validLog(USERS.rn);
    await assertFails(addDoc(col(USERS.rn), missing));
  });
  it('inactive and other-org users cannot log', async () => {
    await assertFails(addDoc(col(USERS.inactive), validLog(USERS.inactive)));
    await assertFails(addDoc(col(USERS.outsider), validLog(USERS.outsider)));
  });
  it('volunteer reads own logs (doc and filtered query); not others\'', async () => {
    await assertSucceeds(getDoc(ref(USERS.rn, 'vl-rn')));
    await assertSucceeds(getDocs(query(col(USERS.rn), where('volunteerUid', '==', USERS.rn.uid))));
    await assertFails(getDoc(ref(USERS.rn, 'vl-intake')));
    await assertFails(getDocs(col(USERS.rn)));
  });
  it('admin reads all logs; other-org admin denied', async () => {
    await assertSucceeds(getDoc(ref(USERS.admin, 'vl-intake')));
    await assertSucceeds(getDocs(col(USERS.admin)));
    await assertFails(getDoc(ref(USERS.outsider, 'vl-rn')));
  });
  it('no update or delete, even own or by admin', async () => {
    await assertFails(updateDoc(ref(USERS.rn, 'vl-rn'), { minutes: 120 }));
    await assertFails(deleteDoc(ref(USERS.rn, 'vl-rn')));
    await assertFails(deleteDoc(ref(USERS.admin, 'vl-rn')));
  });
});

// ---------------------------------------------------------------------------
// Existing collections: org settings, threads, broadcast
// ---------------------------------------------------------------------------

describe('org v2 settings', () => {
  it('admin sets all v2 settings within range', async () => {
    await assertSucceeds(updateDoc(orgRef(USERS.admin), {
      triageRoleKey: 'oncall-rn-north', idgCadenceDays: 14, missedVisitGraceMinutes: 60, messageLifespanDays: 365,
    }));
    await assertSucceeds(updateDoc(orgRef(USERS.admin), { triageRoleKey: null, messageLifespanDays: null }));
  });
  it('range boundaries are accepted', async () => {
    await assertSucceeds(updateDoc(orgRef(USERS.admin), { idgCadenceDays: 1, missedVisitGraceMinutes: 15, messageLifespanDays: 7 }));
    await assertSucceeds(updateDoc(orgRef(USERS.admin), { idgCadenceDays: 30, missedVisitGraceMinutes: 1440, messageLifespanDays: 3650 }));
  });
  it('out-of-range or mistyped values denied', async () => {
    for (const bad of [
      { idgCadenceDays: 0 }, { idgCadenceDays: 31 }, { idgCadenceDays: 'fifteen' }, { idgCadenceDays: 14.5 },
      { missedVisitGraceMinutes: 14 }, { missedVisitGraceMinutes: 1441 },
      { messageLifespanDays: 6 }, { messageLifespanDays: 3651 }, { messageLifespanDays: '30' },
      { triageRoleKey: '' }, { triageRoleKey: 42 },
    ]) {
      await assertFails(updateDoc(orgRef(USERS.admin), bad));
    }
  });
  it('admin may remove a v2 setting (back to its default)', async () => {
    await assertSucceeds(updateDoc(orgRef(USERS.admin), { idgCadenceDays: 10 }));
    await assertSucceeds(updateDoc(orgRef(USERS.admin), { idgCadenceDays: deleteField() }));
  });
  it('non-admins cannot change v2 settings', async () => {
    await assertFails(updateDoc(orgRef(USERS.rn), { idgCadenceDays: 10 }));
    await assertFails(updateDoc(orgRef(USERS.outsider), { messageLifespanDays: 30 }));
  });
});

describe('message threads', () => {
  const col = (user) => collection(db(user), `${chPath}/messages`);

  it('threadParentId may be a string or null, or omitted', async () => {
    await assertSucceeds(addDoc(col(USERS.rn), validMessage(USERS.rn, { threadParentId: 'm1' })));
    await assertSucceeds(addDoc(col(USERS.rn), validMessage(USERS.rn, { threadParentId: null })));
    await assertSucceeds(addDoc(col(USERS.intake), validMessage(USERS.intake)));
  });
  it('bad threadParentId type or empty string denied', async () => {
    await assertFails(addDoc(col(USERS.rn), validMessage(USERS.rn, { threadParentId: 42 })));
    await assertFails(addDoc(col(USERS.rn), validMessage(USERS.rn, { threadParentId: '' })));
    await assertFails(addDoc(col(USERS.rn), validMessage(USERS.rn, { threadParentId: ['m1'] })));
  });
  it('backend-maintained v2 fields cannot be set by clients', async () => {
    await assertFails(addDoc(col(USERS.rn), validMessage(USERS.rn, { replyCount: 0 })));
    await assertFails(addDoc(col(USERS.rn), validMessage(USERS.rn, { lastReplyAt: null })));
    await assertFails(addDoc(col(USERS.rn), validMessage(USERS.rn, { recalledAt: null })));
  });
  it('thread replies still require the 8 base fields', async () => {
    const { roleTarget, ...missing } = validMessage(USERS.rn, { threadParentId: 'm1' });
    await assertFails(addDoc(col(USERS.rn), missing));
  });
  it('thread replies to an archived channel are denied', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), chPath), { archived: true });
    });
    await assertFails(addDoc(col(USERS.rn), validMessage(USERS.rn, { threadParentId: 'm1' })));
  });
});

describe('broadcast channels', () => {
  const col = (user) => collection(db(user), `${bcPath}/messages`);

  it('the creator can post', async () => {
    await assertSucceeds(addDoc(col(USERS.intake), validMessage(USERS.intake, { priority: 'urgent' })));
  });
  it('other members cannot post or reply in a thread', async () => {
    await assertFails(addDoc(col(USERS.rn), validMessage(USERS.rn)));
    await assertFails(addDoc(col(USERS.rn), validMessage(USERS.rn, { threadParentId: 'm1' })));
  });
  it('members can read broadcast messages', async () => {
    await assertSucceeds(getDocs(col(USERS.rn)));
    await assertSucceeds(getDocs(col(USERS.viewer)));
  });
  it('the creator cannot post once the channel is archived', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), bcPath), { archived: true });
    });
    await assertFails(addDoc(col(USERS.intake), validMessage(USERS.intake)));
  });
});
