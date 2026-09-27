/**
 * Tests for the load-test performance fixes: they must keep behavior identical
 * while doing fewer reads / less sequential work.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('firebase-admin/firestore', () => import('../fakes/firestore'));
vi.mock('../../src/lib/notify', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/notify')>()),
  pushToMembers: vi.fn(async () => ({ sent: 0, failed: 0, pruned: 0 })),
}));
vi.mock('../../src/lib/tasks', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/tasks')>()),
  enqueueEscalationCheck: vi.fn(async () => undefined),
}));

import { logger } from 'firebase-functions/v2';
import { fakeDb, Timestamp } from '../fakes/firestore';
import { mapLimit } from '../../src/lib/concurrency';
import { searchMessagesHandler, SEARCH_MAX_HITS, SEARCH_MAX_PER_CHANNEL } from '../../src/messaging/searchMessages';
import { admitPatientHandler } from '../../src/patients/admitPatient';
import { checkOrgDeadlines, deadlineAlertId } from '../../src/patients/checkDeadlines';
import { checkOrgMissedVisits, missedVisitAlertId } from '../../src/visits/checkMissedVisits';
import { generateIdgPrepHandler } from '../../src/ai/generateIdgPrep';
import { generateHandoffHandler } from '../../src/ai/generateHandoff';
import { recordDeathHandler } from '../../src/lifecycle/endOfCare';
import { raiseAlert } from '../../src/alerts/raiseAlert';
import { computeMilestones } from '../../src/domain/milestones';
import type { TextGenerationInput, TextGenerator } from '../../src/lib/aiText';
import type { AdmitPatientRequest, Org } from '../../src/shared/types';
import { docsIn, member, ORG, req, seedOrg } from './helpers';

const DAY = 86_400_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  seedOrg();
});

describe('mapLimit', () => {
  it('returns results in input order with at most `limit` calls in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimit([30, 5, 20, 1, 10, 2], 3, async (ms, i) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await sleep(ms);
      inFlight--;
      return `${i}:${ms}`;
    });
    expect(out).toEqual(['0:30', '1:5', '2:20', '3:1', '4:10', '5:2']);
    expect(peak).toBe(3);
    expect(await mapLimit([], 4, async () => 1)).toEqual([]);
  });

  it('starts nothing new after a failure, lets in-flight calls settle, then rethrows the first error', async () => {
    const started: number[] = [];
    const finished: number[] = [];
    const run = mapLimit([0, 1, 2, 3, 4, 5], 2, async (i) => {
      started.push(i);
      if (i === 1) throw new Error('boom');
      await sleep(10);
      finished.push(i);
      return i;
    });
    await expect(run).rejects.toThrow('boom');
    expect(started).toEqual([0, 1]);
    expect(finished).toEqual([0]);
  });
});

describe('searchMessages paging (identical results, fewer reads)', () => {
  const channels = ['c0', 'c1', 'c2', 'c3'];
  const PER_CHANNEL = SEARCH_MAX_PER_CHANNEL + 20;

  function seed(now: number) {
    channels.forEach((cid, k) => {
      fakeDb.seed(`orgs/${ORG}/channels/${cid}`, {
        type: 'group', name: `Channel ${cid}`, memberUids: ['a', 'b'], patientId: null, teamId: null, createdBy: 'a',
        createdAt: Timestamp.fromMillis(0), lastMessage: null, lastMessageAt: Timestamp.fromMillis(now - k * 1000), archived: false,
      });
      for (let j = 0; j < PER_CHANNEL; j++) {
        // Same timestamps in every channel: ties across channels must keep the full-scan order.
        const body = j === 280 && cid === 'c3' ? 'rare xylophone note' : j === 310 && cid === 'c2' ? 'xylophone beyond the cap' : j % 3 === 0 ? 'pain 4/10' : 'stable';
        fakeDb.seed(`orgs/${ORG}/channels/${cid}/messages/${cid}-${String(j).padStart(3, '0')}`, {
          senderUid: 'b', senderName: 'User B', body, priority: 'normal', attachments: [], roleTarget: null,
          createdAt: Timestamp.fromMillis(now - 60_000 - j * 1000), alertId: null, ...(j === 3 && cid === 'c1' ? { recalledAt: Timestamp.now(), body: '' } : {}),
        });
      }
    });
  }

  /** The pre-change algorithm: newest SEARCH_MAX_PER_CHANNEL per channel, concatenated in channel order, stable sort. */
  function fullScan(query: string): { ids: string[]; truncated: boolean } {
    const all: Array<{ id: string; ms: number }> = [];
    let capped = false;
    for (const cid of channels) {
      const msgs = docsIn(`orgs/${ORG}/channels/${cid}/messages`)
        .map((d) => ({ id: d.id, ms: (d.data.createdAt as Timestamp).toMillis(), body: String(d.data.body), recalled: !!d.data.recalledAt }))
        .sort((x, y) => y.ms - x.ms)
        .slice(0, SEARCH_MAX_PER_CHANNEL);
      if (msgs.length >= SEARCH_MAX_PER_CHANNEL) capped = true;
      for (const m of msgs) if (!m.recalled && m.body.toLowerCase().includes(query.toLowerCase())) all.push(m);
    }
    all.sort((x, y) => y.ms - x.ms);
    return { ids: all.slice(0, SEARCH_MAX_HITS).map((h) => h.id), truncated: capped || all.length > SEARCH_MAX_HITS };
  }

  it('returns the same hits in the same order for a common term while reading far fewer messages', async () => {
    seed(Date.now());
    const expected = fullScan('PAIN');
    fakeDb.reads = 0;
    const res = await searchMessagesHandler(req({ orgId: ORG, query: 'PAIN' }, { uid: 'b' }));
    expect(res.hits.map((h) => h.messageId)).toEqual(expected.ids);
    expect(res.truncated).toBe(true);
    expect(expected.truncated).toBe(true);
    // A full scan reads 4 × 300 messages; paging stops once no channel can reach the top 50.
    expect(fakeDb.reads).toBeLessThan(channels.length * 100);
  });

  it('still finds rare terms anywhere within the per-channel cap, and reports truncation the same way', async () => {
    seed(Date.now());
    const expected = fullScan('xylophone');
    const res = await searchMessagesHandler(req({ orgId: ORG, query: 'xylophone' }, { uid: 'b' }));
    expect(expected.ids).toEqual(['c3-280']);
    expect(res.hits.map((h) => h.messageId)).toEqual(expected.ids);
    expect(res.truncated).toBe(expected.truncated);
  });

  it('is exact for small channels (no cap, fewer hits than the limit)', async () => {
    const now = Date.now();
    fakeDb.seed(`orgs/${ORG}/channels/s1`, {
      type: 'group', name: 'Small', memberUids: ['b'], patientId: null, teamId: null, createdBy: 'a',
      createdAt: Timestamp.fromMillis(0), lastMessage: null, lastMessageAt: Timestamp.fromMillis(now), archived: false,
    });
    for (let j = 0; j < 70; j++) {
      fakeDb.seed(`orgs/${ORG}/channels/s1/messages/m${String(j).padStart(2, '0')}`, {
        senderUid: 'b', senderName: 'User B', body: j % 2 ? 'visit done' : 'call family', priority: 'normal', attachments: [], roleTarget: null,
        createdAt: Timestamp.fromMillis(now - (j + 1) * 1000), alertId: null,
      });
    }
    const res = await searchMessagesHandler(req({ orgId: ORG, query: 'visit' }, { uid: 'b' }));
    expect(res.hits.map((h) => h.messageId)).toEqual(Array.from({ length: 35 }, (_, i) => `m${String(i * 2 + 1).padStart(2, '0')}`));
    expect(res.truncated).toBe(false);
  });
});

