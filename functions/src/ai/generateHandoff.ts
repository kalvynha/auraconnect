/**
 * `generateHandoff` — shift handoff: the last `sinceHours` (default 12) of
 * patient-channel messages, triage calls, visits (plus visits in the next 24 h),
 * timeline events, open tasks and due deadlines. Returned only (never stored).
 * Viewers may call it. Rate limited (10 calls/min per user).
 *
 * v3 (O4) `scope`:
 *  - `care_team` (default): the caller's care-team patients who are admitted, or
 *    who died or were discharged within the window.
 *  - `my_activity` ("my overnight activity"): patients from triage calls the caller
 *    received or was assigned in the window and visits they completed in the window
 *    (any status), plus triage calls not linked to a patient.
 */
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { todayInTimeZone } from '../domain/dates';
import { writeAudit } from '../lib/audit';
import { AI_DISCLAIMER, CLINICAL_SYSTEM_RULES } from '../lib/aiText';
import { parse, requireOrg } from '../lib/context';
import { mapLimit } from '../lib/concurrency';
import { colRef, getDocData, getMany, paths } from '../lib/db';
import { enforceRateLimit } from '../lib/rateLimit';
import { Timestamp } from 'firebase-admin/firestore';
import { id } from '../lib/schemas';
import type { AiTextResult, GenerateHandoffRequest, Org, Patient, TriageCall, Visit } from '../shared/types';
import { clip, formatInstant, formatPatientActivity, MAX_AI_FIELD_CHARS, MAX_AI_MESSAGES, millisOf } from './format';
import { loadPatientActivity } from './patientActivity';
import { generateOrThrow, type AiDeps } from './run';

export const DEFAULT_HANDOFF_HOURS = 12;
export const MAX_HANDOFF_PATIENTS = 20;
/** Patients whose activity is loaded in parallel (5 small queries each). */
export const HANDOFF_LOAD_CONCURRENCY = 5;

const schema = z.object({
  orgId: id,
  sinceHours: z.number().int().min(1).max(72).default(DEFAULT_HANDOFF_HOURS),
  patientIds: z.array(id).min(1).max(MAX_HANDOFF_PATIENTS).optional(),
  scope: z.enum(['care_team', 'my_activity']).default('care_team'),
});

/** Max docs read per "my activity" query (triage received, triage assigned, visits completed). */
export const MY_ACTIVITY_QUERY_LIMIT = 100;

/** True for admitted patients, and for patients whose death or discharge falls on/after `sinceDate`. */
export function inHandoffWindow(p: Pick<Patient, 'status' | 'death' | 'dischargeDate'>, sinceDate: string): boolean {
  if (p.status === 'admitted') return true;
  if (p.status === 'deceased') return !!p.death?.date && p.death.date >= sinceDate;
  if (p.status === 'discharged') return !!p.dischargeDate && p.dischargeDate >= sinceDate;
  return false;
}

interface MyActivity {
  patientIds: string[];
  unlinkedCalls: TriageCall[];
}

/** Triage calls the caller received or was assigned, and visits they completed, since `sinceMs`. */
export async function loadMyActivity(orgId: string, uid: string, sinceMs: number): Promise<MyActivity> {
  const since = Timestamp.fromMillis(sinceMs);
  const org = paths.org(orgId);
  const [received, assigned, visits] = await Promise.all([
    colRef(`${org}/triageCalls`).where('receivedBy', '==', uid).where('receivedAt', '>=', since).limit(MY_ACTIVITY_QUERY_LIMIT).get(),
    colRef(`${org}/triageCalls`).where('assignedUid', '==', uid).where('receivedAt', '>=', since).limit(MY_ACTIVITY_QUERY_LIMIT).get(),
    colRef(`${org}/visits`).where('completedBy', '==', uid).where('completedAt', '>=', since).limit(MY_ACTIVITY_QUERY_LIMIT).get(),
  ]);
  const ids = new Set<string>();
  const unlinked = new Map<string, TriageCall>();
  for (const d of [...received.docs, ...assigned.docs]) {
    const c = d.data() as TriageCall;
    if (c.patientId) ids.add(c.patientId);
    else unlinked.set(d.id, c);
  }
  for (const d of visits.docs) ids.add((d.data() as Visit).patientId);
  const unlinkedCalls = [...unlinked.values()].sort((a, b) => (millisOf(a.receivedAt) ?? 0) - (millisOf(b.receivedAt) ?? 0));
  return { patientIds: [...ids], unlinkedCalls };
}

