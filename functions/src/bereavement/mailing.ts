/**
 * `exportBereavementMailing`: mailing rows for pending letters (or other contact types)
 * due in a date range, for survivors who accept mail/email and are not do-not-contact.
 * With `markDone`, the exported contacts are marked done (one transaction per plan).
 *
 * Scope: admins, the `bereavement` capability, SWs and chaplains see every active plan;
 * anyone else only the plans they coordinate. Reads: the active plans (paged, capped at
 * {@link MAX_MAILING_PLANS}). The rows contain names and addresses: they are returned to
 * the caller only, never logged or audited.
 */
import type { DocumentSnapshot, Query } from 'firebase-admin/firestore';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { diffDays } from '../domain/dates';
import { buildMailingRows, canWorkAllBereavementPlans, contactsByPlan, type MailingPlan } from '../domain/bereavement';
import { writeAudit } from '../lib/audit';
import { carePaths } from '../lib/care';
import { mapLimit } from '../lib/concurrency';
import { parse, requireOrg, type OrgContext } from '../lib/context';
import { colRef } from '../lib/db';
import { id, isoDate } from '../lib/schemas';
import type { BereavementPlan, ExportBereavementMailingRequest, ExportBereavementMailingResponse } from '../shared/types';
import { updatePlanContacts } from './bereavement';

export const MAX_MAILING_RANGE_DAYS = 92;
export const MAX_MAILING_PLANS = 2000;
const PAGE = 500;

const schema = z
  .object({
    orgId: id,
    from: isoDate,
    to: isoDate,
    types: z.array(z.enum(['call', 'letter', 'visit', 'mailing', 'assessment'])).min(1).max(5).default(['letter']),
    markDone: z.boolean().default(false),
  })
  .refine((v) => v.from <= v.to, 'from must not be after to')
  .refine((v) => diffDays(v.from, v.to) <= MAX_MAILING_RANGE_DAYS, `The range can be at most ${MAX_MAILING_RANGE_DAYS} days.`);

/** Active plans the caller may work, paged by `closesOn`. */
export async function loadActivePlansForCaller(ctx: OrgContext, cap = MAX_MAILING_PLANS): Promise<{ plans: MailingPlan[]; truncated: boolean }> {
  let base: Query = colRef(carePaths.bereavementPlans(ctx.orgId)).where('status', '==', 'active');
  if (!canWorkAllBereavementPlans(ctx.member)) base = base.where('assignedUid', '==', ctx.uid);
  base = base.orderBy('closesOn');
  const plans: MailingPlan[] = [];
  let last: DocumentSnapshot | null = null;
  for (;;) {
    const q: Query = last ? base.startAfter(last).limit(PAGE) : base.limit(PAGE);
    const snap = await q.get();
    for (const d of snap.docs) plans.push({ id: d.id, ...(d.data() as BereavementPlan) });
    if (snap.docs.length < PAGE) return { plans, truncated: false };
    if (plans.length >= cap) return { plans, truncated: true };
    last = snap.docs[snap.docs.length - 1]!;
  }
}

export async function exportBereavementMailingHandler(request: CallableRequest<ExportBereavementMailingRequest>): Promise<ExportBereavementMailingResponse> {
  const input = parse(schema, request.data);
  const ctx = await requireOrg(request, input.orgId);
  if (ctx.member.discipline === 'Volunteer' && ctx.role !== 'admin') {
    throw new HttpsError('permission-denied', 'Volunteers cannot export bereavement mailings.');
  }
  const { plans, truncated } = await loadActivePlansForCaller(ctx);
  const rows = buildMailingRows(plans, input.from, input.to, input.types);
  const byPlan = contactsByPlan(rows);
  const contactCount = [...byPlan.values()].reduce((n, l) => n + l.length, 0);

  let marked = 0;
  let failedPlans = 0;
  if (input.markDone) {
    await mapLimit([...byPlan.entries()], 8, async ([planId, contactIds]) => {
      try {
        // Only contacts still pending: a concurrent edit (skip, done by someone else) wins.
        const res = await updatePlanContacts(ctx, planId, contactIds, 'done', undefined, { onlyPending: true, via: 'mailing' });
        marked += res.updated.length;
      } catch {
        failedPlans++;
      }
    });
  }
  await writeAudit(ctx.orgId, {
    actorUid: ctx.uid,
    action: 'bereavement.mailing_export',
    resourceType: 'bereavementPlan',
    resourceId: 'mailing',
    metadata: {
      from: input.from,
      to: input.to,
      types: input.types,
      rows: rows.length,
      contacts: contactCount,
      plans: byPlan.size,
      markDone: input.markDone,
      marked,
      failedPlans,
      truncated,
    },
  });
  return { rows, contactCount, marked, truncated };
}

export const exportBereavementMailing = onCall({ timeoutSeconds: 120 }, exportBereavementMailingHandler);