function admitReq(over: Partial<AdmitPatientRequest> = {}): AdmitPatientRequest {
  return {
    orgId: ORG,
    patient: {
      firstName: 'Jane', lastName: 'Doe', dob: '1940-05-01', sex: 'female', phone: null,
      address: { line1: null, line2: null, city: null, state: null, zip: null },
      mrn: null, medicareMbi: null, primaryDiagnosis: null, secondaryDiagnoses: [], referringPhysician: null,
      attendingPhysician: null, codeStatus: 'DNR', allergies: [], medications: [], caregiver: { name: 'John Doe', relationship: 'son', phone: null },
      insurance: { payer: null, memberId: null },
    },
    admissionDate: '2026-09-20',
    levelOfCare: 'routine',
    careTeamUids: ['c'],
    consents: { electionStatement: true, hipaaNotice: true, releaseOfInformation: true, patientRights: true, polstOnFile: false },
    ...over,
  };
}

describe('checkOrgDeadlines (batched reads, bounded concurrency)', () => {
  it('raises the same alerts for many patients, falls back to admins, and reads members/policy once', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const careTeamUids = i === 5 ? ['x'] : i % 2 ? ['b', 'c'] : ['c']; // x is inactive → admins
      if (i === 5) fakeDb.seed(`orgs/${ORG}/members/x`, member('x', 'clinician', { active: true }));
      ids.push((await admitPatientHandler(req(admitReq({ careTeamUids, patient: { ...admitReq().patient, lastName: `Doe${i}` } }), { uid: 'b' }))).patientId);
      if (i === 5) fakeDb.seed(`orgs/${ORG}/members/x`, member('x', 'clinician', { active: false }));
    }
    const org = fakeDb.read<Org>(`orgs/${ORG}`)!;
    fakeDb.reads = 0;
    expect(await checkOrgDeadlines(ORG, org, '2026-09-23')).toBe(12); // HOPE admission + NOE per patient
    // patients query (6) + members once (3) + org + policy + admins query (1) + one tx read per alert (12).
    expect(fakeDb.reads).toBeLessThanOrEqual(6 + 3 + 2 + 1 + 12);
    ids.forEach((pid, i) => {
      const alert = fakeDb.read<any>(`orgs/${ORG}/alerts/${deadlineAlertId(pid, 'noe:2026-09-25')}`)!;
      expect(alert.targetUids).toEqual(i === 5 ? ['a'] : i % 2 ? ['b', 'c'] : ['c']);
      expect(alert.body).toBe(`Doe${i}, Jane`);
      expect(alert.policyId).toBe('pol');
      expect(fakeDb.read<any>(`orgs/${ORG}/patients/${pid}`)!.remindedMilestones.sort()).toEqual(['hope_admission:2026-09-24', 'noe:2026-09-25']);
    });
    expect(await checkOrgDeadlines(ORG, org, '2026-09-23')).toBe(0);
  });
});

