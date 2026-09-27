/**
 * v3 on-call, messaging, triage, handoff and IDG (PERSONA_REVIEW O2–O5, S6, F5, H3, M3, M4, L6).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('firebase-admin/firestore', () => import('../fakes/firestore'));
vi.mock('../../src/lib/notify', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/notify')>()),
  pushToMembers: vi.fn(async () => ({ sent: 1, failed: 0, pruned: 0 })),
}));
vi.mock('../../src/lib/tasks', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/tasks')>()),
  enqueueEscalationCheck: vi.fn(async () => undefined),
}));
vi.mock('../../src/lib/storageFiles', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/storageFiles')>()),
  deleteStorageObjects: vi.fn(async (p: readonly string[]) => p.length),
}));

import { fakeDb, Timestamp } from '../fakes/firestore';
import { pushToMembers } from '../../src/lib/notify';
import { enforceRateLimit, takeToken } from '../../src/lib/rateLimit';
import { searchMessagesHandler } from '../../src/messaging/searchMessages';
import { sendBroadcastHandler } from '../../src/messaging/sendBroadcast';
import { updateChannelMembersHandler } from '../../src/messaging/updateChannelMembers';
import { ackMessageAlertsOnReply, handleMessageCreated, messageAlertId } from '../../src/messaging/onMessageCreated';
import { joinPatientChannelForCoverageHandler, runCoverageExpiry } from '../../src/messaging/coverage';
import { channelCutoffMs, patientPurgeCutoffMs, runMessagePurge } from '../../src/messaging/purgeExpiredMessages';
import { alertActionHandler, RESOLVED_FROM_ALERT_NOTE } from '../../src/alerts/alertActions';
import { assignTriageCallHandler, logTriageCallHandler, resolveTriageCallHandler, ROUTINE_TRIAGE_ALERT_TITLE, triageAlertId } from '../../src/triage/triage';
import { generateHandoffHandler, inHandoffWindow } from '../../src/ai/generateHandoff';
import { generateIdgPrepHandler } from '../../src/ai/generateIdgPrep';
import {
  completeIdgMeetingHandler,
  idgTaskId,
  missingDisciplineWarnings,
  saveIdgDisciplineNoteHandler,
  saveIdgNoteHandler,
  updateIdgMeetingHandler,
} from '../../src/idg/idg';
import type { Message } from '../../src/shared/types';

type TextGen = { calls: Array<{ prompt: string }>; generate: (input: { prompt: string }) => Promise<{ text: string; model: string }> };
import { docsIn, member, ORG, req, seedOrg } from './helpers';

const H = 3_600_000;
const DAY = 24 * H;
const P = (id: string) => `orgs/${ORG}/patients/${id}`;
const CH = (id: string) => `orgs/${ORG}/channels/${id}`;
const audit = (action: string) => docsIn(`orgs/${ORG}/auditLogs`).filter((l) => l.data.action === action);

function msg(over: Partial<Message> = {}): Message {
  return {
    senderUid: 'b', senderName: 'User B', body: 'hello', priority: 'normal', attachments: [], roleTarget: null,
    createdAt: Timestamp.now(), alertId: null, ...over,
  } as Message;
}

function seedChannel(id: string, over: Record<string, unknown> = {}) {
  fakeDb.seed(CH(id), {
    type: 'group', name: `Channel ${id}`, memberUids: ['a', 'b', 'c'], patientId: null, teamId: null, createdBy: 'a',
    createdAt: Timestamp.fromMillis(0), lastMessage: null, lastMessageAt: Timestamp.now(), archived: false, ...over,
  });
}

function seedPatient(id: string, over: Record<string, unknown> = {}) {
  fakeDb.seed(P(id), {
    firstName: 'Ann', lastName: `Lee-${id}`, status: 'admitted', levelOfCare: 'routine', careTeamUids: ['b'], channelId: `pc_${id}`,
    primaryDiagnosis: null, codeStatus: 'DNR', milestones: null, remindedMilestones: [], ...over,
  });
  seedChannel(`pc_${id}`, { type: 'patient', name: `Lee-${id} – Care Team`, memberUids: ['b'], patientId: id });
}

function fakeGenerator(reply = 'TEXT'): TextGen {
  const calls: Array<{ prompt: string }> = [];
  return { calls, generate: vi.fn(async (input: { prompt: string }) => { calls.push(input); return { text: reply, model: 'gemini-test' }; }) };
}

beforeEach(() => {
  seedOrg();
  vi.mocked(pushToMembers).mockClear();
  fakeDb.seed(`orgs/${ORG}/members/d`, member('d'));
});

describe('M4 rate limits', () => {
  it('token bucket refills continuously and refuses when empty', () => {
    const rule = { capacity: 2, perMinute: 2 };
    expect(takeToken(null, rule, 0)).toBe(1);
    expect(takeToken({ tokens: 0.5, refilledAtMs: 0 }, rule, 0)).toBeNull();
    expect(takeToken({ tokens: 0, refilledAtMs: 0 }, rule, 30_000)).toBe(0); // +1 token after 30 s
    expect(takeToken({ tokens: 2, refilledAtMs: 0 }, rule, 10 * 60_000)).toBe(1); // capped at capacity
  });

  it('searchMessages allows 30 calls a minute per user, then resource-exhausted; buckets are per user', async () => {
    seedChannel('ch1');
    const now = new Date();
    for (let i = 0; i < 29; i++) await enforceRateLimit(ORG, 'b', 'searchMessages', now);
    await searchMessagesHandler(req({ orgId: ORG, query: 'abc' }, { uid: 'b' }));
    await expect(searchMessagesHandler(req({ orgId: ORG, query: 'abc' }, { uid: 'b' }))).rejects.toMatchObject({ code: 'resource-exhausted' });
    await searchMessagesHandler(req({ orgId: ORG, query: 'abc' }, { uid: 'c' }));
    expect(fakeDb.read<any>(`orgs/${ORG}/rateLimits/b_searchMessages`)).toMatchObject({ uid: 'b', action: 'searchMessages' });
  });

  it('critical broadcasts are admin-only; sendBroadcast is rate limited', async () => {
    const body = { orgId: ORG, name: 'x', target: { kind: 'all' as const }, body: 'hi', priority: 'critical' as const };
    await expect(sendBroadcastHandler(req(body, { uid: 'b' }))).rejects.toMatchObject({ code: 'permission-denied' });
    await sendBroadcastHandler(req(body, { uid: 'a', role: 'admin' }));
    for (let i = 0; i < 9; i++) await sendBroadcastHandler(req({ ...body, priority: 'normal' }, { uid: 'a', role: 'admin' }));
    await expect(sendBroadcastHandler(req({ ...body, priority: 'normal' }, { uid: 'a', role: 'admin' }))).rejects.toMatchObject({ code: 'resource-exhausted' });
  });
});

describe('L6 updateChannelMembers', () => {
  it('rejects broadcast and archived channels', async () => {
    seedChannel('bc', { type: 'broadcast', memberUids: ['a', 'b'] });
    seedChannel('arch', { archived: true });
    await expect(updateChannelMembersHandler(req({ orgId: ORG, channelId: 'bc', add: ['c'] }, { uid: 'a', role: 'admin' }))).rejects.toMatchObject({ code: 'failed-precondition' });
    await expect(updateChannelMembersHandler(req({ orgId: ORG, channelId: 'arch', add: ['d'] }, { uid: 'b' }))).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('patient channels: only admins or the care team', async () => {
    seedPatient('p1', { careTeamUids: ['b'] });
    await fakeDb.doc(CH('pc_p1')).update({ memberUids: ['b', 'c'] });
    await expect(updateChannelMembersHandler(req({ orgId: ORG, channelId: 'pc_p1', add: ['d'] }, { uid: 'c' }))).rejects.toMatchObject({ code: 'permission-denied' });
    await updateChannelMembersHandler(req({ orgId: ORG, channelId: 'pc_p1', add: ['d'] }, { uid: 'b' }));
    expect(fakeDb.read<any>(CH('pc_p1'))!.memberUids).toContain('d');
  });
});

describe('O2 acknowledge from chat', () => {
  it('a reply in the channel acks the replier’s open urgent-message alert only', async () => {
    seedChannel('ch1');
    const urgent = msg({ senderUid: 'b', priority: 'urgent' });
    fakeDb.seed(`${CH('ch1')}/messages/m1`, urgent);
    await handleMessageCreated(ORG, 'ch1', 'm1', urgent);
    const alertId = messageAlertId('ch1', 'm1');
    expect(fakeDb.read<any>(`orgs/${ORG}/alerts/${alertId}`)).toMatchObject({ status: 'open', currentTargetUids: ['a', 'c'] });

    // The sender's own follow-up doesn't ack (they are not a target).
    await handleMessageCreated(ORG, 'ch1', 'm2', msg({ senderUid: 'b' }));
    expect(fakeDb.read<any>(`orgs/${ORG}/alerts/${alertId}`)!.status).toBe('open');

    await handleMessageCreated(ORG, 'ch1', 'm3', msg({ senderUid: 'c', senderName: 'User C', body: 'On my way' }));
    expect(fakeDb.read<any>(`orgs/${ORG}/alerts/${alertId}`)).toMatchObject({ status: 'acked', ackedBy: 'c' });
    expect(audit('alert.ack')[0]!.data).toMatchObject({ actorUid: 'c', resourceId: alertId, metadata: { level: 0, via: 'reply' } });
    expect(await ackMessageAlertsOnReply(ORG, 'ch1', 'a')).toEqual([]); // no longer open
  });

  it('ignores alerts from other channels and non-message alerts', async () => {
    seedChannel('ch1');
    seedChannel('ch2');
    const urgent = msg({ senderUid: 'b', priority: 'urgent' });
    fakeDb.seed(`${CH('ch2')}/messages/m1`, urgent);
    await handleMessageCreated(ORG, 'ch2', 'm1', urgent);
    await handleMessageCreated(ORG, 'ch1', 'm9', msg({ senderUid: 'c' }));
    expect(fakeDb.read<any>(`orgs/${ORG}/alerts/${messageAlertId('ch2', 'm1')}`)!.status).toBe('open');
  });
});

describe('O3 triage', () => {
  function seedOnCall() {
    const now = Date.now();
    fakeDb.seed(`orgs/${ORG}/onCallRoles/oncall-rn`, { label: 'On-call RN', discipline: 'RN', teamId: null, fallbackUids: [] });
    fakeDb.seed(`orgs/${ORG}/shifts/s1`, { roleKey: 'oncall-rn', uid: 'd', start: Timestamp.fromMillis(now - H), end: Timestamp.fromMillis(now + 5 * H), notes: null });
  }

  it('routine calls notify the assignee with a normal, non-escalating alert', async () => {
    seedOnCall();
    const res = await logTriageCallHandler(req({ orgId: ORG, callerName: 'Son', reason: 'Refill question', urgency: 'routine', roleKey: 'oncall-rn' }, { uid: 'b' }));
    expect(res).toMatchObject({ assignedUid: 'd', alertId: triageAlertId(res.callId) });
    expect(fakeDb.read<any>(`orgs/${ORG}/alerts/${res.alertId}`)).toMatchObject({
      title: ROUTINE_TRIAGE_ALERT_TITLE, priority: 'normal', policyId: null, targetUids: ['d'], source: { type: 'triage', callId: res.callId },
    });
  });

  it('resolving a triage alert resolves the call (disposition other, default note)', async () => {
    seedOnCall();
    const res = await logTriageCallHandler(req({ orgId: ORG, callerName: 'Son', reason: 'Fall', urgency: 'urgent', roleKey: 'oncall-rn' }, { uid: 'b' }));
    await alertActionHandler(req({ orgId: ORG, alertId: res.alertId! }, { uid: 'd' }), 'resolve');
    expect(fakeDb.read<any>(`orgs/${ORG}/triageCalls/${res.callId}`)).toMatchObject({
      status: 'resolved', disposition: 'other', dispositionNote: RESOLVED_FROM_ALERT_NOTE, resolvedBy: 'd',
    });
    expect(audit('triage.resolve')[0]!.data.metadata).toEqual({ disposition: 'other', via: 'alert' });

    const res2 = await logTriageCallHandler(req({ orgId: ORG, callerName: 'Son', reason: 'Pain', urgency: 'urgent', roleKey: 'oncall-rn' }, { uid: 'b' }));
    await alertActionHandler(req({ orgId: ORG, alertId: res2.alertId!, disposition: 'advice_given', dispositionNote: 'Gave PRN guidance' }, { uid: 'd' }), 'resolve');
    expect(fakeDb.read<any>(`orgs/${ORG}/triageCalls/${res2.callId}`)).toMatchObject({ disposition: 'advice_given', dispositionNote: 'Gave PRN guidance' });
  });

  it('resolveTriageCall creates a PRN visit assigned to the resolver by default', async () => {
    seedOnCall();
    seedPatient('p1');
    const res = await logTriageCallHandler(req({ orgId: ORG, patientId: 'p1', callerName: 'Son', reason: 'Pain', urgency: 'urgent', roleKey: 'oncall-rn' }, { uid: 'b' }));
    const start = new Date(Date.now() + H).toISOString();
    const end = new Date(Date.now() + 2 * H).toISOString();
    // M3: a clinician who is neither assignee nor alert recipient cannot resolve.
    await expect(resolveTriageCallHandler(req({ orgId: ORG, callId: res.callId, disposition: 'visit_scheduled' }, { uid: 'c' }))).rejects.toMatchObject({ code: 'permission-denied' });
    const out = await resolveTriageCallHandler(req({ orgId: ORG, callId: res.callId, disposition: 'visit_scheduled', visit: { start, end } }, { uid: 'd' }));
    expect(out.visitId).toEqual(expect.any(String));
    expect(fakeDb.read<any>(`orgs/${ORG}/visits/${out.visitId}`)).toMatchObject({
      patientId: 'p1', patientName: 'Lee-p1, Ann', discipline: 'RN', assignedUid: 'd', status: 'scheduled', createdBy: 'd', completedAt: null,
    });
    expect(audit('visit.schedule')[0]!.data.metadata).toMatchObject({ source: 'triage', callId: res.callId });
    expect(audit('triage.resolve')[0]!.data.metadata).toMatchObject({ visitId: out.visitId });
  });

  it('a visit needs a patient-linked call', async () => {
    seedOnCall();
    const res = await logTriageCallHandler(req({ orgId: ORG, callerName: 'X', reason: 'Y', urgency: 'routine', roleKey: 'oncall-rn' }, { uid: 'b' }));
    const visit = { start: new Date().toISOString(), end: new Date(Date.now() + H).toISOString() };
    await expect(resolveTriageCallHandler(req({ orgId: ORG, callId: res.callId, disposition: 'other', visit }, { uid: 'd' }))).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('assign moves current recipients to the new assignee and pushes to them; M3 gate', async () => {
    seedOnCall();
    const res = await logTriageCallHandler(req({ orgId: ORG, callerName: 'Son', reason: 'Fall', urgency: 'urgent', roleKey: 'oncall-rn' }, { uid: 'b' }));
    vi.mocked(pushToMembers).mockClear();
    await expect(assignTriageCallHandler(req({ orgId: ORG, callId: res.callId, assignedUid: 'c' }, { uid: 'b' }))).rejects.toMatchObject({ code: 'permission-denied' });
    await assignTriageCallHandler(req({ orgId: ORG, callId: res.callId, assignedUid: 'c' }, { uid: 'd' }));
    const alert = fakeDb.read<any>(`orgs/${ORG}/alerts/${res.alertId}`)!;
    expect(alert.currentTargetUids).toEqual(['c']);
    expect(alert.targetUids).toEqual(['d', 'c']);
    expect(pushToMembers).toHaveBeenCalledWith(ORG, ['c'], 'Urgent alert', expect.objectContaining({ type: 'alert', alertId: res.alertId }));
    // An admin may always reassign.
    await assignTriageCallHandler(req({ orgId: ORG, callId: res.callId, assignedUid: 'b' }, { uid: 'a', role: 'admin' }));
  });

  it('an unassigned call without an alert can be picked up, which notifies the assignee', async () => {
    const res = await logTriageCallHandler(req({ orgId: ORG, callerName: 'Neighbor', reason: 'Question', urgency: 'routine' }, { uid: 'b' }));
    expect(res.alertId).toBeNull();
    await assignTriageCallHandler(req({ orgId: ORG, callId: res.callId, assignedUid: 'c' }, { uid: 'b' }));
    const call = fakeDb.read<any>(`orgs/${ORG}/triageCalls/${res.callId}`)!;
    expect(call.alertId).toBe(triageAlertId(res.callId));
    expect(fakeDb.read<any>(`orgs/${ORG}/alerts/${call.alertId}`)).toMatchObject({ priority: 'normal', policyId: null, targetUids: ['c'] });
  });
});

describe('O4 handoff scope', () => {
  beforeEach(() => {
    seedPatient('p1', { careTeamUids: ['c'] }); // not b's patient
    seedPatient('p2', { careTeamUids: ['b'], status: 'deceased', death: { date: new Date().toISOString().slice(0, 10), time: null, pronouncedBy: null, location: null, notes: null } });
    seedPatient('p3', { careTeamUids: ['b'], status: 'discharged', dischargeDate: '2020-01-01' });
    fakeDb.seed(`orgs/${ORG}/triageCalls/t1`, {
      patientId: 'p1', patientName: 'Lee-p1, Ann', callerName: 'Daughter', callerRelationship: null, callerPhone: null, reason: 'Agitation',
      symptoms: [], urgency: 'urgent', status: 'resolved', assignedUid: 'b', roleKey: null, alertId: null, disposition: 'advice_given',
      dispositionNote: null, receivedAt: Timestamp.fromMillis(Date.now() - 2 * H), receivedBy: 'c', resolvedAt: Timestamp.now(), resolvedBy: 'b',
    });
    fakeDb.seed(`orgs/${ORG}/triageCalls/t2`, {
      patientId: null, patientName: null, callerName: 'Neighbor', callerRelationship: 'friend', callerPhone: null, reason: 'Asked about admission',
      symptoms: [], urgency: 'routine', status: 'open', assignedUid: null, roleKey: null, alertId: null, disposition: null,
      dispositionNote: null, receivedAt: Timestamp.fromMillis(Date.now() - H), receivedBy: 'b', resolvedAt: null, resolvedBy: null,
    });
    fakeDb.seed(`orgs/${ORG}/triageCalls/t3`, {
      patientId: 'p3', patientName: 'x', callerName: 'Old', callerRelationship: null, callerPhone: null, reason: 'Old call',
      symptoms: [], urgency: 'routine', status: 'resolved', assignedUid: 'b', roleKey: null, alertId: null, disposition: 'other',
      dispositionNote: null, receivedAt: Timestamp.fromMillis(Date.now() - 3 * DAY), receivedBy: 'b', resolvedAt: null, resolvedBy: null,
    });
  });

  it('care_team includes patients who died in the window, not older discharges', () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(inHandoffWindow({ status: 'deceased', death: { date: today } as never, dischargeDate: null }, today)).toBe(true);
    expect(inHandoffWindow({ status: 'discharged', death: null, dischargeDate: '2020-01-01' }, today)).toBe(false);
  });

  it('care_team (default) covers admitted plus in-window deaths', async () => {
    const gen = fakeGenerator('H');
    await generateHandoffHandler(req({ orgId: ORG }, { uid: 'b' }), { generator: gen as never });
    const prompt = gen.calls[0]!.prompt;
    expect(prompt).toContain('Lee-p2');
    expect(prompt).not.toContain('Lee-p3');
    expect(prompt).not.toContain('Lee-p1');
  });

  it('my_activity covers my triage calls (any patient) and unlinked calls', async () => {
    const gen = fakeGenerator('H');
    await generateHandoffHandler(req({ orgId: ORG, scope: 'my_activity' }, { uid: 'b' }), { generator: gen as never });
    const prompt = gen.calls[0]!.prompt;
    expect(prompt).toContain('Lee-p1'); // assigned to me in the window
    expect(prompt).toContain('Triage calls not linked to a patient');
    expect(prompt).toContain('Asked about admission');
    expect(prompt).not.toContain('Old call');
    expect(audit('ai.handoff')[0]!.data.metadata).toMatchObject({ scope: 'my_activity', patients: 1, unlinkedCalls: 1 });
  });

  it('my_activity includes visits I completed', async () => {
    fakeDb.seed(`orgs/${ORG}/visits/v1`, {
      patientId: 'p3', patientName: 'x', discipline: 'RN', assignedUid: 'c', scheduledStart: Timestamp.fromMillis(Date.now() - 3 * H),
      scheduledEnd: Timestamp.fromMillis(Date.now() - 2 * H), status: 'completed', note: null, completedAt: Timestamp.fromMillis(Date.now() - H),
      completedBy: 'c', cancelledReason: null, createdBy: 'a', createdAt: Timestamp.now(), updatedAt: Timestamp.now(),
    });
    const gen = fakeGenerator('H');
    await generateHandoffHandler(req({ orgId: ORG, scope: 'my_activity' }, { uid: 'c' }), { generator: gen as never });
    expect(gen.calls[0]!.prompt).toContain('Lee-p3');
  });
});

describe('O5 on-call coverage access', () => {
  beforeEach(() => {
    seedPatient('p1', { careTeamUids: ['b'] });
    fakeDb.seed(`orgs/${ORG}/onCallRoles/oncall-rn`, { label: 'On-call RN', discipline: 'RN', teamId: null, fallbackUids: [] });
  });

  it('requires an active shift (or admin), adds the caller until shift end, and audits', async () => {
    const now = Date.now();
    await expect(joinPatientChannelForCoverageHandler(req({ orgId: ORG, patientId: 'p1', reason: 'Night call' }, { uid: 'd' }))).rejects.toMatchObject({ code: 'permission-denied' });
    // A future shift doesn't count.
    fakeDb.seed(`orgs/${ORG}/shifts/later`, { roleKey: 'oncall-rn', uid: 'd', start: Timestamp.fromMillis(now + H), end: Timestamp.fromMillis(now + 9 * H), notes: null });
    await expect(joinPatientChannelForCoverageHandler(req({ orgId: ORG, patientId: 'p1', reason: 'Night call' }, { uid: 'd' }))).rejects.toMatchObject({ code: 'permission-denied' });

    const end = now + 6 * H;
    fakeDb.seed(`orgs/${ORG}/shifts/s1`, { roleKey: 'oncall-rn', uid: 'd', start: Timestamp.fromMillis(now - H), end: Timestamp.fromMillis(end), notes: null });
    const res = await joinPatientChannelForCoverageHandler(req({ orgId: ORG, patientId: 'p1', reason: 'Night call from family' }, { uid: 'd' }), new Date(now));
    expect(res).toEqual({ channelId: 'pc_p1', until: new Date(end).toISOString(), alreadyMember: false });
    const ch = fakeDb.read<any>(CH('pc_p1'))!;
    expect(ch.memberUids).toEqual(['b', 'd']);
    expect(ch.coverageMembers).toEqual([expect.objectContaining({ uid: 'd', reason: 'Night call from family', roleKey: 'oncall-rn' })]);
    expect(ch.coverageExpiresAt.toMillis()).toBe(end);
    expect(audit('channel.coverage_join')[0]!.data).toMatchObject({ actorUid: 'd', patientId: 'p1', metadata: { roleKey: 'oncall-rn', adminOverride: false } });
  });

  it('hourly expiry removes expired coverage members unless they joined the care team', async () => {
    const now = Date.now();
    fakeDb.seed(`orgs/${ORG}/shifts/s1`, { roleKey: 'oncall-rn', uid: 'd', start: Timestamp.fromMillis(now - H), end: Timestamp.fromMillis(now + H), notes: null });
    fakeDb.seed(`orgs/${ORG}/shifts/s2`, { roleKey: 'oncall-rn', uid: 'c', start: Timestamp.fromMillis(now - H), end: Timestamp.fromMillis(now + 2 * H), notes: null });
    await joinPatientChannelForCoverageHandler(req({ orgId: ORG, patientId: 'p1', reason: 'Night call' }, { uid: 'd' }), new Date(now));
    await joinPatientChannelForCoverageHandler(req({ orgId: ORG, patientId: 'p1', reason: 'Night call' }, { uid: 'c' }), new Date(now));

    expect(await runCoverageExpiry(new Date(now + 30 * 60_000))).toEqual({ channels: 0, removed: 0 });
    // d's coverage ends first; c's remains.
    let res = await runCoverageExpiry(new Date(now + 90 * 60_000));
    expect(res).toEqual({ channels: 1, removed: 1 });
    let ch = fakeDb.read<any>(CH('pc_p1'))!;
    expect(ch.memberUids).toEqual(['b', 'c']);
    expect(ch.coverageMembers.map((c: { uid: string }) => c.uid)).toEqual(['c']);

    // c joins the care team meanwhile: kept as a member when coverage ends.
    await fakeDb.doc(P('p1')).update({ careTeamUids: ['b', 'c'] });
    res = await runCoverageExpiry(new Date(now + 3 * H));
    expect(res.removed).toBe(0);
    ch = fakeDb.read<any>(CH('pc_p1'))!;
    expect(ch.memberUids).toEqual(['b', 'c']);
    expect(ch.coverageMembers).toEqual([]);
    expect(ch.coverageExpiresAt).toBeNull();
    expect(audit('channel.coverage_expire')).toHaveLength(2);
  });

  it('admins without a shift get 12 hours; existing members are reported as such', async () => {
    const now = Date.now();
    const res = await joinPatientChannelForCoverageHandler(req({ orgId: ORG, patientId: 'p1', reason: 'Audit review' }, { uid: 'a', role: 'admin' }), new Date(now));
    expect(res.until).toBe(new Date(now + 12 * H).toISOString());
    expect(audit('channel.coverage_join')[0]!.data.metadata).toMatchObject({ adminOverride: true });
    await fakeDb.doc(CH('pc_p1')).update({ coverageMembers: [] });
    expect(await joinPatientChannelForCoverageHandler(req({ orgId: ORG, patientId: 'p1', reason: 'Already here' }, { uid: 'a', role: 'admin' }))).toMatchObject({
      alreadyMember: true, until: null,
    });
  });
});

describe('S6 retention', () => {
  it('patient channels are exempt unless patientChannelRetentionDays ≥ 2190; legal hold always exempt', async () => {
    expect(patientPurgeCutoffMs(10_000 * DAY, 365)).toBeNull();
    expect(patientPurgeCutoffMs(10_000 * DAY, 2190)).toBe((10_000 - 2190) * DAY);
    expect(channelCutoffMs({ type: 'patient' }, { defaultMs: 5, patientMs: null })).toBeNull();
    expect(channelCutoffMs({ type: 'group', legalHold: true }, { defaultMs: 5, patientMs: null })).toBeNull();

    const now = Date.now();
    fakeDb.seed(`orgs/${ORG}`, { ...fakeDb.read<any>(`orgs/${ORG}`), messageLifespanDays: 30 });
    seedChannel('g');
    seedChannel('held', { legalHold: true });
    seedChannel('pt', { type: 'patient', patientId: 'p1' });
    for (const ch of ['g', 'held', 'pt']) fakeDb.seed(`${CH(ch)}/messages/old`, msg({ createdAt: Timestamp.fromMillis(now - 40 * DAY) }));
    fakeDb.seed(`${CH('pt')}/messages/ancient`, msg({ createdAt: Timestamp.fromMillis(now - 2200 * DAY) }));

    await runMessagePurge(new Date(now));
    expect(docsIn(`${CH('g')}/messages`)).toHaveLength(0);
    expect(docsIn(`${CH('held')}/messages`)).toHaveLength(1);
    expect(docsIn(`${CH('pt')}/messages`)).toHaveLength(2);

    // With a 6-year patient retention only the older-than-6-years message goes.
    await fakeDb.doc(`orgs/${ORG}`).update({ patientChannelRetentionDays: 2190, messageLifespanDays: null });
    const res = await runMessagePurge(new Date(now));
    expect(res.messages).toBe(1);
    expect(docsIn(`${CH('pt')}/messages`).map((d) => d.id)).toEqual(['old']);
  });
});

describe('F5 / H3 IDG', () => {
  const MEETING = `orgs/${ORG}/idgMeetings/mt1`;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-28T18:00:00Z'));
    fakeDb.seed(`orgs/${ORG}/members/md`, member('md', 'clinician', { discipline: 'MD' }));
    fakeDb.seed(`orgs/${ORG}/members/sw`, member('sw', 'clinician', { discipline: 'SW' }));
    seedPatient('p1', { careTeamUids: ['b', 'sw'] });
    seedPatient('p2', { careTeamUids: ['c'] });
    fakeDb.seed(MEETING, {
      title: 'IDG', teamId: null, scheduledAt: Timestamp.fromDate(new Date('2026-09-28T15:00:00Z')), status: 'scheduled',
      attendeeUids: ['b', 'c', 'md', 'sw'], patientIds: ['p1', 'p2'], patientNames: { p1: 'Lee-p1, Ann', p2: 'Lee-p2, Ann' }, notes: {}, aiPrep: {},
      createdBy: 'b', createdAt: Timestamp.now(), completedAt: null, completedBy: null,
    });
  });
  afterEach(() => vi.useRealTimers());

  it('discipline notes are separate docs, so concurrent saves never overwrite each other', async () => {
    await Promise.all([
      saveIdgDisciplineNoteHandler(req({ orgId: ORG, meetingId: 'mt1', patientId: 'p1', discipline: 'SW', text: 'Family coping' }, { uid: 'sw' })),
      saveIdgDisciplineNoteHandler(req({ orgId: ORG, meetingId: 'mt1', patientId: 'p1', discipline: 'RN', text: 'Pain controlled' }, { uid: 'b' })),
    ]);
    expect(fakeDb.read<any>(`${MEETING}/notes/p1_SW`)).toMatchObject({ kind: 'discipline', text: 'Family coping', updatedBy: 'sw', patientId: 'p1' });
    expect(fakeDb.read<any>(`${MEETING}/notes/p1_RN`)).toMatchObject({ text: 'Pain controlled', updatedBy: 'b' });
    expect(fakeDb.read<any>(MEETING)!.notes).toEqual({});
    fakeDb.seed(`orgs/${ORG}/members/e`, member('e'));
    await expect(saveIdgDisciplineNoteHandler(req({ orgId: ORG, meetingId: 'mt1', patientId: 'p1', discipline: 'RN', text: 'x' }, { uid: 'e' }))).rejects.toMatchObject({ code: 'permission-denied' });
    expect(audit('idg.discipline_note')).toHaveLength(2);
  });

  it('attendee and agenda edits are limited to the creator or an admin', async () => {
    await expect(updateIdgMeetingHandler(req({ orgId: ORG, meetingId: 'mt1', attendeeUids: ['c'] }, { uid: 'c' }))).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(updateIdgMeetingHandler(req({ orgId: ORG, meetingId: 'mt1', patientIds: ['p2'] }, { uid: 'c' }))).rejects.toMatchObject({ code: 'permission-denied' });
    await updateIdgMeetingHandler(req({ orgId: ORG, meetingId: 'mt1', title: 'Renamed' }, { uid: 'c' }));
    await saveIdgDisciplineNoteHandler(req({ orgId: ORG, meetingId: 'mt1', patientId: 'p1', discipline: 'RN', text: 'x' }, { uid: 'b' }));
    await updateIdgMeetingHandler(req({ orgId: ORG, meetingId: 'mt1', patientIds: ['p2'] }, { uid: 'b' }));
    expect(fakeDb.read<any>(`${MEETING}/notes/p1_RN`)).toBeUndefined(); // dropped with the agenda item
    await updateIdgMeetingHandler(req({ orgId: ORG, meetingId: 'mt1', attendeeUids: ['a', 'c'] }, { uid: 'a', role: 'admin' }));
  });

  it('generateIdgPrep: care team or admin only (attendance is not enough); skips fresh prep', async () => {
    const gen = fakeGenerator('PREP');
    // md attends but is on no care team.
    await expect(generateIdgPrepHandler(req({ orgId: ORG, meetingId: 'mt1' }, { uid: 'md' }), { generator: gen as never })).rejects.toMatchObject({ code: 'permission-denied' });
    const r1 = await generateIdgPrepHandler(req({ orgId: ORG, meetingId: 'mt1' }, { uid: 'b' }), { generator: gen as never });
    expect(r1.generatedPatientIds).toEqual(['p1']);
    expect(fakeDb.read<any>(MEETING)!.aiPrep).toEqual({});
    const r2 = await generateIdgPrepHandler(req({ orgId: ORG, meetingId: 'mt1', patientIds: ['p1', 'p2'], skipFreshHours: 12 }, { uid: 'a', role: 'admin' }), { generator: gen as never });
    expect(r2).toEqual({ generatedPatientIds: ['p2'], failedPatientIds: [], skippedPatientIds: ['p1'] });
  });

  it('completion: refuses future meetings, warns on missing disciplines, writes idempotent tasks', async () => {
    fakeDb.seed(`${MEETING}`, { ...fakeDb.read<any>(MEETING), scheduledAt: Timestamp.fromDate(new Date('2026-09-30T15:00:00Z')) });
    await expect(completeIdgMeetingHandler(req({ orgId: ORG, meetingId: 'mt1' }, { uid: 'b' }))).rejects.toMatchObject({ code: 'failed-precondition' });
    fakeDb.seed(`${MEETING}`, { ...fakeDb.read<any>(MEETING), scheduledAt: Timestamp.fromDate(new Date('2026-09-28T15:00:00Z')) });

    await saveIdgNoteHandler(req({ orgId: ORG, meetingId: 'mt1', patientId: 'p1', summary: 'Stable', reviewed: true, actionItems: [{ title: 'Bed', assigneeUid: 'b', dueDate: null }] }, { uid: 'b' }));
    const res = await completeIdgMeetingHandler(req({ orgId: ORG, meetingId: 'mt1' }, { uid: 'b' }));
    expect(res).toEqual({ reviewed: 1, patientsUpdated: 1, tasks: 1, warnings: [expect.stringContaining('Chaplain')] });
    expect(fakeDb.read<any>(`orgs/${ORG}/tasks/${idgTaskId('mt1', 'p1', 0)}`)).toMatchObject({ title: 'Bed', source: { type: 'idg', meetingId: 'mt1' } });
    expect(fakeDb.read<any>(MEETING)).toMatchObject({ status: 'completed', completionPending: false, completedBy: 'b' });
    await expect(completeIdgMeetingHandler(req({ orgId: ORG, meetingId: 'mt1' }, { uid: 'b' }))).rejects.toMatchObject({ code: 'failed-precondition' });

    // A completion interrupted after the claim can be retried without duplicating tasks.
    await fakeDb.doc(MEETING).update({ completionPending: true });
    await completeIdgMeetingHandler(req({ orgId: ORG, meetingId: 'mt1' }, { uid: 'b' }));
    expect(docsIn(`orgs/${ORG}/tasks`).filter((t) => t.data.source?.type === 'idg')).toHaveLength(1);
  });

  it('missingDisciplineWarnings', () => {
    expect(missingDisciplineWarnings(['MD', 'RN', 'SW', 'Chaplain'])).toEqual([]);
    expect(missingDisciplineWarnings(['RN'])[0]).toContain('MD, SW, Chaplain');
  });

  it('completion writes in batches for large agendas', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `q${i}`);
    for (const pid of ids) fakeDb.seed(P(pid), { firstName: 'A', lastName: pid, status: 'admitted', careTeamUids: ['b'], milestones: null });
    const notes = Object.fromEntries(ids.map((pid) => [pid, { summary: 's', planOfCareChanges: null, goalsOfCare: null, reviewed: true, updatedBy: 'b', updatedAt: Timestamp.now(), actionItems: [{ title: 'a', assigneeUid: null, dueDate: null }, { title: 'b', assigneeUid: null, dueDate: null }] }]));
    fakeDb.seed(MEETING, { ...fakeDb.read<any>(MEETING), patientIds: ids, notes });
    const res = await completeIdgMeetingHandler(req({ orgId: ORG, meetingId: 'mt1' }, { uid: 'b' }));
    expect(res).toMatchObject({ reviewed: 150, patientsUpdated: 150, tasks: 300 });
  });
});