export function formatUnlinkedCalls(calls: readonly TriageCall[], tz: string): string {
  const lines = ['### Triage calls not linked to a patient'];
  for (const c of calls) {
    const ms = millisOf(c.receivedAt);
    lines.push(
      `  - ${ms === null ? 'unknown time' : formatInstant(ms, tz)} ${c.urgency}, ${c.status}; caller ${clip(c.callerName, 100)}` +
        `${c.callerRelationship ? ` (${clip(c.callerRelationship, 60)})` : ''}: ${clip(c.reason, MAX_AI_FIELD_CHARS)}` +
        (c.disposition ? `; disposition: ${c.disposition}` : '') +
        (c.dispositionNote ? ` (${clip(c.dispositionNote, MAX_AI_FIELD_CHARS)})` : ''),
    );
  }
  return lines.join('\n');
}

export const HANDOFF_SYSTEM_PROMPT = `${CLINICAL_SYSTEM_RULES}

Task: write a shift handoff for a hospice clinician covering the patients below.
For each patient, in the order given, write a short section headed with the patient's name:
- Since last shift: what changed (symptoms, visits, triage calls, decisions), with times when stated
- Watch for: urgent or unresolved issues, overdue or due-soon deadlines, open tasks
- Upcoming: scheduled visits in the next 24 hours
If a patient had no activity in the window, write "No new activity documented." for that patient.
A patient whose status is deceased or discharged had that event in the window: say so first in their section.
If there is a "Triage calls not linked to a patient" section, summarize those calls last under that heading.
Do not rank or compare patients' prognoses. Do not invent vitals, doses or events.`;