describe('checkOrgMissedVisits (bounded concurrency)', () => {
  it('marks every overdue visit missed once and alerts the assignee or care team plus admins', async () => {
    const now = Date.now();
    fakeDb.seed(`orgs/${ORG}/patients/p1`, { firstName: 'Ann', lastName: 'Lee', status: 'admitted', careTeamUids: ['b'] });
    for (let i = 0; i < 12; i++) {
      fakeDb.seed(`orgs/${ORG}/visits/v${i}`, {
        patientId: 'p1', patientName: 'Lee, Ann', discipline: 'RN', assignedUid: i % 3 === 0 ? null : 'c',
        scheduledStart: Timestamp.fromMillis(now - (10 + i) * 3_600_000), scheduledEnd: Timestamp.fromMillis(now - (9 + i) * 3_600_000),
        status: 'scheduled', note: null, completedAt: null, completedBy: null, cancelledReason: null, createdBy: 'a', createdAt: Timestamp.now(), updatedAt: Timestamp.now(),
      });
    }
    const org = fakeDb.read<Org>(`orgs/${ORG}`)!;
    expect(await checkOrgMissedVisits(ORG, org, new Date(now))).toBe(12);
    for (let i = 0; i < 12; i++) {
      expect(fakeDb.read<any>(`orgs/${ORG}/visits/v${i}`)!.status).toBe('missed');
      expect(fakeDb.read<any>(`orgs/${ORG}/alerts/${missedVisitAlertId(`v${i}`)}`)!.targetUids).toEqual(i % 3 === 0 ? ['a', 'b'] : ['a', 'c']);
    }
    expect(docsIn(`orgs/${ORG}/auditLogs`).filter((l) => l.data.action === 'visit.missed')).toHaveLength(12);
    expect(await checkOrgMissedVisits(ORG, org, new Date(now))).toBe(0);
  });
});

