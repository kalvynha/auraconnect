import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { compareISO } from '../domain/dates';
import { computeBenefitPeriods, milestoneKey } from '../domain/milestones';
import { writeAudit } from '../lib/audit';
import { appendPatientEvent, loadPatient, patientDisplayName, prepareTemplateTasks, txPatient, txWriteTemplateTasks } from '../lib/care';
import { CLINICAL_ROLES, parse, requireOrg } from '../lib/context';
import { db } from '../lib/db';
import { id, isoDate } from '../lib/schemas';
import type { RecordRecertificationRequest } from '../shared/types';
import { completionField, completionValue } from './milestones';

/** Benefit periods computed ahead of the one being certified, so reminders keep working for long stays. */
export const PERIODS_AHEAD = 2;

const schema = z.object({
  orgId: id,
  patientId: id,
  periodNumber: z.number().int().min(2).max(200),
  certifyingPhysician: z.string().trim().min(1).max(200),
  certificationDate: isoDate,
  f2fDate: isoDate.optional(),
  f2fBy: z.string().trim().min(1).max(200).optional(),
});

/**
 * Records the certification of benefit period `periodNumber`:
 * completes the recert key of the previous period's end and the period's F2F key,
 * appends a `recertification` event and instantiates the `recertification` template.
 */
export async function recordRecertificationHandler(request: CallableRequest<RecordRecertificationRequest>): Promise<Record<string, never>> {
  const input = parse(schema, request.data);
  const ctx = await requireOrg(request, input.orgId, CLINICAL_ROLES);
  const pre = await loadPatient(ctx.orgId, input.patientId);
  const tasks = await prepareTemplateTasks(ctx.orgId, 'recertification', input.certificationDate, pre.careTeamUids ?? []);

  await db().runTransaction(async (tx) => {
    const { ref, patient } = await txPatient(tx, ctx.orgId, input.patientId);
    if (patient.status !== 'admitted') throw new HttpsError('failed-precondition', 'Only admitted patients can be recertified.');
    const ms = patient.milestones;
    if (!ms) throw new HttpsError('failed-precondition', 'The patient has no milestones.');
    const periods = ms.benefitPeriods;
    const idx = periods.findIndex((p) => p.number === input.periodNumber);
    const period = periods[idx];
    if (!period) throw new HttpsError('invalid-argument', `Benefit period ${input.periodNumber} does not exist for this patient.`);
    const prev = periods[idx - 1];
    if (!prev) throw new HttpsError('invalid-argument', 'The first benefit period is certified at admission, not recertified.');
    if (period.f2fRequired && !input.f2fDate) {
      throw new HttpsError('invalid-argument', `A face-to-face encounter date is required for benefit period ${period.number}.`);
    }
    const recertKey = milestoneKey('recert', prev.end);
    if (patient.milestoneCompletions?.[recertKey]) {
      throw new HttpsError('failed-precondition', `Benefit period ${period.number} has already been recertified.`);
    }

    const update: Record<string, unknown> = {
      [completionField(recertKey)]: completionValue(ctx.uid, `Recertified for benefit period ${period.number}`),
      updatedAt: FieldValue.serverTimestamp(),
    };
    const completed = [recertKey];
    if (period.f2fRequired && period.f2fDueBy) {
      const f2fKey = milestoneKey('f2f', period.f2fDueBy);
      if (!patient.milestoneCompletions?.[f2fKey]) {
        update[completionField(f2fKey)] = completionValue(ctx.uid, `F2F ${input.f2fDate}${input.f2fBy ? ` by ${input.f2fBy}` : ''}`);
        completed.push(f2fKey);
      }
    }
    // Keep future periods computed so recert/F2F reminders continue for long stays.
    const last = periods[periods.length - 1]!;
    if (patient.admissionDate && last.number - period.number < PERIODS_AHEAD) {
      const count = period.number + PERIODS_AHEAD - periods[0]!.number + 1;
      update['milestones.benefitPeriods'] = computeBenefitPeriods(patient.admissionDate, patient.startingBenefitPeriod ?? periods[0]!.number, count);
    }
    tx.update(ref, update);

    const f2fInWindow =
      period.f2fRequired && input.f2fDate && period.f2fWindowStart && period.f2fDueBy
        ? compareISO(input.f2fDate, period.f2fWindowStart) >= 0 && compareISO(input.f2fDate, period.f2fDueBy) <= 0
        : null;
    appendPatientEvent(tx, ctx.orgId, input.patientId, {
      type: 'recertification',
      date: input.certificationDate,
      recordedBy: ctx.uid,
      summary: `Recertified for benefit period ${period.number} (${period.start} – ${period.end})`,
      details: {
        periodNumber: period.number,
        periodStart: period.start,
        periodEnd: period.end,
        certifyingPhysician: input.certifyingPhysician,
        certificationDate: input.certificationDate,
        f2fDate: input.f2fDate ?? null,
        f2fBy: input.f2fBy ?? null,
        f2fInWindow,
      },
    });
    const taskIds = txWriteTemplateTasks(tx, ctx.orgId, 'recertification', tasks, { id: input.patientId, name: patientDisplayName(patient) }, ctx.uid);
    await writeAudit(
      ctx.orgId,
      {
        actorUid: ctx.uid,
        action: 'patient.recertify',
        resourceType: 'patient',
        resourceId: input.patientId,
        patientId: input.patientId,
        metadata: { periodNumber: period.number, completed, tasks: taskIds.length },
      },
      tx,
    );
  });
  return {};
}

export const recordRecertification = onCall(recordRecertificationHandler);
