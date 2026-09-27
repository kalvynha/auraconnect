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
import { computeMilestones } from '../../src/domain/milestones';
import { checkOrgDeadlines, deadlineAlertId } from '../../src/patients/checkDeadlines';
import { completeMilestoneHandler, reopenMilestoneHandler } from '../../src/lifecycle/milestones';
import { changeLevelOfCareHandler } from '../../src/lifecycle/changeLevelOfCare';
import { recordRecertificationHandler } from '../../src/lifecycle/recordRecertification';
import { dischargePatientHandler, recordDeathHandler } from '../../src/lifecycle/endOfCare';
import { archiveOrgEndedChannels } from '../../src/lifecycle/archiveEndedChannels';
import { updatePatientClinicalHandler } from '../../src/lifecycle/updatePatientClinical';
import type { Org } from '../../src/shared/types';
import { docsIn, member, ORG, req, seedOrg } from './helpers';

const PID = 'p1';
const P = `orgs/${ORG}/patients/${PID}`;
const CH = `orgs/${ORG}/channels/ch1`;
const HOUR = 3_600_000;
const audit = (action: string) => docsIn(`orgs/${ORG}/auditLogs`).filter((l) => l.data.action === action);
const alerts = () => docsIn(`orgs/${ORG}/alerts`);
const messages = () => docsIn(`${CH}/messages`);
const org = () => fakeDb.read<Org>(`orgs/${ORG}`)!;
const denied = { code: 'permission-denied' };
const invalid = { code: 'invalid-argument' };

function seedPatient(over: Record<string, unknown> = {}, admissionDate = '2026-09-20') {
  fakeDb.seed(P, {
    firstName: 'Jane', lastName: 'Doe', dob: '1940-05-01', sex: 'female', phone: null,
    address: { line1: '1 Main St', line2: null, city: 'Springfield', state: 'IL', zip: '62701' },
    mrn: null, medicareMbi: null, primaryDiagnosis: { code: 'C34.90', description: 'Lung cancer' }, secondaryDiagnoses: [],
    referringPhysician: null, attendingPhysician: { name: 'Dr. Adams', npi: '123', phone: null, fax: null },
    codeStatus: 'DNR', allergies: ['Penicillin'], medications: [],
    caregiver: { name: 'John Doe', relationship: 'son', phone: '555-0100', address: { line1: '9 Elm', line2: null, city: null, state: null, zip: null } },
    insurance: { payer: null, memberId: null },
    status: 'admitted', referralId: null, admissionDate, startingBenefitPeriod: 1, levelOfCare: 'routine',
    careTeamUids: ['c', 's', 'aide'], channelId: 'ch1', consents: null,
    milestones: computeMilestones(admissionDate, 1, admissionDate), remindedMilestones: [], milestoneCompletions: {},
    createdBy: 'b', createdAt: Timestamp.now(), updatedAt: Timestamp.now(),
    ...over,
  });
  fakeDb.seed(CH, {
    type: 'patient', name: 'Doe, Jane – Care Team', memberUids: ['c', 's', 'aide'], patientId: PID, teamId: null,
    createdBy: 'b', createdAt: Timestamp.now(), lastMessage: null, lastMessageAt: Timestamp.now(), archived: false,
  });
}

beforeEach(() => {
  seedOrg();
  fakeDb.seed(`orgs/${ORG}/members/s`, member('s', 'clinician', { discipline: 'SW' }));
  fakeDb.seed(`orgs/${ORG}/members/aide`, member('aide', 'clinician', { discipline: 'Aide' }));
  fakeDb.seed(`orgs/${ORG}/members/lpn`, member('lpn', 'clinician', { discipline: 'LPN' }));
  fakeDb.seed(`orgs/${ORG}/members/i`, member('i', 'intake', { discipline: 'Other' }));
  fakeDb.seed(`orgs/${ORG}/members/d`, member('d')); // RN, not on the care team
});

