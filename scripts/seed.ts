/**
 * Seeds the Firebase **emulators** with a demo hospice org.
 *
 *   firebase emulators:start            # from the repo root
 *   cd scripts && npm run seed          # in another terminal
 *
 * All patients are FICTITIOUS test data. This script refuses to run unless
 * FIRESTORE_EMULATOR_HOST and FIREBASE_AUTH_EMULATOR_HOST are set, so it can
 * never touch a real project. Re-running it is safe (documents are overwritten).
 */
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import type {
  Alert, AuditLog, BenefitPeriod, BereavementContact, BereavementPlan, Channel, Discipline,
  EscalationPolicy, IdgMeeting, Member, Message, Milestones, OnCallRole, Org, Patient,
  PatientEvent, PatientInput, Referral, Role, Shift, Task, Team, TriageCall, UserOrg, Visit,
  VolunteerAssignment, VolunteerLog,
} from '../functions/src/shared/types.ts';

const PROJECT_ID = 'demo-auraconnect';
const ORG_ID = 'sunrise-demo';
const TIMEZONE = 'America/New_York';
const PASSWORD = 'password123';

// ---------------------------------------------------------------------------
// Safety: emulator only
// ---------------------------------------------------------------------------
const missing = ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST'].filter((k) => !process.env[k]);
if (missing.length) {
  console.error(
    `Refusing to seed: ${missing.join(' and ')} not set.\n` +
      'This script only runs against the Firebase emulators, e.g.:\n' +
      '  FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 npm run seed',
  );
  process.exit(1);
}
const envProject = process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT;
if (envProject && envProject !== PROJECT_ID) {
  console.error(`Refusing to seed: project is "${envProject}", expected "${PROJECT_ID}".`);
  process.exit(1);
}

initializeApp({ projectId: PROJECT_ID });
const auth = getAuth();
const db = getFirestore();
const org = db.doc(`orgs/${ORG_ID}`);

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------
const DAY_MS = 86_400_000;

