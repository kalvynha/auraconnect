import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { normalizeUids } from '../domain/channels';
import { parse, requireOrg, WRITER_ROLES } from '../lib/context';
import { getDocData, paths } from '../lib/db';
import { assertActiveMembers } from '../lib/members';
import { id, priority, uidList } from '../lib/schemas';
import { resolveOnCall } from '../scheduling/resolveOnCall';
import type { CreateAlertRequest, CreateAlertResponse, EscalationPolicy, Patient } from '../shared/types';
import { raiseAlert } from './raiseAlert';

const schema = z
  .object({
    orgId: id,
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().max(2000).default(''),
    priority,
    targetUids: uidList(200).optional(),
    roleKey: id.optional(),
    policyId: id.optional(),
    patientId: id.optional(),
  })
  .refine((v) => (v.targetUids?.length ?? 0) > 0 || !!v.roleKey, 'targetUids or roleKey is required');

export async function createAlertHandler(request: CallableRequest<CreateAlertRequest>): Promise<CreateAlertResponse> {
  const input = parse(schema, request.data);
  const ctx = requireOrg(request, input.orgId, WRITER_ROLES);

  let targets = [...(input.targetUids ?? [])];
  if (input.roleKey) {
    const res = await resolveOnCall(ctx.orgId, input.roleKey, { excludeUid: ctx.uid });
    if (!res.role) throw new HttpsError('not-found', 'Unknown on-call role.');
    targets.push(...res.uids);
  }
  targets = normalizeUids(targets);
  if (targets.length === 0) throw new HttpsError('failed-precondition', 'Nobody is available to receive this alert.');
  await assertActiveMembers(ctx.orgId, targets);

  if (input.policyId && !(await getDocData<EscalationPolicy>(paths.escalationPolicy(ctx.orgId, input.policyId)))) {
    throw new HttpsError('not-found', 'Unknown escalation policy.');
  }
  if (input.patientId && !(await getDocData<Patient>(paths.patient(ctx.orgId, input.patientId)))) {
    throw new HttpsError('not-found', 'Unknown patient.');
  }

  const { alertId } = await raiseAlert({
    orgId: ctx.orgId,
    title: input.title,
    body: input.body,
    priority: input.priority,
    source: { type: 'manual', patientId: input.patientId ?? null },
    targetUids: targets,
    policyId: input.policyId ?? 'default',
    createdBy: ctx.uid,
  });
  return { alertId };
}

export const createAlert = onCall(createAlertHandler);
