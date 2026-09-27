// v3 intake rules: referral MIME types aligned with the extractor (I1), server-only
// claim/duplicate/non-admit fields (I2, I4, I5) and server-only invite revocation (S7).
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, serverTimestamp, setDoc, Timestamp, updateDoc } from 'firebase/firestore';
import { ref as sRef, uploadBytes } from 'firebase/storage';
import { as, createEnv, ORG, seed, USERS } from './fixtures.js';

let env;
beforeAll(async () => { env = await createEnv({ storage: true }); });
afterAll(async () => { await env?.cleanup(); });

beforeEach(async () => {
  await env.clearFirestore();
  await env.clearStorage();
  await seed(env);
  await env.withSecurityRulesDisabled(async (ctx) => {
    const now = Timestamp.now();
    await setDoc(doc(ctx.firestore(), `orgs/${ORG}/referrals/r-open`), {
      ...referral(USERS.intake, 'r-open'), status: 'needs_review', createdAt: now, updatedAt: now,
    });
    await setDoc(doc(ctx.firestore(), `orgs/${ORG}/invites/i1`), {
      email: 'new@example.org', displayName: 'New', role: 'clinician', discipline: 'RN', teamIds: [], status: 'pending',
      createdBy: USERS.admin.uid, createdAt: now, acceptedBy: null, acceptedAt: null, expiresAt: now,
    });
  });
});

const db = (user) => as(env, user).firestore();
const storage = (user) => as(env, user).storage();
const SMALL = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);

function referral(user, id, overrides = {}) {
  const fileName = overrides.fileName ?? 'referral.pdf';
  return {
    fileName,
    contentType: 'application/pdf',
    storagePath: `orgs/${ORG}/referrals/${id}/${fileName}`,
    source: 'upload',
    status: 'uploaded',
    extracted: null,
    error: null,
    model: null,
    patientId: null,
    uploadedBy: user.uid,
    reviewedBy: null,
    rejectionReason: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...overrides,
  };
}

describe('referral create: MIME types match REFERRAL_MIME_TYPES', () => {
  for (const [type, file] of [['image/png', 'a.png'], ['image/jpeg', 'a.jpg'], ['image/webp', 'a.webp'], ['image/heic', 'a.heic'], ['image/heif', 'a.heif']]) {
    it(`allows ${type}`, async () => {
      const id = `r-${file.replace('.', '-')}`;
      await assertSucceeds(setDoc(doc(db(USERS.intake), `orgs/${ORG}/referrals/${id}`), referral(USERS.intake, id, { fileName: file, contentType: type })));
    });
  }
  for (const type of ['image/tiff', 'image/gif', 'image/svg+xml', 'application/octet-stream']) {
    it(`denies ${type}`, async () => {
      await assertFails(setDoc(doc(db(USERS.intake), `orgs/${ORG}/referrals/r-bad`), referral(USERS.intake, 'r-bad', { contentType: type })));
    });
  }
  it('phone referrals and null files are server-only (createManualReferral)', async () => {
    const ref = doc(db(USERS.intake), `orgs/${ORG}/referrals/r-ph`);
    await assertFails(setDoc(ref, referral(USERS.intake, 'r-ph', { source: 'phone' })));
    await assertFails(setDoc(ref, referral(USERS.intake, 'r-ph', { fileName: null, contentType: null, storagePath: null })));
    await assertFails(setDoc(ref, referral(USERS.intake, 'r-ph', { status: 'needs_review' })));
  });
  it('clients cannot pre-set claim, duplicate, extraction or non-admit fields', async () => {
    const ref = doc(db(USERS.intake), `orgs/${ORG}/referrals/r-x`);
    await assertFails(setDoc(ref, referral(USERS.intake, 'r-x', { claimedBy: USERS.intake.uid, claimedAt: serverTimestamp() })));
    await assertFails(setDoc(ref, referral(USERS.intake, 'r-x', { possibleDuplicates: [] })));
    await assertFails(setDoc(ref, referral(USERS.intake, 'r-x', { extractionStartedAt: null })));
    await assertFails(setDoc(ref, referral(USERS.intake, 'r-x', { nonAdmit: null })));
  });
});

describe('referral updates stay server-only', () => {
  it('no client can claim, close or edit a referral directly', async () => {
    const ref = (u) => doc(db(u), `orgs/${ORG}/referrals/r-open`);
    await assertSucceeds(getDoc(ref(USERS.intake)));
    await assertFails(updateDoc(ref(USERS.intake), { claimedBy: USERS.intake.uid }));
    await assertFails(updateDoc(ref(USERS.admin), { status: 'non_admit' }));
    await assertFails(updateDoc(ref(USERS.rn), { possibleDuplicates: [] }));
  });
});

describe('referral files in Storage', () => {
  const path = (f) => `orgs/${ORG}/referrals/r1/${f}`;
  it('allows the aligned image types', async () => {
    await assertSucceeds(uploadBytes(sRef(storage(USERS.intake), path('a.webp')), SMALL, { contentType: 'image/webp' }));
    await assertSucceeds(uploadBytes(sRef(storage(USERS.intake), path('a.heic')), SMALL, { contentType: 'image/heic' }));
  });
  it('denies types the extractor cannot read', async () => {
    await assertFails(uploadBytes(sRef(storage(USERS.intake), path('a.tif')), SMALL, { contentType: 'image/tiff' }));
    await assertFails(uploadBytes(sRef(storage(USERS.intake), path('a.gif')), SMALL, { contentType: 'image/gif' }));
  });
});

describe('invites stay server-only (revokeInvite)', () => {
  it('admins can read but not revoke or extend directly', async () => {
    const ref = (u) => doc(db(u), `orgs/${ORG}/invites/i1`);
    await assertSucceeds(getDoc(ref(USERS.admin)));
    await assertFails(getDoc(ref(USERS.intake)));
    await assertFails(updateDoc(ref(USERS.admin), { status: 'revoked' }));
    await assertFails(updateDoc(ref(USERS.admin), { expiresAt: Timestamp.now() }));
  });
});

describe('patients: non-admit is server-only', () => {
  it('no client can mark a patient non_admit', async () => {
    await assertFails(updateDoc(doc(db(USERS.admin), `orgs/${ORG}/patients/p1`), { status: 'non_admit' }));
  });
});
