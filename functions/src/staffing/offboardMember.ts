/**
 * `offboardMember` (L1): hands a departing member's work to replacements, then deactivates them.
 * Admins and `staffing` holders. A dry run only counts.
 *
 * Replacement for each item: `reassignTo.byDiscipline[work discipline]`, else `reassignTo.default`,
 * else the item is left unassigned (shifts are deleted). Work moved:
 *  - care teams of admitted/referral patients (via `applyCareTeamChange`: channel sync, timeline event)
 *  - open tasks, future scheduled visits, active bereavement plans, open triage calls
 *  - future shifts (`shiftAction`: delete, or reassign to the replacement)
 *  - `onCallRoles.fallbackUids` and `teams.memberUids`
 *  - active volunteer assignments are ended
 *  - escalation policies with a `uid` step for the member are reported (edit them by hand)
 * Finally the member doc is set `active: false` (onMemberWritten revokes claims and audits it).
 * Writes go in batches of ≤ 400 (each change plus its `member.offboard` audit entry).
 */
import { FieldValue, Timestamp, type DocumentReference } from 'firebase-admin/firestore';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { todayInTimeZone } from '../domain/dates';
import { pickReplacement, replacementUids } from '../domain/staffing';
import { writeAudit, type AuditEntry } from '../lib/audit';
import { carePaths, orgSettings } from '../lib/care';
import { mapLimit } from '../lib/concurrency';
import { parse, requireOrg } from '../lib/context';
import { colRef, db, docRef, getDocData, paths } from '../lib/db';
import { assertActiveMembers } from '../lib/members';
import { requireCapability } from '../lib/permissions';
import { discipline, id } from '../lib/schemas';
import { applyCareTeamChange } from './careTeam';
import type {
  Discipline,
  EscalationPolicy,
  Member,
  OffboardCounts,
  OffboardMemberRequest,
  OffboardMemberResponse,
  OnCallRole,
  Org,
  Patient,
  Task,
  Visit,
} from '../shared/types';

/** Changes per write batch (each change + one audit entry = 2 writes → 400 writes). */
export const OFFBOARD_BATCH_OPS = 200;
const CARE_TEAM_CONCURRENCY = 5;

const schema = z.object({
  orgId: id,
  uid: id,
  reassignTo: z
    .object({
      default: id.nullable().optional(),
      byDiscipline: z.record(discipline, id).optional(),
    })
    .default({}),
  shiftAction: z.enum(['delete', 'reassign']),
  dryRun: z.boolean(),
});

type Op =
  | { kind: 'update'; ref: DocumentReference; data: Record<string, unknown>; audit: AuditEntry }
  | { kind: 'delete'; ref: DocumentReference; audit: AuditEntry };

const zeroCounts = (): OffboardCounts => ({
  careTeams: 0, tasks: 0, visits: 0, bereavementPlans: 0, triageCalls: 0, shifts: 0, onCallRoles: 0, teams: 0, volunteerAssignments: 0,
});

async function commitOps(orgId: string, ops: readonly Op[]): Promise<void> {
  for (let i = 0; i < ops.length; i += OFFBOARD_BATCH_OPS) {
    const batch = db().batch();
    for (const op of ops.slice(i, i + OFFBOARD_BATCH_OPS)) {
      if (op.kind === 'update') batch.update(op.ref, op.data);
      else batch.delete(op.ref);
      await writeAudit(orgId, op.audit, batch);
    }
    await batch.commit();
  }
}

