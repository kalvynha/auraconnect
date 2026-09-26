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
import { admitPatientHandler } from '../../src/patients/admitPatient';
import { checkOrgDeadlines } from '../../src/patients/checkDeadlines';
import { completeMilestoneHandler, reopenMilestoneHandler } from '../../src/lifecycle/milestones';
import { changeLevelOfCareHandler } from '../../src/lifecycle/changeLevelOfCare';
import { recordRecertificationHandler } from '../../src/lifecycle/recordRecertification';
import { dischargePatientHandler, recordDeathHandler } from '../../src/lifecycle/endOfCare';
import { cancelVisitHandler, completeVisitHandler, scheduleVisitHandler } from '../../src/visits/visits';
import { checkOrgMissedVisits, missedVisitAlertId, runMissedVisitChecks } from '../../src/visits/checkMissedVisits';
import { createTaskHandler, saveTaskTemplateHandler, updateTaskHandler } from '../../src/tasks/tasks';
import { updateBereavementContactHandler } from '../../src/bereavement/bereavement';
import { completeIdgMeetingHandler, createIdgMeetingHandler, saveIdgNoteHandler } from '../../src/idg/idg';
import { assignTriageCallHandler, logTriageCallHandler, resolveTriageCallHandler, triageAlertId } from '../../src/triage/triage';
import { acceptReferralHandler } from '../../src/referrals/reviewReferral';
import type { AdmitPatientRequest, Org } from '../../src/shared/types';
import { docsIn, member, ORG, req, seedOrg } from './helpers';

const P = (id: string) => `orgs/${ORG}/patients/${id}`;
const HOUR = 3_600_000;

function admitReq(over: Partial<AdmitPatientRequest> = {}): AdmitPatientRequest {
  return {
    orgId: ORG,
    patient: {
      firstName: 'Jane', lastName: 'Doe', dob: '1940-05-01', sex: 'female', phone: null,
      address: { line1: null, line2: null, city: null, state: null, zip: null },
      mrn: null, medicareMbi: null, primaryDiagnosis: null, secondaryDiagnoses: [], referringPhysician: null,
      attendingPhysician: null, codeStatus: 'DNR', allergies: [], medications: [],
      caregiver: { name: 'John Doe', relationship: 'son', phone: '555-0100' },
      insurance: { payer: null, memberId: null },
    },
    admissionDate: '2026-09-20',
    levelOfCare: 'routine',
    careTeamUids: ['c', 's'],
    consents: { electionStatement: true, hipaaNotice: true, releaseOfInformation: true, patientRights: true, polstOnFile: true },
    ...over,
  };
}

async function admit(over: Partial<AdmitPatientRequest> = {}) {
  return admitPatientHandler(req(admitReq(over), { uid: 'b', role: 'intake' }));
}

const tasksFor = (patientId: string) => docsIn(`orgs/${ORG}/tasks`).filter((t) => t.data.patientId === patientId);
const audit = (action: string) => docsIn(`orgs/${ORG}/auditLogs`).filter((l) => l.data.action === action);

function seedVisit(id: string, patientId: string, over: Record<string, unknown> = {}) {
  const now = Date.now();
  fakeDb.seed(`orgs/${ORG}/visits/${id}`, {
    patientId, patientName: 'Doe, Jane', discipline: 'RN', assignedUid: 'c',
    scheduledStart: Timestamp.fromMillis(now + 24 * HOUR), scheduledEnd: Timestamp.fromMillis(now + 25 * HOUR),
    status: 'scheduled', note: null, completedAt: null, completedBy: null, cancelledReason: null,
    createdBy: 'b', createdAt: Timestamp.now(), updatedAt: Timestamp.now(), ...over,
  });
}

beforeEach(() => {
  seedOrg();
  fakeDb.seed(`orgs/${ORG}/members/s`, member('s', 'clinician', { discipline: 'SW' }));
  fakeDb.seed(`orgs/${ORG}/members/d`, member('d', 'clinician'));
});

