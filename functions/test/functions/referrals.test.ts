import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('firebase-admin/firestore', () => import('../fakes/firestore'));

import { fakeDb, Timestamp } from '../fakes/firestore';
import type { Extractor } from '../../src/lib/gemini';
import { handleReferralUploaded, parseReferralPath } from '../../src/referrals/onReferralUploaded';
import type { FileLoader } from '../../src/referrals/runExtraction';
import { acceptReferralHandler, rejectReferralHandler, retryReferralExtractionHandler } from '../../src/referrals/reviewReferral';
import { docsIn, ORG, req, seedOrg } from './helpers';

const PATH = `orgs/${ORG}/referrals/r1/scan.pdf`;
const refPath = `orgs/${ORG}/referrals/r1`;

const pdf: FileLoader = async () => ({ data: Buffer.from('%PDF-1.7 fake'), contentType: 'application/pdf', size: 13 });
const fakeExtractor = (raw: unknown): Extractor => ({ extract: vi.fn(async () => ({ raw, model: 'gemini-test' })) });

function seedReferral(status = 'uploaded') {
  fakeDb.seed(refPath, {
    fileName: 'scan.pdf', contentType: 'application/pdf', storagePath: PATH, source: 'scan', status,
    extracted: null, error: null, model: null, patientId: null, uploadedBy: 'b', reviewedBy: null,
    rejectionReason: null, createdAt: Timestamp.now(), updatedAt: Timestamp.now(),
  });
}

beforeEach(() => {
  seedOrg();
  seedReferral();
});

describe('onReferralUploaded → runExtraction', () => {
  it('normalizes the extractor output and moves to needs_review', async () => {
    const extractor = fakeExtractor({
      patient: { firstName: 'Ann', lastName: 'Lee', dob: '1939-13-40', sex: 'female', codeStatus: 'DNR' },
      fieldConfidence: [{ path: 'patient.lastName', confidence: 3 }],
      warnings: ['fax header cut off'],
    });
    const res = await handleReferralUploaded({ name: PATH, size: 13 }, { extractor, loadFile: pdf });
    expect(res).toBe('needs_review');
    expect(extractor.extract).toHaveBeenCalledWith({ data: expect.any(Buffer), mimeType: 'application/pdf' });
    const r = fakeDb.read<any>(refPath)!;
    expect(r.status).toBe('needs_review');
    expect(r.model).toBe('gemini-test');
    expect(r.extracted.patient).toMatchObject({ firstName: 'Ann', lastName: 'Lee', dob: null, codeStatus: 'DNR' });
    expect(r.extracted.fieldConfidence).toEqual({ 'patient.lastName': 1 });
    expect(r.extracted.warnings[0]).toBe('fax header cut off');
    expect(docsIn(`orgs/${ORG}/auditLogs`).find((l) => l.data.action === 'referral.extract')?.data.actorUid).toBe('system');

    // duplicate trigger delivery does nothing
    expect(await handleReferralUploaded({ name: PATH, size: 13 }, { extractor, loadFile: pdf })).toBe('skipped');
  });

  it('marks failed with a PHI-free error when the model throws', async () => {
    const extractor: Extractor = { extract: async () => { throw new Error('Patient Ann Lee DOB 1939 could not be parsed'); } };
    expect(await handleReferralUploaded({ name: PATH, size: 13 }, { extractor, loadFile: pdf })).toBe('failed');
    const r = fakeDb.read<any>(refPath)!;
    expect(r.status).toBe('failed');
    expect(r.error).not.toMatch(/Ann|Lee|1939/);
  });

  it('rejects oversize files and non-PDF/image types', async () => {
    expect(await handleReferralUploaded({ name: PATH, size: 26 * 1024 * 1024 }, { extractor: fakeExtractor({}), loadFile: pdf })).toBe('failed');
    expect(fakeDb.read<any>(refPath)!.error).toMatch(/25 MB/);
    seedReferral();
    const txt: FileLoader = async () => ({ data: Buffer.from('x'), contentType: 'text/plain', size: 1 });
    expect(await handleReferralUploaded({ name: PATH, size: 1 }, { extractor: fakeExtractor({}), loadFile: txt })).toBe('failed');
  });

  it('ignores unrelated paths and mismatched files', async () => {
    expect(parseReferralPath(`orgs/${ORG}/channels/c/attachments/x.png`)).toBeNull();
    expect(await handleReferralUploaded({ name: `orgs/${ORG}/channels/c/attachments/x.png`, size: 1 })).toBe('ignored');
    expect(await handleReferralUploaded({ name: `orgs/${ORG}/referrals/r1/other.pdf`, size: 1 })).toBe('ignored');
    expect(await handleReferralUploaded({ name: `orgs/${ORG}/referrals/nope/scan.pdf`, size: 1 })).toBe('ignored');
  });

  it('retryReferralExtraction re-runs from failed', async () => {
    seedReferral('failed');
    await retryReferralExtractionHandler(req({ orgId: ORG, referralId: 'r1' }, { uid: 'b' }), { extractor: fakeExtractor({ patient: { firstName: 'Z' } }), loadFile: pdf });
    expect(fakeDb.read<any>(refPath)!).toMatchObject({ status: 'needs_review', error: null });
    seedReferral('accepted');
    await expect(retryReferralExtractionHandler(req({ orgId: ORG, referralId: 'r1' }, { uid: 'b' }))).rejects.toMatchObject({ code: 'failed-precondition' });
  });
});

describe('accept / reject referral', () => {
  const patient = { firstName: 'Ann', lastName: 'Lee' };

  it('accepts from needs_review or failed, creating a referral-status patient (idempotent)', async () => {
    seedReferral('failed');
    const { patientId } = await acceptReferralHandler(req({ orgId: ORG, referralId: 'r1', patient } as any, { uid: 'b', role: 'intake' }));
    expect(fakeDb.read<any>(`orgs/${ORG}/patients/${patientId}`)).toMatchObject({
      status: 'referral', referralId: 'r1', firstName: 'Ann', sex: 'unknown', codeStatus: 'Unknown', remindedMilestones: [], milestones: null,
    });
    expect(fakeDb.read<any>(refPath)).toMatchObject({ status: 'accepted', patientId, reviewedBy: 'b' });
    const again = await acceptReferralHandler(req({ orgId: ORG, referralId: 'r1', patient } as any, { uid: 'b' }));
    expect(again.patientId).toBe(patientId);
    await expect(rejectReferralHandler(req({ orgId: ORG, referralId: 'r1', reason: 'dup' }, { uid: 'b' }))).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('rejects with a reason; viewers cannot', async () => {
    seedReferral('needs_review');
    await expect(rejectReferralHandler(req({ orgId: ORG, referralId: 'r1', reason: 'x' }, { uid: 'v', role: 'viewer' }))).rejects.toMatchObject({ code: 'permission-denied' });
    await rejectReferralHandler(req({ orgId: ORG, referralId: 'r1', reason: 'Not eligible' }, { uid: 'b' }));
    expect(fakeDb.read<any>(refPath)).toMatchObject({ status: 'rejected', rejectionReason: 'Not eligible' });
  });
});
