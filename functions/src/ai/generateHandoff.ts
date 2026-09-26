/**
 * `generateHandoff` — shift handoff for the caller's care-team patients: the
 * last `sinceHours` (default 12) of patient-channel messages, triage calls and
 * visits (plus visits in the next 24 h), open tasks and due deadlines.
 * Returned only (never stored). Viewers may call it.
 */
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { todayInTimeZone } from '../domain/dates';
import { writeAudit } from '../lib/audit';
import { AI_DISCLAIMER, CLINICAL_SYSTEM_RULES } from '../lib/aiText';
import { parse, requireOrg } from '../lib/context';
import { colRef, getDocData, getMany, paths } from '../lib/db';
import { id } from '../lib/schemas';
import type { AiTextResult, GenerateHandoffRequest, Org, Patient } from '../shared/types';
import { formatPatientActivity, MAX_AI_MESSAGES } from './format';
import { loadPatientActivity } from './patientActivity';
import { generateOrThrow, type AiDeps } from './run';

export const DEFAULT_HANDOFF_HOURS = 12;
export const MAX_HANDOFF_PATIENTS = 20;

const schema = z.object({
  orgId: id,
  sinceHours: z.number().int().min(1).max(72).default(DEFAULT_HANDOFF_HOURS),
  patientIds: z.array(id).min(1).max(MAX_HANDOFF_PATIENTS).optional(),
});

export const HANDOFF_SYSTEM_PROMPT = `${CLINICAL_SYSTEM_RULES}

Task: write a shift handoff for a hospice clinician covering the patients below.
For each patient, in the order given, write a short section headed with the patient's name:
- Since last shift: what changed (symptoms, visits, triage calls, decisions), with times when stated
- Watch for: urgent or unresolved issues, overdue or due-soon deadlines, open tasks
- Upcoming: scheduled visits in the next 24 hours
If a patient had no activity in the window, write "No new activity documented." for that patient.
Do not rank or compare patients' prognoses. Do not invent vitals, doses or events.`;

export async function generateHandoffHandler(request: CallableRequest<GenerateHandoffRequest>, deps: AiDeps = {}): Promise<AiTextResult> {
  const input = parse(schema, request.data);
  const ctx = requireOrg(request, input.orgId);

  let patients: Array<{ id: string; p: Patient }>;
  if (input.patientIds) {
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
    patients = snap.docs.map((d) => ({ id: d.id, p: d.data() as Patient })).filter(({ p }) => p.status === 'admitted');
  }
  patients.sort((a, b) => `${a.p.lastName},${a.p.firstName}`.localeCompare(`${b.p.lastName},${b.p.firstName}`));
  const omitted = Math.max(0, patients.length - MAX_HANDOFF_PATIENTS);
  patients = patients.slice(0, MAX_HANDOFF_PATIENTS);

  let result: AiTextResult;
  let messageCount = 0;
  if (patients.length === 0) {
    result = { text: 'You have no admitted care-team patients to hand off.', model: 'none', disclaimer: AI_DISCLAIMER };
  } else {
    const org = await getDocData<Org>(paths.org(ctx.orgId));
    const tz = org?.timezone ?? 'UTC';
    const now = Date.now();
    const perPatientMessages = Math.max(10, Math.floor(MAX_AI_MESSAGES / patients.length));
    const window = {
      sinceMs: now - input.sinceHours * 3_600_000,
      visitsUntilMs: now + 24 * 3_600_000,
      today: todayInTimeZone(new Date(now), tz),
      leadDays: org?.deadlineLeadDays ?? 3,
      messageLimit: perPatientMessages,
      includeEvents: false,
    };
    const sections: string[] = [];
    let budget = MAX_AI_MESSAGES;
    for (const { id: pid, p } of patients) {
      const activity = await loadPatientActivity(ctx.orgId, pid, p, { ...window, messageLimit: Math.min(perPatientMessages, budget) });
      budget -= activity.messages.length;
      messageCount += activity.messages.length;
      sections.push(formatPatientActivity(activity, tz, { includeEvents: false }));
    }
    const prompt =
      `Time zone: ${tz}. Handoff window: last ${input.sinceHours} hours; today is ${window.today}.\n` +
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
    metadata: { model: result.model, patients: patients.length, omittedPatients: omitted, messages: messageCount, sinceHours: input.sinceHours },
  });
  return result;
}

export const generateHandoff = onCall({ timeoutSeconds: 180, memory: '512MiB' }, (req: CallableRequest<GenerateHandoffRequest>) =>
  generateHandoffHandler(req),
);
