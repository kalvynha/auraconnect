/**
 * Coerces arbitrary model JSON into a valid {@link ReferralExtraction}.
 * Pure module: no Firebase imports.
 *
 * - Every field gets a stable shape: missing strings → null (names → ''),
 *   arrays → [], enums → a safe default ('unknown' sex, 'Unknown' code status).
 * - Dates must be real `YYYY-MM-DD` dates, otherwise null (plus a warning).
 * - `fieldConfidence` accepts either a map `{ path: number }` or the array
 *   form `[{ path, confidence }]` the response schema asks for; values are
 *   clamped to [0, 1] and non-numbers dropped.
 */
import type {
  Address,
  Caregiver,
  CodeStatus,
  Diagnosis,
  Insurance,
  Medication,
  PatientInput,
  Physician,
  ReferralExtraction,
  Sex,
} from '../shared/types';
import { isValidISODate } from './dates';

const SEXES: readonly Sex[] = ['female', 'male', 'other', 'unknown'];
const CODE_STATUSES: readonly CodeStatus[] = ['Full Code', 'DNR', 'DNR/DNI', 'Comfort Care Only', 'Unknown'];
const MAX_STR = 2000;
const MAX_LIST = 100;

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function obj(v: unknown): Obj {
  return isObj(v) ? v : {};
}

/** Trimmed non-empty string or null. Numbers are stringified (e.g. zip 12345). */
export function str(v: unknown, max = MAX_STR): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) v = String(v);
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t || /^(null|n\/a|none|unknown)$/i.test(t)) return null;
  return t.slice(0, max);
}

function list<T>(v: unknown, map: (x: unknown) => T | null): T[] {
  if (!Array.isArray(v)) return [];
  const out: T[] = [];
  for (const x of v.slice(0, MAX_LIST)) {
    const m = map(x);
    if (m !== null) out.push(m);
  }
  return out;
}

export function clampConfidence(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, n));
}

function normSex(v: unknown): Sex {
  const s = str(v)?.toLowerCase();
  if (!s) return 'unknown';
  if (SEXES.includes(s as Sex)) return s as Sex;
  if (s === 'f') return 'female';
  if (s === 'm') return 'male';
  return 'unknown';
}

function normCodeStatus(v: unknown): CodeStatus {
  const s = str(v);
  if (!s) return 'Unknown';
  const hit = CODE_STATUSES.find((c) => c.toLowerCase() === s.toLowerCase());
  if (hit) return hit;
  const u = s.toUpperCase().replace(/\s+/g, '');
  if (u === 'FULL' || u === 'FULLCODE') return 'Full Code';
  if (u === 'DNR/DNI' || u === 'DNR-DNI' || u === 'DNRDNI') return 'DNR/DNI';
  return 'Unknown';
}

function normAddress(v: unknown): Address {
  const a = obj(v);
  return {
    line1: str(a.line1),
    line2: str(a.line2),
    city: str(a.city),
    state: str(a.state),
    zip: str(a.zip),
  };
}

function normDiagnosis(v: unknown): Diagnosis | null {
  if (typeof v === 'string') return str(v) ? { code: null, description: str(v)! } : null;
  const d = obj(v);
  const code = str(d.code, 16)?.toUpperCase() ?? null;
  const description = str(d.description);
  if (!code && !description) return null;
  return { code, description: description ?? '' };
}

function normPhysician(v: unknown): Physician | null {
  const p = obj(v);
  const name = str(p.name);
  if (!name) return null;
  return { name, npi: str(p.npi, 20), phone: str(p.phone, 40), fax: str(p.fax, 40) };
}

function normMedication(v: unknown): Medication | null {
  if (typeof v === 'string') return str(v) ? { name: str(v)!, dose: null, route: null, frequency: null } : null;
  const m = obj(v);
  const name = str(m.name);
  if (!name) return null;
  return { name, dose: str(m.dose), route: str(m.route), frequency: str(m.frequency) };
}

