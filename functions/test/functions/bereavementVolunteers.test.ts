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

import { fakeDb, Timestamp } from '../fakes/firestore';
import {
  reassessBereavementRiskHandler,
  updateBereavementContactHandler,
  updateBereavementContactsHandler,
  updateBereavementPlanHandler,
} from '../../src/bereavement/bereavement';
import { exportBereavementMailingHandler } from '../../src/bereavement/mailing';
import { closeExpiredPlansForOrg } from '../../src/bereavement/closeExpired';
import { resolveBereavementCoordinator } from '../../src/bereavement/coordinator';
import { buildBereavementSchedule, pendingContact } from '../../src/domain/bereavement';
import { backfillVolunteerUidsHandler, handleVolunteerAssignmentWritten } from '../../src/volunteers/volunteerUids';
import { handleStaffHoursWritten, voidVolunteerLogHandler, volunteerComplianceReportHandler } from '../../src/volunteers/volunteers';
import { computeDailyMetricsValues } from '../../src/domain/metrics';
import { docsIn, member, ORG, req, seedOrg } from './helpers';

const PLANS = `orgs/${ORG}/bereavementPlans`;
const audit = (action: string) => docsIn(`orgs/${ORG}/auditLogs`).filter((l) => l.data.action === action);
const ADDR = { line1: '1 Main St', line2: null, city: 'Springfield', state: 'IL', zip: '62701' };

function seedPlan(id: string, over: Record<string, unknown> = {}) {
  fakeDb.seed(`${PLANS}/${id}`, {
    patientId: `pat-${id}`,
    patientName: `Doe, ${id}`,
    deathDate: '2026-08-01',
    primaryContact: { name: 'John Doe', relationship: 'son', phone: '555-0100' },
    riskLevel: 'low',
    assignedUid: 'b',
    contacts: buildBereavementSchedule('2026-08-01').map(pendingContact),
    status: 'active',
    closesOn: '2027-09-01',
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
    ...over,
  });
}
const plan = (id: string) => fakeDb.read<any>(`${PLANS}/${id}`)!;
const contact = (id: string, cid: string) => plan(id).contacts.find((c: any) => c.id === cid);

beforeEach(() => {
  seedOrg();
  fakeDb.seed(`orgs/${ORG}/members/sw`, member('sw', 'clinician', { discipline: 'SW' }));
  fakeDb.seed(`orgs/${ORG}/members/bc`, member('bc', 'viewer', { discipline: 'Other', capabilities: ['bereavement'] }));
  fakeDb.seed(`orgs/${ORG}/members/vc`, member('vc', 'clinician', { discipline: 'Other', capabilities: ['volunteers'] }));
  fakeDb.seed(`orgs/${ORG}/members/rp`, member('rp', 'clinician', { discipline: 'Other', capabilities: ['reports'] }));
  fakeDb.seed(`orgs/${ORG}/members/vol`, member('vol', 'viewer', { discipline: 'Volunteer' }));
});