describe('checkDeadlines (S1, V1)', () => {
  it('upcoming: normal, no escalation, licensed care team only; overdue: separate urgent alert on the default policy, once', async () => {
    seedPatient();
    expect(await checkOrgDeadlines(ORG, org(), '2026-09-23')).toBe(2); // HOPE admission 09-24 (lead 2), NOE 09-25 (lead 3)
    const up = fakeDb.read<any>(`orgs/${ORG}/alerts/${deadlineAlertId(PID, 'noe:2026-09-25')}`)!;
    expect(up).toMatchObject({ priority: 'normal', policyId: null, targetUids: ['c'], title: 'NOE due 2026-09-25' });

    // Both become overdue; the earlier upcoming reminder does not suppress the overdue alert.
    expect(await checkOrgDeadlines(ORG, org(), '2026-09-26')).toBe(2);
    const over = fakeDb.read<any>(`orgs/${ORG}/alerts/${deadlineAlertId(PID, 'noe:2026-09-25#overdue')}`)!;
    expect(over).toMatchObject({ priority: 'urgent', policyId: 'pol', targetUids: ['c'], title: 'NOE overdue (due 2026-09-25)' });
    expect(fakeDb.read<any>(P)!.remindedMilestones).toEqual(
      expect.arrayContaining(['noe:2026-09-25', 'noe:2026-09-25#overdue', 'hope_admission:2026-09-24#overdue']),
    );
    // Bounded: never re-alerted, even months later (no 30-day cap, but at most one overdue alert per key).
    expect(await checkOrgDeadlines(ORG, org(), '2026-09-27')).toBe(0);
    const later = await checkOrgDeadlines(ORG, org(), '2026-12-30');
    expect(alerts().filter((a) => a.data.source.milestone === 'noe')).toHaveLength(2);
    expect(later).toBeGreaterThan(0); // HUV1/HUV2 and the period-1 recert
  });

  it('first seen overdue raises only the overdue alert; no licensed care team → admins', async () => {
    seedPatient({ careTeamUids: ['aide', 's'] });
    await checkOrgDeadlines(ORG, org(), '2026-10-30');
    expect(fakeDb.read<any>(`orgs/${ORG}/alerts/${deadlineAlertId(PID, 'noe:2026-09-25')}`)).toBeUndefined();
    expect(fakeDb.read<any>(`orgs/${ORG}/alerts/${deadlineAlertId(PID, 'noe:2026-09-25#overdue')}`)).toMatchObject({ targetUids: ['a'] });
  });

  it('uses deadlineLeadDaysByKind', async () => {
    seedPatient();
    await fakeDb.doc(`orgs/${ORG}`).update({ deadlineLeadDaysByKind: { noe: 5, hope_admission: 0 } });
    expect(await checkOrgDeadlines(ORG, org(), '2026-09-20')).toBe(1);
    expect(fakeDb.read<any>(P)!.remindedMilestones).toEqual(['noe:2026-09-25']);
  });

  it('completing a milestone resolves its open deadline alerts', async () => {
    seedPatient();
    await checkOrgDeadlines(ORG, org(), '2026-09-23');
    await checkOrgDeadlines(ORG, org(), '2026-09-26');
    await completeMilestoneHandler(req({ orgId: ORG, patientId: PID, key: 'noe:2026-09-25', effectiveDate: '2026-09-26' }, { uid: 'c' }));
    for (const k of ['noe:2026-09-25', 'noe:2026-09-25#overdue']) {
      expect(fakeDb.read<any>(`orgs/${ORG}/alerts/${deadlineAlertId(PID, k)}`)).toMatchObject({ status: 'resolved', ackedBy: 'c' });
    }
    expect(fakeDb.read<any>(`orgs/${ORG}/alerts/${deadlineAlertId(PID, 'hope_admission:2026-09-24#overdue')}`)!.status).toBe('open');
  });
});

