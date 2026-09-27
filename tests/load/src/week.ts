/**
 * One busy week at a 100-census hospice, driven through the real handlers with
 * concurrency. Triggers (onMessageCreated, onAlertCreated) are pumped from
 * Firestore listeners, like the deployed triggers; escalation Cloud Tasks are
 * dispatched from the fake queue at the end of each simulated day.
 */
import { FieldValue, getFirestore, Timestamp } from './admin';
import { attempt, measure, taskQueue } from './instrument';
import { DAY_MS, HOUR_MS, isoDateUTC, pool, progress, rng, sleep, type Rng } from './util';
import { FREQUENCIES, messageBody, patientInput, req, type ChannelRec, type PatientRec, type Staff, type TeamKey, type World } from './world';
import { handleMessageCreated } from '../../../functions/src/messaging/onMessageCreated';
import { handleAlertCreated } from '../../../functions/src/alerts/onAlertCreated';
import { handleEscalation } from '../../../functions/src/alerts/escalateAlert';
import { alertActionHandler } from '../../../functions/src/alerts/alertActions';
import { createAlertHandler } from '../../../functions/src/alerts/createAlert';
import { recallMessageHandler } from '../../../functions/src/messaging/recallMessage';
import { searchMessagesHandler } from '../../../functions/src/messaging/searchMessages';
import { sendBroadcastHandler } from '../../../functions/src/messaging/sendBroadcast';
import { sendRoleMessageHandler } from '../../../functions/src/messaging/sendRoleMessage';
import { runMessagePurge } from '../../../functions/src/messaging/purgeExpiredMessages';
import { admitPatientHandler } from '../../../functions/src/patients/admitPatient';
import { runDeadlineChecks } from '../../../functions/src/patients/checkDeadlines';
import { cancelVisitHandler, completeVisitHandler, scheduleVisitHandler, setVisitFrequenciesHandler, updateVisitHandler } from '../../../functions/src/visits/visits';
import { runMissedVisitChecks } from '../../../functions/src/visits/checkMissedVisits';
import { changeLevelOfCareHandler } from '../../../functions/src/lifecycle/changeLevelOfCare';
import { recordRecertificationHandler } from '../../../functions/src/lifecycle/recordRecertification';
import { dischargePatientHandler, recordDeathHandler } from '../../../functions/src/lifecycle/endOfCare';
import { completeMilestoneHandler } from '../../../functions/src/lifecycle/milestones';
import { createTaskHandler, updateTaskHandler } from '../../../functions/src/tasks/tasks';
import { updateBereavementContactHandler } from '../../../functions/src/bereavement/bereavement';
import { completeIdgMeetingHandler, createIdgMeetingHandler, saveIdgNoteHandler } from '../../../functions/src/idg/idg';
import { assignTriageCallHandler, logTriageCallHandler, resolveTriageCallHandler } from '../../../functions/src/triage/triage';
import { handleReferralUploaded } from '../../../functions/src/referrals/onReferralUploaded';
import { acceptReferralHandler, rejectReferralHandler } from '../../../functions/src/referrals/reviewReferral';
import { generateHandoffHandler } from '../../../functions/src/ai/generateHandoff';
import { generateIdgPrepHandler } from '../../../functions/src/ai/generateIdgPrep';
import { summarizeChannelHandler } from '../../../functions/src/ai/summarizeChannel';
import { runDailyMetrics, computeMetricsHandler } from '../../../functions/src/metrics/computeMetrics';
import { milestoneKey } from '../../../functions/src/domain/milestones';
import { fakeExtractor, fakeTextGenerator } from './instrument';
import type { Alert, BereavementPlan, Message, Patient, Task } from '../../../functions/src/shared/types';

export interface WeekConfig {
  concurrency: number;
  messagesPerWeek: number;
  geminiLatencyMs: number;
  purge: boolean;
  /**
   * v4 scenario: some members mute or set "mentions only" on channels, a few are out of office,
   * and some normal messages @mention a member or an on-call role. Uses its own RNG stream, so the
   * rest of the week is identical with it on or off (compare push fan-out with `--no-v4-prefs`).
   */
  v4Prefs: boolean;
}

export const V4_SCENARIO = {
  /** Patient channels: share of non-RN members on "mentions only" / muted all week. */
  patientMentionsOnly: 0.3,
  patientMuted: 0.05,
  /** Team and group channels: share of members who muted them. */
  groupMuted: 0.4,
  /** Staff out of office all week (with a delegate). */
  outOfOffice: 2,
  /** Normal messages that @mention another channel member / an on-call role. */
  memberMention: 0.15,
  roleMention: 0.02,
};