describe('admitPatient (v2)', () => {
  it('appends an admission event, instantiates the admission template and sets nextIdgDueDate', async () => {
    const { patientId } = await admit();
    const p = fakeDb.read<any>(P(patientId))!;
    expect(p).toMatchObject({ nextIdgDueDate: '2026-10-05', lastIdgReviewDate: null, milestoneCompletions: {}, visitFrequencies: [] });
    const events = docsIn(`${P(patientId)}/events`);
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toMatchObject({ type: 'admission', date: '2026-09-20', recordedBy: 'b' });
    const tasks = tasksFor(patientId).map((t) => t.data);
    expect(tasks).toHaveLength(6);
    expect(tasks.find((t) => t.title === 'Comprehensive assessment')).toMatchObject({
      assigneeUid: 'c', dueDate: '2026-09-25', status: 'open', patientName: 'Doe, Jane', source: { type: 'template', event: 'admission' },
    });
    expect(tasks.find((t) => t.title === 'Social work assessment')!.assigneeUid).toBe('s');
    expect(tasks.find((t) => t.title === 'Spiritual assessment')!.assigneeUid).toBeNull();

    // Re-calling for an admitted patient updates it without a second event or duplicate tasks.
    await admit({ patientId });
    expect(docsIn(`${P(patientId)}/events`)).toHaveLength(1);
    expect(tasksFor(patientId)).toHaveLength(6);
  });

  it('uses org task templates and idgCadenceDays when set', async () => {
    await fakeDb.doc(`orgs/${ORG}`).update({ idgCadenceDays: 10 });
    await saveTaskTemplateHandler(req({ orgId: ORG, event: 'admission', items: [{ title: 'Welcome call', discipline: 'SW', offsetDays: 0 }] } as any, { uid: 'a', role: 'admin' }));
    await expect(saveTaskTemplateHandler(req({ orgId: ORG, event: 'admission', items: [] }, { uid: 'b' }))).rejects.toMatchObject({ code: 'permission-denied' });
    const { patientId } = await admit();
    expect(fakeDb.read<any>(P(patientId))!.nextIdgDueDate).toBe('2026-09-30');
    expect(tasksFor(patientId).map((t) => [t.data.title, t.data.assigneeUid, t.data.priority])).toEqual([['Welcome call', 's', 'normal']]);
  });
});

describe('milestones', () => {
  it('completeMilestone/reopenMilestone toggle completion, and checkDeadlines skips completed keys', async () => {
    const { patientId } = await admit();
    await expect(completeMilestoneHandler(req({ orgId: ORG, patientId, key: 'noe:2026-09-25' }, { uid: 'v', role: 'viewer' }))).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(completeMilestoneHandler(req({ orgId: ORG, patientId, key: 'noe:2026-09-26' }, { uid: 'c' }))).rejects.toMatchObject({ code: 'invalid-argument' });
    await completeMilestoneHandler(req({ orgId: ORG, patientId, key: 'noe:2026-09-25', note: 'Filed' }, { uid: 'c' }));
    expect(fakeDb.read<any>(P(patientId))!.milestoneCompletions['noe:2026-09-25']).toMatchObject({ completedBy: 'c', note: 'Filed' });
    expect(audit('milestone.complete')).toHaveLength(1);

    const org = fakeDb.read<Org>(`orgs/${ORG}`)!;
    expect(await checkOrgDeadlines(ORG, org, '2026-09-23')).toBe(1); // only HOPE admission

    await reopenMilestoneHandler(req({ orgId: ORG, patientId, key: 'noe:2026-09-25' }, { uid: 'c' }));
    expect(fakeDb.read<any>(P(patientId))!.milestoneCompletions).toEqual({});
    expect(audit('milestone.reopen')).toHaveLength(1);
    expect(await checkOrgDeadlines(ORG, org, '2026-09-23')).toBe(1); // NOE now reminded
  });

  it('changeLevelOfCare updates the patient and appends an event', async () => {
    const { patientId } = await admit();
    await changeLevelOfCareHandler(req({ orgId: ORG, patientId, levelOfCare: 'gip', effectiveDate: '2026-09-24', reason: 'Pain crisis' }, { uid: 'c' }));
    expect(fakeDb.read<any>(P(patientId))!.levelOfCare).toBe('gip');
    const ev = docsIn(`${P(patientId)}/events`).find((e) => e.data.type === 'level_of_care_change')!;
    expect(ev.data).toMatchObject({ date: '2026-09-24', summary: 'Level of care: Routine → GIP', details: { from: 'routine', to: 'gip' } });
    expect(audit('patient.level_of_care')).toHaveLength(1);
  });
});