function seedAiPatient(id: string, over: Record<string, unknown> = {}) {
  fakeDb.seed(`orgs/${ORG}/patients/${id}`, {
    firstName: 'Ann', lastName: `Lee-${id}`, status: 'admitted', levelOfCare: 'routine', careTeamUids: ['b'], channelId: `pc_${id}`,
    primaryDiagnosis: null, codeStatus: 'DNR', milestones: computeMilestones(new Date(Date.now() - 3 * DAY).toISOString().slice(0, 10)), remindedMilestones: [],
    ...over,
  });
  fakeDb.seed(`orgs/${ORG}/channels/pc_${id}/messages/m-${id}`, {
    senderUid: 'b', senderName: 'User B', body: `note for ${id}`, priority: 'normal', attachments: [], roleTarget: null,
    createdAt: Timestamp.fromMillis(Date.now() - 3_600_000), alertId: null,
  });
}

describe('generateHandoff (parallel loads)', () => {
  it('keeps patient sections in name order with each patient’s activity', async () => {
    for (const id of ['p4', 'p2', 'p3', 'p1']) seedAiPatient(id);
    const calls: TextGenerationInput[] = [];
    const gen: TextGenerator = { generate: async (input) => (calls.push(input), { text: 'HANDOFF', model: 'm' }) };
    await generateHandoffHandler(req({ orgId: ORG }, { uid: 'b' }), { generator: gen });
    const prompt = calls[0]!.prompt;
    const pos = ['p1', 'p2', 'p3', 'p4'].map((id) => prompt.indexOf(`Lee-${id}, Ann`));
    expect(pos.every((p) => p >= 0)).toBe(true);
    expect([...pos].sort((a, b) => a - b)).toEqual(pos);
    for (const id of ['p1', 'p2', 'p3', 'p4']) expect(prompt).toContain(`note for ${id}`);
  });
});

describe('generateIdgPrep (bounded concurrency)', () => {
  const meetingPath = `orgs/${ORG}/idgMeetings/mt1`;
  const agenda = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
  beforeEach(() => {
    agenda.forEach((id) => seedAiPatient(id));
    fakeDb.seed(meetingPath, {
      title: 'IDG', teamId: null, scheduledAt: Timestamp.fromMillis(Date.now() + DAY), status: 'scheduled', attendeeUids: ['c'],
      patientIds: agenda, patientNames: {}, notes: {}, aiPrep: {}, createdBy: 'a', createdAt: Timestamp.now(), completedAt: null, completedBy: null,
    });
  });

  it('reports patients in agenda order even when generations finish out of order', async () => {
    const gen: TextGenerator = {
      generate: async (input) => {
        const id = /Lee-(p\d)/.exec(input.prompt)![1]!;
        await sleep(40 - Number(id.slice(1)) * 5); // later patients finish first
        return { text: `PREP ${id}`, model: 'm' };
      },
    };
    const res = await generateIdgPrepHandler(req({ orgId: ORG, meetingId: 'mt1' }, { uid: 'c' }), { generator: gen });
    expect(res).toEqual({ generatedPatientIds: agenda, failedPatientIds: [] });
    const prep = fakeDb.read<any>(meetingPath)!.aiPrep;
    for (const id of agenda) expect(prep[id].text.startsWith(`PREP ${id}`)).toBe(true);
  });

  it('keeps going after a non-fatal failure and lists failures in agenda order', async () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const gen: TextGenerator = {
      generate: async (input) => {
        if (/Lee-(p3|p5)/.test(input.prompt)) throw Object.assign(new Error('server'), { status: 500 });
        return { text: 'ok', model: 'm' };
      },
    };
    const res = await generateIdgPrepHandler(req({ orgId: ORG, meetingId: 'mt1' }, { uid: 'c' }), { generator: gen });
    expect(res).toEqual({ generatedPatientIds: ['p1', 'p2', 'p4', 'p6'], failedPatientIds: ['p3', 'p5'] });
    spy.mockRestore();
  });
});