export async function offboardMemberHandler(request: CallableRequest<OffboardMemberRequest>): Promise<OffboardMemberResponse> {
  const input = parse(schema, request.data);
  const ctx = await requireOrg(request, input.orgId);
  await requireCapability(ctx, 'staffing');
  const uid = input.uid;
  if (uid === ctx.uid) throw new HttpsError('failed-precondition', 'You cannot offboard yourself. Ask another administrator.');
  const target = await getDocData<Member>(paths.member(ctx.orgId, uid));
  if (!target) throw new HttpsError('not-found', 'Member not found.');
  if (target.role === 'admin' && ctx.role !== 'admin') {
    throw new HttpsError('permission-denied', 'Only an administrator can offboard another administrator.');
  }
  if (target.role === 'admin' && target.active) {
    const admins = await colRef(paths.members(ctx.orgId)).where('role', '==', 'admin').where('active', '==', true).limit(2).get();
    if (admins.docs.filter((d) => d.id !== uid).length === 0) {
      throw new HttpsError('failed-precondition', 'This is the only active administrator. Make another member an admin first.');
    }
  }
  const reassignTo = { default: input.reassignTo.default ?? null, byDiscipline: input.reassignTo.byDiscipline as Partial<Record<Discipline, string>> | undefined };
  const repls = replacementUids(reassignTo);
  if (repls.includes(uid)) throw new HttpsError('invalid-argument', 'The replacement must be someone else.');
  const replMembers = repls.length ? await assertActiveMembers(ctx.orgId, repls) : new Map<string, Member>();
  const pick = (d: Discipline | null | undefined) => pickReplacement(reassignTo, d ?? target.discipline, uid);

  const org = await getDocData<Org>(paths.org(ctx.orgId));
  const today = todayInTimeZone(new Date(), orgSettings(org).timezone);
  const now = Timestamp.now();
  const orgId = ctx.orgId;

  const [patients, tasks, visits, plans, calls, shifts, roles, teams, vols, policies] = await Promise.all([
    colRef(paths.patients(orgId)).where('careTeamUids', 'array-contains', uid).get(),
    colRef(carePaths.tasks(orgId)).where('assigneeUid', '==', uid).where('status', '==', 'open').get(),
    colRef(carePaths.visits(orgId)).where('assignedUid', '==', uid).where('scheduledStart', '>=', now).get(),
    colRef(carePaths.bereavementPlans(orgId)).where('assignedUid', '==', uid).where('status', '==', 'active').get(),
    colRef(carePaths.triageCalls(orgId)).where('assignedUid', '==', uid).where('status', '==', 'open').get(),
    colRef(paths.shifts(orgId)).where('uid', '==', uid).where('end', '>', now).get(),
    colRef(`orgs/${orgId}/onCallRoles`).get(),
    colRef(paths.teams(orgId)).where('memberUids', 'array-contains', uid).get(),
    colRef(`orgs/${orgId}/volunteerAssignments`).where('volunteerUid', '==', uid).where('status', '==', 'active').get(),
    colRef(paths.escalationPolicies(orgId)).get(),
  ]);
  const activePatients = patients.docs.filter((d) => {
    const s = (d.data() as Patient).status;
    return s === 'admitted' || s === 'referral';
  });
  const futureVisits = visits.docs.filter((d) => (d.data() as Visit).status === 'scheduled');

  const counts = zeroCounts();
  const unassigned: Partial<OffboardCounts> = {};
  const bump = (k: keyof OffboardCounts, repl: string | null) => {
    counts[k]++;
    if (!repl) unassigned[k] = (unassigned[k] ?? 0) + 1;
  };
  const meta = { offboard: uid };
  const ops: Op[] = [];
  const audit = (resourceType: string, resourceId: string, patientId: string | null, extra: Record<string, unknown>): AuditEntry => ({
    actorUid: ctx.uid, action: 'member.offboard', resourceType, resourceId, patientId, metadata: { ...meta, ...extra },
  });

  const careRepl = pick(target.discipline);
  for (const _ of activePatients) bump('careTeams', careRepl);
  for (const d of tasks.docs) {
    const t = d.data() as Task;
    const r = pick(t.discipline);
    bump('tasks', r);
    ops.push({ kind: 'update', ref: d.ref, data: { assigneeUid: r, updatedAt: FieldValue.serverTimestamp() }, audit: audit('task', d.id, t.patientId ?? null, { to: r }) });
  }
  for (const d of futureVisits) {
    const v = d.data() as Visit;
    const r = pick(v.discipline);
    bump('visits', r);
    ops.push({ kind: 'update', ref: d.ref, data: { assignedUid: r, updatedAt: FieldValue.serverTimestamp() }, audit: audit('visit', d.id, v.patientId, { to: r }) });
  }
  for (const d of plans.docs) {
    const r = pick(target.discipline);
    bump('bereavementPlans', r);
    ops.push({ kind: 'update', ref: d.ref, data: { assignedUid: r, updatedAt: FieldValue.serverTimestamp() }, audit: audit('bereavementPlan', d.id, (d.get('patientId') as string) ?? null, { to: r }) });
  }
  for (const d of calls.docs) {
    const r = pick(target.discipline);
    bump('triageCalls', r);
    ops.push({ kind: 'update', ref: d.ref, data: { assignedUid: r }, audit: audit('triageCall', d.id, (d.get('patientId') as string | null) ?? null, { to: r }) });
  }
  const roleDiscipline = new Map(roles.docs.map((d) => [d.id, (d.data() as OnCallRole).discipline]));
  const fallbackRoles = roles.docs.filter((d) => ((d.data() as OnCallRole).fallbackUids ?? []).includes(uid));
  for (const d of shifts.docs) {
    const r = input.shiftAction === 'reassign' ? pick(roleDiscipline.get(String(d.get('roleKey'))) ?? null) : null;
    bump('shifts', r);
    if (r) ops.push({ kind: 'update', ref: d.ref, data: { uid: r }, audit: audit('shift', d.id, null, { to: r }) });
    else ops.push({ kind: 'delete', ref: d.ref, audit: audit('shift', d.id, null, { deleted: true }) });
  }
  for (const d of fallbackRoles) {
    const role = d.data() as OnCallRole;
    const r = pick(role.discipline);
    bump('onCallRoles', r);
    const next = (role.fallbackUids ?? []).filter((u) => u !== uid);
    if (r && !next.includes(r)) next.push(r);
    ops.push({ kind: 'update', ref: d.ref, data: { fallbackUids: next }, audit: audit('onCallRole', d.id, null, { to: r }) });
  }
  for (const d of teams.docs) {
    counts.teams++;
    ops.push({ kind: 'update', ref: d.ref, data: { memberUids: FieldValue.arrayRemove(uid) }, audit: audit('team', d.id, null, {}) });
  }
  for (const d of vols.docs) {
    counts.volunteerAssignments++;
    ops.push({ kind: 'update', ref: d.ref, data: { status: 'ended', endDate: today }, audit: audit('volunteerAssignment', d.id, (d.get('patientId') as string) ?? null, { ended: true }) });
  }
  const escalationPolicies = policies.docs
    .filter((d) => ((d.data() as EscalationPolicy).steps ?? []).some((s) => s.target?.kind === 'uid' && s.target.uid === uid))
    .map((d) => ({ id: d.id, name: (d.data() as EscalationPolicy).name }));

  const response: OffboardMemberResponse = { dryRun: input.dryRun, counts, unassigned, escalationPolicies, deactivated: false };
  if (input.dryRun) return response;

  // Care teams first (each its own transaction with channel sync and a timeline event).
  const names = new Map<string, string>([[uid, target.displayName], ...[...replMembers.values()].map((m) => [m.uid, m.displayName] as [string, string])]);
  await mapLimit(activePatients, CARE_TEAM_CONCURRENCY, (d) =>
    applyCareTeamChange({ orgId, patientId: d.id, add: careRepl ? [careRepl] : [], remove: [uid], actorUid: ctx.uid, reason: meta, names, today }),
  );
  await commitOps(orgId, ops);

  // Last: deactivate (and clear team membership on the member doc).
  const final = db().batch();
  final.update(docRef(paths.member(orgId, uid)), { active: false, teamIds: [] });
  await writeAudit(
    orgId,
    { actorUid: ctx.uid, action: 'member.offboard', resourceType: 'member', resourceId: uid, metadata: { counts, unassigned, reassignTo: repls, shiftAction: input.shiftAction, escalationPolicies: escalationPolicies.map((p) => p.id) } },
    final,
  );
  await final.commit();
  response.deactivated = true;
  return response;
}

export const offboardMember = onCall({ timeoutSeconds: 300 }, offboardMemberHandler);
