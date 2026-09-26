/**
 * Loads a bounded window of one patient's recent activity for AI prompts
 * (handoff and IDG prep). Read-only over the care-workflow collections, using
 * the shapes in shared/types.ts.
 *
 * Indexes: visits (patientId, scheduledStart), tasks (patientId, status),
 * triageCalls (patientId, receivedAt); events/messages use single-field indexes.
 */
import { Timestamp } from 'firebase-admin/firestore';
import { MILESTONE_LABELS, upcomingDeadlines } from '../domain/milestones';
import { utcDateToISO } from '../domain/dates';
import { colRef, paths } from '../lib/db';
import type { Message, Patient, PatientEvent, Task, TriageCall, Visit } from '../shared/types';
import { millisOf, type AiMessage, type PatientActivity } from './format';

export interface ActivityWindow {
  sinceMs: number;
  /** Upper bound for visits (lets a handoff include the upcoming shift). */
  visitsUntilMs: number;
  /** Org-local "today" for deadline checks. */
  today: string;
  leadDays: number;
  messageLimit: number;
  includeEvents: boolean;
}

/** Loads recent, non-recalled messages from a channel (newest `limit`, returned oldest-first). */
export async function loadChannelMessages(orgId: string, channelId: string, sinceMs: number, limit: number): Promise<AiMessage[]> {
  if (limit <= 0) return [];
  const snap = await colRef(paths.messages(orgId, channelId))
    .where('createdAt', '>=', Timestamp.fromMillis(sinceMs))
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get();
  const out: AiMessage[] = [];
  for (const d of snap.docs) {
    const m = d.data() as Message;
    if (m.recalledAt) continue;
    out.push({
      senderName: m.senderName ?? 'Unknown',
      body: m.body ?? '',
      priority: m.priority ?? 'normal',
      createdAtMs: millisOf(m.createdAt) ?? 0,
      attachmentCount: m.attachments?.length ?? 0,
      isThreadReply: !!m.threadParentId,
    });
  }
  return out.reverse();
}

export async function loadPatientActivity(orgId: string, patientId: string, patient: Patient, w: ActivityWindow): Promise<PatientActivity> {
  const since = Timestamp.fromMillis(w.sinceMs);
  const org = paths.org(orgId);
  const [events, visits, tasks, triage, messages] = await Promise.all([
    w.includeEvents
      ? colRef(`${paths.patient(orgId, patientId)}/events`).where('date', '>=', utcDateToISO(new Date(w.sinceMs))).limit(50).get()
      : null,
    colRef(`${org}/visits`)
      .where('patientId', '==', patientId)
      .where('scheduledStart', '>=', since)
      .where('scheduledStart', '<=', Timestamp.fromMillis(w.visitsUntilMs))
      .orderBy('scheduledStart', 'asc')
      .limit(50)
      .get(),
    colRef(`${org}/tasks`).where('patientId', '==', patientId).where('status', '==', 'open').limit(50).get(),
    colRef(`${org}/triageCalls`).where('patientId', '==', patientId).where('receivedAt', '>=', since).orderBy('receivedAt', 'asc').limit(30).get(),
    patient.channelId ? loadChannelMessages(orgId, patient.channelId, w.sinceMs, w.messageLimit) : Promise.resolve([]),
  ]);

  const completions = patient.milestoneCompletions ?? {};
  const deadlines = patient.milestones
    ? upcomingDeadlines(patient.milestones, w.today, w.leadDays)
        .filter((d) => !completions[d.key])
        .map((d) => ({ label: MILESTONE_LABELS[d.kind], dueDate: d.dueDate, overdue: d.overdue }))
    : [];

  return {
    patientId,
    name: `${patient.lastName ?? ''}, ${patient.firstName ?? ''}`,
    status: patient.status,
    levelOfCare: patient.levelOfCare ?? 'routine',
    primaryDiagnosis: patient.primaryDiagnosis
      ? [patient.primaryDiagnosis.description, patient.primaryDiagnosis.code ? `(${patient.primaryDiagnosis.code})` : ''].join(' ').trim()
      : null,
    codeStatus: patient.codeStatus ?? null,
    events: (events?.docs ?? [])
      .map((d) => d.data() as PatientEvent)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
      .map((e) => ({ date: e.date, type: e.type, summary: e.summary ?? '' })),
    visits: visits.docs.map((d) => {
      const v = d.data() as Visit;
      return { discipline: v.discipline, status: v.status, startMs: millisOf(v.scheduledStart), note: v.note ?? null };
    }),
    openTasks: tasks.docs
      .map((d) => d.data() as Task)
      .sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999'))
      .map((t) => ({ title: t.title, dueDate: t.dueDate ?? null, priority: t.priority ?? 'normal', discipline: t.discipline ?? null })),
    triageCalls: triage.docs.map((d) => {
      const c = d.data() as TriageCall;
      return {
        receivedAtMs: millisOf(c.receivedAt),
        urgency: c.urgency,
        status: c.status,
        reason: c.reason ?? '',
        symptoms: c.symptoms ?? [],
        disposition: c.disposition ?? null,
        dispositionNote: c.dispositionNote ?? null,
      };
    }),
    deadlines,
    messages,
  };
}
