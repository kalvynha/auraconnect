/** Shared zod schemas for callable payloads (mirroring shared/types.ts). */
import { z } from 'zod';
import { isValidISODate, isValidTimeZone } from '../domain/dates';
import type { Consents, PatientInput } from '../shared/types';

export const id = z.string().trim().min(1).max(128).regex(/^[^/]+$/, 'must not contain "/"');
export const uid = id;
export const role = z.enum(['admin', 'clinician', 'intake', 'viewer']);
export const discipline = z.enum(['RN', 'LPN', 'MD', 'NP', 'SW', 'Chaplain', 'Aide', 'Volunteer', 'Admin', 'Other']);
export const priority = z.enum(['normal', 'urgent', 'critical']);
export const isoDate = z.string().refine((v) => isValidISODate(v), 'must be a valid YYYY-MM-DD date');
export const timeZone = z.string().refine((v) => isValidTimeZone(v), 'must be a valid IANA time zone');
export const uidList = (max = 500) => z.array(uid).max(max);

const s = (max = 500) => z.string().trim().max(max);
const ns = (max = 500) => s(max).nullable().default(null);

const diagnosis = z.object({ code: ns(16), description: s(500) });
const physician = z.object({ name: s(200).min(1), npi: ns(20), phone: ns(40), fax: ns(40) });

export const patientInput: z.ZodType<PatientInput, z.ZodTypeDef, unknown> = z.object({
  firstName: s(100).min(1),
  lastName: s(100).min(1),
  dob: isoDate.nullable().default(null),
  sex: z.enum(['female', 'male', 'other', 'unknown']).default('unknown'),
  phone: ns(40),
  address: z
    .object({ line1: ns(200), line2: ns(200), city: ns(100), state: ns(50), zip: ns(20) })
    .default({}),
  mrn: ns(64),
  medicareMbi: ns(32),
  primaryDiagnosis: diagnosis.nullable().default(null),
  secondaryDiagnoses: z.array(diagnosis).max(50).default([]),
  referringPhysician: physician.nullable().default(null),
  attendingPhysician: physician.nullable().default(null),
  codeStatus: z.enum(['Full Code', 'DNR', 'DNR/DNI', 'Comfort Care Only', 'Unknown']).default('Unknown'),
  allergies: z.array(s(200)).max(100).default([]),
  medications: z
    .array(z.object({ name: s(200).min(1), dose: ns(100), route: ns(100), frequency: ns(100) }))
    .max(200)
    .default([]),
  caregiver: z
    .object({ name: s(200).min(1), relationship: ns(100), phone: ns(40) })
    .nullable()
    .default(null),
  insurance: z.object({ payer: ns(200), memberId: ns(64) }).default({}),
});

export const consents: z.ZodType<Consents, z.ZodTypeDef, unknown> = z.object({
  electionStatement: z.boolean(),
  hipaaNotice: z.boolean(),
  releaseOfInformation: z.boolean().default(false),
  patientRights: z.boolean().default(false),
  polstOnFile: z.boolean().default(false),
});
