import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { directChannelId, normalizeUids } from '../domain/channels';
import { writeAudit } from '../lib/audit';
import { parse, requireOrg, WRITER_ROLES } from '../lib/context';
import { colRef, db, docRef, getDocData, paths } from '../lib/db';
import { assertActiveMembers } from '../lib/members';
import { id, uidList } from '../lib/schemas';
import type { ChannelType, CreateChannelRequest, CreateChannelResponse, Team } from '../shared/types';

const schema = z.object({
  orgId: id,
  type: z.enum(['direct', 'group', 'team']),
  memberUids: uidList(500).default([]),
  name: z.string().trim().min(1).max(100).optional(),
  teamId: id.optional(),
});

export function newChannelDoc(p: {
  type: ChannelType;
  name: string | null;
  memberUids: string[];
  createdBy: string;
  patientId?: string | null;
  teamId?: string | null;
}) {
  const now = FieldValue.serverTimestamp();
  return {
    type: p.type,
    name: p.name,
    memberUids: normalizeUids(p.memberUids),
    patientId: p.patientId ?? null,
    teamId: p.teamId ?? null,
    createdBy: p.createdBy,
    createdAt: now,
    lastMessage: null,
    lastMessageAt: now,
    archived: false,
  };
}

/** Creates (or returns the existing) `dm_{min}_{max}` channel. Members must already be validated. */
export async function ensureDirectChannel(orgId: string, a: string, b: string, createdBy: string): Promise<{ channelId: string; created: boolean }> {
  const channelId = directChannelId(a, b);
  const ref = docRef(paths.channel(orgId, channelId));
  const created = await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) return false;
    tx.create(ref, newChannelDoc({ type: 'direct', name: null, memberUids: [a, b], createdBy }));
    await writeAudit(orgId, { actorUid: createdBy, action: 'channel.create', resourceType: 'channel', resourceId: channelId, metadata: { type: 'direct' } }, tx);
    return true;
  });
  return { channelId, created };
}

export async function createChannelHandler(request: CallableRequest<CreateChannelRequest>): Promise<CreateChannelResponse> {
  const input = parse(schema, request.data);
  const ctx = requireOrg(request, input.orgId, WRITER_ROLES);

  let members = [...input.memberUids];
  let teamId: string | null = null;
  if (input.type === 'team') {
    if (!input.teamId) throw new HttpsError('invalid-argument', 'teamId is required for team channels.');
    const team = await getDocData<Team>(paths.team(ctx.orgId, input.teamId));
    if (!team) throw new HttpsError('not-found', 'Team not found.');
    teamId = input.teamId;
    if (members.length === 0) members = [...(team.memberUids ?? [])];
  }
  members = normalizeUids([...members, ctx.uid]);
  await assertActiveMembers(ctx.orgId, members);

  if (input.type === 'direct') {
    if (members.length !== 2) throw new HttpsError('invalid-argument', 'A direct channel has exactly two members.');
    const other = members.find((u) => u !== ctx.uid)!;
    const { channelId } = await ensureDirectChannel(ctx.orgId, ctx.uid, other, ctx.uid);
    return { channelId };
  }

  if (!input.name) throw new HttpsError('invalid-argument', 'name is required for group and team channels.');
  const ref = colRef(paths.channels(ctx.orgId)).doc();
  const batch = db().batch();
  batch.set(ref, newChannelDoc({ type: input.type, name: input.name, memberUids: members, createdBy: ctx.uid, teamId }));
  await writeAudit(
    ctx.orgId,
    { actorUid: ctx.uid, action: 'channel.create', resourceType: 'channel', resourceId: ref.id, metadata: { type: input.type, members: members.length } },
    batch,
  );
  await batch.commit();
  return { channelId: ref.id };
}

export const createChannel = onCall(createChannelHandler);
