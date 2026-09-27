import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { normalizeUids } from '../domain/channels';
import { writeAudit } from '../lib/audit';
import { parse, requireOrg, WRITER_ROLES } from '../lib/context';
import { db, docRef, paths } from '../lib/db';
import { assertActiveMembers } from '../lib/members';
import { id, uidList } from '../lib/schemas';
import type { Channel, Patient, UpdateChannelMembersRequest } from '../shared/types';
import { earliestCoverageEnd } from './coverage';

const schema = z
  .object({ orgId: id, channelId: id, add: uidList(500).default([]), remove: uidList(500).default([]) })
  .refine((v) => v.add.length + v.remove.length > 0, 'add or remove is required');

export async function updateChannelMembersHandler(request: CallableRequest<UpdateChannelMembersRequest>): Promise<Record<string, never>> {
  const input = parse(schema, request.data);
  const ctx = await requireOrg(request, input.orgId, WRITER_ROLES);
  if (input.add.length) await assertActiveMembers(ctx.orgId, input.add);
  const ref = docRef(paths.channel(ctx.orgId, input.channelId));

  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Channel not found.');
    const channel = snap.data() as Channel;
    const patientRef = channel.type === 'patient' && channel.patientId ? docRef(paths.patient(ctx.orgId, channel.patientId)) : null;
    if (!channel.memberUids.includes(ctx.uid)) throw new HttpsError('permission-denied', 'You are not a member of this channel.');
    if (channel.type === 'direct') throw new HttpsError('failed-precondition', 'Direct channel members cannot change.');
    // L6: broadcast recipients are fixed at send time; archived channels are read-only.
    if (channel.type === 'broadcast') throw new HttpsError('failed-precondition', 'Broadcast recipients cannot change.');
    if (channel.archived) throw new HttpsError('failed-precondition', 'This conversation is archived.');
    // L6: patient channel membership follows the care team; only admins or the care team may change it.
    if (channel.type === 'patient' && ctx.role !== 'admin') {
      const patient = patientRef ? await tx.get(patientRef) : null;
      const careTeam = patient?.exists ? ((patient.data() as Patient).careTeamUids ?? []) : [];
      if (!careTeam.includes(ctx.uid)) {
        throw new HttpsError('permission-denied', 'Only an administrator or the patient’s care team can change this channel’s members.');
      }
    }
    const removeSet = new Set(input.remove);
    const next = normalizeUids([...channel.memberUids, ...input.add]).filter((u) => !removeSet.has(u));
    if (next.length === 0) throw new HttpsError('failed-precondition', 'A channel needs at least one member.');
    const update: Record<string, unknown> = { memberUids: next };
    // O5: anyone added or removed explicitly is no longer a temporary coverage member.
    const touched = new Set([...input.add, ...input.remove]);
    const coverage = channel.coverageMembers ?? [];
    if (coverage.some((c) => touched.has(c.uid))) {
      const kept = coverage.filter((c) => !touched.has(c.uid));
      update.coverageMembers = kept;
      update.coverageExpiresAt = earliestCoverageEnd(kept);
    }
    tx.update(ref, update);
    await writeAudit(
      ctx.orgId,
      {
        actorUid: ctx.uid,
        action: 'channel.members.update',
        resourceType: 'channel',
        resourceId: input.channelId,
        patientId: channel.patientId,
        metadata: { added: input.add, removed: input.remove },
      },
      tx,
    );
  });
  return {};
}

export const updateChannelMembers = onCall(updateChannelMembersHandler);
