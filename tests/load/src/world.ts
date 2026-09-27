/**
 * Builds the hospice "world" through the real handlers wherever the app does:
 * org, invites, members, admissions, historical deaths/discharges, channels.
 * Plain client writes (teams, on-call roles, shifts, FCM tokens) are written
 * directly, as the web/iOS clients do. Historical message volume is bulk-seeded.
 */
import type { CallableRequest } from '../../../functions/node_modules/firebase-functions/lib/v2/providers/https';
import { FieldValue, getAuth, getFirestore, Timestamp } from './admin';
import { measure, attempt, retrying } from './instrument';
import { DAY_MS, HOUR_MS, isoDateUTC, pool, progress, sleep, type Rng } from './util';
import { createOrgHandler } from '../../../functions/src/org/createOrg';
import { inviteMemberHandler } from '../../../functions/src/org/inviteMember';
import { acceptInviteHandler } from '../../../functions/src/org/acceptInvite';
import { handleMemberWritten } from '../../../functions/src/org/onMemberWritten';
import { admitPatientHandler } from '../../../functions/src/patients/admitPatient';
import { setVisitFrequenciesHandler } from '../../../functions/src/visits/visits';
import { dischargePatientHandler, recordDeathHandler } from '../../../functions/src/lifecycle/endOfCare';
import { createChannelHandler } from '../../../functions/src/messaging/createChannel';
import type { Discipline, LevelOfCare, Member, PatientInput, Role, VisitFrequency } from '../../../functions/src/shared/types';

export const PROJECT = process.env.GCLOUD_PROJECT ?? 'demo-auraconnect';
export const TZ = 'America/New_York';

export type TeamKey = 'north' | 'south';

export interface Staff {
  uid: string;
  email: string;
  name: string;
  role: Role;
  discipline: Discipline;
  team: TeamKey | null;
  kind: string;
}

export interface PatientRec {
  id: string;
  first: string;
  last: string;
  team: TeamKey;
  rn: string;
  aide: string;
  sw: string;
  chaplain: string;
  md: string;
  lpn: string;
  careTeam: string[];
  channelId: string;
  admissionDate: string;
  status: 'admitted' | 'discharged' | 'deceased';
}

export interface ChannelRec {
  id: string;
  kind: 'patient' | 'direct' | 'team' | 'group';
  members: string[];
  patientId?: string;
}

export interface World {
  orgId: string;
  staff: Staff[];
  byUid: Map<string, Staff>;
  owner: Staff;
  don: Staff;
  intake: Staff[];
  rns: Staff[];
  admins: Staff[];
  teams: Record<TeamKey, string>;
  patients: PatientRec[];
  history: PatientRec[];
  channels: ChannelRec[];
  weekStartMs: number;
  nowMs: number;
}

export function req<T>(data: T, s: Pick<Staff, 'uid' | 'email' | 'role'>, orgId: string | null): CallableRequest<T> {
  return {
    data,
    auth: { uid: s.uid, token: { ...(orgId ? { orgId, role: s.role } : {}), email: s.email, email_verified: true } },
    rawRequest: {},
    acceptsStreaming: false,
  } as unknown as CallableRequest<T>;
}

const FIRST = ['Ada', 'Ben', 'Cora', 'Dale', 'Edna', 'Frank', 'Gail', 'Hank', 'Iris', 'Joel', 'Kay', 'Lou', 'Mae', 'Ned', 'Opal', 'Paul', 'Rita', 'Sam', 'Tess', 'Vern', 'Wanda', 'Earl', 'Faye', 'Glen'];
const LAST = [
  'Abbott', 'Barnes', 'Castillo', 'Dunn', 'Ellison', 'Fowler', 'Garrett', 'Hale', 'Ingram', 'Jensen', 'Keller', 'Lowe', 'Marsh', 'Nolan', 'Ortega', 'Pruitt',
  'Quinn', 'Reyes', 'Sutton', 'Tate', 'Underwood', 'Vance', 'Whitaker', 'Yates', 'Zamora', 'Beckett', 'Crowley', 'Dalton', 'Easton', 'Fairbanks', 'Gilmore', 'Hensley',
];

