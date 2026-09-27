// v4 messaging rules (docs/DATA_MODEL.md "v4: messaging" → Access): message templates,
// channel prefs, broadcast acks, reactions, reminders, messageEdits and the member
// self-update allowlist (status, outOfOffice, notificationSettings).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import {
  collection, deleteDoc, deleteField, doc, getDoc, getDocs, query, serverTimestamp, setDoc, Timestamp, updateDoc, where,
} from 'firebase/firestore';
import { as, CHANNEL, createEnv, ORG, seed, seedV3, USERS, V3_USERS } from './fixtures.js';

let env;
beforeAll(async () => { env = await createEnv(); });
afterAll(async () => { await env?.cleanup(); });

const V = V3_USERS;
const db = (user) => as(env, user).firestore();
const ch = `orgs/${ORG}/channels/${CHANNEL}`;
const BCAST = 'bc-ack';
const BCAST_NOACK = 'bc-noack';
const REACTIONS = ['👍', '✅', '❤️', '🙏', '👀', '❗'];
const later = () => Timestamp.fromMillis(Date.now() + 3_600_000);

beforeEach(async () => {
  await env.clearFirestore();
  await seed(env);
  await seedV3(env);
  await env.withSecurityRulesDisabled(async (ctx) => {
    const fs = ctx.firestore();
    const now = Timestamp.now();
    // Aide (field staff, role viewer) joins the care channel so reactions by a posting viewer can be tested.
    await updateDoc(doc(fs, ch), { memberUids: [USERS.rn.uid, USERS.intake.uid, USERS.viewer.uid, USERS.inactive.uid, V.aide.uid] });
    const bc = (id, requireAck) => setDoc(doc(fs, `orgs/${ORG}/channels/${id}`), {
      type: 'broadcast', name: 'Policy', memberUids: [USERS.admin.uid, USERS.rn.uid, USERS.viewer.uid], patientId: null, teamId: null,
      createdBy: USERS.admin.uid, createdAt: now, lastMessage: null, lastMessageAt: now, archived: false, requireAck,
    });
    await bc(BCAST, true);
    await bc(BCAST_NOACK, false);
    await setDoc(doc(fs, `orgs/${ORG}/channels/${BCAST}/acks/${USERS.viewer.uid}`), { messageId: 'bm1', ackedAt: now });
    await setDoc(doc(fs, `${ch}/prefs/${USERS.intake.uid}`), { mode: 'mentions', mutedUntil: null, updatedAt: now });
    await setDoc(doc(fs, `${ch}/messages/m1/reactions/${USERS.intake.uid}`), { emoji: '👍', at: now });
    await setDoc(doc(fs, `orgs/${ORG}/messageTemplates/default-sbar`), { title: 'SBAR', body: 'S {{S}}', active: true });
    await setDoc(doc(fs, `orgs/${ORG}/members/${USERS.rn.uid}/templates/t1`), { title: 'Mine', body: 'x', active: true });
    await setDoc(doc(fs, `orgs/${ORG}/reminders/r1`), { channelId: CHANNEL, messageId: 'm1', ownerUid: USERS.rn.uid, dueAt: now, status: 'pending' });
    await setDoc(doc(fs, `orgs/${ORG}/messageEdits/e1`), { channelId: CHANNEL, messageId: 'm1', previousBody: 'old', editedBy: USERS.rn.uid, editedAt: now });
  });
});

// ---------------------------------------------------------------------------
describe('messageTemplates (org)', () => {
  const path = `orgs/${ORG}/messageTemplates/default-sbar`;

  it('staff read; volunteers, inactive members and outsiders do not', async () => {
    for (const u of [USERS.admin, USERS.rn, USERS.viewer, USERS.intake, V.aide, V.volunteerAdmin]) {
      await assertSucceeds(getDoc(doc(db(u), path)));
    }
    await assertSucceeds(getDocs(collection(db(USERS.rn), `orgs/${ORG}/messageTemplates`)));
    await assertFails(getDoc(doc(db(V.volunteer), path)));
    await assertFails(getDocs(collection(db(V.volunteer), `orgs/${ORG}/messageTemplates`)));
    await assertFails(getDoc(doc(db(USERS.inactive), path)));
    await assertFails(getDoc(doc(db(USERS.outsider), path)));
  });

  it('no client writes, even for admins', async () => {
    await assertFails(setDoc(doc(db(USERS.admin), `orgs/${ORG}/messageTemplates/new`), { title: 'x' }));
    await assertFails(updateDoc(doc(db(USERS.admin), path), { title: 'y' }));
    await assertFails(deleteDoc(doc(db(USERS.admin), path)));
  });
});

