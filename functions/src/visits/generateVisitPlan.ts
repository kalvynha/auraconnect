/**
 * `generateVisitPlan` (V2): turns patients' visit frequencies into scheduled visits for one
 * week. Admins and `scheduling` holders. A dry run returns the proposal and conflicts; a real
 * run creates the visits with deterministic ids (`plan_…`), so re-running is idempotent.
 * The planning rules live in `domain/visitPlan.ts`.
 */
import { FieldValue, Timestamp, type WriteBatch } from 'firebase-admin/firestore';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { addDays } from '../domain/dates';
import { planWeek, zonedTimeToUtcMs, type ExistingVisitSpan, type PlanPatient } from '../domain/visitPlan';
import { isAlreadyExists } from '../alerts/raiseAlert';
import { writeAudit } from '../lib/audit';
import { carePaths, orgSettings, patientDisplayName, requireOrgDoc, tsMillis } from '../lib/care';
import { parse, requireOrg } from '../lib/context';
import { colRef, db, docRef, getMany, paths } from '../lib/db';
import { mapLimit } from '../lib/concurrency';
import { requireCapability } from '../lib/permissions';
import { id, isoDate } from '../lib/schemas';
import type { GenerateVisitPlanRequest, GenerateVisitPlanResponse, Member, Patient, PlannedVisit, Visit } from '../shared/types';

/** Visits (plus one audit each) per write batch: 2 × 200 = 400 writes. */
const PLAN_WRITE_CHUNK = 200;
/** Most visits one run may create. */
export const MAX_PLAN_VISITS = 3000;

const schema = z.object({
  orgId: id,
  weekStart: isoDate,
  patientIds: z.array(id).min(1).max(200).optional(),
  dryRun: z.boolean(),
});

function toSpan(id: string, v: Visit): ExistingVisitSpan {
  return {
    id,
    patientId: v.patientId,
    discipline: v.discipline,
    status: v.status,
    assignedUid: v.assignedUid ?? null,
    startMs: tsMillis(v.scheduledStart),
    endMs: tsMillis(v.scheduledEnd),
  };
}

export async function generateVisitPlanHandler(request: CallableRequest<GenerateVisitPlanRequest>): Promise<GenerateVisitPlanResponse> {
  const input = parse(schema, request.data);
  const ctx = await requireOrg(request, input.orgId);
  await requireCapability(ctx, 'scheduling');
  const org = await requireOrgDoc(ctx.orgId);
  const tz = orgSettings(org).timezone;

  // Patients: the requested ones (admitted only) or every admitted patient with frequencies.
  let patients: Array<{ id: string; p: Patient }>;
  if (input.patientIds) {
    const got = await getMany<Patient>(input.patientIds.map((p) => paths.patient(ctx.orgId, p)));
    patients = input.patientIds.flatMap((pid) => {
      const p = got.get(paths.patient(ctx.orgId, pid));
      return p && p.status === 'admitted' ? [{ id: pid, p }] : [];
    });
  } else {
    const snap = await colRef(paths.patients(ctx.orgId)).where('status', '==', 'admitted').get();
    patients = snap.docs.map((d) => ({ id: d.id, p: d.data() as Patient }));
  }
  patients = patients.filter(({ p }) => (p.visitFrequencies ?? []).length > 0);

  // Members (care-team disciplines, frequency assignees, activity).
  const memberUids = new Set<string>();
  for (const { p } of patients) {
    for (const u of p.careTeamUids ?? []) memberUids.add(u);
    for (const f of p.visitFrequencies ?? []) if (f.assignedUid) memberUids.add(f.assignedUid);
  }
  const members = await getMany<Member>([...memberUids].map((u) => paths.member(ctx.orgId, u)));
  const active = new Map<string, Member>();
  for (const m of members.values()) if (m.active) active.set(m.uid, m);

  // Existing visits in the window (org-wide week query: ~900 docs at census 100).
  const windowStart = Timestamp.fromMillis(zonedTimeToUtcMs(input.weekStart, '00:00', tz));
  const windowEnd = Timestamp.fromMillis(zonedTimeToUtcMs(addDays(input.weekStart, 7), '00:00', tz));
  let existing: ExistingVisitSpan[];
  if (input.patientIds) {
    // Patient visits for subtraction, plus the likely assignees' visits for overlap checks.
    const perPatient = await mapLimit(patients, 8, async ({ id: pid }) =>
      (await colRef(carePaths.visits(ctx.orgId)).where('patientId', '==', pid).where('scheduledStart', '>=', windowStart).where('scheduledStart', '<', windowEnd).get()).docs,
    );
    const perAssignee = await mapLimit([...active.keys()], 8, async (uid) =>
      (await colRef(carePaths.visits(ctx.orgId)).where('assignedUid', '==', uid).where('scheduledStart', '>=', windowStart).where('scheduledStart', '<', windowEnd).get()).docs,
    );
    const byId = new Map<string, ExistingVisitSpan>();
    for (const d of [...perPatient.flat(), ...perAssignee.flat()]) byId.set(d.id, toSpan(d.id, d.data() as Visit));
    existing = [...byId.values()];
  } else {
    const snap = await colRef(carePaths.visits(ctx.orgId)).where('scheduledStart', '>=', windowStart).where('scheduledStart', '<', windowEnd).get();
    existing = snap.docs.map((d) => toSpan(d.id, d.data() as Visit));
  }

  const planPatients: PlanPatient[] = patients.map(({ id: pid, p }) => ({
    id: pid,
    name: patientDisplayName(p),
    frequencies: p.visitFrequencies ?? [],
    careTeam: (p.careTeamUids ?? []).flatMap((u) => {
      const m = active.get(u);
      return m ? [{ uid: u, discipline: m.discipline }] : [];
    }),
  }));
  const plan = planWeek({
    weekStart: input.weekStart,
    timeZone: tz,
    nowMs: Date.now(),
    patients: planPatients,
    existing,
    activeUids: new Set(active.keys()),
  });
  if (plan.visits.length > MAX_PLAN_VISITS) {
    throw new HttpsError('failed-precondition', `The plan has ${plan.visits.length} visits; plan fewer patients at a time (max ${MAX_PLAN_VISITS}).`);
  }

  const response: GenerateVisitPlanResponse = {
    weekStart: input.weekStart,
    visits: plan.visits,
    conflicts: plan.conflicts,
    created: 0,
    existing: plan.existing,
  };
  if (input.dryRun) return response;

  response.created = await createPlannedVisits(ctx.orgId, ctx.uid, plan.visits);
  await writeAudit(ctx.orgId, {
    actorUid: ctx.uid,
    action: 'visit.plan',
    resourceType: 'visitPlan',
    resourceId: input.weekStart,
    metadata: { weekStart: input.weekStart, proposed: plan.visits.length, created: response.created, conflicts: plan.conflicts.length, patients: patients.length },
  });
  return response;
}