export function patientInput(r: Rng, first: string, last: string): PatientInput {
  return {
    firstName: first,
    lastName: last,
    dob: `19${r.int(25, 50)}-0${r.int(1, 9)}-1${r.int(0, 9)}`,
    sex: r.pick(['female', 'male'] as const),
    phone: '555-0100',
    address: { line1: `${r.int(1, 999)} Elm St`, line2: null, city: 'Springfield', state: 'IL', zip: '62701' },
    mrn: `MRN${r.int(100000, 999999)}`,
    medicareMbi: null,
    primaryDiagnosis: { code: r.pick(['C34.90', 'J44.9', 'I50.9', 'G30.9', 'C25.9']), description: r.pick(['Lung cancer', 'COPD', 'Heart failure', "Alzheimer's disease", 'Pancreatic cancer']) },
    secondaryDiagnoses: [{ code: 'I10', description: 'Hypertension' }],
    referringPhysician: { name: 'Dr. Referrer', npi: '1234567890', phone: null, fax: null },
    attendingPhysician: { name: 'Dr. Attending', npi: null, phone: null, fax: null },
    codeStatus: 'DNR',
    allergies: ['Penicillin'],
    medications: [
      { name: 'Morphine sulfate', dose: '5 mg', route: 'PO', frequency: 'q4h PRN' },
      { name: 'Lorazepam', dose: '0.5 mg', route: 'SL', frequency: 'q6h PRN' },
      { name: 'Haloperidol', dose: '0.5 mg', route: 'PO', frequency: 'q8h PRN' },
    ],
    caregiver: { name: `${r.pick(FIRST)} ${last}`, relationship: r.pick(['daughter', 'son', 'spouse']), phone: '555-0199' },
    insurance: { payer: 'Medicare', memberId: null },
  };
}

const CONSENTS = { electionStatement: true, hipaaNotice: true, releaseOfInformation: true, patientRights: true, polstOnFile: true };

/** Visit frequencies giving ~9 visits/patient/week → ~900 visits/week for 100 patients. */
export const FREQUENCIES: VisitFrequency[] = [
  { discipline: 'RN', perWeek: 3, notes: null },
  { discipline: 'Aide', perWeek: 4, notes: null },
  { discipline: 'SW', perWeek: 1, notes: null },
  { discipline: 'Chaplain', perWeek: 0.5, notes: null },
  { discipline: 'LPN', perWeek: 0.5, notes: null },
];