describe('bereavement permissions (H4)', () => {
  it('lets the coordinator, SW/Chaplain, the capability and admins work a plan; denies other clinicians', async () => {
    seedPlan('p1'); // assigned to b
    const body = { orgId: ORG, planId: 'p1', contactId: 'd3-call', status: 'done' as const };
    await expect(updateBereavementContactHandler(req(body, { uid: 'c' }))).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(updateBereavementContactHandler(req(body, { uid: 'vol', role: 'viewer' }))).rejects.toMatchObject({ code: 'permission-denied' });
    await updateBereavementContactHandler(req(body, { uid: 'b' }));
    await updateBereavementContactHandler(req({ ...body, contactId: 'd7-letter' }, { uid: 'sw' }));
    await updateBereavementContactHandler(req({ ...body, contactId: 'm1-letter' }, { uid: 'bc', role: 'viewer' }));
    await updateBereavementContactHandler(req({ ...body, contactId: 'm2-letter' }, { uid: 'a', role: 'admin' }));
    expect(['d3-call', 'd7-letter', 'm1-letter', 'm2-letter'].map((c) => contact('p1', c).completedBy)).toEqual(['b', 'sw', 'bc', 'a']);
    await expect(updateBereavementPlanHandler(req({ orgId: ORG, planId: 'p1', status: 'closed' }, { uid: 'c' }))).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(updateBereavementContactHandler(req({ ...body, contactId: 'nope' }, { uid: 'b' }))).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('updateBereavementContacts (bulk)', () => {
  it('updates across plans with one transaction/audit per plan and reports per-item failures', async () => {
    seedPlan('p1');
    seedPlan('p2', { assignedUid: 'c' });
    seedPlan('p3', { status: 'closed' });
    const res = await updateBereavementContactsHandler(req({
      orgId: ORG,
      status: 'done',
      note: 'Mailed',
      items: [
        { planId: 'p1', contactId: 'd3-call' },
        { planId: 'p1', contactId: 'd7-letter' },
        { planId: 'p1', contactId: 'missing' },
        { planId: 'p2', contactId: 'd3-call' }, // b is not p2's coordinator
        { planId: 'p3', contactId: 'd3-call' },
        { planId: 'nope', contactId: 'd3-call' },
      ],
    }, { uid: 'b' }));
    expect(res.updated).toBe(2);
    expect(res.failed.map((f) => [f.planId, f.contactId]).sort()).toEqual([
      ['nope', 'd3-call'], ['p1', 'missing'], ['p2', 'd3-call'], ['p3', 'd3-call'],
    ]);
    expect(contact('p1', 'd3-call')).toMatchObject({ status: 'done', completedBy: 'b', note: 'Mailed' });
    expect(contact('p2', 'd3-call').status).toBe('pending');
    const a = audit('bereavement.update');
    expect(a).toHaveLength(1);
    expect(a[0]!.data.metadata).toEqual({ contactIds: ['d3-call', 'd7-letter'], status: 'done', via: 'bulk' });
    await expect(updateBereavementContactsHandler(req({ orgId: ORG, status: 'done', items: Array.from({ length: 201 }, () => ({ planId: 'p1', contactId: 'x' })) }, { uid: 'b' }))).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});

describe('survivors and risk', () => {
  it('replaces survivors, assigns ids, mirrors the primary into primaryContact, and validates', async () => {
    seedPlan('p1');
    await updateBereavementPlanHandler(req({
      orgId: ORG,
      planId: 'p1',
      survivors: [
        { name: 'Ann Doe', relationship: 'daughter', phone: null, email: 'ann@example.org', address: ADDR, preferredContact: 'mail', doNotContact: false, isPrimary: true },
        { id: 'keep', name: 'Bob Doe', relationship: 'son', phone: '1', email: null, address: ADDR, preferredContact: 'phone', doNotContact: true, isPrimary: false },
      ],
    } as any, { uid: 'b' }));
    const p = plan('p1');
    expect(p.survivors.map((s: any) => s.id)).toEqual(['s1', 'keep']);
    expect(p.primaryContact).toMatchObject({ name: 'Ann Doe', email: 'ann@example.org', address: ADDR });
    expect(audit('bereavement.update')[0]!.data.metadata).toEqual({ fields: ['survivors'], survivorCount: 2 });
    const bad = (s: object[]) => updateBereavementPlanHandler(req({ orgId: ORG, planId: 'p1', survivors: s } as any, { uid: 'b' }));
    await expect(bad([{ name: 'A', isPrimary: true }, { name: 'B', isPrimary: true }])).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(bad([{ name: 'A', preferredContact: 'email' }])).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(bad([{ name: 'A', email: 'not-an-email' }])).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('reassessBereavementRisk appends history, adds high-risk contacts once, and completes the assessment contact', async () => {
    seedPlan('p1');
    const r = await reassessBereavementRiskHandler(req({ orgId: ORG, planId: 'p1', level: 'high', note: 'Isolated, not eating' }, { uid: 'sw' }));
    expect(r.addedContactIds).toEqual(['hr-d14-visit', 'hr-m1-call', 'hr-m2-call', 'hr-m3-call']);
    const p = plan('p1');
    expect(p.riskLevel).toBe('high');
    expect(p.riskHistory).toHaveLength(1);
    expect(p.riskHistory[0]).toMatchObject({ level: 'high', previous: 'low', note: 'Isolated, not eating', by: 'sw' });
    expect(p.contacts).toHaveLength(15);
    expect(contact('p1', 'm1-assessment')).toMatchObject({ status: 'done', completedBy: 'sw', note: 'Isolated, not eating' });
    const dates = p.contacts.map((c: any) => c.dueDate);
    expect([...dates].sort()).toEqual(dates);
    // Past-due additions are due "today" (org tz UTC), never before.
    const today = new Date().toISOString().slice(0, 10);
    expect(contact('p1', 'hr-d14-visit').dueDate >= today).toBe(true);
    // Again: no duplicates.
    const again = await reassessBereavementRiskHandler(req({ orgId: ORG, planId: 'p1', level: 'high', note: 'Still high' }, { uid: 'sw' }));
    expect(again.addedContactIds).toEqual([]);
    expect(plan('p1').contacts).toHaveLength(15);
    expect(audit('bereavement.reassess')).toHaveLength(2);
    expect(JSON.stringify(audit('bereavement.reassess').map((x) => x.data.metadata))).not.toContain('Isolated');
    await expect(reassessBereavementRiskHandler(req({ orgId: ORG, planId: 'p1', level: 'low', note: '' }, { uid: 'sw' }))).rejects.toMatchObject({ code: 'invalid-argument' });
    // updateBereavementPlan risk change also records history.
    await updateBereavementPlanHandler(req({ orgId: ORG, planId: 'p1', riskLevel: 'moderate' }, { uid: 'sw' }));
    expect(plan('p1').riskHistory.map((h: any) => h.level)).toEqual(['high', 'high', 'moderate']);
  });

  it('closing and reopening stamps closedAt/closedBy', async () => {
    seedPlan('p1', { needsReview: true });
    await updateBereavementPlanHandler(req({ orgId: ORG, planId: 'p1', status: 'closed' }, { uid: 'b' }));
    expect(plan('p1')).toMatchObject({ status: 'closed', closedBy: 'b', needsReview: false });
    expect(plan('p1').closedAt).toBeInstanceOf(Timestamp);
    await updateBereavementPlanHandler(req({ orgId: ORG, planId: 'p1', status: 'active' }, { uid: 'b' }));
    expect(plan('p1')).toMatchObject({ status: 'active', closedBy: null, closedAt: null });
  });
});

describe('exportBereavementMailing', () => {
  it('returns rows for mail/email survivors, scopes non-coordinators to their plans, and marks done', async () => {
    const survivors = [
      { id: 'a', name: 'Ann', relationship: 'daughter', phone: null, email: null, address: ADDR, preferredContact: 'mail', doNotContact: false, isPrimary: true },
      { id: 'b', name: 'Bob', relationship: 'son', phone: '1', email: null, address: ADDR, preferredContact: 'phone', doNotContact: false, isPrimary: false },
      { id: 'c', name: 'Cy', relationship: 'son', phone: null, email: 'cy@x.org', address: ADDR, preferredContact: 'email', doNotContact: true, isPrimary: false },
    ];
    seedPlan('p1', { survivors }); // assigned b; d7-letter due 2026-08-08, m1-letter 2026-09-01
    seedPlan('p2', { survivors, assignedUid: 'c' });
    seedPlan('p3'); // legacy primaryContact (phone only) → no rows
    const body = { orgId: ORG, from: '2026-08-05', to: '2026-08-31', types: ['letter' as const] };

    const mine = await exportBereavementMailingHandler(req(body, { uid: 'b' }));
    expect(mine.rows.map((r) => [r.planId, r.contactId, r.survivorName])).toEqual([['p1', 'd7-letter', 'Ann']]);

    const all = await exportBereavementMailingHandler(req({ ...body, markDone: true }, { uid: 'bc', role: 'viewer' }));
    expect(all.rows.map((r) => r.planId).sort()).toEqual(['p1', 'p2']);
    expect(all).toMatchObject({ contactCount: 2, marked: 2, truncated: false });
    expect(contact('p1', 'd7-letter')).toMatchObject({ status: 'done', completedBy: 'bc' });
    expect(contact('p1', 'm1-letter').status).toBe('pending');
    // Already done: exporting again finds nothing.
    expect((await exportBereavementMailingHandler(req(body, { uid: 'bc', role: 'viewer' }))).rows).toEqual([]);
    const ex = audit('bereavement.mailing_export');
    expect(ex).toHaveLength(3);
    expect(JSON.stringify(ex.map((x) => x.data.metadata))).not.toMatch(/Ann|Main St|Doe/);

    await expect(exportBereavementMailingHandler(req({ ...body, to: '2026-12-31' }, { uid: 'bc', role: 'viewer' }))).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(exportBereavementMailingHandler(req(body, { uid: 'vol', role: 'viewer' }))).rejects.toMatchObject({ code: 'permission-denied' });
  });
});

describe('closeExpiredBereavementPlans', () => {
  it('closes expired fully-handled plans, flags the rest once, ignores unexpired', async () => {
    const handled = buildBereavementSchedule('2025-01-01').map((c) => ({ ...pendingContact(c), status: 'done' }));
    seedPlan('done', { closesOn: '2026-02-01', contacts: handled });
    seedPlan('pending', { closesOn: '2026-02-01', contacts: buildBereavementSchedule('2025-01-01').map(pendingContact) });
    seedPlan('future', { closesOn: '2026-12-01' });
    expect(await closeExpiredPlansForOrg(ORG, '2026-03-01')).toEqual({ closed: 1, flagged: 1 });
    expect(plan('done')).toMatchObject({ status: 'closed', closedBy: 'system' });
    expect(plan('pending')).toMatchObject({ status: 'active', needsReview: true });
    expect(plan('future').status).toBe('active');
    expect(await closeExpiredPlansForOrg(ORG, '2026-03-02')).toEqual({ closed: 0, flagged: 0 });
    expect(audit('bereavement.close')).toHaveLength(1);
  });
});

describe('default bereavement coordinator', () => {
  it('uses the org setting when active, else the care-team SW', async () => {
    const team = [{ uid: 'sw', discipline: 'SW' as const }];
    expect(await resolveBereavementCoordinator(ORG, team)).toBe('sw');
    fakeDb.write(`orgs/${ORG}`, { defaultBereavementCoordinatorUid: 'bc' }, 'update');
    expect(await resolveBereavementCoordinator(ORG, team)).toBe('bc');
    fakeDb.write(`orgs/${ORG}`, { defaultBereavementCoordinatorUid: 'x' }, 'update'); // inactive
    expect(await resolveBereavementCoordinator(ORG, [])).toBeNull();
  });
});

describe('volunteers', () => {
  const A = `orgs/${ORG}/volunteerAssignments`;
  const P = (id: string) => `orgs/${ORG}/patients/${id}`;
  const assignment = (volunteerUid: string, patientId: string, status = 'active') => ({
    volunteerUid, patientId, patientName: 'Doe, Jane', activity: 'companionship', status, startDate: '2026-09-01',
    endDate: null, notes: null, createdBy: 'vc', createdAt: Timestamp.now(),
  });

  it('keeps patients.volunteerUids in sync on create, status change, patient move and delete', async () => {
    fakeDb.seed(P('p1'), { firstName: 'Jane', lastName: 'Doe', status: 'admitted' });
    fakeDb.seed(P('p2'), { firstName: 'Joe', lastName: 'Roe', status: 'admitted' });
    const a1 = assignment('vol', 'p1');
    fakeDb.seed(`${A}/a1`, a1);
    expect(await handleVolunteerAssignmentWritten(ORG, null, a1 as any)).toEqual(['p1']);
    expect(fakeDb.read<any>(P('p1'))!.volunteerUids).toEqual(['vol']);
    // notes-only edit: no work
    expect(await handleVolunteerAssignmentWritten(ORG, a1 as any, { ...a1, notes: 'x' } as any)).toEqual([]);
    // patient move p1 → p2
    const moved = { ...a1, patientId: 'p2' };
    fakeDb.seed(`${A}/a1`, moved);
    expect(await handleVolunteerAssignmentWritten(ORG, a1 as any, moved as any)).toEqual(['p1', 'p2']);
    expect(fakeDb.read<any>(P('p1'))!.volunteerUids).toEqual([]);
    expect(fakeDb.read<any>(P('p2'))!.volunteerUids).toEqual(['vol']);
    // ended
    const ended = { ...moved, status: 'ended' };
    fakeDb.seed(`${A}/a1`, ended);
    await handleVolunteerAssignmentWritten(ORG, moved as any, ended as any);
    expect(fakeDb.read<any>(P('p2'))!.volunteerUids).toEqual([]);
    // delete of an active assignment
    const a2 = assignment('vol2', 'p2');
    fakeDb.seed(`${A}/a2`, a2);
    await handleVolunteerAssignmentWritten(ORG, null, a2 as any);
    expect(fakeDb.read<any>(P('p2'))!.volunteerUids).toEqual(['vol2']);
    fakeDb.store.delete(`${A}/a2`);
    await handleVolunteerAssignmentWritten(ORG, a2 as any, null);
    expect(fakeDb.read<any>(P('p2'))!.volunteerUids).toEqual([]);
    expect(audit('volunteer.sync').length).toBeGreaterThanOrEqual(5);
  });

  it('backfillVolunteerUids (admin) sets and clears arrays', async () => {
    fakeDb.seed(P('p1'), { firstName: 'Jane', lastName: 'Doe', status: 'admitted' });
    fakeDb.seed(P('p2'), { firstName: 'Joe', lastName: 'Roe', status: 'admitted', volunteerUids: ['stale'] });
    fakeDb.seed(`${A}/a1`, assignment('vol', 'p1'));
    fakeDb.seed(`${A}/a2`, assignment('v2', 'p1'));
    fakeDb.seed(`${A}/a3`, assignment('v3', 'p2', 'ended'));
    await expect(backfillVolunteerUidsHandler(req({ orgId: ORG }, { uid: 'vc' }))).rejects.toMatchObject({ code: 'permission-denied' });
    const res = await backfillVolunteerUidsHandler(req({ orgId: ORG }, { uid: 'a', role: 'admin' }));
    expect(res).toEqual({ patientsUpdated: 2, activeAssignments: 2 });
    expect(fakeDb.read<any>(P('p1'))!.volunteerUids).toEqual(['v2', 'vol']);
    expect(fakeDb.read<any>(P('p2'))!.volunteerUids).toEqual([]);
  });

  it('voidVolunteerLog: capability or admin only, once, audited; metrics exclude voided logs', async () => {
    const L = `orgs/${ORG}/volunteerLogs`;
    fakeDb.seed(`${L}/l1`, { volunteerUid: 'vol', patientId: null, date: '2026-09-10', minutes: 60, activity: 'companionship', note: null, createdAt: Timestamp.now() });
    await expect(voidVolunteerLogHandler(req({ orgId: ORG, logId: 'l1', reason: 'Duplicate' }, { uid: 'vol', role: 'viewer' }))).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(voidVolunteerLogHandler(req({ orgId: ORG, logId: 'l1', reason: ' ' }, { uid: 'vc' }))).rejects.toMatchObject({ code: 'invalid-argument' });
    await voidVolunteerLogHandler(req({ orgId: ORG, logId: 'l1', reason: 'Duplicate' }, { uid: 'vc' }));
    expect(fakeDb.read<any>(`${L}/l1`)).toMatchObject({ voidedBy: 'vc', voidReason: 'Duplicate' });
    await expect(voidVolunteerLogHandler(req({ orgId: ORG, logId: 'l1', reason: 'Again' }, { uid: 'a', role: 'admin' }))).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(audit('volunteer.void')).toHaveLength(1);
    expect(JSON.stringify(audit('volunteer.void')[0]!.data.metadata)).not.toContain('Duplicate');

    const metrics = computeDailyMetricsValues({
      date: '2026-09-20', timeZone: 'UTC', patients: [], referralCount: 0, alerts: [],
      visits: { scheduled: 0, completed: 0, missed: 0, cancelled: 0 }, triageCalls: [], activeVolunteerAssignments: 0, bereavementPlans: [],
      volunteerLogs: [{ date: '2026-09-10', minutes: 60, voided: true }, { date: '2026-09-11', minutes: 30 }],
    });
    expect(metrics.volunteers.minutesLast30d).toBe(30);
  });

  it('volunteerComplianceReport: visits by default, staffHours override prorated, voided excluded', async () => {
    const L = `orgs/${ORG}/volunteerLogs`;
    const log = (id: string, date: string, minutes: number, over = {}) =>
      fakeDb.seed(`${L}/${id}`, { volunteerUid: 'vol', patientId: null, date, minutes, activity: 'companionship', note: null, createdAt: Timestamp.now(), ...over });
    log('l1', '2026-08-05', 120);
    log('l2', '2026-09-05', 60);
    log('l3', '2026-09-06', 500, { voidedAt: Timestamp.now(), voidedBy: 'vc', voidReason: 'x' });
    log('l4', '2026-10-01', 999); // out of range
    const visit = (id: string, startIso: string, minutes: number, status = 'completed') =>
      fakeDb.seed(`orgs/${ORG}/visits/${id}`, {
        patientId: 'p', patientName: 'x', discipline: 'RN', assignedUid: 'b', status,
        scheduledStart: Timestamp.fromMillis(Date.parse(startIso)),
        scheduledEnd: Timestamp.fromMillis(Date.parse(startIso) + minutes * 60_000),
      });
    visit('v1', '2026-08-10T15:00:00Z', 60);
    visit('v2', '2026-08-11T15:00:00Z', 90);
    visit('v3', '2026-08-12T15:00:00Z', 60, 'missed');
    visit('v4', '2026-09-10T15:00:00Z', 600); // September uses the override instead
    fakeDb.seed(`orgs/${ORG}/staffHours/2026-09`, { paidCareHours: 300, updatedBy: 'a', updatedAt: Timestamp.now() });

    await expect(volunteerComplianceReportHandler(req({ orgId: ORG, from: '2026-08-01', to: '2026-09-30' }, { uid: 'c' }))).rejects.toMatchObject({ code: 'permission-denied' });
    const r = await volunteerComplianceReportHandler(req({ orgId: ORG, from: '2026-08-01', to: '2026-09-30' }, { uid: 'rp' }));
    expect(r.months).toEqual([
      { month: '2026-08', volunteerMinutes: 120, staffMinutes: 150, staffSource: 'visits' },
      { month: '2026-09', volunteerMinutes: 60, staffMinutes: 18000, staffSource: 'override' },
    ]);
    expect(r).toMatchObject({ volunteerMinutes: 180, staffMinutes: 18150, target: 0.05, meetsTarget: false, voidedLogsExcluded: 1, truncated: false });
    expect(r.ratio).toBeCloseTo(180 / 18150);
    // Partial month override is prorated (15 of 30 days).
    const half = await volunteerComplianceReportHandler(req({ orgId: ORG, from: '2026-09-01', to: '2026-09-15' }, { uid: 'vc' }));
    expect(half.staffMinutes).toBe(9000);
    await expect(volunteerComplianceReportHandler(req({ orgId: ORG, from: '2025-01-01', to: '2026-09-15' }, { uid: 'rp' }))).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(audit('volunteer.report')).toHaveLength(2);
  });

  it('audits staffHours writes', async () => {
    await handleStaffHoursWritten(ORG, '2026-09', null, { paidCareHours: 300, updatedBy: 'rp', updatedAt: Timestamp.now() });
    expect(audit('volunteer.staff_hours')[0]!.data).toMatchObject({ actorUid: 'rp', resourceId: '2026-09', metadata: { paidCareHours: 300, previous: null, deleted: false } });
  });
});
