import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { writeAudit } from '../lib/audit';
import { appendPatientEvent, txPatient } from '../lib/care';
import { CLINICAL_ROLES, parse, requireOrg } from '../lib/context';
import { db } from '../lib/db';
import { requireLicensed } from '../lib/permissions';
import { id, isoDate } from '../lib/schemas';
import type { ChangeLevelOfCareRequest, LevelOfCare } from '../shared/types';

export const LEVEL_OF_CARE_LABELS: Record<LevelOfCare, string> = {
  routine: 'Routine',
  continuous: 'Continuous',
  respite: 'Respite',
  gip: 'GIP',
};

const schema = z.object({
  orgId: id,
  patientId: id,
  levelOfCare: z.enum(['routine', 'continuous', 'respite', 'gip']),
  effectiveDate: isoDate,
  reason: z.string().trim().min(1).max(1000),
});

export async function changeLevelOfCareHandler(request: CallableRequest<ChangeLevelOfCareRequest>): Promise<Record<string, never>> {
  const input = parse(schema, request.data);
  const ctx = await requireOrg(request, input.orgId, CLINICAL_ROLES);
  await requireLicensed(ctx); // H4
  await db().runTransaction(async (tx) => {
    const { ref, patient } = await txPatient(tx, ctx.orgId, input.patientId);
    if (patient.status !== 'admitted') throw new HttpsError('failed-precondition', 'Only admitted patients have a level of care.');
    if (patient.levelOfCare === input.levelOfCare) throw new HttpsError('failed-precondition', 'The patient is already at that level of care.');
    if (patient.admissionDate && input.effectiveDate < patient.admissionDate) {
      throw new HttpsError('invalid-argument', 'The effective date is before admission.');
    }
    const from = patient.levelOfCare;
    tx.update(ref, { levelOfCare: input.levelOfCare, updatedAt: FieldValue.serverTimestamp() });
    appendPatientEvent(tx, ctx.orgId, input.patientId, {
      type: 'level_of_care_change',
      date: input.effectiveDate,
      recordedBy: ctx.uid,
      summary: `Level of care: ${LEVEL_OF_CARE_LABELS[from] ?? from} → ${LEVEL_OF_CARE_LABELS[input.levelOfCare]}`,
      details: { from, to: input.levelOfCare, reason: input.reason },
    });
    await writeAudit(
      ctx.orgId,
      {
        actorUid: ctx.uid,
        action: 'patient.level_of_care',
        resourceType: 'patient',
        resourceId: input.patientId,
        patientId: input.patientId,
        metadata: { from, to: input.levelOfCare, effectiveDate: input.effectiveDate },
      },
      tx,
    );
  });
  return {};
}

export const changeLevelOfCare = onCall(changeLevelOfCareHandler);