export async function generateHandoffHandler(request: CallableRequest<GenerateHandoffRequest>, deps: AiDeps = {}): Promise<AiTextResult> {
  const input = parse(schema, request.data);
  const ctx = await requireOrg(request, input.orgId);
  await enforceRateLimit(ctx.orgId, ctx.uid, 'generateHandoff');
  const org = await getDocData<Org>(paths.org(ctx.orgId));
  const tz = org?.timezone ?? 'UTC';
  const now = Date.now();
  const sinceMs = now - input.sinceHours * 3_600_000;
  const sinceDate = todayInTimeZone(new Date(sinceMs), tz);

  let patients: Array<{ id: string; p: Patient }>;
  let unlinkedCalls: TriageCall[] = [];
  if (input.scope === 'my_activity' && !input.patientIds) {
    const mine = await loadMyActivity(ctx.orgId, ctx.uid, sinceMs);
    unlinkedCalls = mine.unlinkedCalls;
    const docs = await getMany<Patient>(mine.patientIds.map((pid) => paths.patient(ctx.orgId, pid)));
    patients = mine.patientIds.flatMap((pid) => {
      const p = docs.get(paths.patient(ctx.orgId, pid));
      return p ? [{ id: pid, p }] : [];
    });
  } else if (input.patientIds) {
    const docs = await getMany<Patient>(input.patientIds.map((pid) => paths.patient(ctx.orgId, pid)));
    patients = input.patientIds.flatMap((pid) => {
      const p = docs.get(paths.patient(ctx.orgId, pid));
      return p ? [{ id: pid, p }] : [];
    });
    if (patients.length !== input.patientIds.length) throw new HttpsError('not-found', 'Patient not found.');
    if (ctx.role !== 'admin' && patients.some(({ p }) => !(p.careTeamUids ?? []).includes(ctx.uid))) {
      throw new HttpsError('permission-denied', 'Handoffs cover only your care-team patients.');
    }
  } else {
    const snap = await colRef(paths.patients(ctx.orgId)).where('careTeamUids', 'array-contains', ctx.uid).limit(200).get();
    patients = snap.docs.map((d) => ({ id: d.id, p: d.data() as Patient })).filter(({ p }) => inHandoffWindow(p, sinceDate));
  }
  patients.sort((a, b) => `${a.p.lastName},${a.p.firstName}`.localeCompare(`${b.p.lastName},${b.p.firstName}`));
  const omitted = Math.max(0, patients.length - MAX_HANDOFF_PATIENTS);
  patients = patients.slice(0, MAX_HANDOFF_PATIENTS);

  let result: AiTextResult;
  let messageCount = 0;
  if (patients.length === 0 && unlinkedCalls.length === 0) {
    const text = input.scope === 'my_activity'
      ? `No triage calls or completed visits of yours in the last ${input.sinceHours} hours.`
      : 'You have no admitted care-team patients to hand off.';
    result = { text, model: 'none', disclaimer: AI_DISCLAIMER };
  } else {
    const perPatientMessages = Math.max(10, Math.floor(MAX_AI_MESSAGES / Math.max(1, patients.length)));
    const window = {
      sinceMs,
      visitsUntilMs: now + 24 * 3_600_000,
      today: todayInTimeZone(new Date(now), tz),
      leadDays: org?.deadlineLeadDays ?? 3,
      messageLimit: perPatientMessages,
      includeEvents: true,
    };
    // Patients load in parallel. Each gets perPatientMessages; since patients ≤ MAX_HANDOFF_PATIENTS,
    // patients × perPatientMessages ≤ MAX_AI_MESSAGES, so the overall budget below never binds, and it
    // is applied in patient order afterwards (keeping the newest messages) exactly as a sequential loop would.
    const activities = await mapLimit(patients, HANDOFF_LOAD_CONCURRENCY, ({ id: pid, p }) =>
      loadPatientActivity(ctx.orgId, pid, p, { ...window, messageLimit: perPatientMessages }),
    );
    const sections: string[] = [];
    let budget = MAX_AI_MESSAGES;
    for (const activity of activities) {
      const keep = Math.max(0, Math.min(activity.messages.length, budget));
      const trimmed = keep === activity.messages.length ? activity : { ...activity, messages: activity.messages.slice(activity.messages.length - keep) };
      budget -= trimmed.messages.length;
      messageCount += trimmed.messages.length;
      sections.push(formatPatientActivity(trimmed, tz, { includeEvents: true }));
    }
    if (unlinkedCalls.length) sections.push(formatUnlinkedCalls(unlinkedCalls, tz));
    const prompt =
      `Time zone: ${tz}. Handoff window: last ${input.sinceHours} hours; today is ${window.today}.\n` +
      (input.scope === 'my_activity' ? 'Scope: the clinician\'s own overnight activity (triage calls they took and visits they completed).\n' : '') +
      (omitted ? `Note: ${omitted} additional patient(s) were omitted because of size limits; say so at the end.\n` : '') +
      `\n${sections.join('\n\n')}`;
    const out = await generateOrThrow(deps, 'generateHandoff', ctx.orgId, { systemInstruction: HANDOFF_SYSTEM_PROMPT, prompt, maxOutputTokens: 4096 });
    result = { text: out.text, model: out.model, disclaimer: AI_DISCLAIMER };
  }

  await writeAudit(ctx.orgId, {
    actorUid: ctx.uid,
    action: 'ai.handoff',
    resourceType: 'handoff',
    resourceId: ctx.uid,
    metadata: {
      model: result.model, patients: patients.length, omittedPatients: omitted, messages: messageCount, sinceHours: input.sinceHours,
      scope: input.scope, unlinkedCalls: unlinkedCalls.length,
    },
  });
  return result;
}

export const generateHandoff = onCall({ timeoutSeconds: 180, memory: '512MiB' }, (req: CallableRequest<GenerateHandoffRequest>) =>
  generateHandoffHandler(req),
);
