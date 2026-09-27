import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { f2fInWindow, milestoneKey, recertCertificationDateError, recomputeBenefitPeriods } from '../domain/milestones';
import { writeAudit } from '../lib/audit';
import { appendPatientEvent, loadPatient, patientDisplayName, prepareTemplateTasks, txPatient, txWriteTemplateTasks } from '../lib/care';
import { CLINICAL_ROLES, parse, requireOrg } from '../lib/context';
import { db } from '../lib/db';
import { id, isoDate } from '../lib/schemas';
import { requireLicensed } from '../lib/permissions';
import type { RecordRecertificationRequest, RecordRecertificationResponse } from '../shared/types';
import { completionField, completionValue, txPrepareResolveDeadlineAlerts } from './milestones';

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
 *
 * v3 (H4, S4): licensed staff or admins only. `certificationDate` must be within
 * [period start − 15 days, period start]. When the period requires a F2F, `f2fDate` and `f2fBy`
 * (the attesting physician/NP) are required; an F2F outside its window is recorded with a
 * warning but does NOT complete the F2F milestone.
 */
export async function recordRecertificationHandler(request: CallableRequest<RecordRecertificationRequest>): Promise<RecordRecertificationResponse> {
  const input = parse(schema, request.data);
  const ctx = await requireOrg(request, input.orgId, CLINICAL_ROLES);
  await requireLicensed(ctx);
  const warnings: string[] = [];
  const pre = await loadPatient(ctx.orgId, input.patientId);
  const tasks = await prepareTemplateTasks(ctx.orgId, 'recertification', input.certificationDate, pre.careTeamUids ?? []);

  await db().runTransaction(async (tx) => {
    warnings.length = 0; // a retried transaction starts over
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
    if (period.f2fRequired && !input.f2fBy) {
      throw new HttpsError('invalid-argument', `The physician or NP who performed the face-to-face encounter is required for benefit period ${period.number}.`);
    }
    const dateError = recertCertificationDateError(period, input.certificationDate);
    if (dateError) throw new HttpsError('invalid-argument', dateError);
    const recertKey = milestoneKey('recert', prev.end);
    if (patient.milestoneCompletions?.[recertKey]) {
      throw new HttpsError('failed-precondition', `Benefit period ${period.number} has already been recertified.`);
    }

    const f2fOk = input.f2fDate ? f2fInWindow(period, input.f2fDate) : null;
    const update: Record<string, unknown> = {
      [completionField(recertKey)]: completionValue(ctx.uid, `Recertified for benefit period ${period.number}`, input.certificationDate),
      updatedAt: FieldValue.serverTimestamp(),
    };
    const completed = [recertKey];
    if (period.f2fRequired && period.f2fDueBy) {
      const f2fKey = milestoneKey('f2f', period.f2fDueBy);
      if (f2fOk === false) {
        warnings.push(
          `The face-to-face encounter on ${input.f2fDate} is outside its window (${period.f2fWindowStart} – ${period.f2fDueBy}). ` +
            'It was recorded, but the F2F milestone stays open.',
        );
      } else if (!patient.milestoneCompletions?.[f2fKey]) {
        update[completionField(f2fKey)] = completionValue(ctx.uid, `F2F ${input.f2fDate} by ${input.f2fBy}`, input.f2fDate!);
        completed.push(f2fKey);
      }
    }
    const resolveAlerts = await txPrepareResolveDeadlineAlerts(tx, ctx.orgId, input.patientId, completed);
    // Keep future periods computed so recert/F2F reminders continue for long stays.
    const last = periods[periods.length - 1]!;
    if (patient.admissionDate && last.number - period.number < PERIODS_AHEAD) {
      const count = period.number + PERIODS_AHEAD - periods[0]!.number + 1;
      update['milestones.benefitPeriods'] = recomputeBenefitPeriods(
        {
          admissionDate: patient.admissionDate,
          startingBenefitPeriod: patient.startingBenefitPeriod ?? periods[0]!.number,
          benefitPeriodStart: patient.benefitPeriodStart ?? (periods[0]!.start < patient.admissionDate ? periods[0]!.start : null),
        },
        count,
      );
    }
    tx.update(ref, update);
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
        f2fInWindow: f2fOk,
        warnings,
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
        metadata: { periodNumber: period.number, completed, tasks: taskIds.length, f2fInWindow: f2fOk },
      },
      tx,
    );
    await resolveAlerts(ctx.uid);
  });
  return { warnings };
}

export const recordRecertification = onCall(recordRecertificationHandler);
