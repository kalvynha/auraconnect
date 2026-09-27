/**
 * Bereavement callables. Plans are created by `recordDeath` (lifecycle/endOfCare.ts).
 *  - `updateBereavementContact`: one contact.
 *  - `updateBereavementContacts`: bulk (≤ 200 contacts), one transaction per plan.
 *  - `updateBereavementPlan`: coordinator, risk, status, survivors.
 *  - `reassessBereavementRisk`: appends to `riskHistory`; `high` adds the high-risk contacts.
 *
 * Permissions (security finding H4): admin or the `bereavement` capability, an SW or
 * Chaplain, or the plan's coordinator (`assignedUid`). See `canWorkBereavementPlan`.
 * Audit metadata never carries names or notes (PHI).
 */
import { FieldValue, Timestamp, type Transaction } from 'firebase-admin/firestore';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { todayInTimeZone } from '../domain/dates';
import {
  canWorkBereavementPlan,
  highRiskAdditions,
  pendingContact,
  primaryContactFrom,
  sortContacts,
} from '../domain/bereavement';
import { writeAudit } from '../lib/audit';
import { carePaths, requireOrgDoc } from '../lib/care';
import { mapLimit } from '../lib/concurrency';
import { parse, requireOrg, type OrgContext } from '../lib/context';
import { db, docRef } from '../lib/db';
import { assertActiveMembers } from '../lib/members';
import { id } from '../lib/schemas';
import type {
  BereavementContact,
  BereavementContactStatus,
  BereavementPlan,
  BereavementRisk,
  BereavementRiskChange,
  BereavementSurvivor,
  ReassessBereavementRiskRequest,
  ReassessBereavementRiskResponse,
  UpdateBereavementContactRequest,
  UpdateBereavementContactsRequest,
  UpdateBereavementContactsResponse,
  UpdateBereavementPlanRequest,
} from '../shared/types';

export const MAX_BULK_CONTACTS = 200;
export const MAX_SURVIVORS = 20;

const risk = z.enum(['low', 'moderate', 'high']);
const contactStatus = z.enum(['pending', 'done', 'skipped']);
const note = z.string().trim().max(2000);
const ns = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .default(null)
    .transform((v) => (v ? v : null));

const address = z
  .object({ line1: ns(200), line2: ns(200), city: ns(100), state: ns(50), zip: ns(20) })
  .default({});

export const survivorSchema = z.object({
  id: id.optional(),
  name: z.string().trim().min(1).max(200),
  relationship: ns(100),
  phone: ns(40),
  email: ns(200).refine((v) => v === null || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), 'must be an email address'),
  address,
  preferredContact: z.enum(['phone', 'mail', 'email']).default('mail'),
  doNotContact: z.boolean().default(false),
  isPrimary: z.boolean().default(false),
});

export const survivorsSchema = z
  .array(survivorSchema)
  .max(MAX_SURVIVORS)
  .superRefine((list, ctx) => {
    if (list.filter((s) => s.isPrimary).length > 1) ctx.addIssue({ code: 'custom', message: 'At most one survivor can be primary.' });
    const ids = list.map((s) => s.id).filter(Boolean);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'Survivor ids must be unique.' });
    for (const s of list) {
      if (s.preferredContact === 'email' && !s.email) ctx.addIssue({ code: 'custom', message: 'A survivor who prefers email needs an email address.' });
    }
  });

const contactSchema = z.object({
  orgId: id,
  planId: id,
  contactId: id,
  status: contactStatus,
  note: note.optional(),
});
const bulkSchema = z.object({
  orgId: id,
  items: z.array(z.object({ planId: id, contactId: id })).min(1).max(MAX_BULK_CONTACTS),
  status: contactStatus,
  note: note.optional(),
});
const planSchema = z.object({
  orgId: id,
  planId: id,
  assignedUid: id.nullable().optional(),
  riskLevel: risk.optional(),
  status: z.enum(['active', 'closed']).optional(),
  survivors: survivorsSchema.optional(),
});
const reassessSchema = z.object({
  orgId: id,
  planId: id,
  level: risk,
  note: note.min(1, 'A reassessment note is required.'),
});

/** Throws permission-denied unless the caller may work `plan`. */
export function assertCanWorkPlan(ctx: OrgContext, plan: Pick<BereavementPlan, 'assignedUid'>): void {
  if (!canWorkBereavementPlan(ctx.member, ctx.uid, plan)) {
    throw new HttpsError(
      'permission-denied',
      'Only the plan’s coordinator, a social worker or chaplain, or someone with the "bereavement" permission can do this.',
    );
  }
}

/** New state of one contact. `completedAt/By` are kept when the status does not change. */
export function applyContactStatus(prev: BereavementContact, status: BereavementContactStatus, noteText: string | undefined, uid: string, now: Timestamp): BereavementContact {
  const handled = status !== 'pending';
  const same = prev.status === status;
  return {
    ...prev,
    status,
    // serverTimestamp() is not allowed inside arrays.
    completedAt: handled ? (same && prev.completedAt ? prev.completedAt : now) : null,
    completedBy: handled ? (same && prev.completedBy ? prev.completedBy : uid) : null,
    note: noteText !== undefined ? noteText || null : prev.note,
  };
}

