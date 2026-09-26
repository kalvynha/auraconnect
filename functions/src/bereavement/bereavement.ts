/** `updateBereavementContact`, `updateBereavementPlan`. Plans are created by `recordDeath`. */
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { writeAudit } from '../lib/audit';
import { carePaths } from '../lib/care';
import { CLINICAL_ROLES, parse, requireOrg } from '../lib/context';
import { db, docRef } from '../lib/db';
import { assertActiveMembers } from '../lib/members';
import { id } from '../lib/schemas';
import type { BereavementContact, BereavementPlan, UpdateBereavementContactRequest, UpdateBereavementPlanRequest } from '../shared/types';

const contactSchema = z.object({
  orgId: id,
  planId: id,
  contactId: id,
  status: z.enum(['pending', 'done', 'skipped']),
  note: z.string().trim().max(2000).optional(),
});
const planSchema = z.object({
  orgId: id,
  planId: id,
  assignedUid: id.nullable().optional(),
  riskLevel: z.enum(['low', 'moderate', 'high']).optional(),
  status: z.enum(['active', 'closed']).optional(),
});

export async function updateBereavementContactHandler(request: CallableRequest<UpdateBereavementContactRequest>): Promise<Record<string, never>> {
  const input = parse(contactSchema, request.data);
  const ctx = requireOrg(request, input.orgId, CLINICAL_ROLES);
  const ref = docRef(carePaths.bereavementPlan(ctx.orgId, input.planId));
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Bereavement plan not found.');
    const plan = snap.data() as BereavementPlan;
    if (plan.status !== 'active') throw new HttpsError('failed-precondition', 'The bereavement plan is closed.');
    const idx = plan.contacts.findIndex((c) => c.id === input.contactId);
    if (idx < 0) throw new HttpsError('not-found', 'Contact not found.');
    const prev = plan.contacts[idx]!;
    const handled = input.status !== 'pending';
    const next: BereavementContact = {
      ...prev,
      status: input.status,
      // serverTimestamp() is not allowed inside arrays.
      completedAt: handled ? (prev.status === input.status && prev.completedAt ? prev.completedAt : Timestamp.now()) : null,
      completedBy: handled ? (prev.status === input.status && prev.completedBy ? prev.completedBy : ctx.uid) : null,
      note: input.note !== undefined ? input.note || null : prev.note,
    };
    const contacts = plan.contacts.map((c, i) => (i === idx ? next : c));
    tx.update(ref, { contacts, updatedAt: FieldValue.serverTimestamp() });
    await writeAudit(
      ctx.orgId,
      {
        actorUid: ctx.uid,
        action: 'bereavement.update',
        resourceType: 'bereavementPlan',
        resourceId: input.planId,
        patientId: plan.patientId,
        metadata: { contactId: input.contactId, status: input.status },
      },
      tx,
    );
  });
  return {};
}

export async function updateBereavementPlanHandler(request: CallableRequest<UpdateBereavementPlanRequest>): Promise<Record<string, never>> {
  const input = parse(planSchema, request.data);
  const ctx = requireOrg(request, input.orgId, CLINICAL_ROLES);
  if (input.assignedUid) await assertActiveMembers(ctx.orgId, [input.assignedUid]);
  const ref = docRef(carePaths.bereavementPlan(ctx.orgId, input.planId));
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Bereavement plan not found.');
    const plan = snap.data() as BereavementPlan;
    const update: Record<string, unknown> = {};
    for (const k of ['assignedUid', 'riskLevel', 'status'] as const) {
      if (input[k] !== undefined && input[k] !== plan[k]) update[k] = input[k];
    }
    const changed = Object.keys(update);
    if (changed.length === 0) return;
    tx.update(ref, { ...update, updatedAt: FieldValue.serverTimestamp() });
    await writeAudit(
      ctx.orgId,
      { actorUid: ctx.uid, action: 'bereavement.update', resourceType: 'bereavementPlan', resourceId: input.planId, patientId: plan.patientId, metadata: { fields: changed } },
      tx,
    );
  });
  return {};
}

export const updateBereavementContact = onCall(updateBereavementContactHandler);
export const updateBereavementPlan = onCall(updateBereavementPlanHandler);
