/**
 * Creates (or removes) one login per role/discipline for manual testing.
 *
 *   gcloud auth application-default login
 *   npx tsx test-accounts.ts --project auraconnect-prod-91ce9 --yes            # create/update
 *   npx tsx test-accounts.ts --project auraconnect-prod-91ce9 --password xyz123 --yes
 *   npx tsx test-accounts.ts --project auraconnect-prod-91ce9 --org <orgId> --yes
 *   npx tsx test-accounts.ts --project auraconnect-prod-91ce9 --delete --yes   # remove them all
 *
 * Sign in with the email shown, e.g. testrn@auraconnect.test (the ".test" domain can never
 * receive mail, so accounts are created pre-verified). Idempotent: re-running resets
 * passwords, roles and capabilities to the values below.
 *
 * These accounts use a weak shared password. Remove them (`--delete`) before real PHI.
 */
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import type { Capability, Discipline, Member, Role, UserOrg } from '../functions/src/shared/types.ts';

interface TestUser {
  username: string;
  role: Role;
  discipline: Discipline;
  title: string;
  capabilities?: Capability[];
}

/** One account per role / discipline / capability combination worth testing. */
const TEST_USERS: TestUser[] = [
  { username: 'TestAdmin', role: 'admin', discipline: 'Admin', title: 'Administrator' },
  { username: 'TestDON', role: 'admin', discipline: 'RN', title: 'Director of Nursing' },
  { username: 'TestRN', role: 'clinician', discipline: 'RN', title: 'RN Case Manager' },
  { username: 'TestOnCallRN', role: 'clinician', discipline: 'RN', title: 'On-call RN' },
  { username: 'TestLPN', role: 'clinician', discipline: 'LPN', title: 'LPN' },
  { username: 'TestAide', role: 'viewer', discipline: 'Aide', title: 'Hospice Aide' },
  { username: 'TestMD', role: 'clinician', discipline: 'MD', title: 'Medical Director' },
  { username: 'TestNP', role: 'clinician', discipline: 'NP', title: 'Nurse Practitioner' },
  { username: 'TestSW', role: 'clinician', discipline: 'SW', title: 'Social Worker' },
  { username: 'TestChaplain', role: 'clinician', discipline: 'Chaplain', title: 'Chaplain' },
  { username: 'TestIntake', role: 'intake', discipline: 'Other', title: 'Intake Coordinator' },
  { username: 'TestScheduler', role: 'intake', discipline: 'Other', title: 'Scheduler', capabilities: ['scheduling', 'staffing'] },
  { username: 'TestBereavement', role: 'clinician', discipline: 'SW', title: 'Bereavement Coordinator', capabilities: ['bereavement'] },
  { username: 'TestVolCoord', role: 'clinician', discipline: 'Other', title: 'Volunteer Coordinator', capabilities: ['volunteers'] },
  { username: 'TestVolunteer', role: 'viewer', discipline: 'Volunteer', title: 'Volunteer' },
  { username: 'TestQA', role: 'viewer', discipline: 'Other', title: 'Compliance / QA', capabilities: ['reports', 'audit'] },
  { username: 'TestViewer', role: 'viewer', discipline: 'Other', title: 'Read-only' },
];

const DOMAIN = 'auraconnect.test';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const projectId = arg('project');
const password = arg('password') ?? 'test1234';
const orgArg = arg('org');
const remove = flag('delete');

if (!projectId || !flag('yes')) {
  console.error('Usage: npx tsx test-accounts.ts --project <projectId> [--org <orgId>] [--password <pw>] [--delete] --yes');
  process.exit(1);
}
if (password.length < 6) {
  console.error('Firebase requires passwords of at least 6 characters.');
  process.exit(1);
}

initializeApp({ projectId });
const auth = getAuth();
const db = getFirestore();

const uidFor = (u: TestUser) => `test-${u.username.slice(4).toLowerCase()}`;
const emailFor = (u: TestUser) => `${u.username.toLowerCase()}@${DOMAIN}`;
const nameFor = (u: TestUser) => `${u.username} (${u.title})`;

async function resolveOrgId(): Promise<string> {
  if (orgArg) return orgArg;
  const orgs = await db.collection('orgs').limit(3).get();
  if (orgs.size === 1) return orgs.docs[0]!.id;
  const list = orgs.docs.map((d) => `${d.id} (${d.get('name')})`).join(', ');
  throw new Error(orgs.empty ? 'No organization exists yet — create one first.' : `Several orgs found; pass --org. Found: ${list}`);
}

async function main() {
  const orgId = await resolveOrgId();
  const org = db.doc(`orgs/${orgId}`);
  console.log(`${remove ? 'Removing' : 'Creating'} ${TEST_USERS.length} test accounts in org ${orgId} (${(await org.get()).get('name')})`);

  for (const u of TEST_USERS) {
    const uid = uidFor(u);
    if (remove) {
      await auth.deleteUser(uid).catch(() => undefined);
      await org.collection('members').doc(uid).delete();
      await db.doc(`userOrgs/${uid}`).delete();
      console.log(`  removed ${u.username}`);
      continue;
    }

    const props = { email: emailFor(u), password, displayName: nameFor(u), emailVerified: true, disabled: false };
    try {
      await auth.updateUser(uid, props);
    } catch {
      await auth.createUser({ uid, ...props });
    }
    await auth.setCustomUserClaims(uid, { orgId, role: u.role });

    const existing = await org.collection('members').doc(uid).get();
    const member: Member = {
      uid,
      email: emailFor(u),
      displayName: nameFor(u),
      role: u.role,
      discipline: u.discipline,
      title: u.title,
      phone: null,
      teamIds: (existing.get('teamIds') as string[] | undefined) ?? [],
      active: true,
      fcmTokens: (existing.get('fcmTokens') as string[] | undefined) ?? [],
      createdAt: (existing.get('createdAt') as Timestamp | undefined) ?? Timestamp.now(),
      capabilities: u.capabilities ?? [],
    };
    await org.collection('members').doc(uid).set(member);
    const userOrg: UserOrg = { orgId, role: u.role };
    await db.doc(`userOrgs/${uid}`).set(userOrg);
    console.log(`  ${u.username.padEnd(16)} ${emailFor(u).padEnd(34)} ${u.role}/${u.discipline}${u.capabilities?.length ? ` +${u.capabilities.join(',')}` : ''}`);
  }

  if (!remove) {
    console.log(`\nPassword for all: ${password}`);
    console.log('Remove them before real patient data: npx tsx test-accounts.ts --project ' + projectId + ' --delete --yes');
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
