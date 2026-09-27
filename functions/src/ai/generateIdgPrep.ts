/**
 * `generateIdgPrep` — for each agenda patient (or one `patientId`, or a batch of
 * `patientIds`), summarizes the last 15 days of timeline events, visits, open
 * tasks, triage calls and patient-channel messages with Gemini and stores it in
 * `idgMeetings/{id}/notes/{patientId}_aiPrep` (text ends with the AI disclaimer).
 *
 * v3 (H3): allowed for admins and, per patient, members of that patient's care
 * team (being an attendee or the meeting's creator is not enough on its own).
 * Clinical roles only; completed (locked) meetings are rejected. Rate limited
 * (10 calls/min per user). `skipFreshHours` skips patients with recent prep.
 * The prep lives in the notes subcollection (staff-only, like the meeting), so
 * it no longer grows the meeting doc or contends with note saves.
 */
import { Timestamp } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { todayInTimeZone } from '../domain/dates';
import { writeAudit } from '../lib/audit';
import { AI_DISCLAIMER, CLINICAL_SYSTEM_RULES, describeAiError, getDefaultTextGenerator, isFatalAiError, toHttpsError } from '../lib/aiText';
import { tsMillis } from '../lib/care';
import { mapLimit } from '../lib/concurrency';
import { CLINICAL_ROLES, parse, requireOrg } from '../lib/context';
import { colRef, getDocData, getMany, paths } from '../lib/db';
import { enforceRateLimit } from '../lib/rateLimit';
import { id } from '../lib/schemas';
import {
  idgAiPrepNoteId,
  type GenerateIdgPrepRequest,
  type GenerateIdgPrepResponse,
  type IdgAiPrepNote,
  type IdgMeeting,
  type Org,
  type Patient,
} from '../shared/types';
import { capPrompt, formatPatientActivity, MAX_AI_MESSAGES } from './format';
import { loadPatientActivity } from './patientActivity';
import type { AiDeps } from './run';

export type { GenerateIdgPrepResponse };

export const IDG_PREP_DAYS = 15;
/** Patients processed per call (one model call each); clients loop over batches for the rest. */
export const MAX_IDG_PREP_PATIENTS = 25;
/** Model calls in flight per request (keeps Vertex quota use modest). */
export const IDG_PREP_CONCURRENCY = 4;

const schema = z.object({
  orgId: id,
  meetingId: id,
  patientId: id.optional(),
  patientIds: z.array(id).min(1).max(MAX_IDG_PREP_PATIENTS).optional(),
  skipFreshHours: z.number().min(0).max(24 * 30).optional(),
});

export const IDG_PREP_SYSTEM_PROMPT = `${CLINICAL_SYSTEM_RULES}

Task: prepare an interdisciplinary group (IDG) meeting prep note for ONE hospice patient from the last ${IDG_PREP_DAYS} days of records.
Structure:
- Status and level of care
- Changes in the period (condition, symptoms, events, level-of-care changes) with dates
- Visits by discipline (completed / missed / cancelled) and notable findings as documented
- After-hours / triage calls and their dispositions
- Open tasks and overdue or upcoming regulatory deadlines
- Items for the team to discuss (only issues evident in the records; label anything uncertain)
Keep it under 300 words.`;

/** A prep that was generated but could not be stored: not an AI failure. */
class PrepStoreError extends Error {
  constructor(readonly original: unknown) {
    super('store failed');
  }
}

export function idgNotesPath(orgId: string, meetingId: string): string {
  return `${paths.org(orgId)}/idgMeetings/${meetingId}/notes`;
}

