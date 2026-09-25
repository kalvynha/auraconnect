import type { ReactNode } from 'react';
import type { CodeStatus, Diagnosis, Medication, PatientInput, Physician, Sex } from '@shared/types';
import { CODE_STATUSES, SEXES } from '../lib/constants';
import { Button, Field } from './ui';

/**
 * Editable PatientInput form. `isLow(path)` returns true when the AI confidence for
 * that dotted path (e.g. `patient.dob`) is below threshold; those inputs are highlighted.
 */
export function PatientForm({
  value,
  onChange,
  isLow = () => false,
  readOnly = false,
}: {
  value: PatientInput;
  onChange: (v: PatientInput) => void;
  isLow?: (path: string) => boolean;
  readOnly?: boolean;
}) {
  const v = value;
  const set = <K extends keyof PatientInput>(k: K, val: PatientInput[K]) => onChange({ ...v, [k]: val });
  const str = (x: string | null | undefined) => x ?? '';
  const nul = (x: string) => (x === '' ? null : x);
  const low = (path: string) => isLow(`patient.${path}`);

  const text = (label: string, path: string, val: string | null, onVal: (s: string) => void, type = 'text', required = false): ReactNode => (
    <Field label={label} warn={low(path)} hint={low(path) ? 'Low confidence — verify' : undefined}>
      <input type={type} value={str(val)} required={required} disabled={readOnly} onChange={(e) => onVal(e.target.value)} />
    </Field>
  );

  const physicianFields = (key: 'referringPhysician' | 'attendingPhysician', label: string) => {
    const p: Physician = v[key] ?? { name: '', npi: null, phone: null, fax: null };
    const up = (patch: Partial<Physician>) => set(key, { ...p, ...patch });
    return (
      <fieldset className={`fieldset ${low(key) ? 'field-warn' : ''}`}>
        <legend>{label}</legend>
        <div className="form-grid">
          {text('Name', `${key}.name`, p.name, (x) => up({ name: x }))}
          {text('NPI', `${key}.npi`, p.npi, (x) => up({ npi: nul(x) }))}
          {text('Phone', `${key}.phone`, p.phone, (x) => up({ phone: nul(x) }), 'tel')}
          {text('Fax', `${key}.fax`, p.fax, (x) => up({ fax: nul(x) }), 'tel')}
        </div>
      </fieldset>
    );
  };

  const pd: Diagnosis = v.primaryDiagnosis ?? { code: null, description: '' };

  return (
    <div className="form patient-form">
      <fieldset className="fieldset">
        <legend>Demographics</legend>
        <div className="form-grid">
          {text('First name', 'firstName', v.firstName, (x) => set('firstName', x), 'text', true)}
          {text('Last name', 'lastName', v.lastName, (x) => set('lastName', x), 'text', true)}
          {text('Date of birth', 'dob', v.dob, (x) => set('dob', nul(x)), 'date')}
          <Field label="Sex" warn={low('sex')}>
            <select value={v.sex} disabled={readOnly} onChange={(e) => set('sex', e.target.value as Sex)}>
              {SEXES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
          {text('Phone', 'phone', v.phone, (x) => set('phone', nul(x)), 'tel')}
          {text('MRN', 'mrn', v.mrn, (x) => set('mrn', nul(x)))}
          {text('Medicare MBI', 'medicareMbi', v.medicareMbi, (x) => set('medicareMbi', nul(x)))}
          <Field label="Code status" warn={low('codeStatus')}>
            <select value={v.codeStatus} disabled={readOnly} onChange={(e) => set('codeStatus', e.target.value as CodeStatus)}>
              {CODE_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
        </div>
      </fieldset>

      <fieldset className={`fieldset ${low('address') ? 'field-warn' : ''}`}>
        <legend>Address</legend>
        <div className="form-grid">
          {text('Line 1', 'address.line1', v.address.line1, (x) => set('address', { ...v.address, line1: nul(x) }))}
          {text('Line 2', 'address.line2', v.address.line2, (x) => set('address', { ...v.address, line2: nul(x) }))}
          {text('City', 'address.city', v.address.city, (x) => set('address', { ...v.address, city: nul(x) }))}
          {text('State', 'address.state', v.address.state, (x) => set('address', { ...v.address, state: nul(x) }))}
          {text('ZIP', 'address.zip', v.address.zip, (x) => set('address', { ...v.address, zip: nul(x) }))}
        </div>
      </fieldset>

      <fieldset className={`fieldset ${low('primaryDiagnosis') ? 'field-warn' : ''}`}>
        <legend>Diagnoses</legend>
        {low('primaryDiagnosis') && <div className="field-hint">Low confidence — verify primary diagnosis</div>}
        <div className="form-grid">
          {text('Primary diagnosis', 'primaryDiagnosis.description', pd.description, (x) => set('primaryDiagnosis', { ...pd, description: x }))}
          {text('ICD-10 code', 'primaryDiagnosis.code', pd.code, (x) => set('primaryDiagnosis', { ...pd, code: nul(x) }))}
        </div>
        <ListEditor<Diagnosis>
          label="Secondary diagnoses"
          warn={low('secondaryDiagnoses')}
          items={v.secondaryDiagnoses}
          readOnly={readOnly}
          blank={{ code: null, description: '' }}
          onChange={(items) => set('secondaryDiagnoses', items)}
          render={(d, up) => (
            <>
              <input placeholder="Description" value={d.description} disabled={readOnly} onChange={(e) => up({ ...d, description: e.target.value })} />
              <input placeholder="ICD-10" className="input-sm" value={str(d.code)} disabled={readOnly} onChange={(e) => up({ ...d, code: nul(e.target.value) })} />
            </>
          )}
        />
      </fieldset>

      {physicianFields('referringPhysician', 'Referring physician')}
      {physicianFields('attendingPhysician', 'Attending physician')}

      <fieldset className="fieldset">
        <legend>Medications & allergies</legend>
        <ListEditor<Medication>
          label="Medications"
          warn={low('medications')}
          items={v.medications}
          readOnly={readOnly}
          blank={{ name: '', dose: null, route: null, frequency: null }}
          onChange={(items) => set('medications', items)}
          render={(m, up) => (
            <>
              <input placeholder="Name" value={m.name} disabled={readOnly} onChange={(e) => up({ ...m, name: e.target.value })} />
              <input placeholder="Dose" className="input-sm" value={str(m.dose)} disabled={readOnly} onChange={(e) => up({ ...m, dose: nul(e.target.value) })} />
              <input placeholder="Route" className="input-sm" value={str(m.route)} disabled={readOnly} onChange={(e) => up({ ...m, route: nul(e.target.value) })} />
              <input placeholder="Frequency" className="input-sm" value={str(m.frequency)} disabled={readOnly} onChange={(e) => up({ ...m, frequency: nul(e.target.value) })} />
            </>
          )}
        />
        <ListEditor<string>
          label="Allergies"
          warn={low('allergies')}
          items={v.allergies}
          readOnly={readOnly}
          blank=""
          onChange={(items) => set('allergies', items)}
          render={(a, up) => <input placeholder="Allergy" value={a} disabled={readOnly} onChange={(e) => up(e.target.value)} />}
        />
      </fieldset>

      <fieldset className={`fieldset ${low('caregiver') ? 'field-warn' : ''}`}>
        <legend>Caregiver</legend>
        <div className="form-grid">
          {text('Name', 'caregiver.name', v.caregiver?.name ?? '', (x) =>
            set('caregiver', { name: x, relationship: v.caregiver?.relationship ?? null, phone: v.caregiver?.phone ?? null }),
          )}
          {text('Relationship', 'caregiver.relationship', v.caregiver?.relationship ?? null, (x) =>
            set('caregiver', { name: v.caregiver?.name ?? '', relationship: nul(x), phone: v.caregiver?.phone ?? null }),
          )}
          {text('Phone', 'caregiver.phone', v.caregiver?.phone ?? null, (x) =>
            set('caregiver', { name: v.caregiver?.name ?? '', relationship: v.caregiver?.relationship ?? null, phone: nul(x) }),
            'tel',
          )}
        </div>
      </fieldset>

      <fieldset className={`fieldset ${low('insurance') ? 'field-warn' : ''}`}>
        <legend>Insurance</legend>
        <div className="form-grid">
          {text('Payer', 'insurance.payer', v.insurance.payer, (x) => set('insurance', { ...v.insurance, payer: nul(x) }))}
          {text('Member ID', 'insurance.memberId', v.insurance.memberId, (x) => set('insurance', { ...v.insurance, memberId: nul(x) }))}
        </div>
      </fieldset>
    </div>
  );
}

function ListEditor<T>({
  label,
  items,
  blank,
  onChange,
  render,
  warn,
  readOnly,
}: {
  label: string;
  items: T[];
  blank: T;
  onChange: (items: T[]) => void;
  render: (item: T, update: (next: T) => void) => ReactNode;
  warn?: boolean;
  readOnly?: boolean;
}) {
  return (
    <div className={`list-editor ${warn ? 'field-warn' : ''}`}>
      <div className="field-label">
        {label} {warn && <span className="field-hint">Low confidence — verify</span>}
      </div>
      {items.map((it, i) => (
        <div key={i} className="list-editor-row">
          {render(it, (next) => onChange(items.map((x, j) => (j === i ? next : x))))}
          {!readOnly && (
            <Button small variant="ghost" onClick={() => onChange(items.filter((_, j) => j !== i))} aria-label="Remove">
              ×
            </Button>
          )}
        </div>
      ))}
      {!readOnly && (
        <Button small variant="ghost" onClick={() => onChange([...items, blank])}>
          + Add
        </Button>
      )}
    </div>
  );
}