export async function resetEmulators(): Promise<void> {
  const fsHost = process.env.FIRESTORE_EMULATOR_HOST;
  const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  if (!fsHost || !authHost) throw new Error('FIRESTORE_EMULATOR_HOST and FIREBASE_AUTH_EMULATOR_HOST must be set (run under `firebase emulators:exec`).');
  await fetch(`http://${fsHost}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  await fetch(`http://${authHost}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
}

function buildStaff(): Staff[] {
  const out: Staff[] = [];
  const add = (kind: string, n: number, role: Role, discipline: Discipline, team: (i: number) => TeamKey | null, name: (i: number) => string) => {
    for (let i = 0; i < n; i++) {
      const uid = `${kind}${n > 1 ? i + 1 : ''}`;
      out.push({ uid, email: `${uid}@sunrise-hospice.test`, name: name(i), role, discipline, team: team(i), kind });
    }
  };
  const alt = (i: number): TeamKey => (i % 2 === 0 ? 'north' : 'south');
  add('owner', 1, 'admin', 'Admin', () => null, () => 'Olivia Owner');
  add('don', 1, 'admin', 'RN', () => null, () => 'Dana Director');
  add('intake', 2, 'intake', 'Admin', () => null, (i) => `Ivy Intake ${i + 1}`);
  add('rn', 10, 'clinician', 'RN', (i) => (i < 5 ? 'north' : 'south'), (i) => `Rae Nurse ${i + 1}`);
  add('lpn', 4, 'clinician', 'LPN', alt, (i) => `Lee Practical ${i + 1}`);
  add('aide', 14, 'clinician', 'Aide', (i) => (i < 7 ? 'north' : 'south'), (i) => `Abe Aide ${i + 1}`);
  add('sw', 4, 'clinician', 'SW', alt, (i) => `Sue Social ${i + 1}`);
  add('chap', 3, 'clinician', 'Chaplain', (i) => (i < 2 ? 'north' : 'south'), (i) => `Chris Chaplain ${i + 1}`);
  add('md', 1, 'clinician', 'MD', () => null, () => 'Dr. Medical Director');
  add('amd', 1, 'clinician', 'MD', () => null, () => 'Dr. Associate');
  add('np', 1, 'clinician', 'NP', () => null, () => 'Nina Practitioner');
  add('bereave', 1, 'clinician', 'SW', () => null, () => 'Bea Bereavement');
  add('volco', 1, 'admin', 'Admin', () => null, () => 'Val Volunteer-Coordinator');
  add('vol', 25, 'viewer', 'Volunteer', alt, (i) => `Vic Volunteer ${i + 1}`);
  return out;
}

export async function buildWorld(r: Rng, opts: { historyWeeks: number; concurrency: number; acceptConcurrency: number }): Promise<World> {
  const db = getFirestore();
  const nowMs = Date.now();
  // Seven whole UTC days ending at today's 00:00 UTC, so every visit in the week is in the past.
  const weekStartMs = Math.floor(nowMs / DAY_MS) * DAY_MS - 7 * DAY_MS;
  const staff = buildStaff();
  const byUid = new Map(staff.map((s) => [s.uid, s]));
  const owner = byUid.get('owner')!;

  progress(`creating ${staff.length} auth users`);
  await pool(staff.map((s) => () => getAuth().createUser({ uid: s.uid, email: s.email, emailVerified: true, displayName: s.name })), 10);

  const { orgId } = await measure('setup:createOrg', () =>
    createOrgHandler(req({ name: 'Sunrise Hospice', timezone: TZ, displayName: owner.name, discipline: 'Admin' }, owner, null)),
  );
  const org = db.doc(`orgs/${orgId}`);
  // Admin client writes: org settings, teams.
  await org.update({ idgCadenceDays: 15, missedVisitGraceMinutes: 120 });
  const teams: Record<TeamKey, string> = { north: 'team-north', south: 'team-south' };
  for (const [k, id] of Object.entries(teams)) {
    await db.doc(`orgs/${orgId}/teams/${id}`).set({ name: k === 'north' ? 'North' : 'South', description: null, memberUids: [owner.uid], createdAt: FieldValue.serverTimestamp() });
  }

  progress('inviting and onboarding staff');
  const ownerReq = <T>(data: T) => req(data, owner, orgId);
  const others = staff.filter((s) => s !== owner);
  const invites = new Map<string, string>();
  await pool(
    others.map((s) => async () => {
      const teamIds = s.team ? [teams[s.team]] : s.discipline === 'MD' || s.discipline === 'NP' ? [teams.north, teams.south] : [];
      const { inviteId } = await measure('setup:inviteMember', () =>
        inviteMemberHandler(ownerReq({ orgId, email: s.email, displayName: s.name, role: s.role, discipline: s.discipline, teamIds })),
      );
      invites.set(s.uid, inviteId);
    }),
    opts.concurrency,
  );
  // Staff accept invites a few at a time (every acceptance arrayUnions into its team doc inside a transaction).
  const failedAccepts: string[] = [];
  await pool(
    others.map((s) => async () => {
      // Users retry when the callable fails (contention on the shared team doc aborts some transactions).
      const ok = await retrying('setup:acceptInvite', () => acceptInviteHandler(req({ orgId, inviteId: invites.get(s.uid)! }, s, null), { requireVerified: false }), 10);
      if (!ok) {
        failedAccepts.push(s.uid);
        return;
      }
      const m = (await db.doc(`orgs/${orgId}/members/${s.uid}`).get()).data() as Member;
      await measure('trigger:onMemberWritten', () => handleMemberWritten(orgId, s.uid, null, m));
    }),
    opts.acceptConcurrency,
  );
  if (failedAccepts.length) throw new Error(`acceptInvite kept failing for ${failedAccepts.join(', ')}`);
  // Self-service client writes: FCM tokens (2 devices for staff, 1 for volunteers).
  await pool(
    staff.map((s) => () => db.doc(`orgs/${orgId}/members/${s.uid}`).update({ fcmTokens: s.role === 'viewer' ? [`fcm-${s.uid}-a`] : [`fcm-${s.uid}-ios`, `fcm-${s.uid}-web`] })),
    opts.concurrency,
  );

  // On-call roles + 2 weeks of shifts (last week and next week), admin client writes.
  const pickTeam = (kind: string, team: TeamKey) => staff.filter((s) => s.kind === kind && s.team === team);
  const don = byUid.get('don')!;
  const md = byUid.get('md')!;
  await db.doc(`orgs/${orgId}/onCallRoles/oncall-rn-north`).set({ label: 'On-call RN North', discipline: 'RN', teamId: teams.north, fallbackUids: [don.uid] });
  await db.doc(`orgs/${orgId}/onCallRoles/oncall-rn-south`).set({ label: 'On-call RN South', discipline: 'RN', teamId: teams.south, fallbackUids: [don.uid] });
  await db.doc(`orgs/${orgId}/onCallRoles/oncall-md`).set({ label: 'On-call MD', discipline: 'MD', teamId: null, fallbackUids: [md.uid] });
  const shiftBatch = db.batch();
  const day0 = Math.floor(nowMs / DAY_MS) * DAY_MS;
  for (let d = -7; d < 7; d++) {
    const base = day0 + d * DAY_MS + 12 * HOUR_MS; // 08:00 America/New_York (EDT)
    for (const team of ['north', 'south'] as const) {
      const rns = pickTeam('rn', team);
      const dayRn = rns[(d + 7) % rns.length]!;
      const nightRn = rns[(d + 9) % rns.length]!;
      shiftBatch.set(db.collection(`orgs/${orgId}/shifts`).doc(), { roleKey: `oncall-rn-${team}`, uid: dayRn.uid, start: Timestamp.fromMillis(base), end: Timestamp.fromMillis(base + 12 * HOUR_MS), notes: null });
      shiftBatch.set(db.collection(`orgs/${orgId}/shifts`).doc(), { roleKey: `oncall-rn-${team}`, uid: nightRn.uid, start: Timestamp.fromMillis(base + 12 * HOUR_MS), end: Timestamp.fromMillis(base + DAY_MS), notes: null });
    }
    const mds = ['md', 'amd', 'np'];
    shiftBatch.set(db.collection(`orgs/${orgId}/shifts`).doc(), { roleKey: 'oncall-md', uid: mds[(d + 7) % 3]!, start: Timestamp.fromMillis(base), end: Timestamp.fromMillis(base + DAY_MS), notes: null });
  }
  await shiftBatch.commit();

  // --- patients -----------------------------------------------------------
  const intake = staff.filter((s) => s.kind === 'intake');
  const nurseFor = (team: TeamKey, i: number) => pickTeam('rn', team)[i % 5]!;
  const careTeamFor = (team: TeamKey, i: number) => {
    const rn = nurseFor(team, i);
    const aide = pickTeam('aide', team)[i % 7]!;
    const sw = pickTeam('sw', team)[i % 2]!;
    const chaps = pickTeam('chap', team);
    const chaplain = chaps[i % chaps.length]!;
    const lpns = pickTeam('lpn', team);
    const lpn = lpns[i % lpns.length]!;
    const mdUid = team === 'north' ? 'md' : 'amd';
    return { rn: rn.uid, aide: aide.uid, sw: sw.uid, chaplain: chaplain.uid, md: mdUid, lpn: lpn.uid, careTeam: [rn.uid, aide.uid, sw.uid, chaplain.uid, mdUid] };
  };

  const levels: LevelOfCare[] = [...Array(95).fill('routine'), 'gip', 'gip', 'continuous', 'continuous', 'respite'];
  r.shuffle(levels);
  const today = isoDateUTC(nowMs);
  const usedNames = new Set<string>();
  const nameFor = (): [string, string] => {
    for (;;) {
      const f = r.pick(FIRST);
      const l = r.pick(LAST);
      if (!usedNames.has(`${f} ${l}`)) {
        usedNames.add(`${f} ${l}`);
        return [f, l];
      }
    }
  };

  async function admit(i: number, team: TeamKey, admissionDate: string, startingBenefitPeriod: number, levelOfCare: LevelOfCare, op: string): Promise<PatientRec> {
    const [first, last] = nameFor();
    const ct = careTeamFor(team, i);
    const caller = intake[i % intake.length]!;
    const res = await measure(op, () =>
      admitPatientHandler(
        req({ orgId, patient: patientInput(r, first, last), admissionDate, startingBenefitPeriod, levelOfCare, careTeamUids: ct.careTeam, consents: CONSENTS }, caller, orgId),
      ),
    );
    return { id: res.patientId, first, last, team, ...ct, channelId: res.channelId, admissionDate, status: 'admitted' };
  }

  progress('admitting 100 patients');
  const patients: PatientRec[] = new Array(100);
  await pool(
    Array.from({ length: 100 }, (_, i) => async () => {
      const team: TeamKey = i < 50 ? 'north' : 'south';
      const bucket = r.next();
      const daysAgo = bucket < 0.3 ? r.int(9, 30) : bucket < 0.55 ? r.int(31, 90) : bucket < 0.75 ? r.int(91, 180) : bucket < 0.9 ? r.int(181, 300) : r.int(301, 400);
      const sbp = r.chance(0.85) ? 1 : r.chance(0.66) ? 2 : 3;
      const p = await admit(i, team, isoDateUTC(nowMs - daysAgo * DAY_MS), sbp, levels[i]!, 'setup:admitPatient');
      patients[i] = p;
      const rn = byUid.get(p.rn)!;
      await measure('setup:setVisitFrequencies', () => setVisitFrequenciesHandler(req({ orgId, patientId: p.id, frequencies: FREQUENCIES }, rn, orgId)));
    }),
    opts.concurrency,
  );

  progress('creating 40 historical (deceased/discharged) patients');
  const history: PatientRec[] = new Array(40);
  await pool(
    Array.from({ length: 40 }, (_, i) => async () => {
      const team: TeamKey = i % 2 === 0 ? 'north' : 'south';
      const endDaysAgo = r.int(9, 390);
      const los = r.int(3, 180);
      const endDate = isoDateUTC(nowMs - endDaysAgo * DAY_MS);
      const p = await admit(i + 100, team, isoDateUTC(nowMs - (endDaysAgo + los) * DAY_MS), 1, 'routine', 'setup:admitPatient(history)');
      const rn = byUid.get(p.rn)!;
      if (i < 32) {
        const ok = await retrying('setup:recordDeath(history)', () => recordDeathHandler(req({ orgId, patientId: p.id, date: endDate, time: '03:15', pronouncedBy: rn.name }, rn, orgId)));
        if (!ok) throw new Error('recordDeath kept failing');
        p.status = 'deceased';
      } else {
        const ok = await retrying('setup:dischargePatient(history)', () =>
          dischargePatientHandler(req({ orgId, patientId: p.id, dischargeDate: endDate, reason: 'no_longer_terminally_ill' }, rn, orgId)),
        );
        if (!ok) throw new Error('dischargePatient kept failing');
        p.status = 'discharged';
      }
      history[i] = p;
    }),
    opts.concurrency,
  );

  // --- channels -----------------------------------------------------------
  for (const list of [patients, history]) {
    const kept = list.filter(Boolean);
    list.length = 0;
    list.push(...kept);
  }
  progress(`creating direct, team and group channels (${patients.length} admitted, ${history.length} historical)`);
  const channels: ChannelRec[] = [];
  for (const p of [...patients, ...history]) {
    const caller = intake[[...patients, ...history].indexOf(p) % intake.length]!;
    channels.push({ id: p.channelId, kind: 'patient', members: [...new Set([...p.careTeam, caller.uid])], patientId: p.id });
  }
  const clinicians = staff.filter((s) => s.role !== 'viewer');
  const pairs = new Set<string>();
  const dmThunks: Array<() => Promise<unknown>> = [];
  while (pairs.size < 60) {
    const a = r.pick(clinicians);
    const b = r.pick(clinicians);
    if (a.uid === b.uid) continue;
    const key = [a.uid, b.uid].sort().join('|');
    if (pairs.has(key)) continue;
    pairs.add(key);
    dmThunks.push(async () => {
      const res = await attempt('setup:createChannel(direct)', () => createChannelHandler(req({ orgId, type: 'direct' as const, memberUids: [b.uid] }, a, orgId)));
      if (res) channels.push({ id: res.channelId, kind: 'direct', members: [a.uid, b.uid] });
    });
  }
  await pool(dmThunks, opts.concurrency);
  for (const team of ['north', 'south'] as const) {
    const res = await measure('setup:createChannel(team)', () =>
      createChannelHandler(req({ orgId, type: 'team' as const, memberUids: [], teamId: teams[team], name: team === 'north' ? 'North team' : 'South team' }, owner, orgId)),
    );
    const t = (await db.doc(`orgs/${orgId}/teams/${teams[team]}`).get()).data() as { memberUids: string[] };
    channels.push({ id: res.channelId, kind: 'team', members: [...new Set([...t.memberUids, owner.uid])] });
  }
  const leadership = [owner.uid, don.uid, md.uid, 'amd', 'np', 'intake1', 'intake2', 'volco', 'bereave'];
  const lead = await measure('setup:createChannel(group)', () =>
    createChannelHandler(req({ orgId, type: 'group' as const, memberUids: leadership, name: 'Leadership' }, owner, orgId)),
  );
  channels.push({ id: lead.channelId, kind: 'group', members: leadership });

  const world: World = {
    orgId,
    staff,
    byUid,
    owner,
    don,
    intake,
    rns: staff.filter((s) => s.kind === 'rn'),
    admins: staff.filter((s) => s.role === 'admin'),
    teams,
    patients,
    history,
    channels,
    weekStartMs,
    nowMs,
  };

  if (opts.historyWeeks > 0) await seedMessageHistory(world, r, opts.historyWeeks);
  progress(`world ready: org ${orgId}, ${patients.length} admitted, ${history.length} historical, ${channels.length} channels (today ${today})`);
  return world;
}

export const WORDS = [
  'pain', 'morphine', 'PRN', 'resting', 'comfortable', 'family', 'bedside', 'visit', 'breathing', 'oxygen', 'lorazepam', 'agitation', 'appetite', 'skin',
  'wound', 'turned', 'repositioned', 'bowel', 'constipation', 'nausea', 'haloperidol', 'daughter', 'son', 'spouse', 'called', 'update', 'meds', 'refill',
  'pharmacy', 'DME', 'hospital bed', 'wheelchair', 'chaplain', 'prayer', 'social work', 'caregiver', 'fatigue', 'sleeping', 'restless', 'confused',
  'fever', 'edema', 'vitals', 'BP', 'pulse', 'respirations', 'mottling', 'decline', 'stable', 'IDG', 'plan of care', 'goals', 'comfort', 'hydration',
];

export function messageBody(r: Rng, extra?: string): string {
  const n = r.int(6, 50);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push(r.pick(WORDS));
  if (extra) parts.splice(r.int(0, parts.length), 0, extra);
  return parts.join(' ');
}

/** Bulk-seeds `weeks` of message history before the busy week (5,000 messages/week, same mix). */
async function seedMessageHistory(w: World, r: Rng, weeks: number): Promise<void> {
  const db = getFirestore();
  const fromMs = w.weekStartMs - weeks * 7 * DAY_MS;
  const perWeek = { patient: 3250 / 140, direct: 1250 / 60, teamgroup: 500 / 3 };
  const ops: Array<{ channel: ChannelRec; at: number; sender: string; body: string }> = [];
  const allPatients = [...w.patients, ...w.history];
  for (const c of w.channels) {
    let rate = c.kind === 'patient' ? perWeek.patient : c.kind === 'direct' ? perWeek.direct : perWeek.teamgroup;
    let start = fromMs;
    let end = w.weekStartMs;
    if (c.kind === 'patient') {
      const p = allPatients.find((x) => x.id === c.patientId)!;
      start = Math.max(start, Date.parse(p.admissionDate));
      if (p.status !== 'admitted') {
        // Historical patients: messages during their stay only (end ≈ admission + stay; approximate with the window).
        end = Math.min(end, start + 60 * DAY_MS);
        rate *= 1.5;
      }
    }
    if (end <= start) continue;
    const n = Math.round((rate * (end - start)) / (7 * DAY_MS));
    const senders = c.members.filter((u) => w.byUid.get(u)?.role !== 'viewer');
    for (let i = 0; i < n; i++) ops.push({ channel: c, at: start + r.next() * (end - start), sender: r.pick(senders), body: messageBody(r) });
  }
  progress(`seeding ${ops.length} historical messages (${weeks} weeks)`);
  const last = new Map<string, (typeof ops)[number]>();
  const first = new Map<string, number>();
  for (const o of ops) first.set(o.channel.id, Math.min(first.get(o.channel.id) ?? Infinity, o.at));
  const chunks: Array<typeof ops> = [];
  for (let i = 0; i < ops.length; i += 400) chunks.push(ops.slice(i, i + 400));
  await pool(
    chunks.map((chunk) => async () => {
      const b = db.batch();
      for (const o of chunk) {
        const ref = db.collection(`orgs/${w.orgId}/channels/${o.channel.id}/messages`).doc();
        b.set(ref, {
          senderUid: o.sender,
          senderName: w.byUid.get(o.sender)!.name,
          body: o.body,
          priority: 'normal',
          attachments: [],
          roleTarget: null,
          createdAt: Timestamp.fromMillis(o.at),
          alertId: null,
          threadParentId: null,
        });
        const prev = last.get(o.channel.id);
        if (!prev || prev.at < o.at) last.set(o.channel.id, o);
      }
      await b.commit();
    }),
    8,
  );
  const b = db.batch();
  for (const [cid, o] of last) {
    const at = Timestamp.fromMillis(o.at);
    b.update(db.doc(`orgs/${w.orgId}/channels/${cid}`), {
      lastMessage: { text: o.body.slice(0, 140), senderUid: o.sender, senderName: w.byUid.get(o.sender)!.name, priority: 'normal', at },
      lastMessageAt: at,
      // The channel existed before its oldest seeded message (the purge job skips younger channels).
      createdAt: Timestamp.fromMillis(first.get(cid)! - 60_000),
    });
  }
  await b.commit();
}