/** Today's calendar date in the org's time zone as YYYY-MM-DD. */
function todayInTz(tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return new Date(d.getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

/** Calendar month arithmetic; clamps to the last day of the target month (Jan 31 + 1 → Feb 28/29). */
function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

/** Instant for a local wall-clock time in `tz` (handles DST via the tz offset at that moment). */
function zonedTime(isoDate: string, hour: number, tz: string): Timestamp {
  const guess = new Date(`${isoDate}T${String(hour).padStart(2, '0')}:00:00Z`);
  const offsetPart = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
    .formatToParts(guess)
    .find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(offsetPart);
  const offsetMin = m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  return Timestamp.fromMillis(guess.getTime() - offsetMin * 60_000);
}

const now = Timestamp.now();
const minutesAgo = (n: number) => Timestamp.fromMillis(now.toMillis() - n * 60_000);
const daysAgo = (n: number) => Timestamp.fromMillis(now.toMillis() - n * DAY_MS);
const today = todayInTz(TIMEZONE);

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------
interface SeedUser {
  key: string;
  email: string;
  displayName: string;
  role: Role;
  discipline: Discipline;
  title: string | null;
}

const SEED_USERS: SeedUser[] = [
  { key: 'admin', email: 'admin@demo.test', displayName: 'Avery Admin', role: 'admin', discipline: 'Admin', title: 'Administrator' },
  { key: 'rn', email: 'rn@demo.test', displayName: 'Riley Nurse', role: 'clinician', discipline: 'RN', title: 'RN Case Manager' },
  { key: 'md', email: 'md@demo.test', displayName: 'Morgan Doctor', role: 'clinician', discipline: 'MD', title: 'Medical Director' },
  { key: 'sw', email: 'sw@demo.test', displayName: 'Sam Social', role: 'clinician', discipline: 'SW', title: 'Social Worker' },
  { key: 'chaplain', email: 'chaplain@demo.test', displayName: 'Casey Chaplain', role: 'clinician', discipline: 'Chaplain', title: 'Chaplain' },
  { key: 'intake', email: 'intake@demo.test', displayName: 'Indy Intake', role: 'intake', discipline: 'Other', title: 'Intake Coordinator' },
  // v2: volunteers are read-only members who log their own time.
  { key: 'volunteer', email: 'volunteer@demo.test', displayName: 'Val Volunteer', role: 'viewer', discipline: 'Volunteer', title: 'Hospice Volunteer' },
];

async function upsertAuthUser(u: SeedUser): Promise<string> {
  const uid = `demo-${u.key}`;
  try {
    await auth.getUser(uid);
    await auth.updateUser(uid, { email: u.email, password: PASSWORD, displayName: u.displayName, emailVerified: true });
  } catch {
    await auth.createUser({ uid, email: u.email, password: PASSWORD, displayName: u.displayName, emailVerified: true });
  }
  await auth.setCustomUserClaims(uid, { orgId: ORG_ID, role: u.role });
  return uid;
}

// ---------------------------------------------------------------------------
// Milestones (mirrors the rules in docs/DATA_MODEL.md; day 1 = admission)
// ---------------------------------------------------------------------------
function computeMilestones(admissionDate: string, startingBenefitPeriod: number, periods = 4): Milestones {
  const benefitPeriods: BenefitPeriod[] = [];
  let start = admissionDate;
  for (let i = 0; i < periods; i++) {
    const number = startingBenefitPeriod + i;
    const lengthDays: 90 | 60 = number <= 2 ? 90 : 60;
    const f2fRequired = number >= 3;
    benefitPeriods.push({
      number,
      start,
      end: addDays(start, lengthDays - 1),
      lengthDays,
      f2fRequired,
      f2fWindowStart: f2fRequired ? addDays(start, -30) : null,
      f2fDueBy: f2fRequired ? addDays(start, -1) : null,
    });
    start = addDays(start, lengthDays);
  }
  return {
    noeDueDate: addDays(admissionDate, 5),
    benefitPeriods,
    hopeAdmissionDue: addDays(admissionDate, 4),
    hopeHuv1Window: { start: addDays(admissionDate, 5), end: addDays(admissionDate, 14) },
    hopeHuv2Window: { start: addDays(admissionDate, 15), end: addDays(admissionDate, 29) },
    computedAt: today,
  };
}

const emptyAddress = { line1: null, line2: null, city: null, state: null, zip: null };

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const uids: Record<string, string> = {};
  for (const u of SEED_USERS) uids[u.key] = await upsertAuthUser(u);
  const byKey = Object.fromEntries(SEED_USERS.map((u) => [u.key, u]));
  const allUids = SEED_USERS.map((u) => uids[u.key]);
  const clinicalUids = ['rn', 'md', 'sw', 'chaplain'].map((k) => uids[k]);

  const batch = db.batch();

  // Org
  const orgDoc: Org = {
    name: 'Sunrise Hospice (Demo)',
    timezone: TIMEZONE,
    deadlineLeadDays: 3,
    defaultEscalationPolicyId: 'default',
    // v2 settings (explicit here; older orgs omit them and readers use ORG_SETTING_DEFAULTS)
    triageRoleKey: 'oncall-rn-north',
    idgCadenceDays: 15,
    missedVisitGraceMinutes: 120,
    messageLifespanDays: null,
    createdBy: uids.admin,
    createdAt: now,
  };
  batch.set(org, orgDoc);

  // Team
  const TEAM_ID = 'north';
  const team: Team = {
    name: 'North Team',
    description: 'Demo interdisciplinary group, north service area',
    memberUids: allUids,
    createdAt: now,
  };
  batch.set(org.collection('teams').doc(TEAM_ID), team);

  // Members + userOrgs
  for (const u of SEED_USERS) {
    const member: Member = {
      uid: uids[u.key],
      email: u.email,
      displayName: u.displayName,
      role: u.role,
      discipline: u.discipline,
      title: u.title,
      phone: null,
      teamIds: [TEAM_ID],
      active: true,
      fcmTokens: [],
      createdAt: now,
    };
    batch.set(org.collection('members').doc(uids[u.key]), member);
    const userOrg: UserOrg = { orgId: ORG_ID, role: u.role };
    batch.set(db.doc(`userOrgs/${uids[u.key]}`), userOrg);
  }

  // On-call roles
  const rnNorth: OnCallRole = { label: 'On-call RN (North)', discipline: 'RN', teamId: TEAM_ID, fallbackUids: [uids.rn] };
  const oncallMd: OnCallRole = { label: 'On-call MD', discipline: 'MD', teamId: null, fallbackUids: [uids.md] };
  batch.set(org.collection('onCallRoles').doc('oncall-rn-north'), rnNorth);
  batch.set(org.collection('onCallRoles').doc('oncall-md'), oncallMd);

  // Shifts for this week (Mon..Sun in the org time zone)
  const dow = new Date(`${today}T12:00:00Z`).getUTCDay(); // 0 = Sunday
  const monday = addDays(today, -((dow + 6) % 7));
  for (let i = 0; i < 7; i++) {
    const day = addDays(monday, i);
    const rnShift: Shift = {
      roleKey: 'oncall-rn-north',
      uid: uids.rn,
      start: zonedTime(day, 8, TIMEZONE),
      end: zonedTime(day, 20, TIMEZONE),
      notes: null,
    };
    const mdShift: Shift = {
      roleKey: 'oncall-md',
      uid: uids.md,
      start: zonedTime(day, 0, TIMEZONE),
      end: zonedTime(addDays(day, 1), 0, TIMEZONE),
      notes: i >= 5 ? 'Weekend coverage' : null,
    };
    batch.set(org.collection('shifts').doc(`rn-north-${day}`), rnShift);
    batch.set(org.collection('shifts').doc(`md-${day}`), mdShift);
  }

  // Default escalation policy
  const policy: EscalationPolicy = {
    name: 'Default',
    steps: [
      { target: { kind: 'original' }, waitMinutes: 5 },
      { target: { kind: 'role', roleKey: 'oncall-rn-north' }, waitMinutes: 10 },
      { target: { kind: 'role', roleKey: 'oncall-md' }, waitMinutes: 15 },
      { target: { kind: 'uid', uid: uids.admin }, waitMinutes: 15 },
    ],
  };
  batch.set(org.collection('escalationPolicies').doc('default'), policy);

  // Patient 1: admitted, with a care-team channel
  const aliceInput: PatientInput = {
    firstName: 'Alice',
    lastName: 'Test',
    dob: '1940-01-01',
    sex: 'female',
    phone: '555-0100',
    address: { line1: '1 Example Way', line2: null, city: 'Testville', state: 'NY', zip: '00000' },
    mrn: 'DEMO-0001',
    medicareMbi: null,
    primaryDiagnosis: { code: 'C34.90', description: 'Malignant neoplasm of unspecified part of bronchus or lung (demo)' },
    secondaryDiagnoses: [{ code: 'I50.9', description: 'Heart failure, unspecified (demo)' }],
    referringPhysician: { name: 'Dr. Example Referrer', npi: null, phone: '555-0101', fax: '555-0102' },
    attendingPhysician: { name: byKey.md.displayName, npi: null, phone: null, fax: null },
    codeStatus: 'DNR',
    allergies: ['Penicillin'],
    medications: [
      { name: 'Morphine sulfate oral solution', dose: '5 mg', route: 'PO', frequency: 'q4h PRN pain' },
      { name: 'Lorazepam', dose: '0.5 mg', route: 'SL', frequency: 'q6h PRN anxiety' },
    ],
    caregiver: { name: 'Charlie Test', relationship: 'Son', phone: '555-0103' },
    insurance: { payer: 'Medicare (demo)', memberId: null },
  };
  const admissionDate = addDays(today, -10);
  const ALICE_ID = 'patient-alice';
  const ALICE_CHANNEL = 'patient-alice-care';
  const aliceCareTeam = clinicalUids;
  const alice: Patient = {
    ...aliceInput,
    status: 'admitted',
    referralId: null,
    admissionDate,
    startingBenefitPeriod: 1,
    levelOfCare: 'routine',
    careTeamUids: aliceCareTeam,
    channelId: ALICE_CHANNEL,
    consents: { electionStatement: true, hipaaNotice: true, releaseOfInformation: true, patientRights: true, polstOnFile: true },
    milestones: computeMilestones(admissionDate, 1),
    remindedMilestones: [],
    // v2
    milestoneCompletions: {
      [`noe:${addDays(admissionDate, 5)}`]: { completedAt: daysAgo(8), completedBy: uids.intake, note: 'NOE filed (demo)' },
    },
    visitFrequencies: [
      { discipline: 'RN', perWeek: 2, notes: null },
      { discipline: 'SW', perWeek: 0.5, notes: 'Every other week' },
      { discipline: 'Chaplain', perWeek: 0.5, notes: null },
      { discipline: 'Volunteer', perWeek: 1, notes: 'Companionship' },
    ],
    lastIdgReviewDate: null,
    nextIdgDueDate: addDays(admissionDate, 15),
    dischargeDate: null,
    dischargeReason: null,
    death: null,
    bereavementPlanId: null,
    createdBy: uids.intake,
    createdAt: Timestamp.fromMillis(now.toMillis() - 10 * DAY_MS),
    updatedAt: now,
  };
  batch.set(org.collection('patients').doc(ALICE_ID), alice);

  // Patient channel messages (last one is urgent and raised the open alert)
  const ALERT_ID = 'alert-alice-pain';
  const aliceMessages: Array<[string, Message]> = [
    ['msg-1', { senderUid: uids.rn, senderName: byKey.rn.displayName, body: 'Visited today. Resting comfortably, family at bedside.', priority: 'normal', attachments: [], roleTarget: null, createdAt: minutesAgo(180), alertId: null }],
    ['msg-2', { senderUid: uids.sw, senderName: byKey.sw.displayName, body: 'Caregiver support visit scheduled for Thursday.', priority: 'normal', attachments: [], roleTarget: null, createdAt: minutesAgo(90), alertId: null }],
    ['msg-3', { senderUid: uids.rn, senderName: byKey.rn.displayName, body: 'Pain 7/10 despite PRN dose. Requesting MD review of orders.', priority: 'urgent', attachments: [], roleTarget: null, createdAt: minutesAgo(12), alertId: ALERT_ID }],
  ];
  const aliceLast = aliceMessages[aliceMessages.length - 1][1];
  const aliceChannel: Channel = {
    type: 'patient',
    name: `${aliceInput.lastName}, ${aliceInput.firstName} – Care Team`,
    memberUids: [...aliceCareTeam, uids.intake],
    patientId: ALICE_ID,
    teamId: TEAM_ID,
    createdBy: uids.intake,
    createdAt: alice.createdAt,
    lastMessage: { text: aliceLast.body, senderUid: aliceLast.senderUid, senderName: aliceLast.senderName, priority: aliceLast.priority, at: aliceLast.createdAt },
    lastMessageAt: aliceLast.createdAt,
    archived: false,
  };
  const aliceChannelRef = org.collection('channels').doc(ALICE_CHANNEL);
  batch.set(aliceChannelRef, aliceChannel);
  for (const [id, m] of aliceMessages) batch.set(aliceChannelRef.collection('messages').doc(id), m);

  // Open alert from the urgent message
  const alertTargets = aliceChannel.memberUids.filter((u) => u !== uids.rn);
  const alert: Alert = {
    title: 'Urgent message',
    body: `Urgent message in ${aliceChannel.name}`,
    priority: 'urgent',
    source: { type: 'message', channelId: ALICE_CHANNEL, messageId: 'msg-3' },
    targetUids: alertTargets,
    currentTargetUids: alertTargets,
    policyId: 'default',
    level: 0,
    exhausted: false,
    status: 'open',
    createdBy: uids.rn,
    createdAt: aliceLast.createdAt,
    ackedBy: null,
    ackedAt: null,
    history: [{ level: 0, targetUids: alertTargets, at: aliceLast.createdAt }],
  };
  batch.set(org.collection('alerts').doc(ALERT_ID), alert);

  // Patient 2: referral status (accepted from a referral, not yet admitted)
  const BOB_ID = 'patient-bob';
  const BOB_REFERRAL = 'referral-bob';
  const bobInput: PatientInput = {
    firstName: 'Bob',
    lastName: 'Test',
    dob: '1938-06-15',
    sex: 'male',
    phone: null,
    address: emptyAddress,
    mrn: null,
    medicareMbi: null,
    primaryDiagnosis: { code: 'G30.9', description: "Alzheimer's disease, unspecified (demo)" },
    secondaryDiagnoses: [],
    referringPhysician: { name: 'Dr. Example Referrer', npi: null, phone: null, fax: '555-0102' },
    attendingPhysician: null,
    codeStatus: 'Unknown',
    allergies: [],
    medications: [],
    caregiver: { name: 'Dana Test', relationship: 'Daughter', phone: '555-0104' },
    insurance: { payer: null, memberId: null },
  };
  const bob: Patient = {
    ...bobInput,
    status: 'referral',
    referralId: BOB_REFERRAL,
    admissionDate: null,
    startingBenefitPeriod: 1,
    levelOfCare: 'routine',
    careTeamUids: [],
    channelId: null,
    consents: null,
    milestones: null,
    remindedMilestones: [],
    createdBy: uids.intake,
    createdAt: minutesAgo(60 * 24),
    updatedAt: minutesAgo(60 * 24),
  };
  batch.set(org.collection('patients').doc(BOB_ID), bob);
  const referral: Referral = {
    fileName: 'referral.pdf',
    contentType: 'application/pdf',
    storagePath: `orgs/${ORG_ID}/referrals/${BOB_REFERRAL}/referral.pdf`,
    source: 'scan',
    status: 'accepted',
    extracted: {
      patient: bobInput,
      referralDate: addDays(today, -1),
      referralSource: 'Example General Hospital (demo)',
      reasonForReferral: 'Progressive decline, family requests comfort-focused care (demo).',
      fieldConfidence: { 'patient.firstName': 0.98, 'patient.lastName': 0.98, 'patient.dob': 0.62 },
      warnings: ['Demo data: no source file exists in Storage.'],
    },
    error: null,
    model: 'gemini-2.5-flash',
    patientId: BOB_ID,
    uploadedBy: uids.intake,
    reviewedBy: uids.intake,
    rejectionReason: null,
    createdAt: minutesAgo(60 * 25),
    updatedAt: minutesAgo(60 * 24),
  };
  batch.set(org.collection('referrals').doc(BOB_REFERRAL), referral);

  // Team channel
  const TEAM_CHANNEL = 'team-north';
  const teamMessages: Array<[string, Message]> = [
    ['msg-1', { senderUid: uids.admin, senderName: byKey.admin.displayName, body: 'Welcome to the North Team channel (demo data).', priority: 'normal', attachments: [], roleTarget: null, createdAt: minutesAgo(600), alertId: null }],
    ['msg-2', { senderUid: uids.chaplain, senderName: byKey.chaplain.displayName, body: 'IDG meeting moved to 2pm tomorrow.', priority: 'normal', attachments: [], roleTarget: null, createdAt: minutesAgo(240), alertId: null }],
  ];
  const teamLast = teamMessages[teamMessages.length - 1][1];
  const teamChannel: Channel = {
    type: 'team',
    name: 'North Team',
    memberUids: allUids,
    patientId: null,
    teamId: TEAM_ID,
    createdBy: uids.admin,
    createdAt: minutesAgo(600),
    lastMessage: { text: teamLast.body, senderUid: teamLast.senderUid, senderName: teamLast.senderName, priority: teamLast.priority, at: teamLast.createdAt },
    lastMessageAt: teamLast.createdAt,
    archived: false,
  };
  const teamChannelRef = org.collection('channels').doc(TEAM_CHANNEL);
  batch.set(teamChannelRef, teamChannel);
  for (const [id, m] of teamMessages) batch.set(teamChannelRef.collection('messages').doc(id), m);

  // A couple of audit entries so the admin audit view isn't empty
  const audits: Array<[string, AuditLog]> = [
    ['seed-org-create', { actorUid: uids.admin, action: 'org.create', resourceType: 'org', resourceId: ORG_ID, patientId: null, at: minutesAgo(60 * 24 * 14), metadata: { seeded: true } }],
    ['seed-patient-admit', { actorUid: uids.intake, action: 'patient.admit', resourceType: 'patient', resourceId: ALICE_ID, patientId: ALICE_ID, at: alice.createdAt, metadata: { seeded: true } }],
    ['seed-alert-create', { actorUid: uids.rn, action: 'alert.create', resourceType: 'alert', resourceId: ALERT_ID, patientId: ALICE_ID, at: alert.createdAt, metadata: { seeded: true } }],
  ];
  for (const [id, a] of audits) batch.set(org.collection('auditLogs').doc(id), a);

  // =========================================================================
  // v2 demo data (all fictitious)
  // =========================================================================
  const aliceName = `${aliceInput.lastName}, ${aliceInput.firstName}`;
  const aliceRef = org.collection('patients').doc(ALICE_ID);

  const aliceAdmissionEvent: PatientEvent = {
    type: 'admission',
    date: admissionDate,
    recordedBy: uids.intake,
    createdAt: alice.createdAt,
    summary: 'Admitted to hospice (routine level of care)',
    details: { levelOfCare: 'routine', startingBenefitPeriod: 1 },
  };
  batch.set(aliceRef.collection('events').doc('evt-admission'), aliceAdmissionEvent);

  // Visits for Alice: one completed, one missed, two upcoming.
  const visit = (discipline: Discipline, assignedUid: string | null, day: string, hour: number, rest: Partial<Visit> = {}): Visit => ({
    patientId: ALICE_ID,
    patientName: aliceName,
    discipline,
    assignedUid,
    scheduledStart: zonedTime(day, hour, TIMEZONE),
    scheduledEnd: zonedTime(day, hour + 1, TIMEZONE),
    status: 'scheduled',
    note: null,
    completedAt: null,
    completedBy: null,
    cancelledReason: null,
    createdBy: uids.rn,
    createdAt: daysAgo(9),
    updatedAt: daysAgo(9),
    ...rest,
  });
  const visits: Array<[string, Visit]> = [
    ['visit-alice-rn-1', visit('RN', uids.rn, addDays(today, -2), 10, {
      status: 'completed', note: 'Symptoms managed; family coping well (demo).',
      completedAt: zonedTime(addDays(today, -2), 11, TIMEZONE), completedBy: uids.rn, updatedAt: zonedTime(addDays(today, -2), 11, TIMEZONE),
    })],
    ['visit-alice-chaplain-1', visit('Chaplain', uids.chaplain, addDays(today, -3), 14, {
      status: 'missed', updatedAt: zonedTime(addDays(today, -3), 17, TIMEZONE),
    })],
    ['visit-alice-rn-2', visit('RN', uids.rn, addDays(today, 1), 10)],
    ['visit-alice-sw-1', visit('SW', uids.sw, addDays(today, 2), 13, { note: 'Caregiver support visit' })],
  ];
  for (const [id, v] of visits) batch.set(org.collection('visits').doc(id), v);

  // Tasks: admission template items for Alice (some done) plus a manual task.
  const task = (title: string, discipline: Discipline | null, assigneeUid: string | null, dueDate: string | null, rest: Partial<Task> = {}): Task => ({
    title,
    description: null,
    patientId: ALICE_ID,
    patientName: aliceName,
    assigneeUid,
    discipline,
    dueDate,
    priority: 'normal',
    status: 'open',
    source: { type: 'template', event: 'admission' },
    createdBy: 'system',
    createdAt: alice.createdAt,
    completedAt: null,
    completedBy: null,
    updatedAt: alice.createdAt,
    ...rest,
  });
  const tasks: Array<[string, Task]> = [
    ['task-alice-medrec', task('Medication reconciliation', 'RN', uids.rn, addDays(admissionDate, 1), {
      status: 'done', completedAt: daysAgo(9), completedBy: uids.rn, updatedAt: daysAgo(9),
    })],
    ['task-alice-assessment', task('Comprehensive assessment', 'RN', uids.rn, addDays(admissionDate, 5), {
      status: 'done', completedAt: daysAgo(6), completedBy: uids.rn, updatedAt: daysAgo(6),
    })],
    ['task-alice-sw', task('Social work assessment', 'SW', uids.sw, addDays(admissionDate, 5))],
    ['task-alice-poc', task('Initial plan of care', 'MD', uids.md, addDays(admissionDate, 5), { priority: 'urgent' })],
    ['task-alice-dme', task('Order hospital bed (demo)', null, uids.intake, addDays(today, 1), {
      description: 'Family requested a hospital bed for the living room.',
      source: { type: 'manual' }, createdBy: uids.rn, createdAt: daysAgo(1), updatedAt: daysAgo(1),
    })],
  ];

  // IDG meeting in 3 days reviewing Alice.
  const IDG_ID = 'idg-north-next';
  const idg: IdgMeeting = {
    title: 'North Team IDG',
    teamId: TEAM_ID,
    scheduledAt: zonedTime(addDays(today, 3), 14, TIMEZONE),
    status: 'scheduled',
    attendeeUids: [uids.admin, ...clinicalUids],
    patientIds: [ALICE_ID],
    patientNames: { [ALICE_ID]: aliceName },
    notes: {},
    aiPrep: {},
    createdBy: uids.admin,
    createdAt: daysAgo(1),
    completedAt: null,
    completedBy: null,
  };
  batch.set(org.collection('idgMeetings').doc(IDG_ID), idg);

  // An open after-hours triage call from Alice's caregiver (routine, so no alert).
  const triage: TriageCall = {
    patientId: ALICE_ID,
    patientName: aliceName,
    callerName: 'Charlie Test',
    callerRelationship: 'Son',
    callerPhone: '555-0103',
    reason: 'Question about PRN lorazepam timing (demo).',
    symptoms: ['anxiety', 'restlessness'],
    urgency: 'routine',
    status: 'open',
    assignedUid: uids.rn,
    roleKey: 'oncall-rn-north',
    alertId: null,
    disposition: null,
    dispositionNote: null,
    receivedAt: minutesAgo(45),
    receivedBy: uids.intake,
    resolvedAt: null,
    resolvedBy: null,
  };
  batch.set(org.collection('triageCalls').doc('triage-alice-1'), triage);

  // Patient 3: "Test, Carol" — deceased 20 days ago, with a bereavement plan.
  const CAROL_ID = 'patient-carol';
  const CAROL_PLAN = 'bereavement-carol';
  const carolAdmission = addDays(today, -80);
  const deathDate = addDays(today, -20);
  const carolInput: PatientInput = {
    firstName: 'Carol',
    lastName: 'Test',
    dob: '1935-03-10',
    sex: 'female',
    phone: null,
    address: { line1: '3 Example Lane', line2: null, city: 'Testville', state: 'NY', zip: '00000' },
    mrn: 'DEMO-0003',
    medicareMbi: null,
    primaryDiagnosis: { code: 'I50.9', description: 'Heart failure, unspecified (demo)' },
    secondaryDiagnoses: [],
    referringPhysician: null,
    attendingPhysician: { name: byKey.md.displayName, npi: null, phone: null, fax: null },
    codeStatus: 'DNR',
    allergies: [],
    medications: [],
    caregiver: { name: 'Erin Test', relationship: 'Daughter', phone: '555-0105' },
    insurance: { payer: 'Medicare (demo)', memberId: null },
  };
  const carol: Patient = {
    ...carolInput,
    status: 'deceased',
    referralId: null,
    admissionDate: carolAdmission,
    startingBenefitPeriod: 1,
    levelOfCare: 'routine',
    careTeamUids: ['rn', 'sw', 'chaplain'].map((k) => uids[k]),
    channelId: null,
    consents: { electionStatement: true, hipaaNotice: true, releaseOfInformation: true, patientRights: true, polstOnFile: true },
    milestones: computeMilestones(carolAdmission, 1),
    remindedMilestones: [],
    milestoneCompletions: {},
    visitFrequencies: [],
    lastIdgReviewDate: addDays(today, -26),
    nextIdgDueDate: null,
    dischargeDate: null,
    dischargeReason: null,
    death: { date: deathDate, time: '03:40', pronouncedBy: byKey.rn.displayName, location: 'Home', notes: 'Peaceful, family present (demo).' },
    bereavementPlanId: CAROL_PLAN,
    createdBy: uids.intake,
    createdAt: daysAgo(80),
    updatedAt: daysAgo(20),
  };
  batch.set(org.collection('patients').doc(CAROL_ID), carol);
  const carolRef = org.collection('patients').doc(CAROL_ID);
  const carolEvents: Array<[string, PatientEvent]> = [
    ['evt-admission', { type: 'admission', date: carolAdmission, recordedBy: uids.intake, createdAt: daysAgo(80), summary: 'Admitted to hospice (routine level of care)', details: {} }],
    ['evt-death', { type: 'death', date: deathDate, recordedBy: uids.rn, createdAt: daysAgo(20), summary: 'Death recorded', details: { location: 'Home' } }],
  ];
  for (const [id, e] of carolEvents) batch.set(carolRef.collection('events').doc(id), e);

  // Default 13-month bereavement schedule (see DATA_MODEL "Death").
  const schedule: Array<[BereavementContact['type'], string, string]> = [
    ['call', 'Condolence call', addDays(deathDate, 3)],
    ['letter', 'Sympathy letter', addDays(deathDate, 7)],
    ['letter', 'Month 1 letter', addMonths(deathDate, 1)],
    ['letter', 'Month 2 letter', addMonths(deathDate, 2)],
    ['letter', 'Month 3 letter', addMonths(deathDate, 3)],
    ['letter', 'Month 6 letter', addMonths(deathDate, 6)],
    ['letter', 'Month 9 letter', addMonths(deathDate, 9)],
    ['call', 'Pre-anniversary call', addMonths(deathDate, 11)],
    ['letter', 'Anniversary letter', addMonths(deathDate, 12)],
    ['call', 'Closing call', addMonths(deathDate, 13)],
  ];
  const contacts: BereavementContact[] = schedule.map(([type, label, dueDate], i) => {
    const done = dueDate < today && i < 2;
    return {
      id: `c${i + 1}`,
      type,
      label,
      dueDate,
      status: done ? 'done' : 'pending',
      completedAt: done ? zonedTime(dueDate, 11, TIMEZONE) : null,
      completedBy: done ? uids.sw : null,
      note: done && type === 'call' ? 'Daughter coping; declined support group for now (demo).' : null,
    };
  });
  const plan: BereavementPlan = {
    patientId: CAROL_ID,
    patientName: `${carolInput.lastName}, ${carolInput.firstName}`,
    deathDate,
    primaryContact: carolInput.caregiver,
    riskLevel: 'moderate',
    assignedUid: uids.sw,
    contacts,
    status: 'active',
    closesOn: addMonths(deathDate, 13),
    createdAt: daysAgo(20),
    updatedAt: daysAgo(13),
  };
  batch.set(org.collection('bereavementPlans').doc(CAROL_PLAN), plan);
  tasks.push(
    ['task-carol-bereavement', task('Bereavement assessment', 'SW', uids.sw, addDays(deathDate, 7), {
      patientId: CAROL_ID, patientName: plan.patientName, source: { type: 'template', event: 'death' },
      status: 'done', createdAt: daysAgo(20), completedAt: daysAgo(14), completedBy: uids.sw, updatedAt: daysAgo(14),
    })],
    ['task-carol-summary', task('Death summary', 'RN', uids.rn, addDays(deathDate, 2), {
      patientId: CAROL_ID, patientName: plan.patientName, source: { type: 'template', event: 'death' },
      createdAt: daysAgo(20), updatedAt: daysAgo(20),
    })],
  );
  for (const [id, t] of tasks) batch.set(org.collection('tasks').doc(id), t);

  // Volunteer assigned to Alice, with two logged sessions.
  const assignment: VolunteerAssignment = {
    volunteerUid: uids.volunteer,
    patientId: ALICE_ID,
    patientName: aliceName,
    activity: 'companionship',
    status: 'active',
    startDate: addDays(admissionDate, 2),
    endDate: null,
    notes: 'Reads to patient; enjoys gardening talk (demo).',
    createdBy: uids.admin,
    createdAt: daysAgo(8),
  };
  batch.set(org.collection('volunteerAssignments').doc('va-alice'), assignment);
  const logs: Array<[string, VolunteerLog]> = [
    ['vlog-1', { volunteerUid: uids.volunteer, patientId: ALICE_ID, date: addDays(today, -6), minutes: 90, activity: 'companionship', note: null, createdAt: daysAgo(6) }],
    ['vlog-2', { volunteerUid: uids.volunteer, patientId: null, date: addDays(today, -3), minutes: 60, activity: 'admin', note: 'Assembled bereavement mailings (demo).', createdAt: daysAgo(3) }],
  ];
  for (const [id, l] of logs) batch.set(org.collection('volunteerLogs').doc(id), l);

  await batch.commit();

  console.log(`Seeded org "${orgDoc.name}" (${ORG_ID}) in project ${PROJECT_ID}.`);
  console.log(`Users (password "${PASSWORD}"):`);
  for (const u of SEED_USERS) console.log(`  ${u.email.padEnd(20)} ${u.role.padEnd(9)} ${u.discipline}`);
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error('Seed failed:', err);
    process.exit(1);
  },
);
