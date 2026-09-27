import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('firebase-admin/firestore', () => import('../fakes/firestore'));

import { logger } from 'firebase-functions/v2';
import { fakeDb, Timestamp } from '../fakes/firestore';
import { AI_DISCLAIMER, describeAiError, type TextGenerationInput, type TextGenerator } from '../../src/lib/aiText';
import { clip, formatMessages, MAX_AI_MESSAGE_CHARS, MAX_AI_MESSAGES } from '../../src/ai/format';
import { summarizeChannelHandler } from '../../src/ai/summarizeChannel';
import { generateHandoffHandler } from '../../src/ai/generateHandoff';
import { generateIdgPrepHandler } from '../../src/ai/generateIdgPrep';
import { computeMilestones } from '../../src/domain/milestones';
import { docsIn, ORG, req, seedOrg } from './helpers';

const H = 3_600_000;

function fakeGenerator(reply = 'SUMMARY TEXT'): TextGenerator & { calls: TextGenerationInput[] } {
  const calls: TextGenerationInput[] = [];
  return {
    calls,
    generate: vi.fn(async (input: TextGenerationInput) => {
      calls.push(input);
      return { text: reply, model: 'gemini-test' };
    }),
  };
}

function failingGenerator(err: unknown): TextGenerator {
  return { generate: vi.fn(async () => { throw err; }) };
}

function seedMessage(channelId: string, id: string, body: string, agoMs: number, over: Record<string, unknown> = {}) {
  fakeDb.seed(`orgs/${ORG}/channels/${channelId}/messages/${id}`, {
    senderUid: 'b', senderName: 'User B', body, priority: 'normal', attachments: [], roleTarget: null,
    createdAt: Timestamp.fromMillis(Date.now() - agoMs), alertId: null, ...over,
  });
}

function seedPatient(id: string, over: Record<string, unknown> = {}) {
  fakeDb.seed(`orgs/${ORG}/patients/${id}`, {
    firstName: 'Ann', lastName: `Lee-${id}`, status: 'admitted', levelOfCare: 'routine', careTeamUids: ['b'],
    channelId: `pc_${id}`, primaryDiagnosis: { code: 'C34.90', description: 'Lung cancer' }, codeStatus: 'DNR',
    milestones: computeMilestones(new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10)), remindedMilestones: [],
    ...over,
  });
  fakeDb.seed(`orgs/${ORG}/channels/pc_${id}`, {
    type: 'patient', name: `Lee-${id} – Care Team`, memberUids: ['b', 'c'], patientId: id, teamId: null, createdBy: 'a',
    createdAt: Timestamp.fromMillis(0), lastMessage: null, lastMessageAt: Timestamp.now(), archived: false,
  });
}

beforeEach(() => {
  seedOrg();
  fakeDb.seed(`orgs/${ORG}/channels/ch1`, {
    type: 'group', name: 'North', memberUids: ['b', 'c', 'v'], patientId: null, teamId: null,
    createdBy: 'b', createdAt: Timestamp.fromMillis(0), lastMessage: null, lastMessageAt: Timestamp.now(), archived: false,
  });
});

describe('format caps', () => {
  it('keeps the newest 200 messages, oldest first, and truncates long bodies', () => {
    const msgs = Array.from({ length: 250 }, (_, i) => ({
      senderName: 'B', body: i === 249 ? 'x'.repeat(5000) : `m${i}`, priority: 'normal', createdAtMs: i * 1000, attachmentCount: 0, isThreadReply: false,
    }));
    const out = formatMessages(msgs, 'UTC').split('\n');
    expect(out).toHaveLength(MAX_AI_MESSAGES);
    expect(out[0]).toContain(': m50');
    expect(out[199]).toContain('[truncated]');
    expect(out[199]!.length).toBeLessThan(MAX_AI_MESSAGE_CHARS + 100);
    expect(clip('a  b\n c', 10)).toBe('a b c');
  });
});

