/**
 * v3 intake: admission guard/readmission (H2, I5, I6), stuck referrals (I1), claims (I2),
 * metadata (I3), duplicates (I4), phone referrals and non-admits (I5), invites (M5/L2/S7).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('firebase-admin/firestore', () => import('../fakes/firestore'));
const claims = new Map<string, Record<string, unknown>>();
vi.mock('firebase-admin/auth', () => ({
  getAuth: () => ({
    getUser: async (uid: string) => ({ uid, customClaims: claims.get(uid) }),
    setCustomUserClaims: async (uid: string, c: Record<string, unknown>) => void claims.set(uid, c),
    revokeRefreshTokens: async () => undefined,
  }),
}));

import type { CallableRequest } from 'firebase-functions/v2/https';
import { fakeDb, Timestamp } from '../fakes/firestore';
import { admitPatientHandler, defaultJoinChannel } from '../../src/patients/admitPatient';
import type { Extractor } from '../../src/lib/gemini';
import { claimReferralHandler } from '../../src/referrals/claim';
import { findPossibleDuplicates, lastNameVariants, normalizeMbi } from '../../src/referrals/duplicates';
import { closeReferralNonAdmitHandler, createManualReferralHandler } from '../../src/referrals/intake';
import { acceptReferralHandler, rejectReferralHandler, retryReferralExtractionHandler } from '../../src/referrals/reviewReferral';
import { isStaleReferral, type FileLoader } from '../../src/referrals/runExtraction';
import { acceptInviteHandler, inviteExpired } from '../../src/org/acceptInvite';
import { inviteMemberHandler } from '../../src/org/inviteMember';
import { listMyInvitesHandler } from '../../src/org/listMyInvites';
import { revokeInviteHandler } from '../../src/org/revokeInvite';
import type { AdmitPatientRequest, PatientInput } from '../../src/shared/types';
import { docsIn, member, ORG, req, seedOrg } from './helpers';

const MIN = 60_000;
const P = (id: string) => `orgs/${ORG}/patients/${id}`;
const R = (id: string) => `orgs/${ORG}/referrals/${id}`;

function patientInput(over: Partial<PatientInput> = {}): PatientInput {
  return {
    firstName: 'Jane', lastName: 'Doe', dob: '1940-05-01', sex: 'female', phone: null,
    address: { line1: null, line2: null, city: null, state: null, zip: null },
    mrn: null, medicareMbi: null, primaryDiagnosis: null, secondaryDiagnoses: [], referringPhysician: null,
    attendingPhysician: null, codeStatus: 'DNR', allergies: [], medications: [], caregiver: null,
    insurance: { payer: null, memberId: null },
    ...over,
  };
}

function admitReq(over: Partial<AdmitPatientRequest> = {}): AdmitPatientRequest {
  return {
    orgId: ORG,
    patient: patientInput(),
    admissionDate: '2026-09-20',
    levelOfCare: 'routine',
    careTeamUids: ['c'],
    consents: { electionStatement: true, hipaaNotice: true, releaseOfInformation: true, patientRights: true, polstOnFile: true },
    ...over,
  };
}

function verifiedReq<T>(data: T, uid: string, email: string): CallableRequest<T> {
  const r = req(data, { uid, orgId: null, email });
  (r.auth!.token as Record<string, unknown>).email_verified = true;
  return r;
}

function seedReferral(id: string, over: Record<string, unknown> = {}) {
  fakeDb.seed(R(id), {
    fileName: 'scan.pdf', contentType: 'application/pdf', storagePath: `orgs/${ORG}/referrals/${id}/scan.pdf`, source: 'upload',
    status: 'needs_review', extracted: { patient: patientInput(), referralDate: '2026-09-18', referralSource: 'Mercy Hospital', reasonForReferral: 'CHF', fieldConfidence: {}, warnings: [] },
    error: null, model: 'm', patientId: null, uploadedBy: 'b', reviewedBy: null, rejectionReason: null,
    createdAt: Timestamp.now(), updatedAt: Timestamp.now(), ...over,
  });
}

const noFile = { statFile: async () => null };
const pdf: FileLoader = async (path) => ({ uri: `gs://bucket/${path}`, contentType: 'application/pdf', size: 10 });
const extractor = (raw: unknown): Extractor => ({ extract: vi.fn(async () => ({ raw, model: 'gemini-test' })) });

beforeEach(() => {
  seedOrg();
  claims.clear();
  // i = intake coordinator (not licensed); m = MD.
  fakeDb.seed(`orgs/${ORG}/members/i`, member('i', 'intake', { discipline: 'Other' }));
  fakeDb.seed(`orgs/${ORG}/members/m`, member('m', 'clinician', { discipline: 'MD' }));
});

describe('admitPatient v3 (H2, I5, I6)', () => {
  it('joinChannel defaults: licensed clinicians join, intake does not', async () => {
    expect(defaultJoinChannel({ role: 'intake', discipline: 'RN' })).toBe(false);
    expect(defaultJoinChannel({ role: 'clinician', discipline: 'NP' })).toBe(true);
    expect(defaultJoinChannel({ role: 'clinician', discipline: 'SW' })).toBe(false);

    const byIntake = await admitPatientHandler(req(admitReq(), { uid: 'i', role: 'intake' }));
    expect(fakeDb.read<any>(`orgs/${ORG}/channels/${byIntake.channelId}`)!.memberUids).toEqual(['c']);
    const byMd = await admitPatientHandler(req(admitReq({ patient: patientInput({ lastName: 'Roe' }) }), { uid: 'm' }));
    expect(fakeDb.read<any>(`orgs/${ORG}/channels/${byMd.channelId}`)!.memberUids).toEqual(['c', 'm']);
    const optOut = await admitPatientHandler(req(admitReq({ patient: patientInput({ lastName: 'Poe' }), joinChannel: false }), { uid: 'm' }));
    expect(fakeDb.read<any>(`orgs/${ORG}/channels/${optOut.channelId}`)!.memberUids).toEqual(['c']);
    const optIn = await admitPatientHandler(req(admitReq({ patient: patientInput({ lastName: 'Moe' }), joinChannel: true }), { uid: 'i' }));
    expect(fakeDb.read<any>(`orgs/${ORG}/channels/${optIn.channelId}`)!.memberUids).toEqual(['c', 'i']);
  });

  it('never overwrites an admitted patient; update needs update: true from admin/care team and keeps server fields', async () => {
    const { patientId, channelId } = await admitPatientHandler(req(admitReq({ visitFrequencies: [{ discipline: 'RN', perWeek: 2, notes: null }] }), { uid: 'i' }));
    expect(fakeDb.read<any>(P(patientId))!.visitFrequencies).toEqual([{ discipline: 'RN', perWeek: 2, notes: null }]);
    await fakeDb.doc(P(patientId)).update({
      milestoneCompletions: { 'noe:2026-09-25': { completedBy: 'c' } }, volunteerUids: ['vol1'], referralSource: 'Mercy',
    });
    await expect(admitPatientHandler(req(admitReq({ patientId }), { uid: 'c' }))).rejects.toMatchObject({ code: 'already-exists' });
    await expect(admitPatientHandler(req(admitReq({ patientId, update: true }), { uid: 'b' }))).rejects.toMatchObject({ code: 'permission-denied' });

    await admitPatientHandler(req(admitReq({ patientId, update: true, patient: patientInput({ codeStatus: 'Full Code' }), levelOfCare: 'gip', careTeamUids: ['b'] }), { uid: 'c' }));
    const p = fakeDb.read<any>(P(patientId))!;
    expect(p).toMatchObject({
      status: 'admitted', codeStatus: 'Full Code', levelOfCare: 'routine', careTeamUids: ['c'], channelId,
      milestoneCompletions: { 'noe:2026-09-25': { completedBy: 'c' } }, volunteerUids: ['vol1'], referralSource: 'Mercy',
    });
    expect(docsIn(`${P(patientId)}/events`)).toHaveLength(1);
    expect(docsIn(`orgs/${ORG}/auditLogs`).find((l) => l.data.metadata.mode === 'update')?.data.action).toBe('patient.update');
    // Admins may update too.
    await admitPatientHandler(req(admitReq({ patientId, update: true }), { uid: 'a', role: 'admin' }));
  });

  it('readmits a discharged patient: archives prior milestones, recomputes, un-archives the channel', async () => {
    const { patientId, channelId } = await admitPatientHandler(req(admitReq(), { uid: 'm' }));
    await fakeDb.doc(P(patientId)).update({
      status: 'discharged', dischargeDate: '2026-10-01', dischargeReason: 'revocation',
      milestoneCompletions: { 'noe:2026-09-25': { completedBy: 'c' } }, remindedMilestones: ['noe:2026-09-25'],
    });
    await fakeDb.doc(`orgs/${ORG}/channels/${channelId}`).update({ archived: true });

    await expect(admitPatientHandler(req(admitReq({ patientId, admissionDate: '2026-11-01' }), { uid: 'm' }))).rejects.toMatchObject({ code: 'failed-precondition' });
    const res = await admitPatientHandler(req(admitReq({ patientId, admissionDate: '2026-11-01', readmission: true, startingBenefitPeriod: 2, careTeamUids: ['c', 'b'] }), { uid: 'm' }));
    expect(res.channelId).toBe(channelId);
    const p = fakeDb.read<any>(P(patientId))!;
    expect(p).toMatchObject({
      status: 'admitted', admissionDate: '2026-11-01', startingBenefitPeriod: 2, dischargeDate: null, dischargeReason: null,
      milestoneCompletions: {}, remindedMilestones: [], careTeamUids: ['b', 'c'],
    });
    expect(p.milestones.noeDueDate).toBe('2026-11-06');
    const ch = fakeDb.read<any>(`orgs/${ORG}/channels/${channelId}`)!;
    expect(ch.archived).toBe(false);
    expect(ch.memberUids.sort()).toEqual(['b', 'c', 'm']);
    const events = docsIn(`${P(patientId)}/events`).map((e) => e.data).filter((e) => e.type === 'admission');
    expect(events).toHaveLength(2);
    const re = events.find((e) => e.details.readmission)!;
    expect(re.summary).toMatch(/^Readmitted/);
    expect(re.details).toMatchObject({ priorAdmissionDate: '2026-09-20', priorDischargeDate: '2026-10-01', priorMilestoneCompletions: { 'noe:2026-09-25': { completedBy: 'c' } } });
    expect(re.details.priorMilestones.noeDueDate).toBe('2026-09-25');
  });

  it('transfer: passes benefitPeriodStart through to milestones and rejects an invalid one', async () => {
    await expect(admitPatientHandler(req(admitReq({ startingBenefitPeriod: 3, benefitPeriodStart: '2026-09-25' }), { uid: 'm' }))).rejects.toMatchObject({ code: 'invalid-argument' });
    const { patientId } = await admitPatientHandler(req(admitReq({ startingBenefitPeriod: 3, benefitPeriodStart: '2026-09-01' }), { uid: 'm' }));
    const p = fakeDb.read<any>(P(patientId))!;
    expect(p.benefitPeriodStart).toBe('2026-09-01');
    expect(p.milestones.benefitPeriods[0]).toMatchObject({ number: 3, start: '2026-09-01' });
  });

  it('cannot admit a deceased or non-admit patient', async () => {
    fakeDb.seed(P('gone'), { ...patientInput(), status: 'non_admit', careTeamUids: [] });
    await expect(admitPatientHandler(req(admitReq({ patientId: 'gone' }), { uid: 'm' }))).rejects.toMatchObject({ code: 'failed-precondition' });
  });
});

describe('stuck referrals and retry (I1)', () => {
  it('isStaleReferral uses extractionStartedAt for extracting and updatedAt for uploaded', () => {
    const now = Date.now();
    const at = (m: number) => Timestamp.fromMillis(now - m * MIN);
    expect(isStaleReferral({ status: 'extracting', extractionStartedAt: at(7), updatedAt: at(1), createdAt: at(9) } as any, now)).toBe(true);
    expect(isStaleReferral({ status: 'extracting', extractionStartedAt: at(5), updatedAt: at(9), createdAt: at(9) } as any, now)).toBe(false);
    expect(isStaleReferral({ status: 'uploaded', updatedAt: at(7), createdAt: at(7) } as any, now)).toBe(true);
    expect(isStaleReferral({ status: 'needs_review', updatedAt: at(70), createdAt: at(70) } as any, now)).toBe(false);
  });

  it('retries a stale extracting referral, records extractionStartedAt, and enforces a 2-minute cooldown', async () => {
    const now = Date.now();
    seedReferral('r1', { status: 'extracting', extractionStartedAt: Timestamp.fromMillis(now - 3 * MIN) });
    const deps = { loadFile: pdf, extractor: extractor({ patient: { firstName: 'Z', lastName: 'Q' } }) };
    await expect(retryReferralExtractionHandler(req({ orgId: ORG, referralId: 'r1' }, { uid: 'b' }), { ...deps, now: () => now })).rejects.toMatchObject({ code: 'failed-precondition' });

    const later = now + 4 * MIN;
    await retryReferralExtractionHandler(req({ orgId: ORG, referralId: 'r1' }, { uid: 'b' }), { ...deps, now: () => later });
    const r = fakeDb.read<any>(R('r1'))!;
    expect(r).toMatchObject({ status: 'needs_review', possibleDuplicates: [] });
    expect(r.extractionStartedAt.toMillis()).toBe(later);
    expect(r.retryRequestedAt.toMillis()).toBe(later);
    expect(deps.extractor.extract).toHaveBeenCalledWith({ fileUri: `gs://bucket/${r.storagePath}`, mimeType: 'application/pdf' });
    expect(docsIn(`orgs/${ORG}/auditLogs`).some((l) => l.data.action === 'referral.retry')).toBe(true);

    await expect(retryReferralExtractionHandler(req({ orgId: ORG, referralId: 'r1' }, { uid: 'c' }), { ...deps, now: () => later + MIN })).rejects.toMatchObject({ code: 'resource-exhausted' });
    await retryReferralExtractionHandler(req({ orgId: ORG, referralId: 'r1' }, { uid: 'c' }), { ...deps, now: () => later + 3 * MIN });
  });

  it('rejects a stale upload but not a fresh one; a phone referral cannot be retried', async () => {
    seedReferral('fresh', { status: 'uploaded' });
    await expect(rejectReferralHandler(req({ orgId: ORG, referralId: 'fresh', reason: 'x' }, { uid: 'b' }))).rejects.toMatchObject({ code: 'failed-precondition' });
    await rejectReferralHandler(req({ orgId: ORG, referralId: 'fresh', reason: 'Never uploaded' }, { uid: 'b' }), { now: () => Date.now() + 10 * MIN });
    expect(fakeDb.read<any>(R('fresh'))!.status).toBe('rejected');

    seedReferral('ph', { source: 'phone', fileName: null, contentType: null, storagePath: null, status: 'failed' });
    await expect(retryReferralExtractionHandler(req({ orgId: ORG, referralId: 'ph' }, { uid: 'b' }))).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('rejects files outside the aligned MIME list (e.g. TIFF)', async () => {
    seedReferral('t', { status: 'failed', contentType: 'image/tiff' });
    const tiff: FileLoader = async (path) => ({ uri: `gs://bucket/${path}`, contentType: 'image/tiff', size: 10 });
    await retryReferralExtractionHandler(req({ orgId: ORG, referralId: 't' }, { uid: 'b' }), { loadFile: tiff, extractor: extractor({}) });
    expect(fakeDb.read<any>(R('t'))).toMatchObject({ status: 'failed', error: expect.stringMatching(/PDF/) });
  });
});

describe('claims (I2) and metadata (I3)', () => {
  it('claim, collision, takeover with force or after 30 minutes, and release', async () => {
    seedReferral('r1');
    const now = Date.now();
    expect(await claimReferralHandler(req({ orgId: ORG, referralId: 'r1' }, { uid: 'b' }), { now: () => now })).toEqual({ claimedBy: 'b' });
    await expect(claimReferralHandler(req({ orgId: ORG, referralId: 'r1' }, { uid: 'c' }), { now: () => now + MIN })).rejects.toMatchObject({ code: 'already-exists' });
    // The claimant blocks accept/reject by others.
    await expect(acceptReferralHandler(req({ orgId: ORG, referralId: 'r1', patient: patientInput() }, { uid: 'c' }), { ...noFile, now: () => now + MIN })).rejects.toMatchObject({ code: 'failed-precondition' });
    await expect(rejectReferralHandler(req({ orgId: ORG, referralId: 'r1', reason: 'x' }, { uid: 'c' }), { now: () => now + MIN })).rejects.toMatchObject({ code: 'failed-precondition' });

    expect(await claimReferralHandler(req({ orgId: ORG, referralId: 'r1', force: true }, { uid: 'c' }), { now: () => now + 2 * MIN })).toEqual({ claimedBy: 'c' });
    expect(await claimReferralHandler(req({ orgId: ORG, referralId: 'r1' }, { uid: 'b' }), { now: () => now + 40 * MIN })).toEqual({ claimedBy: 'b' });
    const takeovers = docsIn(`orgs/${ORG}/auditLogs`).filter((l) => l.data.action === 'referral.claim' && l.data.metadata.takeover);
    expect(takeovers.map((l) => l.data.metadata.previousClaimant)).toEqual(['b', 'c']);

    expect(await claimReferralHandler(req({ orgId: ORG, referralId: 'r1', release: true }, { uid: 'b' }), { now: () => now + 41 * MIN })).toEqual({ claimedBy: null });
    expect(fakeDb.read<any>(R('r1'))!.claimedBy).toBeNull();
  });

  it('accept carries edited metadata and referralReceivedAt onto the patient; a second accept is already-exists', async () => {
    seedReferral('r1');
    await claimReferralHandler(req({ orgId: ORG, referralId: 'r1' }, { uid: 'b' }));
    const { patientId } = await acceptReferralHandler(
      req({ orgId: ORG, referralId: 'r1', patient: patientInput(), referralSource: '  Hospice Link  ', reasonForReferral: '' }, { uid: 'b' }),
      noFile,
    );
    const p = fakeDb.read<any>(P(patientId))!;
    expect(p).toMatchObject({ status: 'referral', referralDate: '2026-09-18', referralSource: 'Hospice Link', reasonForReferral: null });
    expect(p.referralReceivedAt).toEqual(fakeDb.read<any>(R('r1'))!.createdAt);
    await expect(acceptReferralHandler(req({ orgId: ORG, referralId: 'r1', patient: patientInput() }, { uid: 'b' }), noFile)).rejects.toMatchObject({ code: 'already-exists' });
  });
});

describe('duplicate detection (I4)', () => {
  it('matches patients by MBI and name+DOB, and recent referrals; skips itself and old referrals', async () => {
    fakeDb.seed(P('p1'), { ...patientInput({ lastName: 'DOE', medicareMbi: '1EG4-TE5-MK73' }), status: 'admitted' });
    fakeDb.seed(P('p2'), { ...patientInput({ firstName: 'Other', lastName: 'Smith', medicareMbi: null }), status: 'discharged' });
    seedReferral('recent', { status: 'needs_review' });
    seedReferral('old', { createdAt: Timestamp.fromMillis(Date.now() - 40 * 86_400_000) });
    seedReferral('self');

    const matches = await findPossibleDuplicates(ORG, { patient: { lastName: 'Doe', dob: '1940-05-01', medicareMbi: '1eg4te5mk73' }, referralId: 'self' });
    expect(matches.map((m) => `${m.kind}/${m.id}`).sort()).toEqual(['patient/p1', 'referral/recent']);
    expect(matches.find((m) => m.id === 'p1')).toMatchObject({ matchedOn: ['mbi', 'name_dob'], displayName: 'DOE, Jane', status: 'admitted' });
    expect(normalizeMbi(' 1eg4-te5-mk73 ')).toBe('1EG4TE5MK73');
    expect(lastNameVariants("o'brien")).toContain("O'Brien");
  });

  it('extraction writes possibleDuplicates; accept requires confirmNotDuplicate when there are matches', async () => {
    fakeDb.seed(P('p1'), { ...patientInput(), status: 'admitted' });
    seedReferral('r1', { status: 'uploaded', extracted: null });
    await retryReferralExtractionHandler(req({ orgId: ORG, referralId: 'r1' }, { uid: 'b' }), {
      loadFile: pdf, extractor: extractor({ patient: { firstName: 'Jane', lastName: 'Doe', dob: '1940-05-01' } }), now: () => Date.now() + 10 * MIN,
    });
    expect(fakeDb.read<any>(R('r1'))!.possibleDuplicates).toEqual([
      { kind: 'patient', id: 'p1', matchedOn: ['name_dob'], displayName: 'Doe, Jane', status: 'admitted' },
    ]);
    await expect(acceptReferralHandler(req({ orgId: ORG, referralId: 'r1', patient: patientInput() }, { uid: 'b' }), noFile)).rejects.toMatchObject({ code: 'failed-precondition' });
    const { patientId } = await acceptReferralHandler(req({ orgId: ORG, referralId: 'r1', patient: patientInput(), confirmNotDuplicate: true }, { uid: 'b' }), noFile);
    expect(fakeDb.read<any>(R('r1'))).toMatchObject({ status: 'accepted', patientId });
    const audit = docsIn(`orgs/${ORG}/auditLogs`).find((l) => l.data.action === 'referral.accept')!;
    expect(audit.data.metadata).toMatchObject({ possibleDuplicates: 1, confirmedNotDuplicate: true });
  });
});

describe('phone referrals and non-admits (I5)', () => {
  it('createManualReferral goes straight to needs_review with no file, claimed by the creator', async () => {
    const { id } = await createManualReferralHandler(
      req({ orgId: ORG, patient: patientInput(), referralDate: '2026-09-26', referralSource: 'Dr. Patel office', reasonForReferral: 'ALS' }, { uid: 'i', role: 'intake' }),
    );
    expect(fakeDb.read<any>(R(id))).toMatchObject({
      source: 'phone', status: 'needs_review', fileName: null, storagePath: null, contentType: null, claimedBy: 'i', uploadedBy: 'i',
      extracted: { referralDate: '2026-09-26', referralSource: 'Dr. Patel office', reasonForReferral: 'ALS', fieldConfidence: {}, warnings: [] },
    });
    await expect(createManualReferralHandler(req({ orgId: ORG, patient: patientInput() }, { uid: 'v', role: 'viewer' }))).rejects.toMatchObject({ code: 'permission-denied' });
    // Accepting a phone referral creates no patient document.
    const { patientId } = await acceptReferralHandler(req({ orgId: ORG, referralId: id, patient: patientInput() }, { uid: 'i' }));
    expect(docsIn(`${P(patientId)}/documents`)).toHaveLength(0);
    expect(fakeDb.read<any>(P(patientId))!.referralSource).toBe('Dr. Patel office');
    expect(docsIn(`orgs/${ORG}/auditLogs`).some((l) => l.data.action === 'referral.create')).toBe(true);
  });

  it('closes a needs_review referral as a non-admit', async () => {
    seedReferral('r1');
    await expect(closeReferralNonAdmitHandler(req({ orgId: ORG, referralId: 'r1', reason: 'other' }, { uid: 'b' }))).rejects.toMatchObject({ code: 'invalid-argument' });
    await closeReferralNonAdmitHandler(req({ orgId: ORG, referralId: 'r1', reason: 'declined_hospice', note: 'Family chose curative care' }, { uid: 'b' }));
    expect(fakeDb.read<any>(R('r1'))).toMatchObject({ status: 'non_admit', nonAdmit: { reason: 'declined_hospice', note: 'Family chose curative care', deathDate: null, closedBy: 'b' } });
    // Idempotent; cannot be rejected afterwards.
    await closeReferralNonAdmitHandler(req({ orgId: ORG, referralId: 'r1', reason: 'declined_hospice' }, { uid: 'b' }));
    await expect(rejectReferralHandler(req({ orgId: ORG, referralId: 'r1', reason: 'x' }, { uid: 'b' }))).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('died before admission: records the death on the referral patient without a bereavement plan and cancels open work', async () => {
    seedReferral('r1');
    const { patientId } = await acceptReferralHandler(req({ orgId: ORG, referralId: 'r1', patient: patientInput() }, { uid: 'b' }), noFile);
    fakeDb.seed(`orgs/${ORG}/visits/v1`, {
      patientId, status: 'scheduled', scheduledStart: Timestamp.fromMillis(Date.now() + 3_600_000), scheduledEnd: Timestamp.fromMillis(Date.now() + 7_200_000),
    });
    fakeDb.seed(`orgs/${ORG}/tasks/t1`, { patientId, status: 'open' });
    await expect(closeReferralNonAdmitHandler(req({ orgId: ORG, referralId: 'r1', reason: 'died_before_admission', deathDate: '2999-01-01' }, { uid: 'b' }))).rejects.toMatchObject({ code: 'invalid-argument' });
    await closeReferralNonAdmitHandler(req({ orgId: ORG, referralId: 'r1', reason: 'died_before_admission', deathDate: '2026-09-20' }, { uid: 'c' }));
    expect(fakeDb.read<any>(P(patientId))).toMatchObject({
      status: 'non_admit', nonAdmit: { reason: 'died_before_admission', deathDate: '2026-09-20' }, death: { date: '2026-09-20' },
    });
    expect(fakeDb.read<any>(R('r1'))!.status).toBe('non_admit');
    expect(docsIn(`orgs/${ORG}/bereavementPlans`)).toHaveLength(0);
    expect(fakeDb.read<any>(`orgs/${ORG}/visits/v1`)).toMatchObject({ status: 'cancelled', cancelledReason: 'Died before admission' });
    expect(fakeDb.read<any>(`orgs/${ORG}/tasks/t1`)!.status).toBe('cancelled');
    expect(docsIn(`orgs/${ORG}/auditLogs`).find((l) => l.data.action === 'referral.non_admit')!.data).toMatchObject({ patientId, metadata: { reason: 'died_before_admission', patientClosed: true } });
  });

  it('refuses a non-admit once the patient is admitted', async () => {
    seedReferral('r1');
    const { patientId } = await acceptReferralHandler(req({ orgId: ORG, referralId: 'r1', patient: patientInput() }, { uid: 'b' }), noFile);
    await admitPatientHandler(req(admitReq({ patientId }), { uid: 'm' }));
    await expect(closeReferralNonAdmitHandler(req({ orgId: ORG, referralId: 'r1', reason: 'not_eligible' }, { uid: 'b' }))).rejects.toMatchObject({ code: 'failed-precondition' });
  });
});

describe('invites v3 (expiry, revoke, verified listing, team updates)', () => {
  const invite = { orgId: ORG, email: 'new@example.org', displayName: 'New', role: 'clinician' as const, discipline: 'RN' as const };

  it('sets a 14-day expiry; expired and revoked invites cannot be accepted or listed', async () => {
    const { inviteId } = await inviteMemberHandler(req(invite, { uid: 'a', role: 'admin' }));
    const inv = fakeDb.read<any>(`orgs/${ORG}/invites/${inviteId}`)!;
    expect(Math.round((inv.expiresAt.toMillis() - Date.now()) / 86_400_000)).toBe(14);
    expect(inviteExpired({ createdAt: Timestamp.fromMillis(Date.now() - 15 * 86_400_000) } as any)).toBe(true);

    await fakeDb.doc(`orgs/${ORG}/invites/${inviteId}`).update({ expiresAt: Timestamp.fromMillis(Date.now() - 1000) });
    expect((await listMyInvitesHandler(verifiedReq({}, 'n', 'new@example.org'), { requireVerified: true })).invites).toEqual([]);
    await expect(acceptInviteHandler(verifiedReq({ orgId: ORG, inviteId }, 'n', 'new@example.org'), { requireVerified: true })).rejects.toMatchObject({ code: 'failed-precondition' });

    // Re-sending refreshes the expiry.
    await inviteMemberHandler(req(invite, { uid: 'a', role: 'admin' }));
    expect((await listMyInvitesHandler(verifiedReq({}, 'n', 'new@example.org'), { requireVerified: true })).invites).toHaveLength(1);

    await expect(revokeInviteHandler(req({ orgId: ORG, inviteId }, { uid: 'b' }))).rejects.toMatchObject({ code: 'permission-denied' });
    await revokeInviteHandler(req({ orgId: ORG, inviteId }, { uid: 'a', role: 'admin' }));
    expect(fakeDb.read<any>(`orgs/${ORG}/invites/${inviteId}`)).toMatchObject({ status: 'revoked', revokedBy: 'a' });
    expect(docsIn(`orgs/${ORG}/auditLogs`).some((l) => l.data.action === 'invite.revoke')).toBe(true);
    await expect(acceptInviteHandler(verifiedReq({ orgId: ORG, inviteId }, 'n', 'new@example.org'), { requireVerified: true })).rejects.toMatchObject({ code: 'failed-precondition' });
    expect((await listMyInvitesHandler(verifiedReq({}, 'n', 'new@example.org'), { requireVerified: true })).invites).toEqual([]);
  });

  it('listMyInvites requires a verified email (L2)', async () => {
    await inviteMemberHandler(req(invite, { uid: 'a', role: 'admin' }));
    expect(await listMyInvitesHandler(req({}, { uid: 'n', orgId: null, email: 'new@example.org' }), { requireVerified: true })).toEqual({ invites: [], verificationRequired: true });
    expect((await listMyInvitesHandler(verifiedReq({}, 'n', 'new@example.org'), { requireVerified: true })).invites).toHaveLength(1);
  });

  it('acceptInvite adds the member to existing teams with arrayUnion after the transaction', async () => {
    fakeDb.seed(`orgs/${ORG}/teams/t1`, { name: 'North', description: null, memberUids: ['b'], createdAt: Timestamp.now() });
    const { inviteId } = await inviteMemberHandler(req({ ...invite, teamIds: ['t1'] }, { uid: 'a', role: 'admin' }));
    await fakeDb.doc(`orgs/${ORG}/invites/${inviteId}`).update({ teamIds: ['t1', 'deleted'] });
    await acceptInviteHandler(verifiedReq({ orgId: ORG, inviteId }, 'n', 'new@example.org'), { requireVerified: true });
    expect(fakeDb.read<any>(`orgs/${ORG}/teams/t1`)!.memberUids).toEqual(['b', 'n']);
    expect(fakeDb.read<any>(`orgs/${ORG}/members/n`)!.teamIds).toEqual(['t1']);
    expect(claims.get('n')).toEqual({ orgId: ORG, role: 'clinician' });
  });
});