describe('recordRecertification', () => {
  it('completes the previous period recert (and F2F), appends an event and creates template tasks', async () => {
    const { patientId } = await admit();
    const periods = fakeDb.read<any>(P(patientId))!.milestones.benefitPeriods;
    const base = { orgId: ORG, patientId, certifyingPhysician: 'Dr. Who', certificationDate: '2026-12-10' };

    await expect(recordRecertificationHandler(req({ ...base, periodNumber: 1 }, { uid: 'c' }))).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(recordRecertificationHandler(req({ ...base, periodNumber: 40 }, { uid: 'c' }))).rejects.toMatchObject({ code: 'invalid-argument' });

    await recordRecertificationHandler(req({ ...base, periodNumber: 2 }, { uid: 'c' }));
    let p = fakeDb.read<any>(P(patientId))!;
    expect(Object.keys(p.milestoneCompletions)).toEqual([`recert:${periods[0].end}`]);
    const ev = docsIn(`${P(patientId)}/events`).find((e) => e.data.type === 'recertification')!;
    expect(ev.data).toMatchObject({ date: '2026-12-10', details: { periodNumber: 2, certifyingPhysician: 'Dr. Who' } });
    const recertTasks = tasksFor(patientId).filter((t) => t.data.source.event === 'recertification');
    expect(recertTasks.map((t) => [t.data.title, t.data.assigneeUid, t.data.dueDate])).toEqual([
      ['Update plan of care', 'c', '2026-12-10'],
      ['Physician narrative', null, '2026-12-10'],
    ]);
    await expect(recordRecertificationHandler(req({ ...base, periodNumber: 2 }, { uid: 'c' }))).rejects.toMatchObject({ code: 'failed-precondition' });

    // Period 3 requires a face-to-face encounter.
    const p3 = { ...base, periodNumber: 3, certificationDate: '2027-03-10' };
    await expect(recordRecertificationHandler(req(p3, { uid: 'c' }))).rejects.toMatchObject({ code: 'invalid-argument' });
    await recordRecertificationHandler(req({ ...p3, f2fDate: '2027-03-01', f2fBy: 'NP Smith' }, { uid: 'c' }));
    p = fakeDb.read<any>(P(patientId))!;
    expect(p.milestoneCompletions[`recert:${periods[1].end}`]).toBeDefined();
    expect(p.milestoneCompletions[`f2f:${periods[2].f2fDueBy}`]).toMatchObject({ completedBy: 'c' });
    expect(audit('patient.recertify')).toHaveLength(2);
    await expect(recordRecertificationHandler(req({ ...base, periodNumber: 2 }, { uid: 'v', role: 'viewer' }))).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('extends benefit periods when certifying near the end of the computed list', async () => {
    const { patientId } = await admit();
    await fakeDb.doc(P(patientId)).update({ 'milestones.benefitPeriods': fakeDb.read<any>(P(patientId))!.milestones.benefitPeriods.slice(0, 3) });
    await recordRecertificationHandler(req({ orgId: ORG, patientId, periodNumber: 2, certifyingPhysician: 'Dr', certificationDate: '2026-12-10' }, { uid: 'c' }));
    expect(fakeDb.read<any>(P(patientId))!.milestones.benefitPeriods.map((x: any) => x.number)).toEqual([1, 2, 3, 4]);
  });
});

describe('recordDeath / dischargePatient', () => {
  it('records death: archives the channel, cancels future work, creates tasks and a bereavement plan', async () => {
    const { patientId, channelId } = await admit();
    seedVisit('future', patientId);
    seedVisit('past', patientId, { scheduledStart: Timestamp.fromMillis(Date.now() - 5 * HOUR), scheduledEnd: Timestamp.fromMillis(Date.now() - 4 * HOUR) });
    seedVisit('otherPatient', 'someoneElse');
    const admissionTaskIds = tasksFor(patientId).map((t) => t.id);

    await expect(recordDeathHandler(req({ orgId: ORG, patientId, date: '2026-09-25' }, { uid: 'v', role: 'viewer' }))).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(recordDeathHandler(req({ orgId: ORG, patientId, date: '2026-09-19' }, { uid: 'c' }))).rejects.toMatchObject({ code: 'invalid-argument' });
    await recordDeathHandler(req({ orgId: ORG, patientId, date: '2026-09-25', time: '03:40', pronouncedBy: 'RN C', bereavementRisk: 'high' }, { uid: 'c' }));

    const p = fakeDb.read<any>(P(patientId))!;
    expect(p).toMatchObject({ status: 'deceased', death: { date: '2026-09-25', time: '03:40', pronouncedBy: 'RN C', location: null, notes: null } });
    expect(fakeDb.read<any>(`orgs/${ORG}/channels/${channelId}`)!.archived).toBe(true);
    expect(fakeDb.read<any>(`orgs/${ORG}/visits/future`)).toMatchObject({ status: 'cancelled', cancelledReason: 'Patient deceased' });
    expect(fakeDb.read<any>(`orgs/${ORG}/visits/past`)!.status).toBe('scheduled');
    expect(fakeDb.read<any>(`orgs/${ORG}/visits/otherPatient`)!.status).toBe('scheduled');

    const tasks = tasksFor(patientId);
    for (const id of admissionTaskIds) expect(tasks.find((t) => t.id === id)!.data.status).toBe('cancelled');
    const deathTasks = tasks.filter((t) => t.data.source.event === 'death');
    expect(deathTasks).toHaveLength(5);
    expect(deathTasks.every((t) => t.data.status === 'open')).toBe(true);
    expect(deathTasks.find((t) => t.data.title === 'Bereavement assessment')!.data).toMatchObject({ assigneeUid: 's', dueDate: '2026-10-02' });

    const plan = fakeDb.read<any>(`orgs/${ORG}/bereavementPlans/${p.bereavementPlanId}`)!;
    expect(plan).toMatchObject({
      patientId, patientName: 'Doe, Jane', deathDate: '2026-09-25', riskLevel: 'high', assignedUid: 's', status: 'active', closesOn: '2027-10-25',
      primaryContact: { name: 'John Doe', relationship: 'son', phone: '555-0100' },
    });
    expect(plan.contacts).toHaveLength(10);
    expect(plan.contacts[0]).toMatchObject({ id: 'd3-call', dueDate: '2026-09-28', status: 'pending', completedAt: null });

    const ev = docsIn(`${P(patientId)}/events`).find((e) => e.data.type === 'death')!;
    expect(ev.data).toMatchObject({ date: '2026-09-25', recordedBy: 'c' });
    expect(audit('patient.death')[0]!.data.metadata).toMatchObject({ cancelledVisits: 1, cancelledTasks: 6, tasks: 5 });

    await expect(recordDeathHandler(req({ orgId: ORG, patientId, date: '2026-09-25' }, { uid: 'c' }))).rejects.toMatchObject({ code: 'failed-precondition' });

    // Bereavement contact updates
    await updateBereavementContactHandler(req({ orgId: ORG, planId: p.bereavementPlanId, contactId: 'd3-call', status: 'done', note: 'Spoke with son' }, { uid: 's' }));
    const c0 = fakeDb.read<any>(`orgs/${ORG}/bereavementPlans/${p.bereavementPlanId}`)!.contacts[0];
    expect(c0).toMatchObject({ status: 'done', completedBy: 's', note: 'Spoke with son' });
    expect(c0.completedAt).toBeInstanceOf(Timestamp);
    expect(audit('bereavement.update')).toHaveLength(1);
  });

  it('discharges: status, reason, archived channel, template tasks', async () => {
    const { patientId, channelId } = await admit();
    await dischargePatientHandler(req({ orgId: ORG, patientId, dischargeDate: '2026-09-26', reason: 'revocation' }, { uid: 'c' }));
    expect(fakeDb.read<any>(P(patientId))).toMatchObject({ status: 'discharged', dischargeDate: '2026-09-26', dischargeReason: 'revocation' });
    expect(fakeDb.read<any>(`orgs/${ORG}/channels/${channelId}`)!.archived).toBe(true);
    expect(tasksFor(patientId).filter((t) => t.data.source.event === 'discharge' && t.data.status === 'open')).toHaveLength(3);
    expect(docsIn(`${P(patientId)}/events`).map((e) => e.data.type).sort()).toEqual(['admission', 'discharge']);
  });
});

describe('visits and tasks', () => {
  it('only the assignee, care team or an admin may complete or cancel a visit', async () => {
    const { patientId } = await admit();
    const start = new Date(Date.now() + HOUR).toISOString();
    const end = new Date(Date.now() + 2 * HOUR).toISOString();
    await expect(scheduleVisitHandler(req({ orgId: ORG, patientId, discipline: 'RN', start: end, end: start }, { uid: 'b' }))).rejects.toMatchObject({ code: 'invalid-argument' });
    const { id } = await scheduleVisitHandler(req({ orgId: ORG, patientId, discipline: 'RN', assignedUid: 'd', start, end }, { uid: 'b' }));
    expect(fakeDb.read<any>(`orgs/${ORG}/visits/${id}`)).toMatchObject({ patientName: 'Doe, Jane', status: 'scheduled', assignedUid: 'd' });

    await expect(completeVisitHandler(req({ orgId: ORG, visitId: id }, { uid: 'b' }))).rejects.toMatchObject({ code: 'permission-denied' });
    await completeVisitHandler(req({ orgId: ORG, visitId: id, note: 'Stable' }, { uid: 'd' }));
    expect(fakeDb.read<any>(`orgs/${ORG}/visits/${id}`)).toMatchObject({ status: 'completed', completedBy: 'd', note: 'Stable' });
    await expect(cancelVisitHandler(req({ orgId: ORG, visitId: id, reason: 'x' }, { uid: 'a', role: 'admin' }))).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('tasks: creator/assignee/care team/admin may update; completing sets completedAt/By', async () => {
    const { patientId } = await admit();
    const { id } = await createTaskHandler(req({ orgId: ORG, title: 'Call pharmacy', patientId, assigneeUid: 'd' }, { uid: 'b' }));
    expect(fakeDb.read<any>(`orgs/${ORG}/tasks/${id}`)).toMatchObject({ patientName: 'Doe, Jane', source: { type: 'manual' }, priority: 'normal', status: 'open' });
    fakeDb.seed(`orgs/${ORG}/members/e`, member('e'));
    await expect(updateTaskHandler(req({ orgId: ORG, taskId: id, status: 'done' }, { uid: 'e' }))).rejects.toMatchObject({ code: 'permission-denied' });
    await updateTaskHandler(req({ orgId: ORG, taskId: id, status: 'done' }, { uid: 'c' }));
    expect(fakeDb.read<any>(`orgs/${ORG}/tasks/${id}`)).toMatchObject({ status: 'done', completedBy: 'c' });
    expect(audit('task.complete')).toHaveLength(1);
    await updateTaskHandler(req({ orgId: ORG, taskId: id, status: 'open' }, { uid: 'd' }));
    expect(fakeDb.read<any>(`orgs/${ORG}/tasks/${id}`)).toMatchObject({ status: 'open', completedBy: null, completedAt: null });
  });
});

describe('checkMissedVisits', () => {
  it('marks visits missed after the default grace period and alerts assignee/care team plus admins', async () => {
    const { patientId } = await admit();
    const now = Date.now();
    const ago = (h: number) => Timestamp.fromMillis(now - h * HOUR);
    seedVisit('v1', patientId, { assignedUid: 'd', scheduledStart: ago(4), scheduledEnd: ago(3) });
    seedVisit('v2', patientId, { assignedUid: null, scheduledStart: ago(6), scheduledEnd: ago(5), discipline: 'SW' });
    seedVisit('v3', patientId, { scheduledStart: ago(2), scheduledEnd: ago(1) }); // within 120-min grace
    seedVisit('v4', patientId, { status: 'completed', scheduledStart: ago(6), scheduledEnd: ago(5) });

    const org = fakeDb.read<Org>(`orgs/${ORG}`)!;
    expect(org.missedVisitGraceMinutes).toBeUndefined();
    expect(await checkOrgMissedVisits(ORG, org, new Date(now))).toBe(2);

    expect(fakeDb.read<any>(`orgs/${ORG}/visits/v1`)!.status).toBe('missed');
    expect(fakeDb.read<any>(`orgs/${ORG}/visits/v2`)!.status).toBe('missed');
    expect(fakeDb.read<any>(`orgs/${ORG}/visits/v3`)!.status).toBe('scheduled');
    expect(fakeDb.read<any>(`orgs/${ORG}/visits/v4`)!.status).toBe('completed');

    const a1 = fakeDb.read<any>(`orgs/${ORG}/alerts/${missedVisitAlertId('v1')}`)!;
    expect(a1).toMatchObject({
      title: 'Missed RN visit', body: 'Doe, Jane', priority: 'normal', createdBy: 'system', policyId: null,
      source: { type: 'visit_missed', visitId: 'v1', patientId }, targetUids: ['a', 'd'],
    });
    expect(fakeDb.read<any>(`orgs/${ORG}/alerts/${missedVisitAlertId('v2')}`)!.targetUids).toEqual(['a', 'c', 's']);
    expect(audit('visit.missed').map((l) => l.data.actorUid)).toEqual(['system', 'system']);

    // Idempotent; a shorter org grace picks up v3.
    expect(await checkOrgMissedVisits(ORG, org, new Date(now))).toBe(0);
    await fakeDb.doc(`orgs/${ORG}`).update({ missedVisitGraceMinutes: 30 });
    expect(await runMissedVisitChecks(new Date(now))).toEqual({ orgs: 1, alerts: 1 });
    expect(fakeDb.read<any>(`orgs/${ORG}/visits/v3`)!.status).toBe('missed');
  });
});

describe('IDG meetings', () => {
  it('auto-agenda, notes, and completion updates review dates and creates action-item tasks', async () => {
    const { patientId } = await admit(); // nextIdgDueDate 2026-10-05
    const { patientId: later } = await admit({ admissionDate: '2026-09-26', patient: { ...admitReq().patient, firstName: 'Al', lastName: 'Zed' } }); // due 10-11

    const { id } = await createIdgMeetingHandler(req({ orgId: ORG, title: 'Weekly IDG', scheduledAt: '2026-09-28T15:00:00Z', attendeeUids: ['b', 'd'] }, { uid: 'b' }));
    const m = fakeDb.read<any>(`orgs/${ORG}/idgMeetings/${id}`)!;
    expect(m).toMatchObject({ status: 'scheduled', patientIds: [patientId], patientNames: { [patientId]: 'Doe, Jane' }, attendeeUids: ['b', 'd'], notes: {}, aiPrep: {} });
    expect(m.patientIds).not.toContain(later);

    const note = { orgId: ORG, meetingId: id, patientId, summary: 'Comfortable', reviewed: true, actionItems: [{ title: 'Order hospital bed', assigneeUid: 'c', dueDate: '2026-09-30' }, { title: 'Chaplain visit' }] };
    fakeDb.seed(`orgs/${ORG}/members/e`, member('e'));
    await expect(saveIdgNoteHandler(req(note as any, { uid: 'e' }))).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(saveIdgNoteHandler(req({ ...note, patientId: later } as any, { uid: 'b' }))).rejects.toMatchObject({ code: 'failed-precondition' });
    await saveIdgNoteHandler(req(note as any, { uid: 'c' })); // care team member
    expect(fakeDb.read<any>(`orgs/${ORG}/idgMeetings/${id}`)!.notes[patientId]).toMatchObject({ summary: 'Comfortable', reviewed: true, updatedBy: 'c', planOfCareChanges: null });

    await expect(completeIdgMeetingHandler(req({ orgId: ORG, meetingId: id }, { uid: 'v', role: 'viewer' }))).rejects.toMatchObject({ code: 'permission-denied' });
    await completeIdgMeetingHandler(req({ orgId: ORG, meetingId: id }, { uid: 'b' }));
    expect(fakeDb.read<any>(P(patientId))).toMatchObject({ lastIdgReviewDate: '2026-09-28', nextIdgDueDate: '2026-10-13' });
    expect(fakeDb.read<any>(`orgs/${ORG}/idgMeetings/${id}`)).toMatchObject({ status: 'completed', completedBy: 'b' });
    const idgTasks = tasksFor(patientId).filter((t) => t.data.source.type === 'idg');
    expect(idgTasks.map((t) => [t.data.title, t.data.assigneeUid, t.data.dueDate, t.data.source.meetingId])).toEqual([
      ['Order hospital bed', 'c', '2026-09-30', id],
      ['Chaplain visit', null, null, id],
    ]);
    expect(audit('idg.complete')[0]!.data.metadata).toMatchObject({ reviewed: 1, tasks: 2 });

    // Locked
    await expect(saveIdgNoteHandler(req(note as any, { uid: 'c' }))).rejects.toMatchObject({ code: 'failed-precondition' });
    await expect(completeIdgMeetingHandler(req({ orgId: ORG, meetingId: id }, { uid: 'b' }))).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('does not update patients whose note is not reviewed', async () => {
    const { patientId } = await admit();
    const { id } = await createIdgMeetingHandler(req({ orgId: ORG, title: 'IDG', scheduledAt: '2026-09-28T15:00:00Z', patientIds: [patientId] }, { uid: 'b' }));
    await saveIdgNoteHandler(req({ orgId: ORG, meetingId: id, patientId, summary: 'Draft', reviewed: false, actionItems: [{ title: 'X', assigneeUid: null, dueDate: null }] }, { uid: 'b' }));
    await completeIdgMeetingHandler(req({ orgId: ORG, meetingId: id }, { uid: 'b' }));
    expect(fakeDb.read<any>(P(patientId))).toMatchObject({ lastIdgReviewDate: null, nextIdgDueDate: '2026-10-05' });
    expect(tasksFor(patientId).filter((t) => t.data.source.type === 'idg')).toHaveLength(0);
  });
});

describe('triage', () => {
  function seedOnCall() {
    const now = Date.now();
    fakeDb.seed(`orgs/${ORG}/onCallRoles/oncall-rn`, { label: 'On-call RN', discipline: 'RN', teamId: null, fallbackUids: ['c'] });
    fakeDb.seed(`orgs/${ORG}/shifts/s1`, { roleKey: 'oncall-rn', uid: 'd', start: Timestamp.fromMillis(now - HOUR), end: Timestamp.fromMillis(now + HOUR), notes: null });
  }

  it('routes to the org triage role, raises a critical alert for emergent calls, and resolves it', async () => {
    seedOnCall();
    await fakeDb.doc(`orgs/${ORG}`).update({ triageRoleKey: 'oncall-rn' });
    const { patientId } = await admit();
    const res = await logTriageCallHandler(req({ orgId: ORG, patientId, callerName: 'John Doe', reason: 'Severe dyspnea', symptoms: ['dyspnea'], urgency: 'emergent' }, { uid: 'b' }));
    expect(res).toEqual({ callId: expect.any(String), assignedUid: 'd', alertId: triageAlertId(res.callId) });
    const call = fakeDb.read<any>(`orgs/${ORG}/triageCalls/${res.callId}`)!;
    expect(call).toMatchObject({ patientName: 'Doe, Jane', status: 'open', roleKey: 'oncall-rn', assignedUid: 'd', alertId: res.alertId, receivedBy: 'b' });
    const alert = fakeDb.read<any>(`orgs/${ORG}/alerts/${res.alertId}`)!;
    expect(alert).toMatchObject({
      priority: 'critical', title: 'Emergent triage call', policyId: 'pol', targetUids: ['d'],
      source: { type: 'triage', callId: res.callId, patientId },
    });
    expect(audit('alert.create')[0]!.data.patientId).toBe(patientId);

    await assignTriageCallHandler(req({ orgId: ORG, callId: res.callId, assignedUid: 'c' }, { uid: 'b' }));
    expect(fakeDb.read<any>(`orgs/${ORG}/alerts/${res.alertId}`)!.targetUids).toEqual(['d', 'c']);

    await resolveTriageCallHandler(req({ orgId: ORG, callId: res.callId, disposition: 'visit_made', followUpTask: { title: 'Recheck breathing', dueDate: '2026-09-27' } }, { uid: 'c' }));
    expect(fakeDb.read<any>(`orgs/${ORG}/triageCalls/${res.callId}`)).toMatchObject({ status: 'resolved', disposition: 'visit_made', resolvedBy: 'c' });
    expect(fakeDb.read<any>(`orgs/${ORG}/alerts/${res.alertId}`)).toMatchObject({ status: 'resolved', ackedBy: 'c' });
    const followUp = docsIn(`orgs/${ORG}/tasks`).find((t) => t.data.source.type === 'triage')!;
    expect(followUp.data).toMatchObject({ title: 'Recheck breathing', assigneeUid: 'c', patientId, patientName: 'Doe, Jane', source: { callId: res.callId } });
    await expect(resolveTriageCallHandler(req({ orgId: ORG, callId: res.callId, disposition: 'other' }, { uid: 'c' }))).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('routine calls raise no alert; urgent calls with nobody on call alert admins; viewers are rejected', async () => {
    const routine = await logTriageCallHandler(req({ orgId: ORG, callerName: 'Neighbor', reason: 'Question about meds', urgency: 'routine' }, { uid: 'b' }));
    expect(routine).toMatchObject({ assignedUid: null, alertId: null });
    expect(docsIn(`orgs/${ORG}/alerts`)).toHaveLength(0);

    const urgent = await logTriageCallHandler(req({ orgId: ORG, callerName: 'Neighbor', reason: 'Fall', urgency: 'urgent' }, { uid: 'b' }));
    expect(fakeDb.read<any>(`orgs/${ORG}/alerts/${urgent.alertId}`)).toMatchObject({ priority: 'urgent', targetUids: ['a'] });

    seedOnCall();
    const explicit = await logTriageCallHandler(req({ orgId: ORG, callerName: 'X', reason: 'Y', urgency: 'routine', roleKey: 'oncall-rn', assignedUid: 'c' }, { uid: 'b' }));
    expect(explicit.assignedUid).toBe('c');
    await expect(logTriageCallHandler(req({ orgId: ORG, callerName: 'X', reason: 'Y', urgency: 'routine', roleKey: 'nope' }, { uid: 'b' }))).rejects.toMatchObject({ code: 'not-found' });
    await expect(logTriageCallHandler(req({ orgId: ORG, callerName: 'X', reason: 'Y', urgency: 'routine' }, { uid: 'v', role: 'viewer' }))).rejects.toMatchObject({ code: 'permission-denied' });
  });
});

describe('acceptReferral documents', () => {
  it('adds a referral document pointing at the referral file', async () => {
    const path = `orgs/${ORG}/referrals/r1/scan.pdf`;
    fakeDb.seed(`orgs/${ORG}/referrals/r1`, {
      fileName: 'scan.pdf', contentType: 'application/pdf', storagePath: path, source: 'scan', status: 'needs_review',
      extracted: null, error: null, model: null, patientId: null, uploadedBy: 'b', reviewedBy: null, rejectionReason: null,
      createdAt: Timestamp.now(), updatedAt: Timestamp.now(),
    });
    const statFile = vi.fn(async () => ({ size: 2048, contentType: 'application/pdf' }));
    const { patientId } = await acceptReferralHandler(req({ orgId: ORG, referralId: 'r1', patient: admitReq().patient }, { uid: 'c' }), { statFile });
    expect(statFile).toHaveBeenCalledWith(path);
    const docs = docsIn(`${P(patientId)}/documents`);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.data).toMatchObject({ name: 'Referral', category: 'referral', fileName: 'scan.pdf', storagePath: path, contentType: 'application/pdf', size: 2048, uploadedBy: 'b' });
    expect(audit('document.upload')).toHaveLength(1);
  });

  it('skips the document when the file cannot be described', async () => {
    fakeDb.seed(`orgs/${ORG}/referrals/r2`, {
      fileName: 'scan.pdf', contentType: 'application/pdf', storagePath: `orgs/${ORG}/referrals/r2/scan.pdf`, source: 'scan', status: 'failed',
      extracted: null, error: null, model: null, patientId: null, uploadedBy: 'b', reviewedBy: null, rejectionReason: null,
      createdAt: Timestamp.now(), updatedAt: Timestamp.now(),
    });
    const { patientId } = await acceptReferralHandler(req({ orgId: ORG, referralId: 'r2', patient: admitReq().patient }, { uid: 'c' }), { statFile: async () => null });
    expect(docsIn(`${P(patientId)}/documents`)).toHaveLength(0);
    expect(fakeDb.read<any>(`orgs/${ORG}/referrals/r2`)!.status).toBe('accepted');
  });
});
