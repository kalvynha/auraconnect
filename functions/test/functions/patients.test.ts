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

import { fakeDb } from '../fakes/firestore';
import { admitPatientHandler } from '../../src/patients/admitPatient';
import { checkOrgDeadlines, deadlineAlertId, runDeadlineChecks } from '../../src/patients/checkDeadlines';
import type { AdmitPatientRequest, Org } from '../../src/shared/types';
import { docsIn, ORG, req, seedOrg } from './helpers';

function admitReq(over: Partial<AdmitPatientRequest> = {}): AdmitPatientRequest {
  return {
    orgId: ORG,
    patient: {
      firstName: 'Jane', lastName: 'Doe', dob: '1940-05-01', sex: 'female', phone: null,
      address: { line1: null, line2: null, city: null, state: null, zip: null },
      mrn: null, medicareMbi: null, primaryDiagnosis: null, secondaryDiagnoses: [], referringPhysician: null,
      attendingPhysician: null, codeStatus: 'DNR', allergies: [], medications: [], caregiver: null,
      insurance: { payer: null, memberId: null },
    },
    admissionDate: '2026-09-20',
    levelOfCare: 'routine',
    careTeamUids: ['c'],
    consents: { electionStatement: true, hipaaNotice: true, releaseOfInformation: true, patientRights: true, polstOnFile: true },
    ...over,
  };
}

beforeEach(() => seedOrg());

describe('admitPatient', () => {
  it('rejects missing election statement / HIPAA notice consents', async () => {
    const base = admitReq();
    await expect(admitPatientHandler(req(admitReq({ consents: { ...base.consents, electionStatement: false } }), { uid: 'b' }))).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(admitPatientHandler(req(admitReq({ consents: { ...base.consents, hipaaNotice: false } }), { uid: 'b' }))).rejects.toMatchObject({ code: 'invalid-argument' });
    const { consents: _omit, ...noConsents } = base;
    await expect(admitPatientHandler(req(noConsents as AdmitPatientRequest, { uid: 'b' }))).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(docsIn(`orgs/${ORG}/patients`)).toHaveLength(0);
  });

  it('requires dob and at least one care team member; care team must be active members', async () => {
    const base = admitReq();
    await expect(admitPatientHandler(req(admitReq({ patient: { ...base.patient, dob: null } }), { uid: 'b' }))).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(admitPatientHandler(req(admitReq({ careTeamUids: [] }), { uid: 'b' }))).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(admitPatientHandler(req(admitReq({ careTeamUids: ['x'] }), { uid: 'b' }))).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(admitPatientHandler(req(admitReq(), { uid: 'v', role: 'viewer' }))).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('creates the patient with milestones, a care-team channel, and an audit entry', async () => {
    const { patientId, channelId } = await admitPatientHandler(req(admitReq(), { uid: 'b', role: 'intake' }));
    const p = fakeDb.read<any>(`orgs/${ORG}/patients/${patientId}`)!;
    expect(p).toMatchObject({ status: 'admitted', admissionDate: '2026-09-20', careTeamUids: ['c'], channelId, remindedMilestones: [], startingBenefitPeriod: 1 });
    expect(p.milestones.noeDueDate).toBe('2026-09-25');
    expect(fakeDb.read<any>(`orgs/${ORG}/channels/${channelId}`)).toMatchObject({
      type: 'patient', name: 'Doe, Jane – Care Team', memberUids: ['b', 'c'], patientId,
    });
    expect(docsIn(`orgs/${ORG}/auditLogs`).find((l) => l.data.action === 'patient.admit')?.data.patientId).toBe(patientId);
  });

  it('admits an existing referral patient, keeping remindedMilestones and reusing the channel', async () => {
    const first = await admitPatientHandler(req(admitReq(), { uid: 'b' }));
    await fakeDb.doc(`orgs/${ORG}/patients/${first.patientId}`).update({ remindedMilestones: ['noe:2026-09-25'] });
    const again = await admitPatientHandler(req(admitReq({ patientId: first.patientId, careTeamUids: ['a'] }), { uid: 'b' }));
    expect(again.channelId).toBe(first.channelId);
    expect(fakeDb.read<any>(`orgs/${ORG}/patients/${first.patientId}`)!.remindedMilestones).toEqual(['noe:2026-09-25']);
    expect(fakeDb.read<any>(`orgs/${ORG}/channels/${first.channelId}`)!.memberUids.sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('checkDeadlines', () => {
  it('raises deadline alerts to the care team once per milestone key', async () => {
    const { patientId } = await admitPatientHandler(req(admitReq({ admissionDate: '2026-09-20' }), { uid: 'b' }));
    const org = fakeDb.read<Org>(`orgs/${ORG}`)!;
    const n = await checkOrgDeadlines(ORG, org, '2026-09-23'); // HOPE admission 09-24, NOE 09-25
    expect(n).toBe(2);
    const alert = fakeDb.read<any>(`orgs/${ORG}/alerts/${deadlineAlertId(patientId, 'noe:2026-09-25')}`)!;
    expect(alert).toMatchObject({
      targetUids: ['c'], priority: 'normal', createdBy: 'system',
      source: { type: 'deadline', patientId, milestone: 'noe', dueDate: '2026-09-25' },
    });
    expect(fakeDb.read<any>(`orgs/${ORG}/patients/${patientId}`)!.remindedMilestones.sort()).toEqual(['hope_admission:2026-09-24', 'noe:2026-09-25']);
    expect(await checkOrgDeadlines(ORG, org, '2026-09-23')).toBe(0);
  });

  it('only processes orgs at 07:00 local time unless forced', async () => {
    await admitPatientHandler(req(admitReq(), { uid: 'b' }));
    expect(await runDeadlineChecks(new Date('2026-09-23T05:00:00Z'))).toEqual({ orgs: 0, alerts: 0 });
    expect(await runDeadlineChecks(new Date('2026-09-23T07:15:00Z'))).toEqual({ orgs: 1, alerts: 2 });
  });
});