/**
 * Updates `contactIds` of one plan in one transaction. Returns the ids updated and the ids
 * not found. Throws (not-found / failed-precondition / permission-denied) for plan-level
 * problems.
 */
export async function updatePlanContacts(
  ctx: OrgContext,
  planId: string,
  contactIds: readonly string[],
  status: BereavementContactStatus,
  noteText: string | undefined,
  opts: { onlyPending?: boolean; via?: string } = {},
): Promise<{ updated: string[]; missing: string[] }> {
  const ref = docRef(carePaths.bereavementPlan(ctx.orgId, planId));
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Bereavement plan not found.');
    const plan = snap.data() as BereavementPlan;
    assertCanWorkPlan(ctx, plan);
    if (plan.status !== 'active') throw new HttpsError('failed-precondition', 'The bereavement plan is closed.');
    const wanted = new Set(contactIds);
    const present = new Set((plan.contacts ?? []).map((c) => c.id));
    const missing = [...wanted].filter((c) => !present.has(c));
    const updated: string[] = [];
    const now = Timestamp.now();
    const contacts = (plan.contacts ?? []).map((c) => {
      if (!wanted.has(c.id)) return c;
      if (opts.onlyPending && c.status !== 'pending') return c;
      updated.push(c.id);
      return applyContactStatus(c, status, noteText, ctx.uid, now);
    });
    if (updated.length === 0) return { updated, missing };
    tx.update(ref, { contacts, updatedAt: FieldValue.serverTimestamp() });
    await writeAudit(
      ctx.orgId,
      {
        actorUid: ctx.uid,
        action: 'bereavement.update',
        resourceType: 'bereavementPlan',
        resourceId: planId,
        patientId: plan.patientId,
        metadata: {
          ...(updated.length === 1 ? { contactId: updated[0] } : { contactIds: updated }),
          status,
          ...(opts.via ? { via: opts.via } : {}),
        },
      },
      tx,
    );
    return { updated, missing };
  });
}

export async function updateBereavementContactHandler(request: CallableRequest<UpdateBereavementContactRequest>): Promise<Record<string, never>> {
  const input = parse(contactSchema, request.data);
  const ctx = await requireOrg(request, input.orgId);
  const res = await updatePlanContacts(ctx, input.planId, [input.contactId], input.status, input.note);
  if (res.missing.length) throw new HttpsError('not-found', 'Contact not found.');
  return {};
}

export async function updateBereavementContactsHandler(request: CallableRequest<UpdateBereavementContactsRequest>): Promise<UpdateBereavementContactsResponse> {
  const input = parse(bulkSchema, request.data);
  const ctx = await requireOrg(request, input.orgId);
  const byPlan = new Map<string, string[]>();
  for (const it of input.items) {
    const list = byPlan.get(it.planId) ?? [];
    if (!list.includes(it.contactId)) list.push(it.contactId);
    byPlan.set(it.planId, list);
  }
  const failed: UpdateBereavementContactsResponse['failed'] = [];
  let updated = 0;
  await mapLimit([...byPlan.entries()], 8, async ([planId, contactIds]) => {
    try {
      const res = await updatePlanContacts(ctx, planId, contactIds, input.status, input.note, { via: 'bulk' });
      updated += res.updated.length;
      for (const c of res.missing) failed.push({ planId, contactId: c, reason: 'Contact not found.' });
    } catch (e) {
      const reason = e instanceof HttpsError ? e.message : 'Update failed.';
      for (const c of contactIds) failed.push({ planId, contactId: c, reason });
    }
  });
  return { updated, failed };
}

/** Normalizes validated survivors: ids assigned, missing address keys filled. */
export function normalizeSurvivors(list: z.infer<typeof survivorsSchema>): BereavementSurvivor[] {
  const used = new Set(list.map((s) => s.id).filter((x): x is string => !!x));
  let n = 1;
  return list.map((s) => {
    let sid = s.id;
    if (!sid) {
      while (used.has(`s${n}`)) n++;
      sid = `s${n}`;
      used.add(sid);
    }
    return { ...s, id: sid };
  });
}

/**
 * Applies a risk-level change inside a transaction's write phase: appends to
 * `riskHistory` and, for `high`, appends the missing high-risk contacts. Returns the
 * update fields and the added contact ids.
 */
