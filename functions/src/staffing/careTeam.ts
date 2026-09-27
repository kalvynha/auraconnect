/**
 * `updateCareTeam` (L1 / S2): add or remove care-team members after admission.
 *
 * Allowed for admins, `staffing` holders, and RN/NP/MD members already on the patient's
 * care team. One transaction updates `patient.careTeamUids`, keeps the patient channel's
 * `memberUids` in sync (added members join; removed members leave, and lose any temporary
 * coverage entry), appends a `care_team_change` timeline event and writes a
 * `patient.care_team` audit entry. Offboarding reuses `applyCareTeamChange`.
 */
import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { careTeamDiff, mergeCareTeam, MAX_CARE_TEAM } from '../domain/staffing';
import { todayInTimeZone } from '../domain/dates';
import { earliestCoverageEnd } from '../messaging/coverage';
import { writeAudit } from '../lib/audit';
import { appendPatientEvent, orgSettings } from '../lib/care';
import { parse, requireOrg } from '../lib/context';
import { db, docRef, getDocData, paths } from '../lib/db';
import { assertActiveMembers } from '../lib/members';
import { memberHasCapability } from '../lib/permissions';
import { id, uidList } from '../lib/schemas';
import {
  LICENSED_DISCIPLINES,
  type Channel,
  type Member,
  type Org,
  type Patient,
  type UpdateCareTeamRequest,
  type UpdateCareTeamResponse,
} from '../shared/types';

const schema = z
  .object({ orgId: id, patientId: id, add: uidList(MAX_CARE_TEAM).default([]), remove: uidList(MAX_CARE_TEAM).default([]) })
  .refine((v) => v.add.length + v.remove.length > 0, 'add or remove is required');

export interface CareTeamChangeResult {
  careTeamUids: string[];
  added: string[];
  removed: string[];
}

/** Human-readable timeline summary; member names are staff names, not PHI. */
function summarize(added: string[], removed: string[], names: Map<string, string>): string {
  const n = (u: string) => names.get(u) ?? 'a member';
  const parts: string[] = [];
  if (added.length) parts.push(`added ${added.map(n).join(', ')}`);
  if (removed.length) parts.push(`removed ${removed.map(n).join(', ')}`);
  return `Care team: ${parts.join('; ')}`;
}

/**
 * Applies a care-team change in one transaction. `authorize` (optional) runs against the
 * current patient before anything is written. Returns the new care team (unchanged when
 * the change is a no-op; nothing is written then).
 */
export async function applyCareTeamChange(p: {
  orgId: string;
  patientId: string;
  add: readonly string[];
  remove: readonly string[];
  actorUid: string;
  /** Extra audit/event metadata (e.g. `{ offboard: uid }`). */
  reason?: Record<string, unknown>;
  authorize?: (patient: Patient) => void;
  /** Display names for the timeline summary (loaded when omitted). */
  names?: Map<string, string>;
  /** Org-local "today" for the event date (loaded when omitted). */
  today?: string;
}): Promise<CareTeamChangeResult> {
  const today = p.today ?? todayInTimeZone(new Date(), orgSettings(await getDocData<Org>(paths.org(p.orgId))).timezone);
  let names = p.names;
  if (!names) {
    const uids = [...new Set([...p.add, ...p.remove])];
    const docs = await Promise.all(uids.map((u) => getDocData<Member>(paths.member(p.orgId, u))));
    names = new Map(uids.map((u, i) => [u, docs[i]?.displayName ?? 'a member']));
  }
  const patientRef = docRef(paths.patient(p.orgId, p.patientId));
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(patientRef);
    if (!snap.exists) throw new HttpsError('not-found', 'Patient not found.');
    const patient = snap.data() as Patient;
    p.authorize?.(patient);
    const before = patient.careTeamUids ?? [];
    const after = mergeCareTeam(before, p.add, p.remove);
    if (after.length > MAX_CARE_TEAM) throw new HttpsError('invalid-argument', `A care team can have at most ${MAX_CARE_TEAM} members.`);
    const diff = careTeamDiff(before, after);
    if (diff.added.length === 0 && diff.removed.length === 0) return { careTeamUids: before, added: [], removed: [] };

    const channelRef = patient.channelId ? docRef(paths.channel(p.orgId, patient.channelId)) : null;
    const chSnap = channelRef ? await tx.get(channelRef) : null;

    tx.update(patientRef, { careTeamUids: after, updatedAt: FieldValue.serverTimestamp() });
    if (channelRef && chSnap?.exists) {
      const ch = chSnap.data() as Channel;
      const rm = new Set(diff.removed);
      const members = [...new Set([...(ch.memberUids ?? []).filter((u) => !rm.has(u)), ...diff.added])];
      const update: Record<string, unknown> = { memberUids: members };
      const touched = new Set([...diff.added, ...diff.removed]);
      const coverage = ch.coverageMembers ?? [];
      if (coverage.some((c) => touched.has(c.uid))) {
        const kept = coverage.filter((c) => !touched.has(c.uid));
        update.coverageMembers = kept;
        update.coverageExpiresAt = earliestCoverageEnd(kept);
      }
      tx.update(channelRef, update);
    }
    appendPatientEvent(tx, p.orgId, p.patientId, {
      type: 'care_team_change',
      date: today,
      recordedBy: p.actorUid,
      summary: summarize(diff.added, diff.removed, names!),
      details: { added: diff.added, removed: diff.removed, ...(p.reason ?? {}) },
    });
    await writeAudit(
      p.orgId,
      {
        actorUid: p.actorUid,
        action: 'patient.care_team',
        resourceType: 'patient',
        resourceId: p.patientId,
        patientId: p.patientId,
        metadata: { added: diff.added, removed: diff.removed, ...(p.reason ?? {}) },
      },
      tx,
    );
    return { careTeamUids: after, ...diff };
  });
}

export async function updateCareTeamHandler(request: CallableRequest<UpdateCareTeamRequest>): Promise<UpdateCareTeamResponse> {
  const input = parse(schema, request.data);
  const ctx = await requireOrg(request, input.orgId);
  if (input.add.length) await assertActiveMembers(ctx.orgId, input.add);
  const privileged = memberHasCapability(ctx.member, 'staffing');
  const licensed = LICENSED_DISCIPLINES.includes(ctx.member.discipline) && ctx.role !== 'viewer';
  if (!privileged && !licensed) {
    throw new HttpsError('permission-denied', 'Only an administrator, a staffing coordinator or an RN/NP/MD on the care team can change it.');
  }
  const res = await applyCareTeamChange({
    orgId: ctx.orgId,
    patientId: input.patientId,
    add: input.add,
    remove: input.remove,
    actorUid: ctx.uid,
    authorize: (patient) => {
      if (patient.status !== 'admitted' && patient.status !== 'referral') {
        throw new HttpsError('failed-precondition', 'The care team can only be changed for active patients.');
      }
      if (!privileged && !(patient.careTeamUids ?? []).includes(ctx.uid)) {
        throw new HttpsError('permission-denied', 'Only an administrator, a staffing coordinator or an RN/NP/MD on the care team can change it.');
      }
    },
  });
  return { careTeamUids: res.careTeamUids };
}

export const updateCareTeam = onCall(updateCareTeamHandler);
