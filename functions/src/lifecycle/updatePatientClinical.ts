/**
 * `updatePatientClinical` (S2): edit a patient's clinical record after admission — code status,
 * allergies, medications, caregiver, physicians, phone, address and diagnoses.
 *
 *  - Licensed staff (RN/NP/MD) on the patient's care team, or an admin.
 *  - Merge-update only: fields absent from the request are untouched, and object fields are
 *    merged into the existing value (so e.g. a caregiver's mailing address is never dropped).
 *    Lists replace the whole list. `null` clears caregiver, physicians or primary diagnosis.
 *  - Appends a `clinical_update` event and an audit entry (field names only, no values).
 *  - A code-status change posts a system message in the patient channel and raises a normal
 *    (non-escalating) alert to the rest of the care team.
 */
import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { todayInTimeZone } from '../domain/dates';
import { writeAudit } from '../lib/audit';
import { appendPatientEvent, patientDisplayName, requireOrgDoc, txPatient } from '../lib/care';
import { CLINICAL_ROLES, parse, requireOrg } from '../lib/context';
import { db, docRef, paths } from '../lib/db';
import { requireLicensed } from '../lib/permissions';
import { id } from '../lib/schemas';
import type { Patient, UpdatePatientClinicalRequest, UpdatePatientClinicalResponse } from '../shared/types';
import { alertCareTeam, txPostSystemMessage } from './notifyCareTeam';

const str = (max: number) => z.string().trim().max(max);
/** Optional nullable text: empty string → null. */
const optNullable = (max: number) =>
  str(max)
    .nullable()
    .optional()
    .transform((v) => (v === undefined ? undefined : v === null || v === '' ? null : v));

const physician = z.object({ name: str(200).min(1).optional(), npi: optNullable(20), phone: optNullable(40), fax: optNullable(40) }).strict();
const diagnosis = z.object({ code: optNullable(16), description: str(500).min(1).optional() }).strict();

export const CLINICAL_FIELDS = [
  'codeStatus',
  'allergies',
  'medications',
  'caregiver',
  'attendingPhysician',
  'referringPhysician',
  'phone',
  'address',
  'primaryDiagnosis',
  'secondaryDiagnoses',
] as const;
export type ClinicalField = (typeof CLINICAL_FIELDS)[number];

export const CLINICAL_FIELD_LABELS: Record<ClinicalField, string> = {
  codeStatus: 'code status',
  allergies: 'allergies',
  medications: 'medications',
  caregiver: 'caregiver',
  attendingPhysician: 'attending physician',
  referringPhysician: 'referring physician',
  phone: 'phone',
  address: 'address',
  primaryDiagnosis: 'primary diagnosis',
  secondaryDiagnoses: 'secondary diagnoses',
};

const schema = z
  .object({
    orgId: id,
    patientId: id,
    reason: str(1000).min(1, 'a reason is required'),
    codeStatus: z.enum(['Full Code', 'DNR', 'DNR/DNI', 'Comfort Care Only', 'Unknown']).optional(),
    allergies: z.array(str(200).min(1)).max(100).optional(),
    medications: z
      .array(
        z.object({
          name: str(200).min(1),
          dose: optNullable(100).transform((v) => v ?? null),
          route: optNullable(100).transform((v) => v ?? null),
          frequency: optNullable(100).transform((v) => v ?? null),
        }),
      )
      .max(200)
      .optional(),
    caregiver: z
      .object({ name: str(200).min(1).optional(), relationship: optNullable(100), phone: optNullable(40) })
      .strict()
      .nullable()
      .optional(),
    attendingPhysician: physician.nullable().optional(),
    referringPhysician: physician.nullable().optional(),
    phone: optNullable(40),
    address: z
      .object({ line1: optNullable(200), line2: optNullable(200), city: optNullable(100), state: optNullable(50), zip: optNullable(20) })
      .strict()
      .optional(),
    primaryDiagnosis: diagnosis.nullable().optional(),
    secondaryDiagnoses: z
      .array(z.object({ code: optNullable(16).transform((v) => v ?? null), description: str(500).min(1) }))
      .max(50)
      .optional(),
  })
  .refine((v) => CLINICAL_FIELDS.some((f) => v[f] !== undefined), 'nothing to update');

type Input = z.infer<typeof schema>;

function defined<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * Merges a partial object into the current value. `null` clears; when there is no current value
 * the patch must supply every key in `required`.
 */
function mergeObject<T extends object>(
  field: string,
  current: T | null | undefined,
  patch: Record<string, unknown> | null,
  base: Record<string, unknown>,
  required: string[] = [],
): T | null {
  if (patch === null) return null;
  const merged = { ...base, ...(current ?? {}), ...defined(patch) } as Record<string, unknown>;
  for (const k of required) {
    if (typeof merged[k] !== 'string' || !(merged[k] as string)) throw new HttpsError('invalid-argument', `Invalid request. ${field}.${k}: required`);
  }
  return merged as T;
}

