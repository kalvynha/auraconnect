/**
 * IDG meeting callables: `createIdgMeeting` (auto-agenda), `updateIdgMeeting`,
 * `saveIdgNote`, `completeIdgMeeting`. `generateIdgPrep` (AI) lives elsewhere.
 */
import { FieldValue, type Timestamp } from 'firebase-admin/firestore';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { normalizeUids } from '../domain/channels';
import { todayInTimeZone } from '../domain/dates';
import { nextIdgDue, selectIdgAgenda } from '../domain/idg';
import { writeAudit } from '../lib/audit';
import { assertCanActOnPatientWork, carePaths, instant, orgSettings, patientDisplayName, requireOrgDoc, tsMillis, txCreateTask } from '../lib/care';
import { CLINICAL_ROLES, parse, requireOrg } from '../lib/context';
import { colRef, db, docRef, getDocData, getMany, paths } from '../lib/db';
import { assertActiveMembers, loadActiveMembers } from '../lib/members';
import { id, isoDate, uidList } from '../lib/schemas';
import type {
  CompleteIdgMeetingRequest,
  CreateIdgMeetingRequest,
  IdgMeeting,
  IdgPatientNote,
  IdResponse,
  Patient,
  SaveIdgNoteRequest,
  Team,
  UpdateIdgMeetingRequest,
} from '../shared/types';

export const MAX_AGENDA = 100;

const isoInstant = z.string().datetime({ offset: true });
const title = z.string().trim().min(1).max(200);
const patientIds = z.array(id).max(MAX_AGENDA);

const createSchema = z.object({
  orgId: id,
  title,
  scheduledAt: isoInstant,
  teamId: id.optional(),
  attendeeUids: uidList(100).optional(),
  patientIds: patientIds.optional(),
});
const updateSchema = z.object({
  orgId: id,
  meetingId: id,
  title: title.optional(),
  scheduledAt: isoInstant.optional(),
  attendeeUids: uidList(100).optional(),
  patientIds: patientIds.optional(),
});
const actionItem = z.object({ title, assigneeUid: id.nullable().default(null), dueDate: isoDate.nullable().default(null) });
const noteText = (max: number) => z.string().trim().max(max);
const noteSchema = z.object({
  orgId: id,
  meetingId: id,
  patientId: id,
  summary: noteText(8000),
  planOfCareChanges: noteText(8000).nullable().default(null),
  goalsOfCare: noteText(4000).nullable().default(null),
  actionItems: z.array(actionItem).max(20).default([]),
  reviewed: z.boolean(),
});
const completeSchema = z.object({ orgId: id, meetingId: id });

/** Loads the given patients (all must exist) and returns their "Last, First" names. */
async function agendaNames(orgId: string, ids: readonly string[]): Promise<Record<string, string>> {
  const unique = [...new Set(ids)];
  const docs = await getMany<Patient>(unique.map((p) => paths.patient(orgId, p)));
  const names: Record<string, string> = {};
  for (const pid of unique) {
    const p = docs.get(paths.patient(orgId, pid));
    if (!p) throw new HttpsError('invalid-argument', 'One or more agenda patients were not found.');
    names[pid] = patientDisplayName(p);
  }
  return names;
}

/** Admitted patients due for review by the meeting's (org-local) date + 7 days. */
export async function autoAgenda(orgId: string, meetingDate: string, cadenceDays: number): Promise<Record<string, string>> {
  const snap = await colRef(paths.patients(orgId)).where('status', '==', 'admitted').get();
  const patients = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Patient) }));
  const ids = selectIdgAgenda(patients, meetingDate, cadenceDays).slice(0, MAX_AGENDA);
  const byId = new Map(patients.map((p) => [p.id, p]));
  return Object.fromEntries(ids.map((pid) => [pid, patientDisplayName(byId.get(pid)!)]));
}

