// v2 Storage rules: patient documents (docs/DATA_MODEL.md "New Storage path").
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { deleteObject, getMetadata, ref, uploadBytes } from 'firebase/storage';
import { as, createEnv, ORG, OTHER_ORG, seed, USERS } from './fixtures.js';

let env;
beforeAll(async () => { env = await createEnv({ storage: true }); });
afterAll(async () => { await env?.cleanup(); });
beforeEach(async () => {
  await env.clearFirestore();
  await env.clearStorage();
  await seed(env);
  await env.withSecurityRulesDisabled(async (ctx) => {
    await uploadBytes(ref(ctx.storage(), EXISTING), SMALL, { contentType: 'application/pdf' });
  });
});

const SMALL = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"
const PDF = { contentType: 'application/pdf' };
const EXISTING = `orgs/${ORG}/patients/p1/documents/d-existing/consent.pdf`;
const storage = (user) => as(env, user).storage();
const docPath = (file, docId = 'd1') => `orgs/${ORG}/patients/p1/documents/${docId}/${file}`;

describe('patient document files', () => {
  it('clinical roles can upload a PDF or image', async () => {
    await assertSucceeds(uploadBytes(ref(storage(USERS.rn), docPath('consent.pdf')), SMALL, PDF));
    await assertSucceeds(uploadBytes(ref(storage(USERS.intake), docPath('polst.png', 'd2')), SMALL, { contentType: 'image/png' }));
    await assertSucceeds(uploadBytes(ref(storage(USERS.admin), docPath('order.pdf', 'd3')), SMALL, PDF));
  });
  it('viewer, inactive and other-org users cannot upload', async () => {
    await assertFails(uploadBytes(ref(storage(USERS.viewer), docPath('consent.pdf')), SMALL, PDF));
    await assertFails(uploadBytes(ref(storage(USERS.inactive), docPath('consent.pdf')), SMALL, PDF));
    await assertFails(uploadBytes(ref(storage(USERS.outsider), docPath('consent.pdf')), SMALL, PDF));
  });
  it('non-PDF/image content types denied', async () => {
    await assertFails(uploadBytes(ref(storage(USERS.rn), docPath('x.html')), SMALL, { contentType: 'text/html' }));
    await assertFails(uploadBytes(ref(storage(USERS.rn), docPath('x.zip')), SMALL, { contentType: 'application/zip' }));
  });
  it('oversize (>= 25 MB) denied', async () => {
    const big = new Uint8Array(25 * 1024 * 1024 + 1);
    await assertFails(uploadBytes(ref(storage(USERS.rn), docPath('big.pdf')), big, PDF));
  });
  it('all active org members (viewer too) can read; other orgs and inactive cannot', async () => {
    await assertSucceeds(getMetadata(ref(storage(USERS.viewer), EXISTING)));
    await assertSucceeds(getMetadata(ref(storage(USERS.md), EXISTING)));
    await assertFails(getMetadata(ref(storage(USERS.outsider), EXISTING)));
    await assertFails(getMetadata(ref(storage(USERS.inactive), EXISTING)));
  });
  it('overwrite and delete denied, even for admin', async () => {
    await assertFails(uploadBytes(ref(storage(USERS.rn), EXISTING), SMALL, PDF));
    await assertFails(deleteObject(ref(storage(USERS.rn), EXISTING)));
    await assertFails(deleteObject(ref(storage(USERS.admin), EXISTING)));
  });
  it('paths outside the documents layout are denied', async () => {
    await assertFails(uploadBytes(ref(storage(USERS.rn), `orgs/${ORG}/patients/p1/consent.pdf`), SMALL, PDF));
    await assertFails(uploadBytes(ref(storage(USERS.rn), `orgs/${ORG}/patients/p1/documents/d1/nested/x.pdf`), SMALL, PDF));
    await assertFails(uploadBytes(ref(storage(USERS.rn), `orgs/${OTHER_ORG}/patients/p1/documents/d1/x.pdf`), SMALL, PDF));
  });
});
