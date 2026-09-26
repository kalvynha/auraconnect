/** `completeMilestone` / `reopenMilestone`: maintain `patient.milestoneCompletions`. */
import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { allMilestoneKeys, parseMilestoneKey } from '../domain/milestones';
import { writeAudit } from '../lib/audit';
import { txPatient } from '../lib/care';
import { CLINICAL_ROLES, parse, requireOrg } from '../lib/context';
import { db } from '../lib/db';
import { id } from '../lib/schemas';
import type { CompleteMilestoneRequest, ReopenMilestoneRequest } from '../shared/types';

const key = z.string().trim().min(1).max(64).refine((k) => parseMilestoneKey(k) !== null, 'must be {kind}:{YYYY-MM-DD}');
const completeSchema = z.object({ orgId: id, patientId: id, key, note: z.string().trim().max(1000).optional() });
const reopenSchema = z.object({ orgId: id, patientId: id, key });

/** Field path for a completion entry (keys contain only [a-z0-9_:-], which are valid path segments). */
export const completionField = (k: string) => `milestoneCompletions.${k}`;

export function completionValue(completedBy: string, note: string | null) {
  return { completedAt: FieldValue.serverTimestamp(), completedBy, note };
}

export async function completeMilestoneHandler(request: CallableRequest<CompleteMilestoneRequest>): Promise<Record<string, never>> {
  const input = parse(completeSchema, request.data);
  const ctx = requireOrg(request, input.orgId, CLINICAL_ROLES);
  await db().runTransaction(async (tx) => {
    const { ref, patient } = await txPatient(tx, ctx.orgId, input.patientId);
    if (!patient.milestones) throw new HttpsError('failed-precondition', 'The patient has no milestones yet.');
    if (!allMilestoneKeys(patient.milestones).includes(input.key)) {
      throw new HttpsError('invalid-argument', 'That milestone does not belong to this patient.');
    }
    if (patient.milestoneCompletions?.[input.key]) return; // already completed: keep the original record
    tx.update(ref, {
      [completionField(input.key)]: completionValue(ctx.uid, input.note ?? null),
      updatedAt: FieldValue.serverTimestamp(),
    });
    await writeAudit(
      ctx.orgId,
      { actorUid: ctx.uid, action: 'milestone.complete', resourceType: 'patient', resourceId: input.patientId, patientId: input.patientId, metadata: { key: input.key } },
      tx,
    );
  });
  return {};
}

export async function reopenMilestoneHandler(request: CallableRequest<ReopenMilestoneRequest>): Promise<Record<string, never>> {
  const input = parse(reopenSchema, request.data);
  const ctx = requireOrg(request, input.orgId, CLINICAL_ROLES);
  await db().runTransaction(async (tx) => {
    const { ref, patient } = await txPatient(tx, ctx.orgId, input.patientId);
    if (!patient.milestoneCompletions?.[input.key]) return;
    tx.update(ref, { [completionField(input.key)]: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() });
    await writeAudit(
      ctx.orgId,
      { actorUid: ctx.uid, action: 'milestone.reopen', resourceType: 'patient', resourceId: input.patientId, patientId: input.patientId, metadata: { key: input.key } },
      tx,
    );
  });
  return {};
}

export const completeMilestone = onCall(completeMilestoneHandler);
export const reopenMilestone = onCall(reopenMilestoneHandler);