describe('recordDeath (patient and care team read once)', () => {
  it('assigns the care-team social worker and instantiates the death template', async () => {
    fakeDb.seed(`orgs/${ORG}/members/s`, member('s', 'clinician', { discipline: 'SW' }));
    const { patientId } = await admitPatientHandler(req(admitReq({ careTeamUids: ['c', 's'] }), { uid: 'b' }));
    fakeDb.reads = 0;
    await recordDeathHandler(req({ orgId: ORG, patientId, date: '2026-09-24' }, { uid: 'c' }));
    const p = fakeDb.read<any>(`orgs/${ORG}/patients/${patientId}`)!;
    expect(p.status).toBe('deceased');
    expect(fakeDb.read<any>(`orgs/${ORG}/bereavementPlans/${p.bereavementPlanId}`)!.assignedUid).toBe('s');
    const tasks = docsIn(`orgs/${ORG}/tasks`).filter((t) => t.data.source?.event === 'death');
    expect(tasks.find((t) => t.data.discipline === 'SW')!.data.assigneeUid).toBe('s');
    expect(tasks.find((t) => t.data.discipline === 'RN')!.data.assigneeUid).toBe('c');
    // caller's member doc (requireOrg), patient + 2 members + template, then the transaction
    // (patient, channel, visits and tasks queries).
    expect(fakeDb.reads).toBeLessThanOrEqual(1 + 1 + 2 + 1 + 1 + 1 + 1 + 6);
  });
});

describe('raiseAlert (atomic create instead of a read-then-create transaction)', () => {
  const params = {
    orgId: ORG, alertId: 'dl_p1_noe_2026-09-25', title: 'NOE due', body: 'Doe, Jane', priority: 'normal' as const,
    source: { type: 'deadline' as const, patientId: 'p1', milestone: 'noe' as const, dueDate: '2026-09-25' },
    targetUids: ['c'], policyId: 'default' as const, createdBy: 'system',
  };

  it('creates the alert with its audit entry once; a repeat (or concurrent) raise is a no-op', async () => {
    const [first, second] = await Promise.all([raiseAlert(params), raiseAlert({ ...params, title: 'changed' })]);
    expect([first.created, second.created].sort()).toEqual([false, true]);
    expect(first.alertId).toBe(params.alertId);
    expect(second.alertId).toBe(params.alertId);
    expect(await raiseAlert(params)).toEqual({ alertId: params.alertId, created: false });
    const alerts = docsIn(`orgs/${ORG}/alerts`);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.data).toMatchObject({ policyId: 'pol', level: 0, status: 'open', targetUids: ['c'], currentTargetUids: ['c'] });
    expect(docsIn(`orgs/${ORG}/auditLogs`).filter((l) => l.data.action === 'alert.create')).toHaveLength(1);
  });

  it('rethrows other write errors', async () => {
    await expect(raiseAlert({ ...params, alertId: undefined, source: { type: 'manual', patientId: null }, targetUids: [], title: 'x', resolved: { policyId: null, policy: null } })).resolves.toMatchObject({ created: true });
    const failing = Object.assign(new Error('unavailable'), { code: 14 });
    const spy = vi.spyOn(fakeDb, 'batch').mockImplementationOnce(() => ({ create() {}, set() {}, commit: async () => { throw failing; } }) as never);
    await expect(raiseAlert(params)).rejects.toBe(failing);
    spy.mockRestore();
  });
});