export function riskChangeUpdate(
  plan: BereavementPlan,
  level: BereavementRisk,
  noteText: string | null,
  uid: string,
  today: string,
  opts: { completeAssessment?: boolean } = {},
): { update: Record<string, unknown>; added: string[] } {
  const additions = highRiskAdditions(plan.deathDate, level, (plan.contacts ?? []).map((c) => c.id), today);
  const now = Timestamp.now();
  let contacts = [...(plan.contacts ?? []), ...additions.map(pendingContact)];
  if (opts.completeAssessment) {
    // The reassessment itself fulfills the earliest pending assessment contact.
    const target = sortContacts(contacts.filter((c) => c.type === 'assessment' && c.status === 'pending'))[0];
    if (target) contacts = contacts.map((c) => (c.id === target.id ? applyContactStatus(c, 'done', noteText ?? undefined, uid, now) : c));
  }
  const entry: BereavementRiskChange = {
    level,
    previous: plan.riskLevel,
    note: noteText,
    at: now,
    by: uid,
    addedContactIds: additions.map((c) => c.id),
  };
  return {
    update: {
      riskLevel: level,
      riskHistory: [...(plan.riskHistory ?? []), entry],
      contacts: sortContacts(contacts),
    },
    added: entry.addedContactIds,
  };
}

async function orgToday(orgId: string): Promise<string> {
  const org = await requireOrgDoc(orgId);
  return todayInTimeZone(new Date(), org.timezone || 'UTC');
}

export async function updateBereavementPlanHandler(request: CallableRequest<UpdateBereavementPlanRequest>): Promise<Record<string, never>> {
  const input = parse(planSchema, request.data);
  const ctx = await requireOrg(request, input.orgId);
  if (input.assignedUid) await assertActiveMembers(ctx.orgId, [input.assignedUid]);
  const today = input.riskLevel ? await orgToday(ctx.orgId) : '';
  const ref = docRef(carePaths.bereavementPlan(ctx.orgId, input.planId));
  await db().runTransaction(async (tx: Transaction) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Bereavement plan not found.');
    const plan = snap.data() as BereavementPlan;
    assertCanWorkPlan(ctx, plan);
    let update: Record<string, unknown> = {};
    const changed: string[] = [];
    if (input.assignedUid !== undefined && input.assignedUid !== plan.assignedUid) {
      update.assignedUid = input.assignedUid;
      changed.push('assignedUid');
    }
    let added: string[] = [];
    if (input.riskLevel !== undefined && input.riskLevel !== plan.riskLevel) {
      if (plan.status !== 'active') throw new HttpsError('failed-precondition', 'The bereavement plan is closed.');
      const r = riskChangeUpdate(plan, input.riskLevel, null, ctx.uid, today);
      update = { ...update, ...r.update };
      added = r.added;
      changed.push('riskLevel');
    }
    if (input.status !== undefined && input.status !== plan.status) {
      update.status = input.status;
      update.needsReview = false;
      update.closedAt = input.status === 'closed' ? FieldValue.serverTimestamp() : null;
      update.closedBy = input.status === 'closed' ? ctx.uid : null;
      changed.push('status');
    }
    if (input.survivors !== undefined) {
      const survivors = normalizeSurvivors(input.survivors);
      update.survivors = survivors;
      update.primaryContact = primaryContactFrom(survivors);
      changed.push('survivors');
    }
    if (changed.length === 0) return;
    tx.update(ref, { ...update, updatedAt: FieldValue.serverTimestamp() });
    await writeAudit(
      ctx.orgId,
      {
        actorUid: ctx.uid,
        action: 'bereavement.update',
        resourceType: 'bereavementPlan',
        resourceId: input.planId,
        patientId: plan.patientId,
        metadata: {
          fields: changed,
          ...(input.riskLevel && changed.includes('riskLevel') ? { riskLevel: input.riskLevel, addedContacts: added.length } : {}),
          ...(input.status && changed.includes('status') ? { status: input.status } : {}),
          ...(input.survivors ? { survivorCount: input.survivors.length } : {}),
        },
      },
      tx,
    );
  });
  return {};
}

export async function reassessBereavementRiskHandler(request: CallableRequest<ReassessBereavementRiskRequest>): Promise<ReassessBereavementRiskResponse> {
  const input = parse(reassessSchema, request.data);
  const ctx = await requireOrg(request, input.orgId);
  const today = await orgToday(ctx.orgId);
  const ref = docRef(carePaths.bereavementPlan(ctx.orgId, input.planId));
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Bereavement plan not found.');
    const plan = snap.data() as BereavementPlan;
    assertCanWorkPlan(ctx, plan);
    if (plan.status !== 'active') throw new HttpsError('failed-precondition', 'The bereavement plan is closed.');
    const { update, added } = riskChangeUpdate(plan, input.level, input.note, ctx.uid, today, { completeAssessment: true });
    tx.update(ref, { ...update, updatedAt: FieldValue.serverTimestamp() });
    await writeAudit(
      ctx.orgId,
      {
        actorUid: ctx.uid,
        action: 'bereavement.reassess',
        resourceType: 'bereavementPlan',
        resourceId: input.planId,
        patientId: plan.patientId,
        metadata: { level: input.level, previous: plan.riskLevel, addedContacts: added.length },
      },
      tx,
    );
    return { addedContactIds: added };
  });
}

export const updateBereavementContact = onCall(updateBereavementContactHandler);
export const updateBereavementContacts = onCall(updateBereavementContactsHandler);
export const updateBereavementPlan = onCall(updateBereavementPlanHandler);
export const reassessBereavementRisk = onCall(reassessBereavementRiskHandler);