/** v4: channel prefs and out-of-office, written directly as the clients do. */
async function setupV4Scenario(w: World, r4: Rng, concurrency: number): Promise<void> {
  const db = getFirestore();
  const until = Timestamp.fromMillis(Date.now() + 8 * DAY_MS);
  const writes: Array<() => Promise<unknown>> = [];
  for (const c of w.channels) {
    if (c.kind === 'direct') continue;
    for (const uid of c.members) {
      const s = w.byUid.get(uid);
      if (!s) continue;
      let mode: 'all' | 'mentions' | null = null;
      let muted = false;
      if (c.kind === 'patient') {
        if (s.kind === 'rn') continue; // the primary RN hears everything
        if (r4.chance(V4_SCENARIO.patientMentionsOnly)) mode = 'mentions';
        else if (r4.chance(V4_SCENARIO.patientMuted)) muted = true;
      } else if (r4.chance(V4_SCENARIO.groupMuted)) {
        muted = true;
      }
      if (!mode && !muted) continue;
      writes.push(() =>
        db.doc(`orgs/${w.orgId}/channels/${c.id}/prefs/${uid}`).set({
          mode: mode ?? 'all', mutedUntil: muted ? until : null, updatedAt: FieldValue.serverTimestamp(),
        }),
      );
    }
  }
  const away = r4.shuffle(w.staff.filter((s) => s.kind === 'aide' || s.kind === 'sw')).slice(0, V4_SCENARIO.outOfOffice);
  for (const s of away) {
    writes.push(() => db.doc(`orgs/${w.orgId}/members/${s.uid}`).update({ outOfOffice: { until, delegateUid: w.don.uid, note: null } }));
  }
  await pool(writes, concurrency);
  progress(`v4 scenario: ${writes.length - away.length} channel prefs, ${away.length} out of office`);
}

export interface JobRun {
  job: string;
  runs: number;
  totalMs: number;
  maxMs: number;
}

interface PlannedVisit {
  id: string;
  patient: PatientRec;
  day: number;
  assignee: string;
  discipline: string;
  fate: 'complete' | 'miss' | 'cancel' | 'update';
}

// ---------------------------------------------------------------------------
// Trigger pumps
// ---------------------------------------------------------------------------

class TriggerPump {
  private inflight = 0;
  private lastEvent = Date.now();
  private unsubs: Array<() => void> = [];
  followUps: Array<Promise<unknown>> = [];

  constructor(private readonly w: World, private readonly r: Rng) {}

  start(): void {
    const db = getFirestore();
    const since = Timestamp.fromMillis(Date.now() - 60_000);
    this.unsubs.push(
      db
        .collectionGroup('messages')
        .where('createdAt', '>=', since)
        .onSnapshot((snap) => {
          for (const ch of snap.docChanges()) {
            if (ch.type !== 'added') continue;
            const [, orgId, , channelId, , messageId] = ch.doc.ref.path.split('/');
            const data = ch.doc.data() as Message;
            this.run(() => attempt('trigger:onMessageCreated', () => handleMessageCreated(orgId!, channelId!, messageId!, data)));
          }
        }),
    );
    this.unsubs.push(
      db
        .collection(`orgs/${this.w.orgId}/alerts`)
        .where('createdAt', '>=', since)
        .onSnapshot((snap) => {
          for (const ch of snap.docChanges()) {
            if (ch.type !== 'added') continue;
            const alert = ch.doc.data() as Alert;
            const id = ch.doc.id;
            this.run(async () => {
              await attempt('trigger:onAlertCreated', () => handleAlertCreated(this.w.orgId, id, alert));
              this.followUp(id, alert);
            });
          }
        }),
    );
  }

  /** Recipients acknowledge most urgent pages quickly; routine reminders less often. */
  private followUp(id: string, alert: Alert): void {
    const p = alert.source.type === 'message' ? 0.75 : alert.source.type === 'triage' ? 0.0 : alert.source.type === 'deadline' ? 0.4 : alert.source.type === 'visit_missed' ? 0.3 : 0.6;
    if (!this.r.chance(p)) return;
    const who = this.w.byUid.get(alert.targetUids[0]!) ?? this.w.owner;
    const action = this.r.chance(0.3) ? 'resolve' : 'ack';
    this.run(() => attempt(`callable:${action}Alert`, () => alertActionHandler(req({ orgId: this.w.orgId, alertId: id }, who, this.w.orgId), action)));
  }

  private run(fn: () => Promise<unknown>): void {
    this.inflight++;
    this.lastEvent = Date.now();
    void fn().finally(() => {
      this.inflight--;
      this.lastEvent = Date.now();
    });
  }

