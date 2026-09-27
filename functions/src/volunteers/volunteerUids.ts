/**
 * Keeps `patients/{id}.volunteerUids` equal to the volunteers with an ACTIVE
 * `volunteerAssignments` doc for that patient (C2). The security rules let a Volunteer
 * read a patient (and its events/documents) only through this field.
 *  - `onVolunteerAssignmentWritten`: on any create/update/delete, recomputes the array for
 *    the patient(s) before and after the write (handles status, volunteer and patient
 *    changes and deletes). Recomputing from the current assignments (in a transaction)
 *    makes retries and out-of-order deliveries converge on the right value.
 *  - `backfillVolunteerUids` (admin): recomputes every patient that has an active
 *    assignment or a non-empty `volunteerUids`.
 * Changes are audited as `volunteer.sync` (uids only; no PHI).
 */
import { FieldValue, type QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { writeAudit } from '../lib/audit';
import { parse, requireOrg } from '../lib/context';
import { colRef, db, docRef, paths } from '../lib/db';
import { FIRESTORE_TRIGGER_REGION } from '../lib/regions';
import { id } from '../lib/schemas';
import type { BackfillVolunteerUidsRequest, BackfillVolunteerUidsResponse, Patient, VolunteerAssignment } from '../shared/types';

export const volunteerPaths = {
  assignments: (orgId: string) => `orgs/${orgId}/volunteerAssignments`,
  logs: (orgId: string) => `orgs/${orgId}/volunteerLogs`,
  log: (orgId: string, logId: string) => `orgs/${orgId}/volunteerLogs/${logId}`,
  staffHours: (orgId: string) => `orgs/${orgId}/staffHours`,
} as const;

/** Sorted, de-duplicated volunteer uids of the active assignments. Pure. */
export function activeVolunteerUids(assignments: ReadonlyArray<Pick<VolunteerAssignment, 'volunteerUid' | 'status'>>): string[] {
  return [...new Set(assignments.filter((a) => a.status === 'active' && !!a.volunteerUid).map((a) => a.volunteerUid))].sort();
}

function sameList(a: readonly string[] | undefined, b: readonly string[]): boolean {
  const x = [...(a ?? [])].sort();
  return x.length === b.length && x.every((v, i) => v === b[i]);
}

/** Recomputes one patient's `volunteerUids`. Returns true when the doc changed. */
export async function syncPatientVolunteerUids(orgId: string, patientId: string, actorUid = 'system'): Promise<boolean> {
  const patientRef = docRef(paths.patient(orgId, patientId));
  const q = colRef(volunteerPaths.assignments(orgId)).where('patientId', '==', patientId).where('status', '==', 'active').limit(200);
  return db().runTransaction(async (tx) => {
    const [pSnap, aSnap] = await Promise.all([tx.get(patientRef), tx.get(q)]);
    if (!pSnap.exists) return false;
    const current = (pSnap.data() as Patient).volunteerUids;
    const next = activeVolunteerUids(aSnap.docs.map((d) => d.data() as VolunteerAssignment));
    if (current !== undefined && sameList(current, next)) return false;
    if (current === undefined && next.length === 0) return false;
    tx.update(patientRef, { volunteerUids: next, updatedAt: FieldValue.serverTimestamp() });
    await writeAudit(
      orgId,
      { actorUid, action: 'volunteer.sync', resourceType: 'patient', resourceId: patientId, patientId, metadata: { volunteerUids: next } },
      tx,
    );
    return true;
  });
}

/** Patients affected by an assignment write: the patient before and after. */
export function affectedPatientIds(before: Partial<VolunteerAssignment> | null, after: Partial<VolunteerAssignment> | null): string[] {
  const ids = [before?.patientId, after?.patientId].filter((x): x is string => typeof x === 'string' && x.length > 0 && !x.includes('/'));
  return [...new Set(ids)];
}

export async function handleVolunteerAssignmentWritten(
  orgId: string,
  before: Partial<VolunteerAssignment> | null,
  after: Partial<VolunteerAssignment> | null,
): Promise<string[]> {
  if (
    before &&
    after &&
    before.patientId === after.patientId &&
    before.volunteerUid === after.volunteerUid &&
    before.status === after.status
  ) {
    return []; // notes/dates only
  }
  const changed: string[] = [];
  for (const pid of affectedPatientIds(before, after)) {
    if (await syncPatientVolunteerUids(orgId, pid)) changed.push(pid);
  }
  return changed;
}

export const onVolunteerAssignmentWritten = onDocumentWritten(
  { document: 'orgs/{orgId}/volunteerAssignments/{assignmentId}', region: FIRESTORE_TRIGGER_REGION },
  async (event) => {
    const before = event.data?.before.exists ? (event.data.before.data() as VolunteerAssignment) : null;
    const after = event.data?.after.exists ? (event.data.after.data() as VolunteerAssignment) : null;
    await handleVolunteerAssignmentWritten(event.params.orgId, before, after);
  },
);

const PAGE = 500;
const backfillSchema = z.object({ orgId: id });

export async function backfillVolunteerUidsHandler(request: CallableRequest<BackfillVolunteerUidsRequest>): Promise<BackfillVolunteerUidsResponse> {
  const input = parse(backfillSchema, request.data);
  const ctx = await requireOrg(request, input.orgId, ['admin']);
  // Desired state: patientId → uids, from every active assignment (paged).
  const desired = new Map<string, VolunteerAssignment[]>();
  let activeAssignments = 0;
  const aBase = colRef(volunteerPaths.assignments(ctx.orgId)).where('status', '==', 'active').orderBy('startDate');
  let last: QueryDocumentSnapshot | null = null;
  for (;;) {
    const snap = await (last ? aBase.startAfter(last) : aBase).limit(PAGE).get();
    for (const d of snap.docs) {
      const a = d.data() as VolunteerAssignment;
      activeAssignments++;
      desired.set(a.patientId, [...(desired.get(a.patientId) ?? []), a]);
    }
    if (snap.docs.length < PAGE) break;
    last = snap.docs[snap.docs.length - 1]!;
  }
  // Patients that currently list any volunteer (they may need clearing).
  const withUids = await colRef(paths.patients(ctx.orgId)).where('volunteerUids', '!=', []).get();
  const targets = new Set<string>([...desired.keys(), ...withUids.docs.map((d) => d.id)]);
  let patientsUpdated = 0;
  for (const pid of targets) {
    if (pid.includes('/')) continue;
    if (await syncPatientVolunteerUids(ctx.orgId, pid, ctx.uid)) patientsUpdated++;
  }
  await writeAudit(ctx.orgId, {
    actorUid: ctx.uid,
    action: 'volunteer.sync',
    resourceType: 'org',
    resourceId: ctx.orgId,
    metadata: { backfill: true, patientsChecked: targets.size, patientsUpdated, activeAssignments },
  });
  return { patientsUpdated, activeAssignments };
}

export const backfillVolunteerUids = onCall({ timeoutSeconds: 540 }, backfillVolunteerUidsHandler);
