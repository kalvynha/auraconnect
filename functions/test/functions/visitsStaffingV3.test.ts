import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('firebase-admin/firestore', () => import('../fakes/firestore'));
const pushes: Array<{ uids: readonly string[]; title: string }> = [];
vi.mock('../../src/lib/notify', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/notify')>()),
  pushToMembers: vi.fn(async (_org: string, uids: readonly string[], title: string) => {
    pushes.push({ uids, title });
    return { sent: 0, failed: 0, pruned: 0 };
  }),
}));
vi.mock('../../src/lib/tasks', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/tasks')>()),
  enqueueEscalationCheck: vi.fn(async () => undefined),
}));
const claims = new Map<string, Record<string, unknown>>();
vi.mock('firebase-admin/auth', () => ({
  getAuth: () => ({
    getUser: async (uid: string) => ({ uid, customClaims: claims.get(uid) }),
    setCustomUserClaims: async (uid: string, c: Record<string, unknown>) => void claims.set(uid, c),
    revokeRefreshTokens: async () => undefined,
  }),
}));

import { fakeDb, Timestamp } from '../fakes/firestore';
import { cancelVisitHandler, completeVisitHandler, scheduleVisitHandler, updateVisitHandler } from '../../src/visits/visits';
import { checkOrgMissedVisits, missedDigestAlertId, missedVisitAlertId, sendMissedVisitDigest } from '../../src/visits/checkMissedVisits';
import { generateVisitPlanHandler } from '../../src/visits/generateVisitPlan';
import { reassignVisitsHandler } from '../../src/visits/reassignVisits';
import { updateCareTeamHandler } from '../../src/staffing/careTeam';
import { offboardMemberHandler } from '../../src/staffing/offboardMember';
import { handleMemberWritten } from '../../src/org/onMemberWritten';
import { handleOrgUpdated } from '../../src/org/onOrgSettingsUpdated';
import { censusReportHandler, complianceReportHandler } from '../../src/reports/reports';
import { computeMilestones } from '../../src/domain/milestones';
import { planVisitId } from '../../src/domain/visitPlan';
import { loadMetricsInput } from '../../src/metrics/loadMetricsInput';
import { computeDailyMetricsValues } from '../../src/domain/metrics';
import type { Org } from '../../src/shared/types';
import { docsIn, member, ORG, req, seedOrg } from './helpers';

const HOUR = 3_600_000;
const P = (id: string) => `orgs/${ORG}/patients/${id}`;
const V = (id: string) => `orgs/${ORG}/visits/${id}`;
const audit = (action: string) => docsIn(`orgs/${ORG}/auditLogs`).filter((l) => l.data.action === action);

function seedPatient(id: string, over: Record<string, unknown> = {}) {
  fakeDb.seed(P(id), {
    firstName: 'Jane', lastName: 'Doe', status: 'admitted', mrn: 'MRN1', levelOfCare: 'routine', admissionDate: '2026-09-01',
    careTeamUids: ['c', 's'], channelId: `ch_${id}`, milestones: null, remindedMilestones: [], createdBy: 'a',
    createdAt: Timestamp.now(), updatedAt: Timestamp.now(), ...over,
  });
  fakeDb.seed(`orgs/${ORG}/channels/ch_${id}`, { type: 'patient', name: 'Doe, Jane – Care Team', memberUids: ['b', 'c', 's'], patientId: id, archived: false });
}

function seedVisit(id: string, patientId: string, over: Record<string, unknown> = {}) {
  const now = Date.now();
  fakeDb.seed(V(id), {
    patientId, patientName: 'Doe, Jane', discipline: 'RN', assignedUid: 'c',
    scheduledStart: Timestamp.fromMillis(now + 24 * HOUR), scheduledEnd: Timestamp.fromMillis(now + 25 * HOUR),
    status: 'scheduled', note: null, completedAt: null, completedBy: null, cancelledReason: null,
    createdBy: 'b', createdAt: Timestamp.now(), updatedAt: Timestamp.now(), ...over,
  });
}

