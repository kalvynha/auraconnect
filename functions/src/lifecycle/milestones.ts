/**
 * `completeMilestone` / `reopenMilestone`: maintain `patient.milestoneCompletions`.
 *
 * v3:
 *  - S5: a completion records `effectiveDate`, the actual filing date (≤ today in the org time
 *    zone); on-time is judged from it. Reopening moves the completion to `milestoneHistory[]`.
 *  - H4: completing needs a licensed member (RN/NP/MD) or an admin, except that the intake
 *    role may complete the NOE. Reopening needs a licensed member or an admin.
 *  - Completing resolves the key's open deadline alerts (upcoming and overdue).
 */
import { FieldValue, Timestamp, type Transaction } from 'firebase-admin/firestore';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { compareISO, todayInTimeZone } from '../domain/dates';
import { allMilestoneKeys, parseMilestoneKey } from '../domain/milestones';
import { writeAudit } from '../lib/audit';
import { requireOrgDoc, txPatient } from '../lib/care';
import { CLINICAL_ROLES, parse, requireOrg, type OrgContext } from '../lib/context';
import { db, docRef, paths } from '../lib/db';
import { memberIsLicensed, requireLicensed } from '../lib/permissions';
import { id, isoDate } from '../lib/schemas';
import { deadlineAlertId } from '../patients/checkDeadlines';
import type { Alert, CompleteMilestoneRequest, ISODate, MilestoneKind, ReopenMilestoneRequest } from '../shared/types';

const key = z.string().trim().min(1).max(64).refine((k) => parseMilestoneKey(k) !== null, 'must be {kind}:{YYYY-MM-DD}');
const completeSchema = z.object({
  orgId: id,
  patientId: id,
  key,
  note: z.string().trim().max(1000).optional(),
  effectiveDate: isoDate,
});
const reopenSchema = z.object({ orgId: id, patientId: id, key, reason: z.string().trim().max(1000).optional() });

/** Field path for a completion entry (keys contain only [a-z0-9_:-], which are valid path segments). */
export const completionField = (k: string) => `milestoneCompletions.${k}`;

export function completionValue(completedBy: string, note: string | null, effectiveDate: ISODate) {
  return { completedAt: FieldValue.serverTimestamp(), completedBy, note, effectiveDate };
}

/** H4: who may mark a milestone of `kind` complete. */
export function canCompleteMilestone(ctx: Pick<OrgContext, 'role' | 'member'>, kind: MilestoneKind): boolean {
  if (memberIsLicensed(ctx.member)) return true; // RN/NP/MD, or admin
  return ctx.role === 'intake' && kind === 'noe';
}

/**
 * Reads (inside a transaction) the deadline alerts for `keys` (upcoming and overdue ids) and returns
 * a function that resolves the open/acked ones in the write phase. Returns the number resolved.
 */
export async function txPrepareResolveDeadlineAlerts(tx: Transaction, orgId: string, patientId: string, keys: readonly string[]) {
  const refs = keys.flatMap((k) => [docRef(paths.alert(orgId, deadlineAlertId(patientId, k))), docRef(paths.alert(orgId, deadlineAlertId(patientId, `${k}#overdue`)))]);
  const snaps = await Promise.all(refs.map((r) => tx.get(r)));
  const open = snaps.filter((s) => s.exists && (s.data() as Alert).status !== 'resolved');
  return async (actorUid: string): Promise<number> => {
    for (const s of open) {
      const a = s.data() as Alert;
      tx.update(s.ref, {
        status: 'resolved',
        ...(a.ackedBy ? {} : { ackedBy: actorUid, ackedAt: FieldValue.serverTimestamp() }),
      });
      await writeAudit(
        orgId,
        { actorUid, action: 'alert.resolve', resourceType: 'alert', resourceId: s.id, patientId, metadata: { reason: 'milestone_completed' } },
        tx,
      );
    }
    return open.length;
  };
}

export async function completeMilestoneHandler(request: CallableRequest<CompleteMilestoneRequest>): Promise<Record<string, never>> {
  const input = parse(completeSchema, request.data);
  const ctx = await requireOrg(request, input.orgId, CLINICAL_ROLES);
  const parsed = parseMilestoneKey(input.key)!;
  if (!canCompleteMilestone(ctx, parsed.kind)) {
    throw new HttpsError(
      'permission-denied',
      ctx.role === 'intake' ? 'Intake can mark only the NOE as filed.' : 'Only an RN, NP, MD or administrator can complete this milestone.',
    );
  }
  const org = await requireOrgDoc(ctx.orgId);
  const today = todayInTimeZone(new Date(), org.timezone);
  if (compareISO(input.effectiveDate, today) > 0) {
    throw new HttpsError('invalid-argument', 'The filing date cannot be in the future.');
  }
  await db().runTransaction(async (tx) => {
    const { ref, patient } = await txPatient(tx, ctx.orgId, input.patientId);
    if (!patient.milestones) throw new HttpsError('failed-precondition', 'The patient has no milestones yet.');
    if (!allMilestoneKeys(patient.milestones).includes(input.key)) {
      throw new HttpsError('invalid-argument', 'That milestone does not belong to this patient.');
    }
    if (patient.milestoneCompletions?.[input.key]) return; // already completed: keep the original record
    const resolveAlerts = await txPrepareResolveDeadlineAlerts(tx, ctx.orgId, input.patientId, [input.key]);
    tx.update(ref, {
      [completionField(input.key)]: completionValue(ctx.uid, input.note ?? null, input.effectiveDate),
      updatedAt: FieldValue.serverTimestamp(),
    });
    const onTime = compareISO(input.effectiveDate, parsed.dueDate) <= 0;
    await writeAudit(
      ctx.orgId,
      {
        actorUid: ctx.uid,
        action: 'milestone.complete',
        resourceType: 'patient',
        resourceId: input.patientId,
        patientId: input.patientId,
        metadata: { key: input.key, effectiveDate: input.effectiveDate, onTime },
      },
      tx,
    );
    await resolveAlerts(ctx.uid);
  });
  return {};
}

export async function reopenMilestoneHandler(request: CallableRequest<ReopenMilestoneRequest>): Promise<Record<string, never>> {
  const input = parse(reopenSchema, request.data);
  const ctx = await requireOrg(request, input.orgId, CLINICAL_ROLES);
  await requireLicensed(ctx);
  await db().runTransaction(async (tx) => {
    const { ref, patient } = await txPatient(tx, ctx.orgId, input.patientId);
    const completion = patient.milestoneCompletions?.[input.key];
    if (!completion) return;
    // serverTimestamp() is not allowed inside arrays, so the history entry uses a client Timestamp.
    const entry = {
      key: input.key,
      completedAt: completion.completedAt ?? null,
      completedBy: completion.completedBy ?? null,
      note: completion.note ?? null,
      effectiveDate: completion.effectiveDate ?? null,
      reopenedAt: Timestamp.now(),
      reopenedBy: ctx.uid,
      reopenReason: input.reason || null,
    };
    tx.update(ref, {
      [completionField(input.key)]: FieldValue.delete(),
      milestoneHistory: FieldValue.arrayUnion(entry),
      updatedAt: FieldValue.serverTimestamp(),
    });
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