describe('members/{uid}/templates (personal)', () => {
  const path = `orgs/${ORG}/members/${USERS.rn.uid}/templates/t1`;

  it('only the owner reads', async () => {
    await assertSucceeds(getDoc(doc(db(USERS.rn), path)));
    await assertSucceeds(getDocs(collection(db(USERS.rn), `orgs/${ORG}/members/${USERS.rn.uid}/templates`)));
    await assertFails(getDoc(doc(db(USERS.admin), path)));
    await assertFails(getDoc(doc(db(USERS.md), path)));
    await assertFails(getDocs(collection(db(USERS.md), `orgs/${ORG}/members/${USERS.rn.uid}/templates`)));
  });

  it('no client writes, even by the owner', async () => {
    await assertFails(setDoc(doc(db(USERS.rn), `orgs/${ORG}/members/${USERS.rn.uid}/templates/t2`), { title: 'x' }));
    await assertFails(updateDoc(doc(db(USERS.rn), path), { title: 'y' }));
    await assertFails(deleteDoc(doc(db(USERS.rn), path)));
  });
});

// ---------------------------------------------------------------------------
describe('channels/{cid}/prefs/{uid}', () => {
  const prefs = (u) => doc(db(u), `${ch}/prefs/${u.uid}`);
  const ok = (over = {}) => ({ mode: 'mentions', mutedUntil: null, updatedAt: serverTimestamp(), ...over });

  it('a channel member writes exactly {mode, mutedUntil, updatedAt == request.time}', async () => {
    await assertSucceeds(setDoc(prefs(USERS.rn), ok()));
    await assertSucceeds(setDoc(prefs(USERS.rn), ok({ mode: 'all', mutedUntil: later() })));
    await assertSucceeds(setDoc(prefs(USERS.rn), ok({ mode: 'urgent_only' })));
    await assertSucceeds(updateDoc(prefs(USERS.intake), { mode: 'all', updatedAt: serverTimestamp() }));
    await assertSucceeds(setDoc(prefs(USERS.viewer), ok())); // viewers may mute their channels too
  });

  it('rejects bad shapes', async () => {
    await assertFails(setDoc(prefs(USERS.rn), ok({ mode: 'never' })));
    await assertFails(setDoc(prefs(USERS.rn), ok({ mutedUntil: 'tomorrow' })));
    await assertFails(setDoc(prefs(USERS.rn), ok({ updatedAt: Timestamp.fromMillis(0) })));
    await assertFails(setDoc(prefs(USERS.rn), ok({ extra: true })));
    await assertFails(setDoc(prefs(USERS.rn), { mode: 'all', updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(prefs(USERS.intake), { mode: 'all' })); // updatedAt must be request.time
  });

  it('self only, channel members only; no delete', async () => {
    await assertFails(setDoc(doc(db(USERS.rn), `${ch}/prefs/${USERS.intake.uid}`), ok()));
    await assertFails(setDoc(prefs(USERS.md), ok())); // not a channel member
    await assertFails(setDoc(prefs(USERS.admin), ok()));
    await assertFails(setDoc(prefs(USERS.inactive), ok()));
    await assertFails(deleteDoc(prefs(USERS.intake)));
  });

  it('only the owner reads', async () => {
    await assertSucceeds(getDoc(prefs(USERS.intake)));
    await assertFails(getDoc(doc(db(USERS.rn), `${ch}/prefs/${USERS.intake.uid}`)));
    await assertFails(getDocs(collection(db(USERS.rn), `${ch}/prefs`)));
    await assertFails(getDoc(doc(db(USERS.admin), `${ch}/prefs/${USERS.intake.uid}`)));
  });
});

// ---------------------------------------------------------------------------
describe('channels/{cid}/acks/{uid}', () => {
  const ack = (u, cid = BCAST) => doc(db(u), `orgs/${ORG}/channels/${cid}/acks/${u.uid}`);

  it('a member of an ack-required broadcast creates exactly {messageId, ackedAt == request.time}', async () => {
    await assertSucceeds(setDoc(ack(USERS.rn), { messageId: 'bm1', ackedAt: serverTimestamp() }));
  });

  it('rejects bad shapes, other uids, non-members, and channels without requireAck', async () => {
    await assertFails(setDoc(ack(USERS.rn), { messageId: 'bm1', ackedAt: Timestamp.fromMillis(0) }));
    await assertFails(setDoc(ack(USERS.rn), { messageId: '', ackedAt: serverTimestamp() }));
    await assertFails(setDoc(ack(USERS.rn), { messageId: 'bm1', ackedAt: serverTimestamp(), note: 'x' }));
    await assertFails(setDoc(ack(USERS.rn), { ackedAt: serverTimestamp() }));
    await assertFails(setDoc(doc(db(USERS.rn), `orgs/${ORG}/channels/${BCAST}/acks/${USERS.admin.uid}`), { messageId: 'bm1', ackedAt: serverTimestamp() }));
    await assertFails(setDoc(ack(USERS.md), { messageId: 'bm1', ackedAt: serverTimestamp() }));
    await assertFails(setDoc(ack(USERS.rn, BCAST_NOACK), { messageId: 'bm1', ackedAt: serverTimestamp() }));
    await assertFails(setDoc(ack(USERS.rn, CHANNEL), { messageId: 'm1', ackedAt: serverTimestamp() }));
  });

  it('create only: no update or delete', async () => {
    await assertFails(setDoc(ack(USERS.viewer), { messageId: 'bm2', ackedAt: serverTimestamp() }));
    await assertFails(updateDoc(ack(USERS.viewer), { ackedAt: serverTimestamp() }));
    await assertFails(deleteDoc(ack(USERS.viewer)));
  });

  it('channel members read (the sender sees who acked); others do not', async () => {
    await assertSucceeds(getDocs(collection(db(USERS.admin), `orgs/${ORG}/channels/${BCAST}/acks`)));
    await assertSucceeds(getDoc(ack(USERS.viewer)));
    await assertFails(getDocs(collection(db(USERS.md), `orgs/${ORG}/channels/${BCAST}/acks`)));
  });
});

// ---------------------------------------------------------------------------
describe('messages/{mid}/reactions/{uid}', () => {
  const r = (u) => doc(db(u), `${ch}/messages/m1/reactions/${u.uid}`);

  it('a member who can post sets, changes and removes their own reaction (every allowed emoji)', async () => {
    for (const emoji of REACTIONS) await assertSucceeds(setDoc(r(USERS.rn), { emoji, at: serverTimestamp() }));
    await assertSucceeds(updateDoc(r(USERS.intake), { emoji: '✅', at: serverTimestamp() }));
    await assertSucceeds(deleteDoc(r(USERS.intake)));
    await assertSucceeds(setDoc(r(V.aide), { emoji: '🙏', at: serverTimestamp() })); // field-staff viewer can post
  });

  it('rejects other emoji, bad shapes and stale times', async () => {
    for (const emoji of ['💩', '👍🏽', 'ok', '', '❤']) await assertFails(setDoc(r(USERS.rn), { emoji, at: serverTimestamp() }));
    await assertFails(setDoc(r(USERS.rn), { emoji: '👍', at: Timestamp.fromMillis(0) }));
    await assertFails(setDoc(r(USERS.rn), { emoji: '👍' }));
    await assertFails(setDoc(r(USERS.rn), { emoji: '👍', at: serverTimestamp(), count: 5 }));
  });

  it('self only; members who cannot post, non-members and inactive members are refused', async () => {
    await assertFails(setDoc(doc(db(USERS.rn), `${ch}/messages/m1/reactions/${USERS.intake.uid}`), { emoji: '👍', at: serverTimestamp() }));
    await assertFails(deleteDoc(doc(db(USERS.rn), `${ch}/messages/m1/reactions/${USERS.intake.uid}`)));
    await assertFails(setDoc(r(USERS.viewer), { emoji: '👍', at: serverTimestamp() })); // viewer (not field staff)
    await assertFails(setDoc(r(USERS.md), { emoji: '👍', at: serverTimestamp() }));
    await assertFails(setDoc(r(USERS.inactive), { emoji: '👍', at: serverTimestamp() }));
  });

  it('channel members read', async () => {
    await assertSucceeds(getDocs(collection(db(USERS.viewer), `${ch}/messages/m1/reactions`)));
    await assertFails(getDocs(collection(db(USERS.md), `${ch}/messages/m1/reactions`)));
  });

  it('message.reactionCounts and the other v4 message fields stay server-only', async () => {
    await assertFails(updateDoc(doc(db(USERS.rn), `${ch}/messages/m1`), { reactionCounts: { '👍': 9 } }));
    await assertFails(setDoc(doc(db(USERS.rn), `${ch}/messages/m9`), {
      senderUid: USERS.rn.uid, senderName: USERS.rn.uid, body: 'x', priority: 'normal', attachments: [], roleTarget: null,
      createdAt: serverTimestamp(), alertId: null, mentions: [USERS.intake.uid],
    }));
  });
});

// ---------------------------------------------------------------------------
describe('reminders and messageEdits', () => {
  it('reminders: the owner reads (and lists their own); nobody writes', async () => {
    await assertSucceeds(getDoc(doc(db(USERS.rn), `orgs/${ORG}/reminders/r1`)));
    await assertSucceeds(getDocs(query(collection(db(USERS.rn), `orgs/${ORG}/reminders`), where('ownerUid', '==', USERS.rn.uid))));
    await assertFails(getDoc(doc(db(USERS.admin), `orgs/${ORG}/reminders/r1`)));
    await assertFails(getDocs(collection(db(USERS.rn), `orgs/${ORG}/reminders`)));
    await assertFails(setDoc(doc(db(USERS.rn), `orgs/${ORG}/reminders/r2`), { ownerUid: USERS.rn.uid }));
    await assertFails(updateDoc(doc(db(USERS.rn), `orgs/${ORG}/reminders/r1`), { status: 'cancelled' }));
    await assertFails(deleteDoc(doc(db(USERS.rn), `orgs/${ORG}/reminders/r1`)));
  });

  it('messageEdits: admin or the audit capability read; not even the editor; no writes', async () => {
    await assertSucceeds(getDoc(doc(db(USERS.admin), `orgs/${ORG}/messageEdits/e1`)));
    await assertSucceeds(getDocs(collection(db(V.auditor), `orgs/${ORG}/messageEdits`)));
    await assertFails(getDoc(doc(db(USERS.rn), `orgs/${ORG}/messageEdits/e1`)));
    await assertFails(getDoc(doc(db(V.reporter), `orgs/${ORG}/messageEdits/e1`)));
    await assertFails(setDoc(doc(db(USERS.admin), `orgs/${ORG}/messageEdits/e2`), { previousBody: 'x' }));
    await assertFails(deleteDoc(doc(db(USERS.admin), `orgs/${ORG}/messageEdits/e1`)));
  });
});

// ---------------------------------------------------------------------------
describe('members/{uid} self-update: status, outOfOffice, notificationSettings', () => {
  const me = (u = USERS.rn) => doc(db(u), `orgs/${ORG}/members/${u.uid}`);
  const status = (over = {}) => ({ state: 'in_visit', text: 'Back at 3', until: later(), ...over });
  const ooo = (over = {}) => ({ until: later(), delegateUid: USERS.md.uid, note: 'Vacation', ...over });
  const settings = (over = {}) => ({ quietHours: { start: '22:00', end: '07:00' }, offShiftQuiet: true, ...over });

  it('accepts valid values, nulls (clear) and removal', async () => {
    for (const state of ['available', 'in_visit', 'busy', 'off']) await assertSucceeds(updateDoc(me(), { status: status({ state }) }));
    await assertSucceeds(updateDoc(me(), { status: status({ text: null, until: null }) }));
    await assertSucceeds(updateDoc(me(), { status: status({ text: 'x'.repeat(100) }) }));
    await assertSucceeds(updateDoc(me(), { outOfOffice: ooo() }));
    await assertSucceeds(updateDoc(me(), { outOfOffice: ooo({ delegateUid: null, note: null }) }));
    await assertSucceeds(updateDoc(me(), { outOfOffice: ooo({ note: 'x'.repeat(500) }) }));
    await assertSucceeds(updateDoc(me(), { notificationSettings: settings() }));
    await assertSucceeds(updateDoc(me(), { notificationSettings: settings({ quietHours: null, offShiftQuiet: false }) }));
    await assertSucceeds(updateDoc(me(), { notificationSettings: settings({ quietHours: { start: '00:00', end: '23:59' } }) }));
    await assertSucceeds(updateDoc(me(), { status: null, outOfOffice: null, notificationSettings: null }));
    await assertSucceeds(updateDoc(me(), { status: deleteField(), outOfOffice: deleteField(), notificationSettings: deleteField() }));
    // Together with the existing self-writable fields.
    await assertSucceeds(updateDoc(me(), { fcmTokens: ['web-token'], status: status() }));
    await assertSucceeds(updateDoc(me(V.volunteer), { status: status() }));
  });

  it('rejects malformed status', async () => {
    for (const bad of [
      status({ state: 'away' }), status({ text: 'x'.repeat(101) }), status({ text: 5 }), status({ until: 'soon' }),
      { state: 'busy', text: null }, { ...status(), extra: 1 }, 'busy', ['busy'],
    ]) await assertFails(updateDoc(me(), { status: bad }));
  });

  it('rejects malformed outOfOffice', async () => {
    for (const bad of [
      ooo({ until: null }), ooo({ until: '2026-10-01' }), ooo({ delegateUid: '' }), ooo({ delegateUid: 7 }),
      ooo({ note: 'x'.repeat(501) }), { until: later(), delegateUid: null }, { ...ooo(), extra: 1 }, true,
    ]) await assertFails(updateDoc(me(), { outOfOffice: bad }));
  });

  it('rejects malformed notificationSettings', async () => {
    for (const bad of [
      settings({ offShiftQuiet: 'yes' }), settings({ quietHours: { start: '24:00', end: '07:00' } }),
      settings({ quietHours: { start: '7:00', end: '08:00' } }), settings({ quietHours: { start: '22:00' } }),
      settings({ quietHours: { start: '22:00', end: '07:00', tz: 'UTC' } }), settings({ quietHours: '22:00-07:00' }),
      { quietHours: null }, { ...settings(), extra: 1 },
    ]) await assertFails(updateDoc(me(), { notificationSettings: bad }));
  });

  it('still cannot touch role, capabilities, discipline, active or teamIds, or anyone else’s doc', async () => {
    await assertFails(updateDoc(me(), { status: status(), role: 'admin' }));
    await assertFails(updateDoc(me(), { outOfOffice: ooo(), capabilities: ['audit'] }));
    await assertFails(updateDoc(me(), { notificationSettings: settings(), discipline: 'MD' }));
    await assertFails(updateDoc(me(), { status: status(), active: false }));
    await assertFails(updateDoc(me(), { status: status(), teamIds: ['t1'] }));
    await assertFails(updateDoc(doc(db(USERS.md), `orgs/${ORG}/members/${USERS.rn.uid}`), { status: status() }));
    await assertFails(updateDoc(me(USERS.inactive), { status: status() }));
  });

  it('admins may set them on any member, shape-validated', async () => {
    await assertSucceeds(updateDoc(doc(db(USERS.admin), `orgs/${ORG}/members/${USERS.rn.uid}`), { outOfOffice: ooo() }));
    await assertFails(updateDoc(doc(db(USERS.admin), `orgs/${ORG}/members/${USERS.rn.uid}`), { outOfOffice: ooo({ until: 'x' }) }));
    await assertFails(updateDoc(doc(db(USERS.admin), `orgs/${ORG}/members/${USERS.rn.uid}`), { status: { state: 'gone' } }));
  });

  it('the stored values read back as written', async () => {
    await updateDoc(me(), { notificationSettings: settings() });
    const snap = await getDoc(me());
    expect(snap.data().notificationSettings).toEqual({ quietHours: { start: '22:00', end: '07:00' }, offShiftQuiet: true });
  });
});
