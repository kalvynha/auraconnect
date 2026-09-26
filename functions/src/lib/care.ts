/**
 * Shared helpers for the v2 care workflows (lifecycle, visits, tasks,
 * bereavement, IDG, triage): paths, org-setting defaults, patient access
 * checks, timeline events and task creation.
 */
import { FieldValue, Timestamp, type DocumentReference, type Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { instantiateTemplate, templateItemsFor, type CareTeamMemberRef, type InstantiatedTask } from '../domain/taskTemplates';
import { colRef, docRef, getDocData, paths } from './db';
import { loadActiveMembers } from './members';
import type { OrgContext } from './context';
import {
  ORG_SETTING_DEFAULTS,
  type ISODate,
  type Org,
  type Patient,
  type PatientEventType,
  type Priority,
  type TaskSource,
  type TaskTemplate,
  type TaskTemplateEvent,
  type Discipline,
} from '../shared/types';

export const carePaths = {
  events: (orgId: string, patientId: string) => `orgs/${orgId}/patients/${patientId}/events`,
  documents: (orgId: string, patientId: string) => `orgs/${orgId}/patients/${patientId}/documents`,
  visits: (orgId: string) => `orgs/${orgId}/visits`,
  visit: (orgId: string, id: string) => `orgs/${orgId}/visits/${id}`,
  tasks: (orgId: string) => `orgs/${orgId}/tasks`,
  task: (orgId: string, id: string) => `orgs/${orgId}/tasks/${id}`,
  taskTemplate: (orgId: string, event: TaskTemplateEvent) => `orgs/${orgId}/taskTemplates/${event}`,
  bereavementPlans: (orgId: string) => `orgs/${orgId}/bereavementPlans`,
  bereavementPlan: (orgId: string, id: string) => `orgs/${orgId}/bereavementPlans/${id}`,
  idgMeetings: (orgId: string) => `orgs/${orgId}/idgMeetings`,
  idgMeeting: (orgId: string, id: string) => `orgs/${orgId}/idgMeetings/${id}`,
  triageCalls: (orgId: string) => `orgs/${orgId}/triageCalls`,
  triageCall: (orgId: string, id: string) => `orgs/${orgId}/triageCalls/${id}`,
} as const;

/** Org v2 settings with `ORG_SETTING_DEFAULTS` applied for missing fields. */
export function orgSettings(org: Partial<Org> | null | undefined) {
  return {
    triageRoleKey: org?.triageRoleKey ?? ORG_SETTING_DEFAULTS.triageRoleKey,
    idgCadenceDays: org?.idgCadenceDays ?? ORG_SETTING_DEFAULTS.idgCadenceDays,
    missedVisitGraceMinutes: org?.missedVisitGraceMinutes ?? ORG_SETTING_DEFAULTS.missedVisitGraceMinutes,
    messageLifespanDays: org?.messageLifespanDays ?? ORG_SETTING_DEFAULTS.messageLifespanDays,
    timezone: org?.timezone || 'UTC',
  };
}

export async function requireOrgDoc(orgId: string): Promise<Org> {
  const org = await getDocData<Org>(paths.org(orgId));
  if (!org) throw new HttpsError('not-found', 'Organization not found.');
  return org;
}

/** Denormalized patient name: "Last, First". */
export function patientDisplayName(p: Pick<Patient, 'firstName' | 'lastName'>): string {
  return [p.lastName?.trim(), p.firstName?.trim()].filter(Boolean).join(', ') || 'Patient';
}

/** Reads a patient inside a transaction; throws not-found when missing. */
export async function txPatient(tx: Transaction, orgId: string, patientId: string): Promise<{ ref: DocumentReference; patient: Patient }> {
  const ref = docRef(paths.patient(orgId, patientId));
  const snap = await tx.get(ref);
  if (!snap.exists) throw new HttpsError('not-found', 'Patient not found.');
  return { ref, patient: snap.data() as Patient };
}

export async function loadPatient(orgId: string, patientId: string): Promise<Patient> {
  const p = await getDocData<Patient>(paths.patient(orgId, patientId));
  if (!p) throw new HttpsError('not-found', 'Patient not found.');
  return p;
}

/** True for admins, the patient's care team, or any of `extraUids` (assignee, creator…). */
export function canActOnPatientWork(ctx: Pick<OrgContext, 'uid' | 'role'>, careTeamUids: readonly string[] | null | undefined, extraUids: ReadonlyArray<string | null | undefined> = []): boolean {
  if (ctx.role === 'admin') return true;
  if ((careTeamUids ?? []).includes(ctx.uid)) return true;
  return extraUids.some((u) => !!u && u === ctx.uid);
}

export function assertCanActOnPatientWork(...args: Parameters<typeof canActOnPatientWork>): void {
  if (!canActOnPatientWork(...args)) {
    throw new HttpsError('permission-denied', 'Only the assignee, the patient’s care team or an admin can do this.');
  }
}

/** Parses an ISO 8601 instant into a Timestamp. */
export function instant(iso: string): Timestamp {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new HttpsError('invalid-argument', 'Invalid date-time.');
  return Timestamp.fromMillis(ms);
}

export function tsMillis(t: { toMillis?: () => number; seconds: number; nanoseconds?: number } | null | undefined): number {
  if (!t) return NaN;
  if (typeof t.toMillis === 'function') return t.toMillis();
  return t.seconds * 1000 + Math.floor((t.nanoseconds ?? 0) / 1e6);
}

/** Appends a patient timeline event within a transaction. */
export function appendPatientEvent(
  tx: Transaction,
  orgId: string,
  patientId: string,
  e: { type: PatientEventType; date: ISODate; recordedBy: string; summary: string; details?: Record<string, unknown> },
): string {
  const ref = colRef(carePaths.events(orgId, patientId)).doc();
  tx.set(ref, {
    type: e.type,
    date: e.date,
    recordedBy: e.recordedBy,
    createdAt: FieldValue.serverTimestamp(),
    summary: e.summary,
    details: e.details ?? {},
  });
  return ref.id;
}

export interface NewTask {
  title: string;
  description: string | null;
  patientId: string | null;
  patientName: string | null;
  assigneeUid: string | null;
  discipline: Discipline | null;
  dueDate: ISODate | null;
  priority: Priority;
  source: TaskSource;
  createdBy: string;
}

export function newTaskDoc(t: NewTask) {
  const now = FieldValue.serverTimestamp();
  return {
    title: t.title,
    description: t.description,
    patientId: t.patientId,
    patientName: t.patientName,
    assigneeUid: t.assigneeUid,
    discipline: t.discipline,
    dueDate: t.dueDate,
    priority: t.priority,
    status: 'open' as const,
    source: t.source,
    createdBy: t.createdBy,
    createdAt: now,
    completedAt: null,
    completedBy: null,
    updatedAt: now,
  };
}

/** Writes a task within a transaction and returns its id. */
export function txCreateTask(tx: Transaction, orgId: string, t: NewTask): string {
  const ref = colRef(carePaths.tasks(orgId)).doc();
  tx.set(ref, newTaskDoc(t));
  return ref.id;
}

/** Active care-team members (uid + discipline), in care-team order. */
export async function careTeamRefs(orgId: string, careTeamUids: readonly string[]): Promise<CareTeamMemberRef[]> {
  const active = await loadActiveMembers(orgId, careTeamUids);
  return careTeamUids.flatMap((u) => {
    const m = active.get(u);
    return m ? [{ uid: u, discipline: m.discipline }] : [];
  });
}

/**
 * Loads the org's template for `event` (falling back to the defaults) and
 * instantiates it for a patient. Do the reads before a transaction starts.
 */
export async function prepareTemplateTasks(
  orgId: string,
  event: TaskTemplateEvent,
  eventDate: ISODate,
  careTeamUids: readonly string[],
): Promise<InstantiatedTask[]> {
  const [tpl, team] = await Promise.all([
    getDocData<TaskTemplate>(carePaths.taskTemplate(orgId, event)),
    careTeamRefs(orgId, careTeamUids),
  ]);
  return instantiateTemplate(templateItemsFor(event, tpl?.items ?? null), eventDate, team);
}

/** Writes instantiated template tasks within a transaction. */
export function txWriteTemplateTasks(
  tx: Transaction,
  orgId: string,
  event: TaskTemplateEvent,
  tasks: readonly InstantiatedTask[],
  patient: { id: string; name: string },
  createdBy: string,
): string[] {
  return tasks.map((t) =>
    txCreateTask(tx, orgId, {
      ...t,
      patientId: patient.id,
      patientName: patient.name,
      source: { type: 'template', event },
      createdBy,
    }),
  );
}

/**
 * Reads, inside a transaction, the patient's future scheduled visits and open
 * tasks; returns a function that cancels them (call it in the write phase).
 */
export async function txPrepareCancelOpenWork(tx: Transaction, orgId: string, patientId: string, now: Date) {
  const [visits, tasks] = await Promise.all([
    tx.get(colRef(carePaths.visits(orgId)).where('patientId', '==', patientId).where('status', '==', 'scheduled')),
    tx.get(colRef(carePaths.tasks(orgId)).where('patientId', '==', patientId).where('status', '==', 'open')),
  ]);
  const futureVisits = visits.docs.filter((d) => tsMillis(d.get('scheduledStart')) > now.getTime());
  return {
    visits: futureVisits.length,
    tasks: tasks.docs.length,
    apply(reason: string) {
      const ts = FieldValue.serverTimestamp();
      for (const d of futureVisits) tx.update(d.ref, { status: 'cancelled', cancelledReason: reason, updatedAt: ts });
      for (const d of tasks.docs) tx.update(d.ref, { status: 'cancelled', updatedAt: ts });
    },
  };
}