export async function createIdgMeetingHandler(request: CallableRequest<CreateIdgMeetingRequest>): Promise<IdResponse> {
  const input = parse(createSchema, request.data);
  const ctx = await requireOrg(request, input.orgId, CLINICAL_ROLES);
  const org = await requireOrgDoc(ctx.orgId);
  const settings = orgSettings(org);
  const scheduledAt = instant(input.scheduledAt);

  let attendees: string[];
  if (input.teamId) {
    const team = await getDocData<Team>(paths.team(ctx.orgId, input.teamId));
    if (!team) throw new HttpsError('not-found', 'Team not found.');
    attendees = input.attendeeUids ?? [...(await loadActiveMembers(ctx.orgId, team.memberUids ?? [])).keys()];
  } else {
    attendees = input.attendeeUids ?? [ctx.uid];
  }
  attendees = normalizeUids(attendees);
  if (input.attendeeUids) await assertActiveMembers(ctx.orgId, attendees);

  const meetingDate = todayInTimeZone(new Date(tsMillis(scheduledAt)), settings.timezone);
  const auto = input.patientIds === undefined;
  const names = auto ? await autoAgenda(ctx.orgId, meetingDate, settings.idgCadenceDays) : await agendaNames(ctx.orgId, input.patientIds!);

  const ref = colRef(carePaths.idgMeetings(ctx.orgId)).doc();
  const batch = db().batch();
  batch.set(ref, {
    title: input.title,
    teamId: input.teamId ?? null,
    scheduledAt,
    status: 'scheduled',
    attendeeUids: attendees,
    patientIds: Object.keys(names),
    patientNames: names,
    notes: {},
    aiPrep: {},
    createdBy: ctx.uid,
    createdAt: FieldValue.serverTimestamp(),
    completedAt: null,
    completedBy: null,
  });
  await writeAudit(
    ctx.orgId,
    { actorUid: ctx.uid, action: 'idg.create', resourceType: 'idgMeeting', resourceId: ref.id, metadata: { patients: Object.keys(names).length, autoAgenda: auto } },
    batch,
  );
  await batch.commit();
  return { id: ref.id };
}

function assertScheduled(m: IdgMeeting): void {
  if (m.status !== 'scheduled') throw new HttpsError('failed-precondition', 'The meeting is completed and locked.');
}

export async function updateIdgMeetingHandler(request: CallableRequest<UpdateIdgMeetingRequest>): Promise<Record<string, never>> {
  const input = parse(updateSchema, request.data);
  const ctx = await requireOrg(request, input.orgId, CLINICAL_ROLES);
  const attendees = input.attendeeUids ? normalizeUids(input.attendeeUids) : undefined;
  if (attendees) await assertActiveMembers(ctx.orgId, attendees);
  const names = input.patientIds ? await agendaNames(ctx.orgId, input.patientIds) : undefined;
  const ref = docRef(carePaths.idgMeeting(ctx.orgId, input.meetingId));

  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Meeting not found.');
    const m = snap.data() as IdgMeeting;
    assertScheduled(m);
    const update: Record<string, unknown> = {};
    if (input.title !== undefined) update.title = input.title;
    if (input.scheduledAt !== undefined) update.scheduledAt = instant(input.scheduledAt);
    if (attendees) update.attendeeUids = attendees;
    if (names) {
      const keep = new Set(Object.keys(names));
      update.patientIds = Object.keys(names);
      update.patientNames = names;
      // Notes and AI prep for patients removed from the agenda are dropped.
      update.notes = Object.fromEntries(Object.entries(m.notes ?? {}).filter(([pid]) => keep.has(pid)));
      update.aiPrep = Object.fromEntries(Object.entries(m.aiPrep ?? {}).filter(([pid]) => keep.has(pid)));
    }
    const changed = Object.keys(update);
    if (changed.length === 0) return;
    tx.update(ref, update);
    await writeAudit(
      ctx.orgId,
      { actorUid: ctx.uid, action: 'idg.update', resourceType: 'idgMeeting', resourceId: input.meetingId, metadata: { fields: changed } },
      tx,
    );
  });
  return {};
}