function normCaregiver(v: unknown): Caregiver | null {
  const c = obj(v);
  const name = str(c.name);
  if (!name) return null;
  return { name, relationship: str(c.relationship), phone: str(c.phone, 40) };
}

function normInsurance(v: unknown): Insurance {
  const i = obj(v);
  return { payer: str(i.payer), memberId: str(i.memberId, 64) };
}

function normDate(v: unknown, path: string, warnings: string[]): string | null {
  const s = str(v, 32);
  if (!s) return null;
  if (isValidISODate(s)) return s;
  warnings.push(`${path} was not a valid YYYY-MM-DD date and was cleared.`);
  return null;
}

export function emptyPatientInput(): PatientInput {
  return {
    firstName: '',
    lastName: '',
    dob: null,
    sex: 'unknown',
    phone: null,
    address: { line1: null, line2: null, city: null, state: null, zip: null },
    mrn: null,
    medicareMbi: null,
    primaryDiagnosis: null,
    secondaryDiagnoses: [],
    referringPhysician: null,
    attendingPhysician: null,
    codeStatus: 'Unknown',
    allergies: [],
    medications: [],
    caregiver: null,
    insurance: { payer: null, memberId: null },
  };
}

function normPatient(v: unknown, warnings: string[]): PatientInput {
  const p = obj(v);
  const mbi = str(p.medicareMbi, 32);
  return {
    firstName: str(p.firstName, 100) ?? '',
    lastName: str(p.lastName, 100) ?? '',
    dob: normDate(p.dob, 'patient.dob', warnings),
    sex: normSex(p.sex),
    phone: str(p.phone, 40),
    address: normAddress(p.address),
    mrn: str(p.mrn, 64),
    medicareMbi: mbi ? mbi.replace(/[\s-]/g, '').toUpperCase() : null,
    primaryDiagnosis: normDiagnosis(p.primaryDiagnosis),
    secondaryDiagnoses: list(p.secondaryDiagnoses, normDiagnosis),
    referringPhysician: normPhysician(p.referringPhysician),
    attendingPhysician: normPhysician(p.attendingPhysician),
    codeStatus: normCodeStatus(p.codeStatus),
    allergies: list(p.allergies, (x) => str(x, 200)),
    medications: list(p.medications, normMedication),
    caregiver: normCaregiver(p.caregiver),
    insurance: normInsurance(p.insurance),
  };
}

function normConfidence(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  const put = (path: unknown, value: unknown) => {
    const key = str(path, 200);
    const c = clampConfidence(value);
    if (key && c !== null && !['__proto__', 'constructor', 'prototype'].includes(key)) out[key] = c;
  };
  if (Array.isArray(v)) {
    for (const e of v.slice(0, 500)) {
      const o = obj(e);
      put(o.path ?? o.field ?? o.key, o.confidence ?? o.value);
    }
  } else if (isObj(v)) {
    for (const [k, val] of Object.entries(v).slice(0, 500)) put(k, val);
  }
  return out;
}

/** Coerce model output (object or JSON string) into a valid ReferralExtraction. */
export function normalizeExtraction(raw: unknown): ReferralExtraction {
  let input: unknown = raw;
  const warnings: string[] = [];
  if (typeof input === 'string') {
    try {
      input = JSON.parse(input);
    } catch {
      input = {};
      warnings.push('The extraction output could not be parsed; all fields need manual entry.');
    }
  }
  const r = obj(input);
  const modelWarnings = list(r.warnings, (x) => (typeof x === 'string' ? str(x, 500) : null)).slice(0, 50);
  const patient = normPatient(r.patient, warnings);
  return {
    patient,
    referralDate: normDate(r.referralDate, 'referralDate', warnings),
    referralSource: str(r.referralSource, 500),
    reasonForReferral: str(r.reasonForReferral),
    fieldConfidence: normConfidence(r.fieldConfidence),
    warnings: [...modelWarnings, ...warnings],
  };
}