export async function generateIdgPrepHandler(request: CallableRequest<GenerateIdgPrepRequest>, deps: AiDeps = {}): Promise<GenerateIdgPrepResponse> {
  const input = parse(schema, request.data);
  const ctx = await requireOrg(request, input.orgId, CLINICAL_ROLES);

  const meetingPath = `${paths.org(ctx.orgId)}/idgMeetings/${input.meetingId}`;
  const notesPath = idgNotesPath(ctx.orgId, input.meetingId);
  const meeting = await getDocData<IdgMeeting>(meetingPath);
  if (!meeting) throw new HttpsError('not-found', 'Meeting not found.');
  if (meeting.status === 'completed') throw new HttpsError('failed-precondition', 'This meeting is completed and locked.');

  const agenda = meeting.patientIds ?? [];
  const requested = input.patientIds ?? (input.patientId ? [input.patientId] : null);
  if (requested && requested.some((pid) => !agenda.includes(pid))) throw new HttpsError('invalid-argument', 'That patient is not on this meeting agenda.');
  const wanted = requested ? [...new Set(requested)] : agenda.slice(0, MAX_IDG_PREP_PATIENTS);
  if (wanted.length === 0) throw new HttpsError('failed-precondition', 'The meeting agenda is empty.');

  // H3: admins, or the patient's care team. Attendance alone does not open a patient's record.
  const docs = await getMany<Patient>(wanted.map((pid) => paths.patient(ctx.orgId, pid)));
  const allowed = (p: Patient) => ctx.role === 'admin' || (p.careTeamUids ?? []).includes(ctx.uid);
  let patients = wanted.flatMap((pid) => {
    const p = docs.get(paths.patient(ctx.orgId, pid));
    return p && allowed(p) ? [{ id: pid, p }] : [];
  });
  if (patients.length === 0) {
    throw new HttpsError('permission-denied', 'Only admins and the patient’s care team can generate IDG prep.');
  }
  await enforceRateLimit(ctx.orgId, ctx.uid, 'generateIdgPrep');

  const skipped: string[] = [];
  if (input.skipFreshHours !== undefined) {
    const freshSince = Date.now() - input.skipFreshHours * 3_600_000;
    const existing = await getMany<IdgAiPrepNote>(patients.map(({ id: pid }) => `${notesPath}/${idgAiPrepNoteId(pid)}`));
    patients = patients.filter(({ id: pid }) => {
      const prep = existing.get(`${notesPath}/${idgAiPrepNoteId(pid)}`);
      const fresh = !!prep && tsMillis(prep.generatedAt) >= freshSince;
      if (fresh) skipped.push(pid);
      return !fresh;
    });
  }

  const org = await getDocData<Org>(paths.org(ctx.orgId));
  const tz = org?.timezone ?? 'UTC';
  const now = Date.now();
  const window = {
    sinceMs: now - IDG_PREP_DAYS * 86_400_000,
    visitsUntilMs: now + 7 * 86_400_000,
    today: todayInTimeZone(new Date(now), tz),
    leadDays: Math.max(org?.deadlineLeadDays ?? 3, 14),
    messageLimit: MAX_AI_MESSAGES,
    includeEvents: true,
  };
  const generator = deps.generator ?? getDefaultTextGenerator();

  // The first patient runs alone, so a setup error (auth, missing model, quota) stops the call after
  // one model request. The rest are generated IDG_PREP_CONCURRENCY at a time. Each result is stored as
  // soon as it is ready (so progress survives a timeout) in its own notes doc: there is no transaction
  // on the meeting doc, so saves don't contend. Only a completed (locked) meeting stops the loop.
  const outcome: Array<'generated' | 'failed' | undefined> = new Array(patients.length);
  let model: string | null = null;
  let lastAiError: unknown = null;
  let lastStoreError: unknown = null;
  let locked: HttpsError | null = null;
  const prepOne = async ({ id: pid, p }: (typeof patients)[number], i: number): Promise<void> => {
    if (locked) return;
    if (lastAiError !== null && isFatalAiError(lastAiError)) {
      outcome[i] = 'failed';
      return;
    }
    try {
      const activity = await loadPatientActivity(ctx.orgId, pid, p, window);
      const prompt = capPrompt(
        `Time zone: ${tz}. Review window: last ${IDG_PREP_DAYS} days; today is ${window.today}.\n\n` +
          formatPatientActivity(activity, tz, { includeEvents: true }),
      );
      const out = await generator.generate({ systemInstruction: IDG_PREP_SYSTEM_PROMPT, prompt, maxOutputTokens: 1024 });
      model = out.model;
      const current = await getDocData<IdgMeeting>(meetingPath);
      if (!current || current.status === 'completed') {
        locked ??= new HttpsError('failed-precondition', 'This meeting was completed while the prep was generated.');
        return;
      }
      const doc: IdgAiPrepNote = {
        kind: 'ai_prep',
        meetingId: input.meetingId,
        patientId: pid,
        text: `${out.text}\n\n${AI_DISCLAIMER}`,
        model: out.model,
        generatedBy: ctx.uid,
        generatedAt: Timestamp.now(),
      };
      try {
        await colRef(notesPath).doc(idgAiPrepNoteId(pid)).set(doc as unknown as Record<string, unknown>);
      } catch (e) {
        throw new PrepStoreError(e);
      }
      outcome[i] = 'generated';
    } catch (e) {
      outcome[i] = 'failed';
      if (e instanceof PrepStoreError) {
        // Storage or contention problems are not AI failures; they are reported separately.
        lastStoreError = e.original;
        logger.error('idg prep store failed', {
          feature: 'generateIdgPrep', orgId: ctx.orgId, meetingId: input.meetingId,
          code: (e.original as { code?: unknown })?.code ?? 'unknown',
        });
        return;
      }
      lastAiError = e;
      logger.error('idg prep generation failed', { feature: 'generateIdgPrep', orgId: ctx.orgId, meetingId: input.meetingId, ...describeAiError(e).logFields });
    }
  };
  if (patients.length > 0) {
    await prepOne(patients[0]!, 0);
    await mapLimit(patients.slice(1), IDG_PREP_CONCURRENCY, (pt, i) => prepOne(pt, i + 1));
  }
  const generated = patients.filter((_, i) => outcome[i] === 'generated').map(({ id: pid }) => pid);
  const failed = patients.filter((_, i) => outcome[i] === 'failed').map(({ id: pid }) => pid);

  await writeAudit(ctx.orgId, {
    actorUid: ctx.uid,
    action: 'idg.ai_prep',
    resourceType: 'idgMeeting',
    resourceId: input.meetingId,
    patientId: input.patientId ?? null,
    metadata: { model, generated: generated.length, failed: failed.length, ...(skipped.length ? { skipped: skipped.length } : {}) },
  });

  if (locked) throw locked;
  if (generated.length === 0 && lastAiError !== null) throw toHttpsError(describeAiError(lastAiError));
  if (generated.length === 0 && lastStoreError !== null) {
    throw new HttpsError('aborted', 'The prep was generated but could not be saved. Try again.');
  }
  return {
    generatedPatientIds: generated,
    failedPatientIds: failed,
    ...(input.skipFreshHours !== undefined ? { skippedPatientIds: skipped } : {}),
  };
}

export const generateIdgPrep = onCall({ timeoutSeconds: 540, memory: '512MiB' }, (req: CallableRequest<GenerateIdgPrepRequest>) =>
  generateIdgPrepHandler(req),
);