/** The new value of every requested field (pure; exported for tests). */
export function clinicalPatch(patient: Patient, input: Input): Partial<Record<ClinicalField, unknown>> {
  const out: Partial<Record<ClinicalField, unknown>> = {};
  if (input.codeStatus !== undefined) out.codeStatus = input.codeStatus;
  if (input.allergies !== undefined) out.allergies = input.allergies;
  if (input.medications !== undefined) out.medications = input.medications;
  if (input.phone !== undefined) out.phone = input.phone;
  if (input.secondaryDiagnoses !== undefined) out.secondaryDiagnoses = input.secondaryDiagnoses;
  if (input.caregiver !== undefined) {
    out.caregiver = mergeObject('caregiver', patient.caregiver, input.caregiver, { relationship: null, phone: null }, ['name']);
  }
  for (const f of ['attendingPhysician', 'referringPhysician'] as const) {
    if (input[f] !== undefined) out[f] = mergeObject(f, patient[f], input[f] ?? null, { npi: null, phone: null, fax: null }, ['name']);
  }
  if (input.primaryDiagnosis !== undefined) {
    out.primaryDiagnosis = mergeObject('primaryDiagnosis', patient.primaryDiagnosis, input.primaryDiagnosis, { code: null }, ['description']);
  }
  if (input.address !== undefined) {
    out.address = mergeObject('address', patient.address, input.address, { line1: null, line2: null, city: null, state: null, zip: null });
  }
  return out;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export async function updatePatientClinicalHandler(
  request: CallableRequest<UpdatePatientClinicalRequest>,
): Promise<UpdatePatientClinicalResponse> {
  const input = parse(schema, request.data);
  const ctx = await requireOrg(request, input.orgId, CLINICAL_ROLES);
  await requireLicensed(ctx);
  const org = await requireOrgDoc(ctx.orgId);
  const today = todayInTimeZone(new Date(), org.timezone);
  const actorName = ctx.member.displayName || 'a care team member';

  const result = await db().runTransaction(async (tx) => {
    const { ref, patient } = await txPatient(tx, ctx.orgId, input.patientId);
    if (ctx.role !== 'admin' && !(patient.careTeamUids ?? []).includes(ctx.uid)) {
      throw new HttpsError('permission-denied', 'Only the patient’s care team or an admin can update the clinical record.');
    }
    if (patient.status !== 'admitted' && patient.status !== 'referral') {
      throw new HttpsError('failed-precondition', `The record of a ${patient.status} patient cannot be changed.`);
    }
    const next = clinicalPatch(patient, input);
    const changed = CLINICAL_FIELDS.filter((f) => f in next && !same((patient as unknown as Record<string, unknown>)[f], next[f]));
    if (changed.length === 0) return { changed, patient, codeStatusFrom: null as string | null };

    const chRef = patient.channelId ? docRef(paths.channel(ctx.orgId, patient.channelId)) : null;
    const codeStatusChanged = changed.includes('codeStatus');
    const chSnap = codeStatusChanged && chRef ? await tx.get(chRef) : null;

    // --- writes ---
    const update: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
    for (const f of changed) update[f] = next[f];
    tx.update(ref, update);
    const labels = changed.map((f) => CLINICAL_FIELD_LABELS[f]);
    const summary = codeStatusChanged
      ? `Clinical update: code status ${patient.codeStatus} → ${input.codeStatus}${labels.length > 1 ? `; ${labels.filter((l) => l !== 'code status').join(', ')}` : ''}`
      : `Clinical update: ${labels.join(', ')}`;
    appendPatientEvent(tx, ctx.orgId, input.patientId, {
      type: 'clinical_update',
      date: today,
      recordedBy: ctx.uid,
      summary,
      details: {
        fields: changed,
        reason: input.reason,
        ...(codeStatusChanged ? { codeStatus: { from: patient.codeStatus, to: input.codeStatus } } : {}),
      },
    });
    if (codeStatusChanged && chRef && chSnap?.exists && chSnap.get('archived') !== true) {
      txPostSystemMessage(tx, ctx.orgId, chRef.id, `Code status changed to ${input.codeStatus} by ${actorName}.`);
    }
    await writeAudit(
      ctx.orgId,
      {
        actorUid: ctx.uid,
        action: 'patient.clinical_update',
        resourceType: 'patient',
        resourceId: input.patientId,
        patientId: input.patientId,
        metadata: { fields: changed },
      },
      tx,
    );
    return { changed, patient, codeStatusFrom: codeStatusChanged ? patient.codeStatus : null };
  });

  if (result.codeStatusFrom !== null) {
    await alertCareTeam({
      orgId: ctx.orgId,
      patientId: input.patientId,
      careTeamUids: result.patient.careTeamUids ?? [],
      actorUid: ctx.uid,
      title: 'Code status changed',
      body: `${patientDisplayName(result.patient)}: ${result.codeStatusFrom} → ${input.codeStatus}`,
    });
  }
  return { changed: result.changed };
}

export const updatePatientClinical = onCall(updatePatientClinicalHandler);