describe('milestone completion (S5, H4)', () => {
  it('requires a past-or-today effectiveDate and records on-time from it', async () => {
    seedPatient();
    await expect(completeMilestoneHandler(req({ orgId: ORG, patientId: PID, key: 'noe:2026-09-25' } as any, { uid: 'c' }))).rejects.toMatchObject(invalid);
    await expect(completeMilestoneHandler(req({ orgId: ORG, patientId: PID, key: 'noe:2026-09-25', effectiveDate: '2999-01-01' }, { uid: 'c' }))).rejects.toMatchObject(invalid);
    await completeMilestoneHandler(req({ orgId: ORG, patientId: PID, key: 'noe:2026-09-25', effectiveDate: '2026-09-27' }, { uid: 'c' }));
    expect(fakeDb.read<any>(P)!.milestoneCompletions['noe:2026-09-25']).toMatchObject({ effectiveDate: '2026-09-27', completedBy: 'c' });
    expect(audit('milestone.complete')[0]!.data.metadata).toEqual({ key: 'noe:2026-09-25', effectiveDate: '2026-09-27', onTime: false });
  });

  it('licensed staff or admin; intake only for the NOE; aides and LPNs never', async () => {
    seedPatient();
    const done = (key: string) => ({ orgId: ORG, patientId: PID, key, effectiveDate: '2026-09-22' });
    await expect(completeMilestoneHandler(req(done('noe:2026-09-25'), { uid: 'aide' }))).rejects.toMatchObject(denied);
    await expect(completeMilestoneHandler(req(done('noe:2026-09-25'), { uid: 'lpn' }))).rejects.toMatchObject(denied);
    await expect(completeMilestoneHandler(req(done('hope_admission:2026-09-24'), { uid: 'i', role: 'intake' }))).rejects.toMatchObject(denied);
    await completeMilestoneHandler(req(done('noe:2026-09-25'), { uid: 'i', role: 'intake' }));
    await completeMilestoneHandler(req(done('hope_admission:2026-09-24'), { uid: 'a', role: 'admin' }));
    expect(Object.keys(fakeDb.read<any>(P)!.milestoneCompletions).sort()).toEqual(['hope_admission:2026-09-24', 'noe:2026-09-25']);
  });

  it('reopen keeps the completion in milestoneHistory and needs a licensed member', async () => {
    seedPatient();
    await completeMilestoneHandler(req({ orgId: ORG, patientId: PID, key: 'noe:2026-09-25', note: 'Filed', effectiveDate: '2026-09-24' }, { uid: 'c' }));
    await expect(reopenMilestoneHandler(req({ orgId: ORG, patientId: PID, key: 'noe:2026-09-25' }, { uid: 'i', role: 'intake' }))).rejects.toMatchObject(denied);
    await reopenMilestoneHandler(req({ orgId: ORG, patientId: PID, key: 'noe:2026-09-25', reason: 'Rejected by MAC' }, { uid: 'c' }));
    const p = fakeDb.read<any>(P)!;
    expect(p.milestoneCompletions).toEqual({});
    expect(p.milestoneHistory).toHaveLength(1);
    expect(p.milestoneHistory[0]).toMatchObject({ key: 'noe:2026-09-25', completedBy: 'c', note: 'Filed', effectiveDate: '2026-09-24', reopenedBy: 'c', reopenReason: 'Rejected by MAC' });
    expect(p.milestoneHistory[0].reopenedAt).toBeInstanceOf(Timestamp);
    // Complete and reopen again: history accumulates.
    await completeMilestoneHandler(req({ orgId: ORG, patientId: PID, key: 'noe:2026-09-25', effectiveDate: '2026-09-25' }, { uid: 'c' }));
    await reopenMilestoneHandler(req({ orgId: ORG, patientId: PID, key: 'noe:2026-09-25' }, { uid: 'a', role: 'admin' }));
    expect(fakeDb.read<any>(P)!.milestoneHistory.map((h: any) => h.effectiveDate)).toEqual(['2026-09-24', '2026-09-25']);
  });
});

describe('H4: licensed lifecycle acts', () => {
  it('aides, LPNs and unlicensed intake cannot record death, discharge, change level of care or recertify', async () => {
    seedPatient();
    for (const uid of ['aide', 'lpn', 'i']) {
      const who = { uid, role: uid === 'i' ? ('intake' as const) : ('clinician' as const) };
      await expect(recordDeathHandler(req({ orgId: ORG, patientId: PID, date: '2026-09-25' }, who))).rejects.toMatchObject(denied);
      await expect(dischargePatientHandler(req({ orgId: ORG, patientId: PID, dischargeDate: '2026-09-25', reason: 'revocation' }, who))).rejects.toMatchObject(denied);
      await expect(changeLevelOfCareHandler(req({ orgId: ORG, patientId: PID, levelOfCare: 'gip', effectiveDate: '2026-09-25', reason: 'x' }, who))).rejects.toMatchObject(denied);
      await expect(
        recordRecertificationHandler(req({ orgId: ORG, patientId: PID, periodNumber: 2, certifyingPhysician: 'Dr', certificationDate: '2026-12-10' }, who)),
      ).rejects.toMatchObject(denied);
    }
    expect(fakeDb.read<any>(P)!.status).toBe('admitted');
    // An admin with a non-clinical discipline may.
    fakeDb.seed(`orgs/${ORG}/members/a`, member('a', 'admin', { discipline: 'Admin' }));
    await changeLevelOfCareHandler(req({ orgId: ORG, patientId: PID, levelOfCare: 'gip', effectiveDate: '2026-09-25', reason: 'Pain' }, { uid: 'a', role: 'admin' }));
    expect(fakeDb.read<any>(P)!.levelOfCare).toBe('gip');
  });
});

