/**
 * O5: on-call coverage access to a patient's care-team channel.
 *
 * `joinPatientChannelForCoverage({patientId, reason})` — allowed when the caller
 * holds a shift for any on-call role right now, or is an admin. The caller is
 * added to the channel's `memberUids` and recorded in `coverageMembers` with
 * `until` = the end of that shift (admins without a shift: 12 hours). Audited
 * with the justification.
 *
 * `expireChannelCoverage` (hourly) removes coverage members whose `until` has
 * passed, from `coverageMembers` and from `memberUids` — unless they have
 * since joined the patient's care team. Channels are found by
 * `coverageExpiresAt` (earliest `until`), a single-field query per org.
 */
import { Timestamp } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { z } from 'zod';
import { writeAudit } from '../lib/audit';
import { tsMillis } from '../lib/care';
import { parse, requireOrg } from '../lib/context';
import { colRef, db, docRef, getDocData, paths } from '../lib/db';
import { id } from '../lib/schemas';
import type {
  Channel,
  CoverageMember,
  JoinPatientChannelForCoverageRequest,
  JoinPatientChannelForCoverageResponse,
  Patient,
  Shift,
  TimestampLike,
} from '../shared/types';

/** Coverage length for an admin who is not on shift. */
export const ADMIN_COVERAGE_HOURS = 12;
/** Longest coverage granted from one shift (guards against mis-entered multi-day shifts). */
export const MAX_COVERAGE_HOURS = 24;

const schema = z.object({ orgId: id, patientId: id, reason: z.string().trim().min(3, 'is required').max(500) });

/** Earliest `until` among entries, or null. */
export function earliestCoverageEnd(entries: readonly Pick<CoverageMember, 'until'>[]): TimestampLike | null {
  let best: TimestampLike | null = null;
  for (const e of entries) if (!best || tsMillis(e.until) < tsMillis(best)) best = e.until;
  return best;
}

/** The caller's shift that covers `nowMs` and ends last, or null. */
export async function activeShiftFor(orgId: string, uid: string, now: Date): Promise<Shift | null> {
  const snap = await colRef(paths.shifts(orgId)).where('uid', '==', uid).where('end', '>', Timestamp.fromDate(now)).limit(50).get();
  let best: Shift | null = null;
  for (const d of snap.docs) {
    const s = d.data() as Shift;
    if (tsMillis(s.start) > now.getTime()) continue;
    if (!best || tsMillis(s.end) > tsMillis(best.end)) best = s;
  }
  return best;
}

export async function joinPatientChannelForCoverageHandler(
  request: CallableRequest<JoinPatientChannelForCoverageRequest>,
  now: Date = new Date(),
): Promise<JoinPatientChannelForCoverageResponse> {
  const input = parse(schema, request.data);
  const ctx = await requireOrg(request, input.orgId);
  const shift = await activeShiftFor(ctx.orgId, ctx.uid, now);
  if (!shift && ctx.role !== 'admin') {
    throw new HttpsError('permission-denied', 'Only the on-call clinician on shift (or an administrator) can join a care-team channel for coverage.');
  }
  const patient = await getDocData<Patient>(paths.patient(ctx.orgId, input.patientId));
  if (!patient) throw new HttpsError('not-found', 'Patient not found.');
  if (!patient.channelId) throw new HttpsError('failed-precondition', 'This patient has no care-team channel.');
  const channelId = patient.channelId;

  const cap = now.getTime() + MAX_COVERAGE_HOURS * 3_600_000;
  const untilMs = shift ? Math.min(tsMillis(shift.end), cap) : now.getTime() + ADMIN_COVERAGE_HOURS * 3_600_000;
  const until = Timestamp.fromMillis(untilMs);
  const ref = docRef(paths.channel(ctx.orgId, channelId));

  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Channel not found.');
    const channel = snap.data() as Channel;
    if (channel.type !== 'patient' || channel.patientId !== input.patientId) {
      throw new HttpsError('failed-precondition', 'That is not this patient’s care-team channel.');
    }
    const coverage = channel.coverageMembers ?? [];
    const existing = coverage.find((c) => c.uid === ctx.uid);
    if (channel.memberUids.includes(ctx.uid) && !existing) {
      return { channelId, until: null, alreadyMember: true };
    }
    const entry: CoverageMember = { uid: ctx.uid, until, reason: input.reason, roleKey: shift?.roleKey ?? null, grantedAt: Timestamp.fromDate(now) };
    const nextCoverage = [...coverage.filter((c) => c.uid !== ctx.uid), entry];
    tx.update(ref, {
      memberUids: channel.memberUids.includes(ctx.uid) ? channel.memberUids : [...channel.memberUids, ctx.uid],
      coverageMembers: nextCoverage,
      coverageExpiresAt: earliestCoverageEnd(nextCoverage),
    });
    await writeAudit(
      ctx.orgId,
      {
        actorUid: ctx.uid,
        action: 'channel.coverage_join',
        resourceType: 'channel',
        resourceId: channelId,
        patientId: input.patientId,
        // The justification is the point of a break-the-glass audit entry (audit readers only).
        metadata: { reason: input.reason, roleKey: shift?.roleKey ?? null, untilMs, adminOverride: !shift, extended: !!existing },
      },
      tx,
    );
    return { channelId, until: new Date(untilMs).toISOString(), alreadyMember: false };
  });
}