describe('summarizeChannel', () => {
  it('summarizes recent non-recalled messages for a member (viewer ok) with the disclaimer, and audits without content', async () => {
    seedMessage('ch1', 'm1', 'Pt restless overnight, gave lorazepam 0.5mg', 2 * H);
    seedMessage('ch1', 'm2', 'RECALLED CONTENT', H, { recalledAt: Timestamp.now(), body: '' });
    seedMessage('ch1', 'm3', 'too old', 48 * H);
    const gen = fakeGenerator();
    const res = await summarizeChannelHandler(req({ orgId: ORG, channelId: 'ch1' }, { uid: 'v', role: 'viewer' }), { generator: gen });
    expect(res).toEqual({ text: 'SUMMARY TEXT', model: 'gemini-test', disclaimer: AI_DISCLAIMER });
    expect(AI_DISCLAIMER).toBe('AI-generated summary — verify against the chart before acting.');
    expect(gen.calls).toHaveLength(1);
    expect(gen.calls[0]!.prompt).toContain('lorazepam 0.5mg');
    expect(gen.calls[0]!.prompt).not.toContain('too old');
    expect(gen.calls[0]!.systemInstruction).toMatch(/Never invent/);

    const audit = docsIn(`orgs/${ORG}/auditLogs`).find((l) => l.data.action === 'ai.summarize_channel')!;
    expect(audit.data).toMatchObject({ actorUid: 'v', resourceId: 'ch1', metadata: { model: 'gemini-test', messages: 1, sinceHours: 24 } });
    expect(JSON.stringify(audit.data)).not.toMatch(/lorazepam|SUMMARY/);
  });

  it('caps the input at 200 messages', async () => {
    for (let i = 0; i < 230; i++) seedMessage('ch1', `m${String(i).padStart(3, '0')}`, `note ${i}`, i * 1000);
    const gen = fakeGenerator();
    await summarizeChannelHandler(req({ orgId: ORG, channelId: 'ch1' }, { uid: 'b' }), { generator: gen });
    const lines = gen.calls[0]!.prompt.split('\n').filter((l) => l.startsWith('['));
    expect(lines).toHaveLength(MAX_AI_MESSAGES);
    expect(gen.calls[0]!.prompt).toContain('older messages omitted');
  });

  it('does not call the model for an empty window, and rejects non-members', async () => {
    const gen = fakeGenerator();
    const res = await summarizeChannelHandler(req({ orgId: ORG, channelId: 'ch1', sinceHours: 1 }, { uid: 'b' }), { generator: gen });
    expect(res.model).toBe('none');
    expect(res.disclaimer).toBe(AI_DISCLAIMER);
    expect(gen.calls).toHaveLength(0);
    await expect(summarizeChannelHandler(req({ orgId: ORG, channelId: 'ch1' }, { uid: 'a', role: 'admin' }), { generator: gen })).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(summarizeChannelHandler(req({ orgId: ORG, channelId: 'ch1', sinceHours: 0 }, { uid: 'b' }), { generator: gen })).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('maps Vertex errors and logs only codes/statuses', async () => {
    seedMessage('ch1', 'm1', 'Patient John Doe is declining', H);
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const apiErr = Object.assign(new Error('Permission denied: prompt was "Patient John Doe"'), { status: 403 });
    await expect(summarizeChannelHandler(req({ orgId: ORG, channelId: 'ch1' }, { uid: 'b' }), { generator: failingGenerator(apiErr) })).rejects.toMatchObject({
      code: 'failed-precondition',
    });
    await expect(summarizeChannelHandler(req({ orgId: ORG, channelId: 'ch1' }, { uid: 'b' }), { generator: failingGenerator(new Error('John Doe')) })).rejects.toMatchObject({
      code: 'internal',
    });
    expect(JSON.stringify(spy.mock.calls)).not.toContain('John');
    expect(spy.mock.calls[0]![1]).toMatchObject({ status: 403, code: 'vertex_api_error' });
    spy.mockRestore();
    expect(describeAiError(Object.assign(new Error('x'), { status: 429 })).code).toBe('resource-exhausted');
  });
});

describe('generateHandoff', () => {
  beforeEach(() => {
    seedPatient('p1');
    seedPatient('p2', { careTeamUids: ['c'] });
    seedPatient('p3', { status: 'discharged' });
    seedMessage('pc_p1', 'm1', 'Family requests chaplain visit', 2 * H);
    seedMessage('pc_p1', 'm0', 'ancient message', 30 * H);
    fakeDb.seed(`orgs/${ORG}/triageCalls/t1`, {
      patientId: 'p1', patientName: 'Lee-p1, Ann', callerName: 'Daughter', callerRelationship: null, callerPhone: null,
      reason: 'Breakthrough pain 8/10', symptoms: ['pain'], urgency: 'urgent', status: 'resolved', assignedUid: 'c', roleKey: null,
      alertId: null, disposition: 'advice_given', dispositionNote: null, receivedAt: Timestamp.fromMillis(Date.now() - 3 * H),
      receivedBy: 'c', resolvedAt: Timestamp.now(), resolvedBy: 'c',
    });
    fakeDb.seed(`orgs/${ORG}/visits/v1`, {
      patientId: 'p1', patientName: 'x', discipline: 'RN', assignedUid: 'b', scheduledStart: Timestamp.fromMillis(Date.now() + 5 * H),
      scheduledEnd: Timestamp.fromMillis(Date.now() + 6 * H), status: 'scheduled', note: null, completedAt: null, completedBy: null,
      cancelledReason: null, createdBy: 'a', createdAt: Timestamp.now(), updatedAt: Timestamp.now(),
    });
    fakeDb.seed(`orgs/${ORG}/tasks/k1`, {
      title: 'Medication reconciliation', description: null, patientId: 'p1', patientName: 'x', assigneeUid: 'b', discipline: 'RN',
      dueDate: '2026-09-27', priority: 'normal', status: 'open', source: { type: 'manual' }, createdBy: 'a', createdAt: Timestamp.now(),
      completedAt: null, completedBy: null, updatedAt: Timestamp.now(),
    });
  });

  it("covers the caller's admitted care-team patients with messages, triage, visits, tasks and deadlines", async () => {
    const gen = fakeGenerator('HANDOFF');
    const res = await generateHandoffHandler(req({ orgId: ORG }, { uid: 'b', role: 'viewer' }), { generator: gen });
    expect(res).toEqual({ text: 'HANDOFF', model: 'gemini-test', disclaimer: AI_DISCLAIMER });
    const prompt = gen.calls[0]!.prompt;
    expect(prompt).toContain('Lee-p1, Ann');
    expect(prompt).not.toContain('Lee-p2');
    expect(prompt).not.toContain('Lee-p3');
    expect(prompt).toContain('Family requests chaplain visit');
    expect(prompt).not.toContain('ancient message');
    expect(prompt).toContain('Breakthrough pain 8/10');
    expect(prompt).toContain('RN visit, scheduled');
    expect(prompt).toContain('Medication reconciliation');
    expect(prompt).toMatch(/NOE (OVERDUE, was due|due)/);
    const audit = docsIn(`orgs/${ORG}/auditLogs`).find((l) => l.data.action === 'ai.handoff')!;
    expect(audit.data.metadata).toMatchObject({ patients: 1, messages: 1, sinceHours: 12, model: 'gemini-test' });
    expect(JSON.stringify(audit.data)).not.toMatch(/chaplain|HANDOFF|Lee/);
  });

  it('rejects explicit patients outside the care team (except for admins)', async () => {
    const gen = fakeGenerator();
    await expect(generateHandoffHandler(req({ orgId: ORG, patientIds: ['p2'] }, { uid: 'b' }), { generator: gen })).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(generateHandoffHandler(req({ orgId: ORG, patientIds: ['zz'] }, { uid: 'b' }), { generator: gen })).rejects.toMatchObject({ code: 'not-found' });
    await generateHandoffHandler(req({ orgId: ORG, patientIds: ['p2'] }, { uid: 'a', role: 'admin' }), { generator: gen });
    expect(gen.calls[0]!.prompt).toContain('Lee-p2');
  });

  it('returns without calling the model when there are no patients', async () => {
    const gen = fakeGenerator();
    const res = await generateHandoffHandler(req({ orgId: ORG }, { uid: 'v', role: 'viewer' }), { generator: gen });
    expect(res.model).toBe('none');
    expect(gen.calls).toHaveLength(0);
  });
});

describe('generateIdgPrep', () => {
  const meetingPath = `orgs/${ORG}/idgMeetings/mt1`;
  beforeEach(() => {
    seedPatient('p1');
    seedPatient('p2', { careTeamUids: ['c'] });
    fakeDb.seed(`orgs/${ORG}/patients/p1/events/e1`, {
      type: 'level_of_care_change', date: new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10), recordedBy: 'c',
      createdAt: Timestamp.now(), summary: 'Level of care: routine → GIP', details: {},
    });
    fakeDb.seed(meetingPath, {
      title: 'IDG', teamId: null, scheduledAt: Timestamp.fromMillis(Date.now() + 86_400_000), status: 'scheduled', attendeeUids: ['c'],
      patientIds: ['p1', 'p2'], patientNames: {}, notes: {}, aiPrep: {}, createdBy: 'a', createdAt: Timestamp.now(), completedAt: null, completedBy: null,
    });
  });

  it('writes aiPrep for each agenda patient with the disclaimer and audits', async () => {
    const gen = fakeGenerator('PREP');
    // v3 (H3): an admin may prep every agenda patient; prep is stored in the notes subcollection.
    const res = await generateIdgPrepHandler(req({ orgId: ORG, meetingId: 'mt1' }, { uid: 'a', role: 'admin' }), { generator: gen });
    expect(res).toEqual({ generatedPatientIds: ['p1', 'p2'], failedPatientIds: [] });
    const prep = fakeDb.read<any>(`${meetingPath}/notes/p1_aiPrep`)!;
    expect(prep).toMatchObject({ kind: 'ai_prep', patientId: 'p1', text: `PREP\n\n${AI_DISCLAIMER}`, model: 'gemini-test', generatedBy: 'a' });
    expect(prep.generatedAt).toBeInstanceOf(Timestamp);
    expect(gen.calls[0]!.prompt).toContain('routine → GIP');
    expect(docsIn(`orgs/${ORG}/auditLogs`).find((l) => l.data.action === 'idg.ai_prep')?.data.metadata).toEqual({ model: 'gemini-test', generated: 2, failed: 0 });
  });

  it('limits non-attendees to their care-team patients and rejects viewers and locked meetings', async () => {
    const gen = fakeGenerator();
    const res = await generateIdgPrepHandler(req({ orgId: ORG, meetingId: 'mt1' }, { uid: 'b' }), { generator: gen });
    expect(res.generatedPatientIds).toEqual(['p1']);
    await expect(generateIdgPrepHandler(req({ orgId: ORG, meetingId: 'mt1', patientId: 'p2' }, { uid: 'b' }), { generator: gen })).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(generateIdgPrepHandler(req({ orgId: ORG, meetingId: 'mt1' }, { uid: 'v', role: 'viewer' }), { generator: gen })).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(generateIdgPrepHandler(req({ orgId: ORG, meetingId: 'mt1', patientId: 'zz' }, { uid: 'c' }), { generator: gen })).rejects.toMatchObject({ code: 'invalid-argument' });
    fakeDb.seed(meetingPath, { ...fakeDb.read<any>(meetingPath), status: 'completed' });
    await expect(generateIdgPrepHandler(req({ orgId: ORG, meetingId: 'mt1' }, { uid: 'c' }), { generator: gen })).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('stops after a setup error and surfaces it when nothing was generated', async () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const gen = failingGenerator(Object.assign(new Error('denied'), { status: 403 }));
    await expect(generateIdgPrepHandler(req({ orgId: ORG, meetingId: 'mt1' }, { uid: 'c' }), { generator: gen })).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(gen.generate).toHaveBeenCalledTimes(1);
    expect(fakeDb.read<any>(meetingPath)!.aiPrep).toEqual({});
    spy.mockRestore();
  });
});