/** Allowed for attendees, the patient's care team and admins. */
export async function saveIdgNoteHandler(request: CallableRequest<SaveIdgNoteRequest>): Promise<Record<string, never>> {
  const input = parse(noteSchema, request.data);
  const ctx = await requireOrg(request, input.orgId, CLINICAL_ROLES);
  const assignees = input.actionItems.map((a) => a.assigneeUid).filter((u): u is string => !!u);
  if (assignees.length) await assertActiveMembers(ctx.orgId, assignees);
  const ref = docRef(carePaths.idgMeeting(ctx.orgId, input.meetingId));

  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Meeting not found.');
    const m = snap.data() as IdgMeeting;
    const pSnap = await tx.get(docRef(paths.patient(ctx.orgId, input.patientId)));
    assertScheduled(m);
    if (!m.patientIds.includes(input.patientId)) throw new HttpsError('failed-precondition', 'The patient is not on this meeting’s agenda.');
    const careTeam = pSnap.exists ? ((pSnap.data() as Patient).careTeamUids ?? []) : [];
    assertCanActOnPatientWork(ctx, careTeam, m.attendeeUids ?? []);

    const note: Omit<IdgPatientNote, 'updatedAt'> & { updatedAt: unknown } = {
      summary: input.summary,
      planOfCareChanges: input.planOfCareChanges,
      goalsOfCare: input.goalsOfCare,
      actionItems: input.actionItems,
      reviewed: input.reviewed,
      updatedBy: ctx.uid,
      updatedAt: FieldValue.serverTimestamp(),
    };
    // Rewrite the whole map: patient ids are not guaranteed to be valid dotted field-path segments.
    tx.update(ref, { notes: { ...(m.notes ?? {}), [input.patientId]: note } });
    await writeAudit(
      ctx.orgId,
      {
        actorUid: ctx.uid,
        action: 'idg.update',
        resourceType: 'idgMeeting',
        resourceId: input.meetingId,
        patientId: input.patientId,
        metadata: { note: true, reviewed: input.reviewed, actionItems: input.actionItems.length },
      },
      tx,
    );
  });
  return {};
}

/**
 * Locks the meeting. For each agenda patient whose note is `reviewed`: sets
 * `lastIdgReviewDate` = meeting date (org-local) and `nextIdgDueDate` = that + cadence,
 * and creates one task per action item (source `idg`).
 */
export async function completeIdgMeetingHandler(request: CallableRequest<CompleteIdgMeetingRequest>): Promise<Record<string, never>> {
  const input = parse(completeSchema, request.data);
  const ctx = await requireOrg(request, input.orgId, CLINICAL_ROLES);
  const settings = orgSettings(await requireOrgDoc(ctx.orgId));
  const ref = docRef(carePaths.idgMeeting(ctx.orgId, input.meetingId));

  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Meeting not found.');
    const m = snap.data() as IdgMeeting;
    assertScheduled(m);
    const reviewed = m.patientIds.filter((pid) => m.notes?.[pid]?.reviewed === true);
    const patientRefs = reviewed.map((pid) => docRef(paths.patient(ctx.orgId, pid)));
    const patientSnaps = patientRefs.length ? await tx.getAll(...patientRefs) : [];

    const meetingDate = todayInTimeZone(new Date(tsMillis(m.scheduledAt as Timestamp)), settings.timezone);
    const nextDue = nextIdgDue(meetingDate, settings.idgCadenceDays);
    let tasks = 0;
    let updated = 0;
    reviewed.forEach((pid, i) => {
      const ps = patientSnaps[i];
      const patient = ps?.exists ? (ps.data() as Patient) : null;
      if (ps && patient) {
        tx.update(ps.ref, { lastIdgReviewDate: meetingDate, nextIdgDueDate: nextDue, updatedAt: FieldValue.serverTimestamp() });
        updated++;
      }
      const name = m.patientNames?.[pid] ?? (patient ? patientDisplayName(patient) : null);
      for (const item of m.notes[pid]!.actionItems ?? []) {
        txCreateTask(tx, ctx.orgId, {
          title: item.title,
          description: `IDG action item: ${m.title}`,
          patientId: pid,
          patientName: name,
          assigneeUid: item.assigneeUid ?? null,
          discipline: null,
          dueDate: item.dueDate ?? null,
          priority: 'normal',
          source: { type: 'idg', meetingId: input.meetingId },
          createdBy: ctx.uid,
        });
        tasks++;
      }
    });
    const now = FieldValue.serverTimestamp();
    tx.update(ref, { status: 'completed', completedAt: now, completedBy: ctx.uid });
    await writeAudit(
      ctx.orgId,
      {
        actorUid: ctx.uid,
        action: 'idg.complete',
        resourceType: 'idgMeeting',
        resourceId: input.meetingId,
        metadata: { reviewed: reviewed.length, patientsUpdated: updated, tasks, meetingDate },
      },
      tx,
    );
  });
  return {};
}

export const createIdgMeeting = onCall(createIdgMeetingHandler);
export const updateIdgMeeting = onCall(updateIdgMeetingHandler);
export const saveIdgNote = onCall(saveIdgNoteHandler);
export const completeIdgMeeting = onCall(completeIdgMeetingHandler);
