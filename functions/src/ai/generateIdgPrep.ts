/**
 * `generateIdgPrep` — for each agenda patient (or one `patientId`), summarizes
 * the last 15 days of timeline events, visits, open tasks, triage calls and
 * patient-channel messages with Gemini and stores it in
 * `idgMeetings/{id}.aiPrep[patientId]` (text ends with the AI disclaimer).
 *
 * Allowed for clinical roles who are an attendee, an admin, or on the
 * patient's care team (same audience as `saveIdgNote`). Completed (locked)
 * meetings are rejected.
 */
import { FieldValue } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { todayInTimeZone } from '../domain/dates';
import { writeAudit } from '../lib/audit';
import { AI_DISCLAIMER, CLINICAL_SYSTEM_RULES, describeAiError, getDefaultTextGenerator, isFatalAiError, toHttpsError } from '../lib/aiText';
import { CLINICAL_ROLES, parse, requireOrg } from '../lib/context';
import { db, docRef, getDocData, getMany, paths } from '../lib/db';
import { id } from '../lib/schemas';
import type { GenerateIdgPrepRequest, IdgMeeting, Org, Patient } from '../shared/types';
import { capPrompt, formatPatientActivity, MAX_AI_MESSAGES } from './format';
import { loadPatientActivity } from './patientActivity';
import type { AiDeps } from './run';

export const IDG_PREP_DAYS = 15;
/** Patients processed per call (one model call each); call again with `patientId` for the rest. */
export const MAX_IDG_PREP_PATIENTS = 25;

/** Not in shared/types (contract gap) — returned so clients can report partial failures. */
export interface GenerateIdgPrepResponse {
  generatedPatientIds: string[];
  failedPatientIds: string[];
}

const schema = z.object({ orgId: id, meetingId: id, patientId: id.optional() });

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

export async function generateIdgPrepHandler(request: CallableRequest<GenerateIdgPrepRequest>, deps: AiDeps = {}): Promise<GenerateIdgPrepResponse> {
  const input = parse(schema, request.data);
  const ctx = requireOrg(request, input.orgId, CLINICAL_ROLES);

  const meetingPath = `${paths.org(ctx.orgId)}/idgMeetings/${input.meetingId}`;
  const meeting = await getDocData<IdgMeeting>(meetingPath);
  if (!meeting) throw new HttpsError('not-found', 'Meeting not found.');
  if (meeting.status === 'completed') throw new HttpsError('failed-precondition', 'This meeting is completed and locked.');

  const agenda = meeting.patientIds ?? [];
  if (input.patientId && !agenda.includes(input.patientId)) throw new HttpsError('invalid-argument', 'That patient is not on this meeting agenda.');
  const wanted = input.patientId ? [input.patientId] : agenda.slice(0, MAX_IDG_PREP_PATIENTS);
  if (wanted.length === 0) throw new HttpsError('failed-precondition', 'The meeting agenda is empty.');

  const docs = await getMany<Patient>(wanted.map((pid) => paths.patient(ctx.orgId, pid)));
  const privileged = ctx.role === 'admin' || (meeting.attendeeUids ?? []).includes(ctx.uid);
  const patients = wanted.flatMap((pid) => {
    const p = docs.get(paths.patient(ctx.orgId, pid));
    if (!p) return [];
    if (!privileged && !(p.careTeamUids ?? []).includes(ctx.uid)) return [];
    return [{ id: pid, p }];
  });
  if (patients.length === 0) {
    throw new HttpsError('permission-denied', 'Only attendees, admins and care-team members can generate IDG prep.');
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

  const generated: string[] = [];
  const failed: string[] = [];
  let model: string | null = null;
  let lastError: unknown = null;
  let locked: HttpsError | null = null;
  for (const { id: pid, p } of patients) {
    if (lastError !== null && isFatalAiError(lastError)) {
      failed.push(pid);
      continue;
    }
    try {
      const activity = await loadPatientActivity(ctx.orgId, pid, p, window);
      const prompt = capPrompt(
        `Time zone: ${tz}. Review window: last ${IDG_PREP_DAYS} days; today is ${window.today}.\n\n` +
          formatPatientActivity(activity, tz, { includeEvents: true }),
      );
      const out = await generator.generate({ systemInstruction: IDG_PREP_SYSTEM_PROMPT, prompt, maxOutputTokens: 1024 });
      model = out.model;
      const ref = docRef(meetingPath);
      await db().runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists || (snap.data() as IdgMeeting).status === 'completed') {
          throw new HttpsError('failed-precondition', 'This meeting was completed while the prep was generated.');
        }
        tx.update(ref, {
          [`aiPrep.${pid}`]: { text: `${out.text}\n\n${AI_DISCLAIMER}`, model: out.model, generatedAt: FieldValue.serverTimestamp() },
        });
      });
      generated.push(pid);
    } catch (e) {
      if (e instanceof HttpsError) {
        locked = e;
        break;
      }
      lastError = e;
      failed.push(pid);
      logger.error('idg prep generation failed', { feature: 'generateIdgPrep', orgId: ctx.orgId, meetingId: input.meetingId, ...describeAiError(e).logFields });
    }
  }

  await writeAudit(ctx.orgId, {
    actorUid: ctx.uid,
    action: 'idg.ai_prep',
    resourceType: 'idgMeeting',
    resourceId: input.meetingId,
    patientId: input.patientId ?? null,
    metadata: { model, generated: generated.length, failed: failed.length },
  });

  if (locked) throw locked;
  if (generated.length === 0 && lastError !== null) throw toHttpsError(describeAiError(lastError));
  return { generatedPatientIds: generated, failedPatientIds: failed };
}

export const generateIdgPrep = onCall({ timeoutSeconds: 540, memory: '512MiB' }, (req: CallableRequest<GenerateIdgPrepRequest>) =>
  generateIdgPrepHandler(req),
);
