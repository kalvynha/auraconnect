import { describe, expect, it } from 'vitest';
import { emptyPatientInput, normalizeExtraction } from '../../src/domain/referralNormalize';

describe('normalizeExtraction', () => {
  it.each([null, undefined, 42, 'not json', [], { patient: 'nope' }])('turns garbage (%s) into a valid empty shape', (raw) => {
    const r = normalizeExtraction(raw);
    expect(r.patient).toEqual(emptyPatientInput());
    expect(r.referralDate).toBeNull();
    expect(r.referralSource).toBeNull();
    expect(r.reasonForReferral).toBeNull();
    expect(r.fieldConfidence).toEqual({});
    expect(Array.isArray(r.warnings)).toBe(true);
  });

  it('clamps confidences and accepts both array and map forms', () => {
    expect(
      normalizeExtraction({ fieldConfidence: [{ path: 'patient.dob', confidence: 1.7 }, { path: 'patient.lastName', confidence: -2 }, { path: 'x', confidence: 'abc' }] })
        .fieldConfidence,
    ).toEqual({ 'patient.dob': 1, 'patient.lastName': 0 });
    expect(normalizeExtraction({ fieldConfidence: { 'patient.mrn': 0.42, bad: NaN } }).fieldConfidence).toEqual({ 'patient.mrn': 0.42 });
  });

  it('nulls invalid dates with a warning', () => {
    const r = normalizeExtraction({ patient: { firstName: 'A', lastName: 'B', dob: '1942-02-30' }, referralDate: '09/01/2026' });
    expect(r.patient.dob).toBeNull();
    expect(r.referralDate).toBeNull();
    expect(r.warnings.some((w) => w.includes('patient.dob'))).toBe(true);
    expect(normalizeExtraction({ patient: { dob: '1942-03-01' } }).patient.dob).toBe('1942-03-01');
  });

  it('coerces enums, lists and nested objects', () => {
    const r = normalizeExtraction({
      patient: {
        firstName: '  Mary ',
        lastName: 'Smith',
        sex: 'F',
        codeStatus: 'dnr',
        medicareMbi: '1eg4-te5-mk73',
        address: { city: 'Austin', zip: 78701 },
        primaryDiagnosis: { code: 'c34.90', description: 'Lung cancer' },
        secondaryDiagnoses: ['COPD', { code: null, description: '' }, 7],
        medications: [{ name: 'Morphine', dose: '5 mg' }, { dose: 'no name' }, 'Lorazepam'],
        allergies: ['PCN', '', null],
        referringPhysician: { name: '' },
        caregiver: { name: 'Tom', relationship: 'son' },
      },
      warnings: ['page 2 illegible', 5],
      referralSource: 'N/A',
    });
    expect(r.patient.firstName).toBe('Mary');
    expect(r.patient.sex).toBe('female');
    expect(r.patient.codeStatus).toBe('DNR');
    expect(r.patient.medicareMbi).toBe('1EG4TE5MK73');
    expect(r.patient.address).toEqual({ line1: null, line2: null, city: 'Austin', state: null, zip: '78701' });
    expect(r.patient.primaryDiagnosis).toEqual({ code: 'C34.90', description: 'Lung cancer' });
    expect(r.patient.secondaryDiagnoses).toEqual([{ code: null, description: 'COPD' }]);
    expect(r.patient.medications).toEqual([
      { name: 'Morphine', dose: '5 mg', route: null, frequency: null },
      { name: 'Lorazepam', dose: null, route: null, frequency: null },
    ]);
    expect(r.patient.allergies).toEqual(['PCN']);
    expect(r.patient.referringPhysician).toBeNull();
    expect(r.patient.caregiver).toEqual({ name: 'Tom', relationship: 'son', phone: null });
    expect(r.referralSource).toBeNull();
    expect(r.warnings).toEqual(['page 2 illegible']);
  });

  it('parses JSON strings', () => {
    expect(normalizeExtraction('{"patient":{"firstName":"A"}}').patient.firstName).toBe('A');
  });
});