beforeEach(() => {
  seedOrg();
  pushes.length = 0;
  claims.clear();
  fakeDb.seed(`orgs/${ORG}/members/s`, member('s', 'clinician', { discipline: 'SW' }));
  fakeDb.seed(`orgs/${ORG}/members/d`, member('d', 'clinician'));
  fakeDb.seed(`orgs/${ORG}/members/aide`, member('aide', 'viewer', { discipline: 'Aide' }));
  fakeDb.seed(`orgs/${ORG}/members/sched`, member('sched', 'intake', { discipline: 'Admin', capabilities: ['scheduling'] }));
  fakeDb.seed(`orgs/${ORG}/members/rep`, member('rep', 'clinician', { discipline: 'Admin', capabilities: ['reports'] }));
  fakeDb.seed(`orgs/${ORG}/members/staff`, member('staff', 'clinician', { discipline: 'Admin', capabilities: ['staffing'] }));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('V4 visit permissions', () => {
  it('schedules admission/evaluation visits for referral patients only', async () => {
    seedPatient('r1', { status: 'referral' });
    const start = new Date(Date.now() + HOUR).toISOString();
    const end = new Date(Date.now() + 2 * HOUR).toISOString();
    await expect(scheduleVisitHandler(req({ orgId: ORG, patientId: 'r1', discipline: 'RN', start, end }, { uid: 'b' }))).rejects.toMatchObject({ code: 'failed-precondition' });
    const { id } = await scheduleVisitHandler(req({ orgId: ORG, patientId: 'r1', discipline: 'RN', start, end, type: 'evaluation' as const }, { uid: 'b' }));
    expect(fakeDb.read<any>(V(id))).toMatchObject({ type: 'evaluation', status: 'scheduled' });
    expect(audit('visit.schedule')[0]!.data.metadata).toMatchObject({ type: 'evaluation' });
    // Viewers without `scheduling` cannot schedule.
    await expect(scheduleVisitHandler(req({ orgId: ORG, patientId: 'r1', discipline: 'RN', start, end, type: 'admission' as const }, { uid: 'aide', role: 'viewer' }))).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('scheduling holders, creators and care team may update/cancel; others may not', async () => {
    seedPatient('p1');
    seedVisit('v1', 'p1', { assignedUid: 'd', createdBy: 'b' });
    fakeDb.seed(`orgs/${ORG}/members/e`, member('e'));
    await expect(cancelVisitHandler(req({ orgId: ORG, visitId: 'v1', reason: 'x' }, { uid: 'e' }))).rejects.toMatchObject({ code: 'permission-denied' });
    await updateVisitHandler(req({ orgId: ORG, visitId: 'v1', assignedUid: 'c' }, { uid: 'sched', role: 'intake' }));
    expect(fakeDb.read<any>(V('v1'))!.assignedUid).toBe('c');
    await updateVisitHandler(req({ orgId: ORG, visitId: 'v1', note: 'Gate code 12' }, { uid: 'b' })); // creator
    await cancelVisitHandler(req({ orgId: ORG, visitId: 'v1', reason: 'Hospitalized' }, { uid: 'sched', role: 'intake' }));
    expect(fakeDb.read<any>(V('v1'))).toMatchObject({ status: 'cancelled', note: 'Gate code 12' });
  });

  it('aide viewers complete only their own visits', async () => {
    seedPatient('p1');
    seedVisit('mine', 'p1', { assignedUid: 'aide', discipline: 'Aide' });
    seedVisit('theirs', 'p1', { assignedUid: 'd' });
    await expect(completeVisitHandler(req({ orgId: ORG, visitId: 'theirs' }, { uid: 'aide', role: 'viewer' }))).rejects.toMatchObject({ code: 'permission-denied' });
    await completeVisitHandler(req({ orgId: ORG, visitId: 'mine', note: 'Bath given' }, { uid: 'aide', role: 'viewer' }));
    expect(fakeDb.read<any>(V('mine'))).toMatchObject({ status: 'completed', completedBy: 'aide' });
    // A non-field viewer is refused outright.
    await expect(completeVisitHandler(req({ orgId: ORG, visitId: 'theirs' }, { uid: 'v', role: 'viewer' }))).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('missed visits reschedule to the future only, and late completion or reschedule resolves the vm_ alert', async () => {
    seedPatient('p1');
    const past = (h: number) => Timestamp.fromMillis(Date.now() - h * HOUR);
    seedVisit('m1', 'p1', { status: 'missed', scheduledStart: past(5), scheduledEnd: past(4) });
    seedVisit('m2', 'p1', { status: 'missed', scheduledStart: past(5), scheduledEnd: past(4) });
    for (const id of ['m1', 'm2']) {
      fakeDb.seed(`orgs/${ORG}/alerts/${missedVisitAlertId(id)}`, { status: 'open', ackedBy: null, targetUids: ['c'], source: { type: 'visit_missed', visitId: id, patientId: 'p1' } });
    }
    await expect(updateVisitHandler(req({ orgId: ORG, visitId: 'm1', note: 'x' }, { uid: 'c' }))).rejects.toMatchObject({ code: 'failed-precondition' });
    await expect(updateVisitHandler(req({ orgId: ORG, visitId: 'm1', start: new Date(Date.now() - HOUR).toISOString() }, { uid: 'c' }))).rejects.toMatchObject({ code: 'invalid-argument' });
    const newStart = Date.now() + 48 * HOUR;
    await updateVisitHandler(req({ orgId: ORG, visitId: 'm1', start: new Date(newStart).toISOString() }, { uid: 'c' }));
    const m1 = fakeDb.read<any>(V('m1'))!;
    expect(m1.status).toBe('scheduled');
    expect(m1.scheduledEnd.toMillis() - m1.scheduledStart.toMillis()).toBe(HOUR); // length kept
    expect(fakeDb.read<any>(`orgs/${ORG}/alerts/${missedVisitAlertId('m1')}`)).toMatchObject({ status: 'resolved', ackedBy: 'c' });

    await completeVisitHandler(req({ orgId: ORG, visitId: 'm2', note: 'Late entry' }, { uid: 'c' }));
    expect(fakeDb.read<any>(`orgs/${ORG}/alerts/${missedVisitAlertId('m2')}`)!.status).toBe('resolved');
    expect(audit('alert.resolve').map((l) => l.data.metadata.reason).sort()).toEqual(['visit_completed', 'visit_rescheduled']);
  });
});

describe('V1 missed-visit alert modes and digest', () => {
  const ago = (h: number) => Timestamp.fromMillis(Date.now() - h * HOUR);

  it('assignee_admins adds admins; digest and off raise no per-visit alert', async () => {
    seedPatient('p1');
    seedVisit('a1', 'p1', { assignedUid: 'd', scheduledStart: ago(6), scheduledEnd: ago(5) });
    await checkOrgMissedVisits(ORG, { ...fakeDb.read<Org>(`orgs/${ORG}`)!, missedVisitAlertMode: 'assignee_admins' }, new Date());
    expect(fakeDb.read<any>(`orgs/${ORG}/alerts/${missedVisitAlertId('a1')}`)!.targetUids).toEqual(['a', 'd']);

    seedVisit('a2', 'p1', { scheduledStart: ago(6), scheduledEnd: ago(5) });
    seedVisit('a3', 'p1', { scheduledStart: ago(6), scheduledEnd: ago(5) });
    expect(await checkOrgMissedVisits(ORG, { ...fakeDb.read<Org>(`orgs/${ORG}`)!, missedVisitAlertMode: 'digest' }, new Date())).toBe(0);
    expect(fakeDb.read<any>(V('a2'))!.status).toBe('missed');
    expect(await checkOrgMissedVisits(ORG, { ...fakeDb.read<Org>(`orgs/${ORG}`)!, missedVisitAlertMode: 'off' }, new Date())).toBe(0);
    expect(fakeDb.read(`orgs/${ORG}/alerts/${missedVisitAlertId('a2')}`)).toBeUndefined();
  });

  it('sends one PHI-free digest at 07:00 local to admins and scheduling holders', async () => {
    seedPatient('p1');
    seedVisit('x1', 'p1', { status: 'missed', scheduledStart: ago(6), scheduledEnd: ago(5) });
    seedVisit('x2', 'p1', { status: 'missed', scheduledStart: ago(30), scheduledEnd: ago(29) }); // older than 24 h
    const org = { ...fakeDb.read<Org>(`orgs/${ORG}`)!, timezone: 'UTC' };
    const at7 = new Date();
    at7.setUTCHours(7, 10, 0, 0);
    seedVisit('x3', 'p1', { status: 'missed', scheduledStart: Timestamp.fromMillis(at7.getTime() - 3 * HOUR), scheduledEnd: Timestamp.fromMillis(at7.getTime() - 2 * HOUR) });
    const at9 = new Date(at7.getTime() + 2 * HOUR);
    expect(await sendMissedVisitDigest(ORG, org, at9)).toBe(0);
    expect(await sendMissedVisitDigest(ORG, { ...org, missedVisitAlertMode: 'off' }, at7)).toBe(0);
    const n = await sendMissedVisitDigest(ORG, org, at7);
    expect(n).toBeGreaterThanOrEqual(1);
    const date = at7.toISOString().slice(0, 10);
    const alert = fakeDb.read<any>(`orgs/${ORG}/alerts/${missedDigestAlertId(date)}`)!;
    expect(alert.targetUids).toEqual(['a', 'sched']);
    expect(alert.source).toMatchObject({ type: 'visit_missed_digest', date, patientId: null });
    expect(alert.body).not.toContain('Doe');
    expect(await sendMissedVisitDigest(ORG, org, at7)).toBe(0); // idempotent per day
  });
});

describe('V2 generateVisitPlan', () => {
  it('dry-runs, then creates idempotently; scheduling capability required', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
    seedPatient('p1', { visitFrequencies: [{ discipline: 'RN', perWeek: 2, notes: null }, { discipline: 'SW', perWeek: 0.5, notes: null }] });
    fakeDb.seed(`orgs/${ORG}/members/c`, member('c', 'clinician', { discipline: 'RN' }));
    const reqData = { orgId: ORG, weekStart: '2026-10-05', dryRun: true };
    await expect(generateVisitPlanHandler(req(reqData, { uid: 'b' }))).rejects.toMatchObject({ code: 'permission-denied' });

    const dry = await generateVisitPlanHandler(req(reqData, { uid: 'sched', role: 'intake' }));
    const rn = dry.visits.filter((v) => v.discipline === 'RN');
    expect(rn.map((v) => v.assignedUid)).toEqual(['c', 'c']);
    expect(dry.created).toBe(0);
    expect(docsIn(`orgs/${ORG}/visits`)).toHaveLength(0);

    const real = await generateVisitPlanHandler(req({ ...reqData, dryRun: false }, { uid: 'sched', role: 'intake' }));
    expect(real.created).toBe(dry.visits.length);
    expect(fakeDb.read<any>(V(planVisitId('p1', 'RN', '2026-10-05', 1)))).toMatchObject({ status: 'scheduled', assignedUid: 'c', type: 'routine', createdBy: 'sched', patientName: 'Doe, Jane' });
    expect(audit('visit.plan')).toHaveLength(1);
    expect(audit('visit.schedule')).toHaveLength(real.created);

    const again = await generateVisitPlanHandler(req({ ...reqData, dryRun: false }, { uid: 'a', role: 'admin' }));
    expect(again).toMatchObject({ created: 0, visits: [], existing: real.created });
  });
});

describe('V3 reassignVisits', () => {
  it('moves scheduled visits in chunks, skips others, audits and pushes once', async () => {
    seedPatient('p1');
    const ids = Array.from({ length: 55 }, (_, i) => `r${i}`);
    for (const id of ids) seedVisit(id, 'p1', { assignedUid: 'c' });
    seedVisit('done', 'p1', { status: 'completed' });
    await expect(reassignVisitsHandler(req({ orgId: ORG, visitIds: ids, assignedUid: 'd', reason: 'Sick call' }, { uid: 'b' }))).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(reassignVisitsHandler(req({ orgId: ORG, visitIds: ids, assignedUid: 'x', reason: 'Sick call' }, { uid: 'sched', role: 'intake' }))).rejects.toMatchObject({ code: 'invalid-argument' });
    const res = await reassignVisitsHandler(req({ orgId: ORG, visitIds: [...ids, 'done', 'nope'], assignedUid: 'd', reason: 'Sick call' }, { uid: 'staff' }));
    expect(res.reassigned).toBe(55);
    expect(res.skipped).toEqual([{ visitId: 'done', reason: 'status_completed' }, { visitId: 'nope', reason: 'not_found' }]);
    expect(ids.every((id) => fakeDb.read<any>(V(id))!.assignedUid === 'd')).toBe(true);
    expect(audit('visit.reassign')).toHaveLength(55);
    expect(pushes).toEqual([{ uids: ['d'], title: '55 visits were assigned to you' }]);
  });
});

describe('L1 updateCareTeam', () => {
  it('syncs the channel, appends an event and audits; licensed care-team members or staffing only', async () => {
    seedPatient('p1');
    await expect(updateCareTeamHandler(req({ orgId: ORG, patientId: 'p1', add: ['d'] }, { uid: 's' }))).rejects.toMatchObject({ code: 'permission-denied' }); // SW
    await expect(updateCareTeamHandler(req({ orgId: ORG, patientId: 'p1', add: ['d'] }, { uid: 'b' }))).rejects.toMatchObject({ code: 'permission-denied' }); // RN, not on team
    const res = await updateCareTeamHandler(req({ orgId: ORG, patientId: 'p1', add: ['d'], remove: ['s'] }, { uid: 'c' }));
    expect(res.careTeamUids).toEqual(['c', 'd']);
    expect(fakeDb.read<any>(`orgs/${ORG}/channels/ch_p1`)!.memberUids).toEqual(['b', 'c', 'd']);
    const events = docsIn(`${P('p1')}/events`);
    expect(events.map((e) => e.data.type)).toEqual(['care_team_change']);
    expect(events[0]!.data.details).toMatchObject({ added: ['d'], removed: ['s'] });
    expect(audit('patient.care_team')[0]!.data).toMatchObject({ actorUid: 'c', patientId: 'p1' });
    await updateCareTeamHandler(req({ orgId: ORG, patientId: 'p1', add: ['s'] }, { uid: 'staff' }));
    await expect(updateCareTeamHandler(req({ orgId: ORG, patientId: 'p1', add: ['x'] }, { uid: 'staff' }))).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});

describe('L1 offboardMember', () => {
  it('dry-run counts, then reassigns everything and deactivates', async () => {
    const future = Timestamp.fromMillis(Date.now() + 24 * HOUR);
    seedPatient('p1', { careTeamUids: ['c', 's'] });
    seedPatient('p2', { careTeamUids: ['c'], status: 'discharged' });
    seedVisit('fv', 'p1', { assignedUid: 'c' });
    seedVisit('pv', 'p1', { assignedUid: 'c', scheduledStart: Timestamp.fromMillis(Date.now() - 48 * HOUR), scheduledEnd: Timestamp.fromMillis(Date.now() - 47 * HOUR), status: 'completed' });
    fakeDb.seed(`orgs/${ORG}/tasks/t1`, { title: 'Call', assigneeUid: 'c', status: 'open', discipline: 'RN', patientId: 'p1' });
    fakeDb.seed(`orgs/${ORG}/tasks/t2`, { title: 'Chaplain', assigneeUid: 'c', status: 'open', discipline: 'Chaplain', patientId: 'p1' });
    fakeDb.seed(`orgs/${ORG}/bereavementPlans/bp`, { assignedUid: 'c', status: 'active', patientId: 'p2' });
    fakeDb.seed(`orgs/${ORG}/triageCalls/tc`, { assignedUid: 'c', status: 'open', patientId: 'p1' });
    fakeDb.seed(`orgs/${ORG}/shifts/sh`, { roleKey: 'oncall-rn', uid: 'c', start: future, end: Timestamp.fromMillis(Date.now() + 36 * HOUR), notes: null });
    fakeDb.seed(`orgs/${ORG}/onCallRoles/oncall-rn`, { label: 'On-call RN', discipline: 'RN', teamId: null, fallbackUids: ['c', 'b'] });
    fakeDb.seed(`orgs/${ORG}/teams/north`, { name: 'North', memberUids: ['c', 'b'] });
    fakeDb.seed(`orgs/${ORG}/volunteerAssignments/va`, { volunteerUid: 'c', status: 'active', patientId: 'p1' });
    fakeDb.seed(`orgs/${ORG}/escalationPolicies/pc`, { name: 'Night', steps: [{ target: { kind: 'uid', uid: 'c' }, waitMinutes: 5 }] });

    const body = { orgId: ORG, uid: 'c', reassignTo: { byDiscipline: { RN: 'd' } }, shiftAction: 'reassign' as const, dryRun: true };
    await expect(offboardMemberHandler(req(body, { uid: 'b' }))).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(offboardMemberHandler(req({ ...body, uid: 'staff' }, { uid: 'staff' }))).rejects.toMatchObject({ code: 'failed-precondition' });
    const dry = await offboardMemberHandler(req(body, { uid: 'staff' }));
    expect(dry.counts).toEqual({ careTeams: 1, tasks: 2, visits: 1, bereavementPlans: 1, triageCalls: 1, shifts: 1, onCallRoles: 1, teams: 1, volunteerAssignments: 1 });
    expect(dry.unassigned).toEqual({ tasks: 1 });
    expect(dry.escalationPolicies).toEqual([{ id: 'pc', name: 'Night' }]);
    expect(fakeDb.read<any>(`orgs/${ORG}/members/c`)!.active).toBe(true);

    const res = await offboardMemberHandler(req({ ...body, dryRun: false }, { uid: 'staff' }));
    expect(res.deactivated).toBe(true);
    expect(fakeDb.read<any>(P('p1'))!.careTeamUids).toEqual(['s', 'd']);
    expect(fakeDb.read<any>(P('p2'))!.careTeamUids).toEqual(['c']); // discharged: untouched
    expect(fakeDb.read<any>(`orgs/${ORG}/channels/ch_p1`)!.memberUids).toEqual(['b', 's', 'd']);
    expect(fakeDb.read<any>(V('fv'))!.assignedUid).toBe('d');
    expect(fakeDb.read<any>(V('pv'))!.assignedUid).toBe('c');
    expect(fakeDb.read<any>(`orgs/${ORG}/tasks/t1`)!.assigneeUid).toBe('d');
    expect(fakeDb.read<any>(`orgs/${ORG}/tasks/t2`)!.assigneeUid).toBeNull();
    expect(fakeDb.read<any>(`orgs/${ORG}/bereavementPlans/bp`)!.assignedUid).toBe('d');
    expect(fakeDb.read<any>(`orgs/${ORG}/triageCalls/tc`)!.assignedUid).toBe('d');
    expect(fakeDb.read<any>(`orgs/${ORG}/shifts/sh`)!.uid).toBe('d');
    expect(fakeDb.read<any>(`orgs/${ORG}/onCallRoles/oncall-rn`)!.fallbackUids).toEqual(['b', 'd']);
    expect(fakeDb.read<any>(`orgs/${ORG}/teams/north`)!.memberUids).toEqual(['b']);
    expect(fakeDb.read<any>(`orgs/${ORG}/volunteerAssignments/va`)!.status).toBe('ended');
    expect(fakeDb.read<any>(`orgs/${ORG}/members/c`)).toMatchObject({ active: false, teamIds: [] });
    expect(audit('member.offboard').length).toBeGreaterThanOrEqual(9);
  });

  it('refuses to offboard the last admin and deletes shifts on request', async () => {
    fakeDb.seed(`orgs/${ORG}/members/a2`, member('a2', 'admin', { active: false }));
    await expect(offboardMemberHandler(req({ orgId: ORG, uid: 'a', reassignTo: {}, shiftAction: 'delete', dryRun: true }, { uid: 'staff' }))).rejects.toMatchObject({ code: 'permission-denied' });
    fakeDb.seed(`orgs/${ORG}/shifts/sh`, { roleKey: 'r', uid: 'b', start: Timestamp.now(), end: Timestamp.fromMillis(Date.now() + HOUR), notes: null });
    await offboardMemberHandler(req({ orgId: ORG, uid: 'b', reassignTo: {}, shiftAction: 'delete', dryRun: false }, { uid: 'a', role: 'admin' }));
    expect(fakeDb.read(`orgs/${ORG}/shifts/sh`)).toBeUndefined();
  });
});

describe('admin guardrails', () => {
  it('reverts a change that would leave no active admin, and audits member changes', async () => {
    const before = member('a', 'admin');
    await fakeDb.doc(`orgs/${ORG}/members/a`).update({ role: 'clinician' });
    expect(await handleMemberWritten(ORG, 'a', before as any, { ...before, role: 'clinician' } as any, 'a')).toBe('reverted');
    expect(fakeDb.read<any>(`orgs/${ORG}/members/a`)).toMatchObject({ role: 'admin', active: true });
    expect(audit('member.update')[0]!.data.metadata).toMatchObject({ reverted: true, reason: 'last_active_admin' });

    const b = member('b');
    expect(await handleMemberWritten(ORG, 'b', b as any, { ...b, capabilities: ['reports'] } as any, 'a')).toBe('skipped');
    expect(await handleMemberWritten(ORG, 'b', b as any, { ...b, active: false } as any, 'a')).toBe('revoked');
    expect(audit('member.update').at(-1)!.data.metadata).toMatchObject({ fields: ['capabilities'] });
    expect(audit('member.deactivate')[0]!.data).toMatchObject({ actorUid: 'a', resourceId: 'b' });
    // fcm-token-only edits are not audited.
    const n = docsIn(`orgs/${ORG}/auditLogs`).length;
    await handleMemberWritten(ORG, 'b', b as any, { ...b, fcmTokens: ['t2'] } as any, 'b');
    expect(docsIn(`orgs/${ORG}/auditLogs`)).toHaveLength(n);
  });

  it('audits org settings changes with from/to', async () => {
    expect(await handleOrgUpdated(ORG, { name: 'X', missedVisitGraceMinutes: 120 }, { name: 'X', missedVisitGraceMinutes: 60, missedVisitAlertMode: 'digest' }, 'a')).toBe(true);
    expect(audit('org.settings_update')[0]!.data.metadata).toEqual({
      fields: ['missedVisitAlertMode', 'missedVisitGraceMinutes'],
      changes: { missedVisitAlertMode: { from: null, to: 'digest' }, missedVisitGraceMinutes: { from: 120, to: 60 } },
    });
    expect(await handleOrgUpdated(ORG, { name: 'X' }, { name: 'X' }, 'a')).toBe(false);
  });
});

describe('L4 reports', () => {
  it('compliance rows for admitted and recently discharged patients; reports capability required', async () => {
    seedPatient('p1', { admissionDate: '2026-09-01', milestones: computeMilestones('2026-09-01'), milestoneCompletions: {
      'noe:2026-09-06': { completedAt: Timestamp.fromMillis(Date.parse('2026-09-09T15:00:00Z')), completedBy: 'c', note: null, effectiveDate: '2026-09-05' },
      'hope_admission:2026-09-05': { completedAt: Timestamp.fromMillis(Date.parse('2026-09-07T15:00:00Z')), completedBy: 'c', note: null },
    } });
    seedPatient('p2', { status: 'discharged', admissionDate: '2026-08-20', dischargeDate: '2026-09-03', dischargeReason: 'revocation', milestones: computeMilestones('2026-08-20') });
    seedPatient('p3', { status: 'discharged', admissionDate: '2026-01-01', dischargeDate: '2026-02-01', milestones: computeMilestones('2026-01-01') });
    const body = { orgId: ORG, from: '2026-09-01', to: '2026-09-10', kinds: ['noe', 'hope_admission'] as any };
    await expect(complianceReportHandler(req(body, { uid: 'b' }))).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(complianceReportHandler(req({ ...body, to: '2028-01-01' }, { uid: 'rep' }))).rejects.toMatchObject({ code: 'invalid-argument' });
    const res = await complianceReportHandler(req(body, { uid: 'rep' }));
    expect(res.patientsScanned).toBe(2);
    expect(res.rows.map((r) => [r.patientId, r.kind, r.status, r.effectiveDate, r.daysLate])).toEqual([
      ['p1', 'hope_admission', 'late', '2026-09-07', 2],
      ['p1', 'noe', 'on_time', '2026-09-05', 0],
    ]);
    expect(audit('report.compliance')).toHaveLength(1);

    const census = await censusReportHandler(req({ orgId: ORG, from: '2026-09-01', to: '2026-09-10' }, { uid: 'rep' }));
    expect(census).toMatchObject({ admissions: 1, discharges: 1, deaths: 0, censusAtStart: 2, censusAtEnd: 1 });
    expect(census.roster.map((r) => r.patientId).sort()).toEqual(['p1', 'p2']);
  });
});

describe('metrics use completionDate (effectiveDate first)', () => {
  it('counts a completion filed on time but marked complete late as on time', async () => {
    seedPatient('p1', { admissionDate: '2026-09-01', milestones: computeMilestones('2026-09-01'), milestoneCompletions: {
      'noe:2026-09-06': { completedAt: Timestamp.fromMillis(Date.parse('2026-09-09T15:00:00Z')), completedBy: 'c', note: null, effectiveDate: '2026-09-05' },
      'hope_admission:2026-09-05': { completedAt: Timestamp.fromMillis(Date.parse('2026-09-07T15:00:00Z')), completedBy: 'c', note: null },
    } });
    const input = await loadMetricsInput(ORG, { timezone: 'America/New_York' }, '2026-09-20');
    const m = computeDailyMetricsValues(input);
    expect(m.deadlines).toMatchObject({ completedOnTime30d: 1, completedLate30d: 1 });
  });
});