describe('recordRecertification (S4)', () => {
  const base = { orgId: ORG, patientId: PID, certifyingPhysician: 'Dr. Who' };

  it('rejects a certification date outside period start − 15 … period start', async () => {
    seedPatient(); // period 2 starts 2026-12-19
    await expect(recordRecertificationHandler(req({ ...base, periodNumber: 2, certificationDate: '2026-12-03' }, { uid: 'c' }))).rejects.toMatchObject(invalid);
    await expect(recordRecertificationHandler(req({ ...base, periodNumber: 2, certificationDate: '2026-12-20' }, { uid: 'c' }))).rejects.toMatchObject(invalid);
    const res = await recordRecertificationHandler(req({ ...base, periodNumber: 2, certificationDate: '2026-12-04' }, { uid: 'c' }));
    expect(res).toEqual({ warnings: [] });
    expect(fakeDb.read<any>(P)!.milestoneCompletions['recert:2026-12-18']).toMatchObject({ effectiveDate: '2026-12-04' });
  });

  it('requires the F2F performer; an out-of-window F2F is a warning and leaves the F2F milestone open', async () => {
    seedPatient(); // period 3 starts 2027-03-19; F2F window 2027-02-17 … 2027-03-18
    await recordRecertificationHandler(req({ ...base, periodNumber: 2, certificationDate: '2026-12-10' }, { uid: 'c' }));
    const p3 = { ...base, periodNumber: 3, certificationDate: '2027-03-10' };
    await expect(recordRecertificationHandler(req({ ...p3, f2fDate: '2027-03-01' }, { uid: 'c' }))).rejects.toMatchObject(invalid);
    const res = await recordRecertificationHandler(req({ ...p3, f2fDate: '2027-02-10', f2fBy: 'NP Smith' }, { uid: 'c' }));
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toMatch(/outside its window \(2027-02-17 – 2027-03-18\)/);
    const p = fakeDb.read<any>(P)!;
    expect(p.milestoneCompletions['recert:2027-03-18']).toBeDefined();
    expect(p.milestoneCompletions['f2f:2027-03-18']).toBeUndefined();
    const ev = docsIn(`${P}/events`).find((e) => e.data.type === 'recertification' && e.data.details.periodNumber === 3)!;
    expect(ev.data.details).toMatchObject({ f2fInWindow: false, f2fBy: 'NP Smith', warnings: res.warnings });
  });

  it('an in-window F2F completes the F2F milestone with its date as effectiveDate', async () => {
    seedPatient();
    await recordRecertificationHandler(req({ ...base, periodNumber: 2, certificationDate: '2026-12-10' }, { uid: 'c' }));
    const res = await recordRecertificationHandler(req({ ...base, periodNumber: 3, certificationDate: '2027-03-10', f2fDate: '2027-03-01', f2fBy: 'NP Smith' }, { uid: 'c' }));
    expect(res.warnings).toEqual([]);
    expect(fakeDb.read<any>(P)!.milestoneCompletions['f2f:2027-03-18']).toMatchObject({ effectiveDate: '2027-03-01' });
  });
});