function plannedVisitDoc(v: PlannedVisit, createdBy: string) {
  const now = FieldValue.serverTimestamp();
  return {
    patientId: v.patientId,
    patientName: v.patientName,
    discipline: v.discipline,
    assignedUid: v.assignedUid,
    scheduledStart: Timestamp.fromMillis(Date.parse(v.start)),
    scheduledEnd: Timestamp.fromMillis(Date.parse(v.end)),
    status: 'scheduled',
    note: null,
    completedAt: null,
    completedBy: null,
    cancelledReason: null,
    createdBy,
    createdAt: now,
    updatedAt: now,
    type: 'routine',
  };
}

/**
 * Creates planned visits in batches (`create`, so an existing id is never overwritten).
 * When a batch hits an id created concurrently, its visits are retried one by one.
 */
async function createPlannedVisits(orgId: string, actorUid: string, visits: readonly PlannedVisit[]): Promise<number> {
  let created = 0;
  const writeOne = async (v: PlannedVisit, batch: WriteBatch) => {
    batch.create(docRef(carePaths.visit(orgId, v.id)), plannedVisitDoc(v, actorUid));
    await writeAudit(
      orgId,
      { actorUid, action: 'visit.schedule', resourceType: 'visit', resourceId: v.id, patientId: v.patientId, metadata: { discipline: v.discipline, source: 'plan' } },
      batch,
    );
  };
  for (let i = 0; i < visits.length; i += PLAN_WRITE_CHUNK) {
    const chunk = visits.slice(i, i + PLAN_WRITE_CHUNK);
    const batch = db().batch();
    for (const v of chunk) await writeOne(v, batch);
    try {
      await batch.commit();
      created += chunk.length;
    } catch (e) {
      if (!isAlreadyExists(e)) throw e;
      for (const v of chunk) {
        const one = db().batch();
        await writeOne(v, one);
        try {
          await one.commit();
          created++;
        } catch (err) {
          if (!isAlreadyExists(err)) throw err;
        }
      }
    }
  }
  return created;
}

export const generateVisitPlan = onCall({ timeoutSeconds: 300, memory: '512MiB' }, generateVisitPlanHandler);
