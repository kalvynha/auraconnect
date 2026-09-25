import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { deleteObject, getMetadata, ref, uploadBytes } from 'firebase/storage';
import { as, CHANNEL, createEnv, ORG, seed, USERS } from './fixtures.js';

let env;
beforeAll(async () => { env = await createEnv({ storage: true }); });
afterAll(async () => { await env?.cleanup(); });
beforeEach(async () => {
  await env.clearFirestore();
  await env.clearStorage();
  await seed(env);
  await env.withSecurityRulesDisabled(async (ctx) => {
    const s = ctx.storage();
    await uploadBytes(ref(s, `orgs/${ORG}/referrals/r-existing/a.pdf`), SMALL, { contentType: 'application/pdf' });
    await uploadBytes(ref(s, `orgs/${ORG}/channels/${CHANNEL}/attachments/photo.png`), SMALL, { contentType: 'image/png' });
  });
});

const SMALL = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"
const storage = (user) => as(env, user).storage();
const referralPath = (file) => `orgs/${ORG}/referrals/r1/${file}`;
const attachmentPath = (file) => `orgs/${ORG}/channels/${CHANNEL}/attachments/${file}`;

describe('referral files', () => {
  it('intake can upload a PDF and an image', async () => {
    await assertSucceeds(uploadBytes(ref(storage(USERS.intake), referralPath('scan.pdf')), SMALL, { contentType: 'application/pdf' }));
    await assertSucceeds(uploadBytes(ref(storage(USERS.rn), referralPath('fax.jpg')), SMALL, { contentType: 'image/jpeg' }));
  });
  it('viewer and other-org users are denied', async () => {
    await assertFails(uploadBytes(ref(storage(USERS.viewer), referralPath('scan.pdf')), SMALL, { contentType: 'application/pdf' }));
    await assertFails(uploadBytes(ref(storage(USERS.outsider), referralPath('scan.pdf')), SMALL, { contentType: 'application/pdf' }));
    await assertFails(getMetadata(ref(storage(USERS.viewer), `orgs/${ORG}/referrals/r-existing/a.pdf`)));
  });
  it('deactivated member is denied', async () => {
    await assertFails(uploadBytes(ref(storage(USERS.inactive), referralPath('scan.pdf')), SMALL, { contentType: 'application/pdf' }));
  });
  it('wrong content type denied', async () => {
    await assertFails(uploadBytes(ref(storage(USERS.intake), referralPath('x.html')), SMALL, { contentType: 'text/html' }));
  });
  it('oversize (>= 25 MB) denied', async () => {
    const big = new Uint8Array(25 * 1024 * 1024 + 1);
    await assertFails(uploadBytes(ref(storage(USERS.intake), referralPath('big.pdf')), big, { contentType: 'application/pdf' }));
  });
  it('allowed roles can read; overwrite and delete denied', async () => {
    const existing = `orgs/${ORG}/referrals/r-existing/a.pdf`;
    await assertSucceeds(getMetadata(ref(storage(USERS.rn), existing)));
    await assertFails(deleteObject(ref(storage(USERS.admin), existing)));
    await assertFails(uploadBytes(ref(storage(USERS.intake), existing), SMALL, { contentType: 'application/pdf' }));
  });
});

describe('channel attachments', () => {
  it('channel member can upload and read', async () => {
    await assertSucceeds(uploadBytes(ref(storage(USERS.rn), attachmentPath('wound.jpg')), SMALL, { contentType: 'image/jpeg' }));
    await assertSucceeds(getMetadata(ref(storage(USERS.intake), attachmentPath('photo.png'))));
    await assertSucceeds(getMetadata(ref(storage(USERS.viewer), attachmentPath('photo.png'))));
  });
  it('non-member (even admin) cannot upload or read', async () => {
    await assertFails(uploadBytes(ref(storage(USERS.md), attachmentPath('x.jpg')), SMALL, { contentType: 'image/jpeg' }));
    await assertFails(getMetadata(ref(storage(USERS.admin), attachmentPath('photo.png'))));
    await assertFails(getMetadata(ref(storage(USERS.outsider), attachmentPath('photo.png'))));
  });
  it('viewer member cannot upload; oversize denied; delete denied', async () => {
    await assertFails(uploadBytes(ref(storage(USERS.viewer), attachmentPath('v.jpg')), SMALL, { contentType: 'image/jpeg' }));
    const big = new Uint8Array(25 * 1024 * 1024 + 1);
    await assertFails(uploadBytes(ref(storage(USERS.rn), attachmentPath('big.bin')), big, { contentType: 'application/octet-stream' }));
    await assertFails(deleteObject(ref(storage(USERS.rn), attachmentPath('photo.png'))));
  });
});

describe('default deny', () => {
  it('other paths denied', async () => {
    await assertFails(uploadBytes(ref(storage(USERS.admin), `orgs/${ORG}/other/x.pdf`), SMALL, { contentType: 'application/pdf' }));
    await assertFails(uploadBytes(ref(storage(USERS.admin), 'public/x.pdf'), SMALL, { contentType: 'application/pdf' }));
  });
});