describe('recordDeath / discharge (O1)', () => {
  function seedVisit(id: string, over: Record<string, unknown> = {}) {
    const now = Date.now();
    fakeDb.seed(`orgs/${ORG}/visits/${id}`, {
      patientId: PID, patientName: 'Doe, Jane', discipline: 'RN', assignedUid: 'c',
      scheduledStart: Timestamp.fromMillis(now - HOUR), scheduledEnd: Timestamp.fromMillis(now + HOUR),
      status: 'scheduled', note: null, completedAt: null, completedBy: null, cancelledReason: null,
      createdBy: 'b', createdAt: Timestamp.now(), updatedAt: Timestamp.now(), ...over,
    });
  }

  it('completes the death visit at the time of death, delays archiving, notifies the care team', async () => {
    seedPatient({}, '2025-01-01');
    seedVisit('death');
    seedVisit('future', { scheduledStart: Timestamp.fromMillis(Date.now() + 24 * HOUR), scheduledEnd: Timestamp.fromMillis(Date.now() + 25 * HOUR) });
    seedVisit('other', { patientId: 'p2' });
    const tod = new Date(Date.now() - 10 * 60_000);
    const date = tod.toISOString().slice(0, 10);
    const time = tod.toISOString().slice(11, 16); // org time zone is UTC
    await expect(recordDeathHandler(req({ orgId: ORG, patientId: PID, date, time, visitId: 'other' }, { uid: 'c' }))).rejects.toMatchObject(invalid);

    await recordDeathHandler(req({ orgId: ORG, patientId: PID, date, time, visitId: 'death', bereavementRisk: 'low' }, { uid: 'c' }));
    const v = fakeDb.read<any>(`orgs/${ORG}/visits/death`)!;
    expect(v).toMatchObject({ status: 'completed', completedBy: 'c' });
    expect(Math.abs(v.completedAt.toMillis() - Math.floor(tod.getTime() / 60_000) * 60_000)).toBeLessThan(1000);
    expect(fakeDb.read<any>(`orgs/${ORG}/visits/future`)!.status).toBe('cancelled');

    const ch = fakeDb.read<any>(CH)!;
    expect(ch.archived).toBe(false);
    expect(ch.archiveAfter.toMillis() - Date.now()).toBeGreaterThan(71 * HOUR);
    expect(messages().map((m) => m.data)).toEqual([
      expect.objectContaining({ senderUid: 'system', priority: 'normal', body: expect.stringMatching(/^Patient death recorded by User C\./) }),
    ]);
    const alert = fakeDb.read<any>(`orgs/${ORG}/alerts/death_${PID}`)!;
    expect(alert).toMatchObject({ title: 'Patient death recorded', priority: 'normal', policyId: null });
    expect([...alert.targetUids].sort()).toEqual(['aide', 's']); // the care team minus the recorder
    expect(audit('patient.death')[0]!.data.metadata).toMatchObject({ completedVisitId: 'death', channelArchiveDelayed: true });
    expect(audit('visit.complete')).toHaveLength(1);
  });

  it('archiveEndedChannels archives after the delay, and skips a re-admitted patient', async () => {
    seedPatient();
    await dischargePatientHandler(req({ orgId: ORG, patientId: PID, dischargeDate: '2026-09-26', reason: 'revocation' }, { uid: 'c' }));
    expect(messages()).toHaveLength(1);
    expect(await archiveOrgEndedChannels(ORG, new Date())).toBe(0);
    expect(fakeDb.read<any>(CH)!.archived).toBe(false);
    expect(await archiveOrgEndedChannels(ORG, new Date(Date.now() + 73 * HOUR))).toBe(1);
    const ch = fakeDb.read<any>(CH)!;
    expect(ch.archived).toBe(true);
    expect(ch.archiveAfter).toBeUndefined();
    expect(audit('channel.archive')[0]!.data).toMatchObject({ actorUid: 'system', resourceId: 'ch1', patientId: PID });

    // Re-admitted within the delay: the channel stays open and the marker is cleared.
    seedPatient();
    await fakeDb.doc(CH).update({ archiveAfter: Timestamp.fromMillis(Date.now() - HOUR) });
    expect(await archiveOrgEndedChannels(ORG, new Date())).toBe(0);
    expect(fakeDb.read<any>(CH)!).toMatchObject({ archived: false });
    expect(fakeDb.read<any>(CH)!.archiveAfter).toBeUndefined();
  });
});

