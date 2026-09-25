import type { Address, PatientInput, Physician } from '@shared/types';

export function emptyAddress(): Address {
  return { line1: null, line2: null, city: null, state: null, zip: null };
}

export function emptyPatientInput(): PatientInput {
  return {
    firstName: '',
    lastName: '',
    dob: null,
    sex: 'unknown',
    phone: null,
    address: emptyAddress(),
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

/** Pick only PatientInput fields from a Patient/extraction (drops server fields) and fill gaps. */
export function toPatientInput(src: Partial<PatientInput> | null | undefined): PatientInput {
  const e = emptyPatientInput();
  if (!src) return e;
  return {
    firstName: src.firstName ?? e.firstName,
    lastName: src.lastName ?? e.lastName,
    dob: src.dob ?? null,
    sex: src.sex ?? e.sex,
    phone: src.phone ?? null,
    address: { ...e.address, ...(src.address ?? {}) },
    mrn: src.mrn ?? null,
    medicareMbi: src.medicareMbi ?? null,
    primaryDiagnosis: src.primaryDiagnosis ?? null,
    secondaryDiagnoses: src.secondaryDiagnoses ?? [],
    referringPhysician: src.referringPhysician ?? null,
    attendingPhysician: src.attendingPhysician ?? null,
    codeStatus: src.codeStatus ?? e.codeStatus,
    allergies: src.allergies ?? [],
    medications: src.medications ?? [],
    caregiver: src.caregiver ?? null,
    insurance: { payer: src.insurance?.payer ?? null, memberId: src.insurance?.memberId ?? null },
  };
}

const s = (v: string | null | undefined): string | null => {
  const t = (v ?? '').trim();
  return t ? t : null;
};

function physician(p: Physician | null): Physician | null {
  if (!p || !p.name.trim()) return null;
  return { name: p.name.trim(), npi: s(p.npi), phone: s(p.phone), fax: s(p.fax) };
}

/** Trim strings, convert blanks to null and drop empty nested objects/list rows. */
export function normalizePatientInput(p: PatientInput): PatientInput {
  return {
    firstName: p.firstName.trim(),
    lastName: p.lastName.trim(),
    dob: s(p.dob),
    sex: p.sex,
    phone: s(p.phone),
    address: {
      line1: s(p.address.line1),
      line2: s(p.address.line2),
      city: s(p.address.city),
      state: s(p.address.state),
      zip: s(p.address.zip),
    },
    mrn: s(p.mrn),
    medicareMbi: s(p.medicareMbi),
    primaryDiagnosis:
      p.primaryDiagnosis && (p.primaryDiagnosis.description.trim() || s(p.primaryDiagnosis.code))
        ? { code: s(p.primaryDiagnosis.code), description: p.primaryDiagnosis.description.trim() }
        : null,
    secondaryDiagnoses: p.secondaryDiagnoses
      .filter((d) => d.description.trim() || s(d.code))
      .map((d) => ({ code: s(d.code), description: d.description.trim() })),
    referringPhysician: physician(p.referringPhysician),
    attendingPhysician: physician(p.attendingPhysician),
    codeStatus: p.codeStatus,
    allergies: p.allergies.map((a) => a.trim()).filter(Boolean),
    medications: p.medications
      .filter((m) => m.name.trim())
      .map((m) => ({ name: m.name.trim(), dose: s(m.dose), route: s(m.route), frequency: s(m.frequency) })),
    caregiver:
      p.caregiver && p.caregiver.name.trim()
        ? { name: p.caregiver.name.trim(), relationship: s(p.caregiver.relationship), phone: s(p.caregiver.phone) }
        : null,
    insurance: { payer: s(p.insurance.payer), memberId: s(p.insurance.memberId) },
  };
}

export function patientName(p: { firstName: string; lastName: string }): string {
  const n = [p.lastName, p.firstName].filter(Boolean).join(', ');
  return n || '(unnamed)';
}