/** Removes expired coverage members from one channel. Returns how many were removed. */
export async function expireChannelCoverage(orgId: string, channelId: string, now: Date): Promise<number> {
  const ref = docRef(paths.channel(orgId, channelId));
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return 0;
    const channel = snap.data() as Channel;
    const coverage = channel.coverageMembers ?? [];
    const expired = coverage.filter((c) => tsMillis(c.until) <= now.getTime());
    const kept = coverage.filter((c) => tsMillis(c.until) > now.getTime());
    if (expired.length === 0) {
      const next = earliestCoverageEnd(kept);
      const current = channel.coverageExpiresAt ?? null;
      const same = next === null ? current === null : current !== null && tsMillis(next) === tsMillis(current);
      if (!same) tx.update(ref, { coverageExpiresAt: next });
      return 0;
    }
    let careTeam: string[] = [];
    if (channel.patientId) {
      const p = await tx.get(docRef(paths.patient(orgId, channel.patientId)));
      careTeam = p.exists ? ((p.data() as Patient).careTeamUids ?? []) : [];
    }
    const drop = new Set(expired.map((c) => c.uid).filter((u) => !careTeam.includes(u)));
    tx.update(ref, {
      memberUids: channel.memberUids.filter((u) => !drop.has(u)),
      coverageMembers: kept,
      coverageExpiresAt: earliestCoverageEnd(kept),
    });
    await writeAudit(
      orgId,
      {
        actorUid: 'system',
        action: 'channel.coverage_expire',
        resourceType: 'channel',
        resourceId: channelId,
        patientId: channel.patientId ?? null,
        metadata: { removed: [...drop], keptOnCareTeam: expired.length - drop.size },
      },
      tx,
    );
    return drop.size;
  });
}

export async function runCoverageExpiry(now: Date): Promise<{ channels: number; removed: number }> {
  const orgs = await db().collection('orgs').get();
  const out = { channels: 0, removed: 0 };
  for (const org of orgs.docs) {
    try {
      const due = await colRef(paths.channels(org.id)).where('coverageExpiresAt', '<=', Timestamp.fromDate(now)).limit(200).get();
      for (const ch of due.docs) {
        out.removed += await expireChannelCoverage(org.id, ch.id, now);
        out.channels++;
      }
    } catch (e) {
      logger.error('coverage expiry failed for org', { orgId: org.id, code: (e as { code?: unknown })?.code ?? (e as Error)?.name ?? 'unknown' });
    }
  }
  return out;
}

export const joinPatientChannelForCoverage = onCall((req: CallableRequest<JoinPatientChannelForCoverageRequest>) => joinPatientChannelForCoverageHandler(req));

export const expireChannelCoverageJob = onSchedule({ schedule: '5 * * * *', timeZone: 'UTC', retryCount: 1 }, async () => {
  const res = await runCoverageExpiry(new Date());
  if (res.channels > 0) logger.info('channel coverage expired', res);
});