describe('updatePatientClinical (S2)', () => {
  const upd = (over: Record<string, unknown>) => ({ orgId: ORG, patientId: PID, reason: 'Family meeting', ...over });

  it('licensed care-team members or admins only', async () => {
    seedPatient();
    await expect(updatePatientClinicalHandler(req(upd({ allergies: [] }) as any, { uid: 'aide' }))).rejects.toMatchObject(denied);
    await expect(updatePatientClinicalHandler(req(upd({ allergies: [] }) as any, { uid: 'd' }))).rejects.toMatchObject(denied);
    await expect(updatePatientClinicalHandler(req(upd({ allergies: [] }) as any, { uid: 'v', role: 'viewer' }))).rejects.toMatchObject(denied);
    await expect(updatePatientClinicalHandler(req({ orgId: ORG, patientId: PID, allergies: [] } as any, { uid: 'c' }))).rejects.toMatchObject(invalid);
    await expect(updatePatientClinicalHandler(req(upd({}) as any, { uid: 'c' }))).rejects.toMatchObject(invalid);
    expect(await updatePatientClinicalHandler(req(upd({ allergies: ['Latex'] }) as any, { uid: 'a', role: 'admin' }))).toEqual({ changed: ['allergies'] });
  });

  it('merges object fields, replaces lists, and records an event and a PHI-free audit entry', async () => {
    seedPatient();
    const res = await updatePatientClinicalHandler(
      req(
        upd({
          caregiver: { phone: '555-9999' },
          attendingPhysician: { phone: '555-0200' },
          address: { line2: 'Apt 4' },
          medications: [{ name: 'Morphine', dose: '5 mg' }],
          referringPhysician: { npi: '999' } /* no current value and no name → invalid */,
        }) as any,
        { uid: 'c' },
      ),
    ).catch((e) => e);
    expect(res).toMatchObject(invalid);

    const ok = await updatePatientClinicalHandler(
      req(
        upd({
          caregiver: { phone: '555-9999' },
          attendingPhysician: { phone: '555-0200' },
          address: { line2: 'Apt 4' },
          medications: [{ name: 'Morphine', dose: '5 mg' }],
          phone: '',
        }) as any,
        { uid: 'c' },
      ),
    );
    expect(ok.changed).toEqual(['medications', 'caregiver', 'attendingPhysician', 'address']); // phone '' → null, unchanged
    const p = fakeDb.read<any>(P)!;
    expect(p.caregiver).toEqual({ name: 'John Doe', relationship: 'son', phone: '555-9999', address: { line1: '9 Elm', line2: null, city: null, state: null, zip: null } });
    expect(p.attendingPhysician).toEqual({ name: 'Dr. Adams', npi: '123', phone: '555-0200', fax: null });
    expect(p.address).toEqual({ line1: '1 Main St', line2: 'Apt 4', city: 'Springfield', state: 'IL', zip: '62701' });
    expect(p.medications).toEqual([{ name: 'Morphine', dose: '5 mg', route: null, frequency: null }]);
    expect(p.allergies).toEqual(['Penicillin']);
    expect(p.primaryDiagnosis).toEqual({ code: 'C34.90', description: 'Lung cancer' });

    const ev = docsIn(`${P}/events`).find((e) => e.data.type === 'clinical_update')!;
    expect(ev.data).toMatchObject({ recordedBy: 'c', summary: 'Clinical update: medications, caregiver, attending physician, address', details: { reason: 'Family meeting' } });
    expect(audit('patient.clinical_update')[0]!.data.metadata).toEqual({ fields: ['medications', 'caregiver', 'attendingPhysician', 'address'] });
    expect(messages()).toHaveLength(0); // no code-status change → no channel message or alert
    expect(alerts()).toHaveLength(0);

    // A no-op writes nothing.
    expect(await updatePatientClinicalHandler(req(upd({ allergies: ['Penicillin'] }) as any, { uid: 'c' }))).toEqual({ changed: [] });
    expect(docsIn(`${P}/events`).filter((e) => e.data.type === 'clinical_update')).toHaveLength(1);
  });

  it('a code-status change posts to the patient channel and alerts the rest of the care team', async () => {
    seedPatient();
    await updatePatientClinicalHandler(req(upd({ codeStatus: 'Full Code' }) as any, { uid: 'c' }));
    expect(fakeDb.read<any>(P)!.codeStatus).toBe('Full Code');
    expect(messages().map((m) => m.data)).toEqual([expect.objectContaining({ senderUid: 'system', body: 'Code status changed to Full Code by User C.' })]);
    const [alert] = alerts();
    expect(alert!.data).toMatchObject({ title: 'Code status changed', priority: 'normal', policyId: null, body: 'Doe, Jane: DNR → Full Code' });
    expect([...alert!.data.targetUids].sort()).toEqual(['aide', 's']);
    const ev = docsIn(`${P}/events`).find((e) => e.data.type === 'clinical_update')!;
    expect(ev.data.details).toMatchObject({ fields: ['codeStatus'], codeStatus: { from: 'DNR', to: 'Full Code' } });
    expect(ev.data.summary).toBe('Clinical update: code status DNR → Full Code');
  });
});