  /** Waits until no trigger is running and no listener event arrived for `quietMs`. */
  async drain(quietMs = 400): Promise<void> {
    for (;;) {
      await sleep(100);
      if (this.inflight === 0 && Date.now() - this.lastEvent >= quietMs) return;
    }
  }

  stop(): void {
    for (const u of this.unsubs) u();
  }
}

/** Dispatches every queued escalation check (advancing alerts enqueue the next level). */
async function dispatchEscalations(concurrency: number): Promise<void> {
  while (taskQueue.length > 0) {
    const batch = taskQueue.splice(0, taskQueue.length);
    await pool(batch.map((t) => () => attempt('task:escalateAlert', () => handleEscalation(t.payload))), concurrency);
  }
}

// ---------------------------------------------------------------------------
// The week
// ---------------------------------------------------------------------------

export async function runWeek(w: World, r: Rng, cfg: WeekConfig): Promise<JobRun[]> {
  const db = getFirestore();
  const { orgId } = w;
  const C = cfg.concurrency;
  const gen = fakeTextGenerator(cfg.geminiLatencyMs);
  const staff = (uid: string) => w.byUid.get(uid)!;
  const as = <T>(data: T, s: Staff) => req(data, s, orgId);
  const jobs = new Map<string, JobRun>();
  const timeJob = async (job: string, fn: () => Promise<unknown>) => {
    const t0 = performance.now();
    await attempt(job, fn);
    const ms = performance.now() - t0;
    const j = jobs.get(job) ?? { job, runs: 0, totalMs: 0, maxMs: 0 };
    j.runs++;
    j.totalMs += ms;
    j.maxMs = Math.max(j.maxMs, ms);
    jobs.set(job, j);
  };

  const pump = new TriggerPump(w, r);
  pump.start();
  await sleep(500);
  // v4 scenario on its own RNG stream (the main stream `r` is untouched either way).
  const r4 = rng(0x4a11c0de);
  if (cfg.v4Prefs) await setupV4Scenario(w, r4, C);

  const active = new Set(w.patients.map((p) => p.id));
  const activePatients = () => w.patients.filter((p) => active.has(p.id));
  const dayStart = (d: number) => w.weekStartMs + d * DAY_MS;
  const simDate = (d: number) => isoDateUTC(dayStart(d) + 12 * HOUR_MS);
  const archived = new Set<string>();

  // --- plan and schedule the week's visits ---------------------------------
  const visits: PlannedVisit[] = [];
  const scheduleFor = (p: PatientRec, fromDay: number): Array<() => Promise<unknown>> => {
    const thunks: Array<() => Promise<unknown>> = [];
    for (const f of FREQUENCIES) {
      const count = Math.floor(f.perWeek) + (r.chance(f.perWeek % 1) ? 1 : 0);
      for (let k = 0; k < count; k++) {
        const day = r.int(fromDay, 6);
        const assignee = f.discipline === 'RN' ? p.rn : f.discipline === 'Aide' ? p.aide : f.discipline === 'SW' ? p.sw : f.discipline === 'Chaplain' ? p.chaplain : p.lpn;
        const startMs = dayStart(day) + r.int(12, 21) * HOUR_MS + r.pick([0, 15, 30, 45]) * 60_000;
        const durMin = f.discipline === 'Aide' ? r.pick([60, 90]) : f.discipline === 'RN' ? 60 : 45;
        const roll = r.next();
        const fate: PlannedVisit['fate'] = roll < 0.05 ? 'miss' : roll < 0.06 ? 'cancel' : roll < 0.08 ? 'update' : 'complete';
        thunks.push(async () => {
          const res = await measure('callable:scheduleVisit', () =>
            scheduleVisitHandler(
              as(
                { orgId, patientId: p.id, discipline: f.discipline, assignedUid: assignee, start: new Date(startMs).toISOString(), end: new Date(startMs + durMin * 60_000).toISOString() },
                staff(p.rn),
              ),
            ),
          );
          visits.push({ id: res.id, patient: p, day, assignee, discipline: f.discipline, fate });
        });
      }
    }
    return thunks;
  };
  progress('scheduling the week of visits');
  await pool(w.patients.flatMap((p) => scheduleFor(p, 0)), C);
  progress(`scheduled ${visits.length} visits`);

  // --- fixed weekly plan -----------------------------------------------------
  const pickDistinct = (n: number, exclude: Set<string>) => {
    const pool2 = r.shuffle(activePatients().filter((p) => !exclude.has(p.id)));
    return pool2.slice(0, n);
  };
  const reserved = new Set<string>();
  const deathPlan = pickDistinct(8, reserved);
  deathPlan.forEach((p) => reserved.add(p.id));
  const dischargePlan = pickDistinct(2, reserved);
  dischargePlan.forEach((p) => reserved.add(p.id));
  const locPlan = pickDistinct(2, reserved);
  locPlan.forEach((p) => reserved.add(p.id));
  const deathDays = [0, 1, 2, 3, 3, 4, 5, 6];
  const dischargeDays = [2, 5];
  const locDays = [1, 4];
  const recertDays = [0, 1, 2, 4, 5, 6];
  const referralDays = [0, 0, 1, 1, 2, 2, 3, 4, 4, 5, 5, 6];
  const recertDone = new Set<string>();

  // Pre-compute recert candidates: admitted patients currently in benefit period ≥ 2.
  const recertCandidates: Array<{ p: PatientRec; periodNumber: number; f2f: boolean; f2fDate: string | null; certDate: string }> = [];
  {
    const snaps = await db.getAll(...w.patients.filter((p) => !reserved.has(p.id)).map((p) => db.doc(`orgs/${orgId}/patients/${p.id}`)));
    const today = isoDateUTC(w.nowMs);
    for (const s of snaps) {
      const pat = s.data() as Patient;
      const periods = pat.milestones?.benefitPeriods ?? [];
      const idx = periods.findIndex((bp) => bp.start <= today && today <= bp.end);
      const period = periods[idx];
      // The first computed period is certified at admission; only later ones are recertified.
      if (!period || idx < 1) continue;
      const rec = w.patients.find((x) => x.id === s.id)!;
      // v3 (S4): the certification must be dated within the 15 days before the period starts.
      recertCandidates.push({ p: rec, periodNumber: period.number, f2f: period.f2fRequired, f2fDate: period.f2fRequired ? period.f2fDueBy : null, certDate: period.start });
    }
    r.shuffle(recertCandidates);
  }

  const msgsPerDay = Math.round(cfg.messagesPerWeek / 7);
  const sentByChannel = new Map<string, Array<{ id: string; sender: string }>>();
  let recallsLeft = 10;
  let triageLeft = 40;
  let searchesLeft = 50;
  let roleMsgsLeft = 20;
  let manualAlertsLeft = 5;

  for (let d = 0; d < 7; d++) {
    const date = simDate(d);
    progress(`day ${d + 1}/7 (${date})`);
    const actions: Array<() => Promise<unknown>> = [];

    // Messages ------------------------------------------------------------------
    const liveChannels = w.channels.filter((c) => !archived.has(c.id) && (c.kind !== 'patient' || active.has(c.patientId!)));
    const byKind = (k: ChannelRec['kind'][]) => liveChannels.filter((c) => k.includes(c.kind));
    const patientCh = byKind(['patient']);
    const dmCh = byKind(['direct']);
    const tgCh = byKind(['team', 'group']);
    for (let i = 0; i < msgsPerDay; i++) {
      const roll = r.next();
      const c = roll < 0.65 ? r.pick(patientCh) : roll < 0.9 ? r.pick(dmCh) : r.pick(tgCh);
      const senders = c.members.filter((u) => w.byUid.get(u)?.role !== 'viewer');
      const sender = staff(r.pick(senders));
      const pr = r.next();
      const priority = pr < 0.005 ? 'critical' : pr < 0.03 ? 'urgent' : 'normal';
      const prior = sentByChannel.get(c.id) ?? [];
      const threadParentId = prior.length > 0 && r.chance(0.1) ? r.pick(prior).id : null;
      const patient = c.patientId ? w.patients.find((p) => p.id === c.patientId) : undefined;
      let body = messageBody(r, patient && r.chance(0.2) ? patient.last : undefined);
      if (cfg.v4Prefs && priority === 'normal') {
        const others = c.members.filter((u) => u !== sender.uid && w.byUid.has(u));
        if (others.length && r4.chance(V4_SCENARIO.memberMention)) body = `@${staff(r4.pick(others)).name} ${body}`;
        else if (r4.chance(V4_SCENARIO.roleMention)) body = `@oncall-rn-${sender.team ?? 'north'} ${body}`;
      }
      actions.push(async () => {
        const ref = db.collection(`orgs/${orgId}/channels/${c.id}/messages`).doc();
        await measure('client:message.create', () =>
          ref.set({
            senderUid: sender.uid,
            senderName: sender.name,
            body,
            priority,
            attachments: [],
            roleTarget: null,
            createdAt: FieldValue.serverTimestamp(),
            alertId: null,
            ...(threadParentId ? { threadParentId } : {}),
          }),
        );
        if (!threadParentId) {
          const list = sentByChannel.get(c.id) ?? [];
          list.push({ id: ref.id, sender: sender.uid });
          sentByChannel.set(c.id, list);
        }
      });
    }
    // A few recalls of earlier messages.
    for (let i = 0; i < 2 && recallsLeft > 0 && d > 0; i++, recallsLeft--) {
      const entries = [...sentByChannel.entries()].filter(([cid]) => !archived.has(cid));
      const [cid, list] = r.pick(entries);
      const m = r.pick(list);
      actions.push(() => attempt('callable:recallMessage', () => recallMessageHandler(as({ orgId, channelId: cid, messageId: m.id }, staff(m.sender)))));
    }
    // Role messages and manual alerts.
    for (let i = 0; i < 3 && roleMsgsLeft > 0; i++, roleMsgsLeft--) {
      const team: TeamKey = r.chance(0.5) ? 'north' : 'south';
      const sender = r.pick(w.staff.filter((s) => (s.kind === 'aide' || s.kind === 'lpn') && s.team === team));
      actions.push(() =>
        attempt('callable:sendRoleMessage', () =>
          sendRoleMessageHandler(as({ orgId, roleKey: `oncall-rn-${team}`, body: messageBody(r), priority: r.chance(0.2) ? 'urgent' : 'normal' }, sender)),
        ),
      );
    }
    if (manualAlertsLeft-- > 0) {
      const p = r.pick(activePatients());
      actions.push(() =>
        attempt('callable:createAlert', () =>
          createAlertHandler(as({ orgId, title: 'Please call re: symptom change', body: 'Callback requested', priority: 'urgent', targetUids: [p.md], patientId: p.id }, staff(p.rn))),
        ),
      );
    }
    // Broadcasts.
    if (d === 0) actions.push(() => attempt('callable:sendBroadcast(all)', () => sendBroadcastHandler(as({ orgId, name: 'All staff', target: { kind: 'all' }, body: 'Reminder: annual competencies due Friday.', priority: 'normal' }, w.owner))));
    if (d === 2) actions.push(() => attempt('callable:sendBroadcast(team)', () => sendBroadcastHandler(as({ orgId, name: 'North team', target: { kind: 'team', teamId: w.teams.north }, body: 'IDG moved to 1pm.', priority: 'normal' }, w.don))));
    if (d === 4) actions.push(() => attempt('callable:sendBroadcast(discipline)', () => sendBroadcastHandler(as({ orgId, name: 'Aides', target: { kind: 'discipline', discipline: 'Aide' }, body: 'New glove supplier this week.', priority: 'normal' }, w.don))));

    // Visits: complete / update / cancel the day's visits (misses are left for the job).
    for (const v of visits.filter((x) => x.day === d && active.has(x.patient.id))) {
      const who = staff(v.assignee);
      if (v.fate === 'complete') actions.push(() => attempt('callable:completeVisit', () => completeVisitHandler(as({ orgId, visitId: v.id, note: 'Visit completed; patient comfortable.' }, who))));
      if (v.fate === 'cancel') actions.push(() => attempt('callable:cancelVisit', () => cancelVisitHandler(as({ orgId, visitId: v.id, reason: 'Family declined today' }, staff(v.patient.rn)))));
      if (v.fate === 'update') {
        actions.push(async () => {
          await attempt('callable:updateVisit', () => updateVisitHandler(as({ orgId, visitId: v.id, note: 'Moved 30 min later per family' }, staff(v.patient.rn))));
          await attempt('callable:completeVisit', () => completeVisitHandler(as({ orgId, visitId: v.id }, who)));
        });
      }
    }

    // Referrals → admissions.
    for (const idx of referralDays.map((rd, i) => (rd === d ? i : -1)).filter((i) => i >= 0)) {
      const intake = w.intake[idx % 2]!;
      actions.push(async () => {
        const ref = db.collection(`orgs/${orgId}/referrals`).doc();
        const storagePath = `orgs/${orgId}/referrals/${ref.id}/referral.pdf`;
        await measure('client:referral.create', () =>
          ref.set({
            fileName: 'referral.pdf', contentType: 'application/pdf', storagePath, source: 'upload', status: 'uploaded', extracted: null, error: null,
            model: null, patientId: null, uploadedBy: intake.uid, reviewedBy: null, rejectionReason: null,
            createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
          }),
        );
        await attempt('trigger:onReferralUploaded', () =>
          handleReferralUploaded(
            { name: storagePath, size: 250_000, contentType: 'application/pdf' },
            { extractor: fakeExtractor(cfg.geminiLatencyMs), loadFile: async (path: string) => ({ uri: `gs://load-test-bucket/${path}`, contentType: 'application/pdf', size: 250_000 }) },
          ),
        );
        if (idx >= 10) {
          await attempt('callable:rejectReferral', () => rejectReferralHandler(as({ orgId, referralId: ref.id, reason: 'Not hospice eligible at this time' }, intake)));
          return;
        }
        const first = `New${idx}`;
        const last = `Admit${String.fromCharCode(65 + idx)}son`;
        const acc = await attempt('callable:acceptReferral', () =>
          acceptReferralHandler(as({ orgId, referralId: ref.id, patient: patientInput(r, first, last) }, intake), { statFile: async () => ({ size: 250_000, contentType: 'application/pdf' }) }),
        );
        if (!acc) return;
        const team: TeamKey = idx % 2 === 0 ? 'north' : 'south';
        const rn = w.rns.filter((s) => s.team === team)[idx % 5]!;
        const tm = w.staff.filter((s) => s.team === team);
        const ct = {
          rn: rn.uid,
          aide: tm.filter((s) => s.kind === 'aide')[idx % 7]!.uid,
          sw: tm.filter((s) => s.kind === 'sw')[0]!.uid,
          chaplain: tm.filter((s) => s.kind === 'chap')[0]!.uid,
          md: team === 'north' ? 'md' : 'amd',
          lpn: tm.filter((s) => s.kind === 'lpn')[0]!.uid,
        };
        const careTeam = [ct.rn, ct.aide, ct.sw, ct.chaplain, ct.md];
        const adm = await attempt('callable:admitPatient', () =>
          admitPatientHandler(
            as(
              {
                orgId, patientId: acc.patientId, patient: patientInput(r, first, last), admissionDate: date, startingBenefitPeriod: 1, levelOfCare: 'routine' as const,
                careTeamUids: careTeam, consents: { electionStatement: true, hipaaNotice: true, releaseOfInformation: true, patientRights: true, polstOnFile: true },
              },
              intake,
            ),
          ),
        );
        if (!adm) return;
        const rec: PatientRec = { id: acc.patientId, first, last, team, ...ct, careTeam, channelId: adm.channelId, admissionDate: date, status: 'admitted' };
        w.patients.push(rec);
        active.add(rec.id);
        w.channels.push({ id: adm.channelId, kind: 'patient', members: [...careTeam, intake.uid], patientId: rec.id });
        await attempt('callable:setVisitFrequencies', () => setVisitFrequenciesHandler(as({ orgId, patientId: rec.id, frequencies: FREQUENCIES }, rn)));
        await pool(d < 6 ? scheduleFor(rec, d + 1) : [], 4);
        const p = (await db.doc(`orgs/${orgId}/patients/${rec.id}`).get()).data() as Patient;
        await attempt('callable:completeMilestone', () =>
          completeMilestoneHandler(as({ orgId, patientId: rec.id, key: milestoneKey('noe', p.milestones!.noeDueDate), note: 'NOE filed', effectiveDate: [date, new Date().toISOString().slice(0, 10)].sort()[0]! }, intake)),
        );
      });
    }

    // Deaths, discharges, recertifications, level-of-care changes.
    const endOfStay = (p: PatientRec, kind: 'death' | 'discharge') => async () => {
      const rn = staff(p.rn);
      const ok =
        kind === 'death'
          ? await attempt('callable:recordDeath', () => recordDeathHandler(as({ orgId, patientId: p.id, date, time: '04:40', pronouncedBy: rn.name, location: 'Home' }, rn)))
          : await attempt('callable:dischargePatient', () => dischargePatientHandler(as({ orgId, patientId: p.id, dischargeDate: date, reason: 'revocation' }, rn)));
      if (ok === undefined) return;
      active.delete(p.id);
      archived.add(p.channelId);
      p.status = kind === 'death' ? 'deceased' : 'discharged';
      // Visits later this week are in the past for the backend clock, so the RN cancels them explicitly.
      await pool(
        visits.filter((v) => v.patient.id === p.id && v.day > d).map((v) => () => attempt('callable:cancelVisit', () => cancelVisitHandler(as({ orgId, visitId: v.id, reason: 'Patient no longer on service' }, rn)))),
        4,
      );
    };
    deathPlan.forEach((p, i) => deathDays[i] === d && actions.push(endOfStay(p, 'death')));
    dischargePlan.forEach((p, i) => dischargeDays[i] === d && actions.push(endOfStay(p, 'discharge')));
    locPlan.forEach((p, i) => {
      if (locDays[i] !== d) return;
      actions.push(() =>
        attempt('callable:changeLevelOfCare', () =>
          changeLevelOfCareHandler(as({ orgId, patientId: p.id, levelOfCare: i === 0 ? 'gip' : 'continuous', effectiveDate: date, reason: 'Uncontrolled symptoms' }, staff(p.rn))),
        ),
      );
    });
    if (recertDays.includes(d)) {
      const cand = recertCandidates.find((c) => !recertDone.has(c.p.id) && active.has(c.p.id));
      if (cand) {
        recertDone.add(cand.p.id);
        actions.push(() =>
          attempt('callable:recordRecertification', () =>
            recordRecertificationHandler(
              as(
                {
                  orgId, patientId: cand.p.id, periodNumber: cand.periodNumber, certifyingPhysician: 'Dr. Medical Director', certificationDate: cand.certDate,
                  ...(cand.f2f ? { f2fDate: cand.f2fDate!, f2fBy: 'Nina Practitioner' } : {}),
                },
                staff(cand.p.md),
              ),
            ),
          ),
        );
      }
    }

    // After-hours triage (~6/day).
    for (let i = 0; i < 6 && triageLeft > 0; i++, triageLeft--) {
      const p = r.pick(activePatients());
      const u = r.next();
      const urgency = u < 0.55 ? 'routine' : u < 0.9 ? 'urgent' : 'emergent';
      const receiver = staff(p.rn);
      actions.push(async () => {
        const res = await attempt('callable:logTriageCall', () =>
          logTriageCallHandler(
            as({ orgId, patientId: p.id, callerName: 'Caregiver', callerRelationship: 'daughter', callerPhone: '555-0199', reason: 'Increased pain and restlessness overnight', symptoms: ['pain', 'agitation'], urgency, roleKey: `oncall-rn-${p.team}` }, receiver),
          ),
        );
        if (!res) return;
        let assignee = res.assignedUid ?? receiver.uid;
        if (r.chance(0.1)) {
          const other = r.pick(w.rns.filter((s) => s.team === p.team && s.uid !== assignee));
          if (await attempt('callable:assignTriageCall', () => assignTriageCallHandler(as({ orgId, callId: res.callId, assignedUid: other.uid }, receiver)))) assignee = other.uid;
          else assignee = other.uid;
        }
        if (r.chance(0.9)) {
          await attempt('callable:resolveTriageCall', () =>
            resolveTriageCallHandler(
              as(
                { orgId, callId: res.callId, disposition: r.pick(['advice_given', 'visit_made', 'md_contacted'] as const), dispositionNote: 'Gave PRN per protocol', ...(r.chance(0.3) ? { followUpTask: { title: 'Follow-up call in AM', assigneeUid: p.rn } } : {}) },
                staff(assignee),
              ),
            ),
          );
        }
      });
    }

    // Handoffs by all 10 RNs, searches, channel summaries.
    for (const rn of w.rns) actions.push(() => attempt('callable:generateHandoff', () => generateHandoffHandler(as({ orgId }, rn), { generator: gen })));
    for (let i = 0; i < 7 && searchesLeft > 0; i++, searchesLeft--) {
      const who = r.pick(w.staff.filter((s) => s.role !== 'viewer'));
      const q = r.next();
      const term = q < 0.4 ? r.pick(['pain', 'morphine', 'family', 'oxygen']) : q < 0.7 ? r.pick(w.patients).last : r.pick(['xylophone', 'zzqv', 'tracheostomy']);
      actions.push(() => attempt(`callable:searchMessages(${q < 0.4 ? 'common' : q < 0.7 ? 'name' : 'rare'})`, () => searchMessagesHandler(as({ orgId, query: term }, who))));
    }
    for (let i = 0; i < 2; i++) {
      const c = r.pick(patientCh);
      const who = staff(c.members[0]!);
      actions.push(() => attempt('callable:summarizeChannel', () => summarizeChannelHandler(as({ orgId, channelId: c.id, sinceHours: 72 }, who), { generator: gen })));
    }

    // Tasks: complete ~25 open assigned tasks, create a few manual ones.
    {
      const open = await db.collection(`orgs/${orgId}/tasks`).where('status', '==', 'open').limit(400).get();
      const assigned = r.shuffle(open.docs.filter((t) => (t.data() as Task).assigneeUid)).slice(0, 25);
      for (const t of assigned) {
        const task = t.data() as Task;
        actions.push(() => attempt('callable:updateTask(done)', () => updateTaskHandler(as({ orgId, taskId: t.id, status: 'done' as const }, staff(task.assigneeUid!)))));
      }
      for (let i = 0; i < 4; i++) {
        const p = r.pick(activePatients());
        actions.push(() =>
          attempt('callable:createTask', () => createTaskHandler(as({ orgId, title: 'Order hospital bed', patientId: p.id, assigneeUid: p.aide, dueDate: date, priority: 'normal' as const }, staff(p.rn)))),
        );
      }
    }
    // Bereavement follow-ups.
    {
      const plans = await db.collection(`orgs/${orgId}/bereavementPlans`).where('status', '==', 'active').limit(50).get();
      for (const pl of r.shuffle([...plans.docs]).slice(0, 3)) {
        const plan = pl.data() as BereavementPlan;
        const c = plan.contacts.find((x) => x.status === 'pending');
        if (!c) continue;
        actions.push(() => attempt('callable:updateBereavementContact', () => updateBereavementContactHandler(as({ orgId, planId: pl.id, contactId: c.id, status: 'done' as const, note: 'Spoke with family' }, staff('bereave')))));
      }
    }
    actions.push(() => attempt('callable:computeMetrics', () => computeMetricsHandler(as({ orgId }, w.owner))));

    // IDG: North on day 3, South on day 4.
    if (d === 2 || d === 3) actions.push(() => idgFlow(d === 2 ? 'north' : 'south', date));

    await pool(r.shuffle(actions), C);
    await pump.drain();
    await dispatchEscalations(C);

    // Scheduled jobs for this simulated day.
    await timeJob('job:checkDeadlines', () => runDeadlineChecks(new Date(dayStart(d) + 11 * HOUR_MS), { force: true }));
    await timeJob('job:computeDailyMetrics', () => runDailyMetrics(new Date(dayStart(d + 1) + 5 * HOUR_MS), { force: true }));
    for (let t = 1; t <= 48; t++) await timeJob('job:checkMissedVisits', () => runMissedVisitChecks(new Date(dayStart(d) + t * 30 * 60_000)));
    await pump.drain();
    await dispatchEscalations(C);
    await pump.drain();
  }

  if (cfg.purge) {
    progress('message purge with a 60-day lifespan');
    await db.doc(`orgs/${orgId}`).update({ messageLifespanDays: 60 });
    await timeJob('job:purgeExpiredMessages', () => runMessagePurge(new Date()));
  }
  pump.stop();
  return [...jobs.values()];

  async function idgFlow(team: TeamKey, date: string): Promise<void> {
    const pts = activePatients().filter((p) => p.team === team);
    const attendees = [...new Set([...w.staff.filter((s) => s.team === team && ['rn', 'sw', 'chap'].includes(s.kind)).map((s) => s.uid), 'md', 'amd', 'np', w.don.uid])];
    const created = await attempt(`callable:createIdgMeeting`, () =>
      createIdgMeetingHandler(as({ orgId, title: `IDG ${team}`, scheduledAt: new Date().toISOString(), teamId: w.teams[team], attendeeUids: attendees, patientIds: pts.map((p) => p.id) }, w.don)),
    );
    if (!created) return;
    const meetingId = created.id;
    // Prep: one bulk call (first 25), then the rest one patient at a time, concurrently.
    await attempt('callable:generateIdgPrep(bulk)', () => generateIdgPrepHandler(as({ orgId, meetingId }, w.don), { generator: gen }));
    await pool(pts.slice(25).map((p) => () => attempt('callable:generateIdgPrep(single)', () => generateIdgPrepHandler(as({ orgId, meetingId, patientId: p.id }, staff(p.rn)), { generator: gen }))), C);
    // Notes are written concurrently by each patient's RN during the meeting.
    await pool(
      pts.map((p) => () =>
        attempt('callable:saveIdgNote', () =>
          saveIdgNoteHandler(
            as(
              {
                orgId, meetingId, patientId: p.id, summary: messageBody(r), planOfCareChanges: 'Increase aide visits to 5/wk', goalsOfCare: 'Comfort at home',
                actionItems: [{ title: 'Update POC', assigneeUid: p.rn, dueDate: date }, ...(r.chance(0.5) ? [{ title: 'Family meeting', assigneeUid: p.sw, dueDate: date }] : [])],
                reviewed: r.chance(0.9),
              },
              staff(p.rn),
            ),
          ),
        ),
      ),
      C,
    );
    await attempt('callable:completeIdgMeeting', () => completeIdgMeetingHandler(as({ orgId, meetingId }, w.don)));
  }
}

