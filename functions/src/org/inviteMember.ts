import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { writeAudit } from '../lib/audit';
import { parse, requireOrg } from '../lib/context';
import { colRef, getMany, paths } from '../lib/db';
import { discipline, id, role } from '../lib/schemas';
import type { InviteMemberRequest, InviteMemberResponse, Team } from '../shared/types';

const schema = z.object({
  orgId: id,
  email: z.string().trim().toLowerCase().email().max(320),
  displayName: z.string().trim().min(1).max(200),
  role,
  discipline,
  teamIds: z.array(id).max(50).optional(),
});

export async function inviteMemberHandler(request: CallableRequest<InviteMemberRequest>): Promise<InviteMemberResponse> {
  const input = parse(schema, request.data);
  const ctx = requireOrg(request, input.orgId, ['admin']);
  const teamIds = [...new Set(input.teamIds ?? [])];
  if (teamIds.length) {
    const teams = await getMany<Team>(teamIds.map((t) => paths.team(ctx.orgId, t)));
    if (teams.size !== teamIds.length) throw new HttpsError('invalid-argument', 'Unknown team.');
  }

  const existingMember = await colRef(paths.members(ctx.orgId)).where('email', '==', input.email).limit(5).get();
  if (existingMember.docs.some((d) => d.data().active === true)) {
    throw new HttpsError('already-exists', 'This person is already a member of the organization.');
  }

  const fields = { displayName: input.displayName, role: input.role, discipline: input.discipline, teamIds };
  const pending = await colRef(paths.invites(ctx.orgId))
    .where('email', '==', input.email)
    .where('status', '==', 'pending')
    .limit(1)
    .get();

  let inviteId: string;
  if (!pending.empty) {
    const doc = pending.docs[0]!;
    inviteId = doc.id;
    await doc.ref.update(fields);
  } else {
    const ref = colRef(paths.invites(ctx.orgId)).doc();
    inviteId = ref.id;
    await ref.set({
      email: input.email,
      ...fields,
      status: 'pending',
      createdBy: ctx.uid,
      createdAt: FieldValue.serverTimestamp(),
      acceptedBy: null,
      acceptedAt: null,
    });
  }
  await writeAudit(ctx.orgId, {
    actorUid: ctx.uid,
    action: 'member.invite',
    resourceType: 'invite',
    resourceId: inviteId,
    metadata: { role: input.role, updatedExisting: !pending.empty },
  });
  return { inviteId };
}

export const inviteMember = onCall(inviteMemberHandler);
