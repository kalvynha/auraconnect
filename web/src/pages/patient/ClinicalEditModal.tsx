import { useState, type FormEvent, type ReactNode } from 'react';
import type {
  Address,
  CodeStatus,
  Diagnosis,
  Medication,
  Patient,
  Physician,
  UpdatePatientClinicalRequest,
  UpdatePatientClinicalResponse,
} from '@shared/types';
import { useOrgSession } from '../../lib/session';
import type { WithId } from '../../lib/firestore';
import { useAction } from '../../lib/hooks';
import { call } from '../../lib/firebase';
import { CODE_STATUSES } from '../../lib/constants';
import { Button, ErrorBanner, Field, Modal } from '../../components/ui';

/** S2: edit code status, allergies, medications, contacts, physicians and diagnoses (`updatePatientClinical`). */

type Phys = { name: string; npi: string; phone: string; fax: string };
type Med = { name: string; dose: string; route: string; frequency: string };
type Dx = { code: string; description: string };

const s = (v: string | null | undefined) => v ?? '';
const n = (v: string) => (v.trim() === '' ? null : v.trim());
const physDraft = (p: Physician | null): Phys => ({ name: s(p?.name), npi: s(p?.npi), phone: s(p?.phone), fax: s(p?.fax) });
const physOut = (p: Phys): Physician | null =>
  !p.name.trim() && !p.npi.trim() && !p.phone.trim() && !p.fax.trim() ? null : { name: p.name.trim(), npi: n(p.npi), phone: n(p.phone), fax: n(p.fax) };
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function Rows<T>({ label, items, blank, onChange, render }: { label: string; items: T[]; blank: T; onChange: (x: T[]) => void; render: (it: T, up: (next: T) => void) => ReactNode }) {
  return (
    <div className="list-editor">
      <div className="field-label">{label}</div>
      {items.map((it, i) => (
        <div key={i} className="list-editor-row">
          {render(it, (next) => onChange(items.map((x, j) => (j === i ? next : x))))}
          <Button small variant="ghost" aria-label="Remove" onClick={() => onChange(items.filter((_, j) => j !== i))}>×</Button>
        </div>
      ))}
      <Button small onClick={() => onChange([...items, blank])}>+ Add</Button>
    </div>
  );
}

export function ClinicalEditModal({ patient, onClose }: { patient: WithId<Patient>; onClose: () => void }) {
  const session = useOrgSession();
  const act = useAction();
  const [codeStatus, setCodeStatus] = useState<CodeStatus>(patient.codeStatus);
  const [allergies, setAllergies] = useState<string[]>(patient.allergies ?? []);
  const [meds, setMeds] = useState<Med[]>((patient.medications ?? []).map((m) => ({ name: m.name, dose: s(m.dose), route: s(m.route), frequency: s(m.frequency) })));
  const [cg, setCg] = useState({ name: s(patient.caregiver?.name), relationship: s(patient.caregiver?.relationship), phone: s(patient.caregiver?.phone) });
  const [attending, setAttending] = useState<Phys>(physDraft(patient.attendingPhysician));
  const [referring, setReferring] = useState<Phys>(physDraft(patient.referringPhysician));
  const [phone, setPhone] = useState(s(patient.phone));
  const [addr, setAddr] = useState({
    line1: s(patient.address?.line1), line2: s(patient.address?.line2), city: s(patient.address?.city), state: s(patient.address?.state), zip: s(patient.address?.zip),
  });
  const [pd, setPd] = useState<Dx>({ code: s(patient.primaryDiagnosis?.code), description: s(patient.primaryDiagnosis?.description) });
  const [dxs, setDxs] = useState<Dx[]>((patient.secondaryDiagnoses ?? []).map((d) => ({ code: s(d.code), description: d.description })));
  const [reason, setReason] = useState('');

  function build(): UpdatePatientClinicalRequest | string {
    const req: UpdatePatientClinicalRequest = { orgId: session.orgId, patientId: patient.id, reason: reason.trim() };
    if (codeStatus !== patient.codeStatus) req.codeStatus = codeStatus;
    const al = allergies.map((a) => a.trim()).filter(Boolean);
    if (!same(al, patient.allergies)) req.allergies = al;
    const md: Medication[] = meds
      .filter((m) => m.name.trim() || m.dose.trim() || m.route.trim() || m.frequency.trim())
      .map((m) => ({ name: m.name.trim(), dose: n(m.dose), route: n(m.route), frequency: n(m.frequency) }));
    if (md.some((m) => !m.name)) return 'Every medication needs a name.';
    if (!same(md, patient.medications)) req.medications = md;
    const careg = !cg.name.trim() && !cg.relationship.trim() && !cg.phone.trim() ? null : { name: cg.name.trim(), relationship: n(cg.relationship), phone: n(cg.phone) };
    if (careg && !careg.name) return 'The caregiver needs a name (or clear all caregiver fields).';
    const curCg = patient.caregiver ? { name: patient.caregiver.name, relationship: patient.caregiver.relationship, phone: patient.caregiver.phone } : null;
    if (!same(careg, curCg)) req.caregiver = careg;
    for (const [key, draft, label] of [['attendingPhysician', attending, 'attending'], ['referringPhysician', referring, 'referring']] as const) {
      const out = physOut(draft);
      if (out && !out.name) return `The ${label} physician needs a name (or clear all of its fields).`;
      if (!same(out, patient[key])) req[key] = out;
    }
    if (n(phone) !== (patient.phone ?? null)) req.phone = n(phone);
    const address: Address = { line1: n(addr.line1), line2: n(addr.line2), city: n(addr.city), state: n(addr.state), zip: n(addr.zip) };
    if (!same(address, { line1: patient.address?.line1 ?? null, line2: patient.address?.line2 ?? null, city: patient.address?.city ?? null, state: patient.address?.state ?? null, zip: patient.address?.zip ?? null })) {
      req.address = address;
    }
    const primary: Diagnosis | null = !pd.description.trim() && !pd.code.trim() ? null : { code: n(pd.code), description: pd.description.trim() };
    if (primary && !primary.description) return 'The primary diagnosis needs a description.';
    if (!same(primary, patient.primaryDiagnosis ? { code: patient.primaryDiagnosis.code, description: patient.primaryDiagnosis.description } : null)) req.primaryDiagnosis = primary;
    const sec: Diagnosis[] = dxs.filter((d) => d.description.trim() || d.code.trim()).map((d) => ({ code: n(d.code), description: d.description.trim() }));
    if (sec.some((d) => !d.description)) return 'Every secondary diagnosis needs a description.';
    if (!same(sec, patient.secondaryDiagnoses)) req.secondaryDiagnoses = sec;
    return req;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!reason.trim()) return act.setError('Enter a reason for the change.');
    const req = build();
    if (typeof req === 'string') return act.setError(req);
    if (Object.keys(req).length <= 3) return act.setError('Nothing has changed.');
    if (req.codeStatus && !window.confirm(`Change code status from ${patient.codeStatus} to ${req.codeStatus}? The care team will be notified.`)) return;
    if (await act.run(() => call<UpdatePatientClinicalRequest, UpdatePatientClinicalResponse>('updatePatientClinical', req))) onClose();
  }

  const physFields = (p: Phys, set: (p: Phys) => void) => (
    <div className="form-grid">
      <Field label="Name"><input value={p.name} onChange={(e) => set({ ...p, name: e.target.value })} /></Field>
      <Field label="NPI"><input value={p.npi} onChange={(e) => set({ ...p, npi: e.target.value })} /></Field>
      <Field label="Phone"><input type="tel" value={p.phone} onChange={(e) => set({ ...p, phone: e.target.value })} /></Field>
      <Field label="Fax"><input type="tel" value={p.fax} onChange={(e) => set({ ...p, fax: e.target.value })} /></Field>
    </div>
  );

  return (
    <Modal title="Edit clinical record" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <ErrorBanner error={act.error} />
        <fieldset className="fieldset">
          <legend>Code status and allergies</legend>
          <Field label="Code status" hint="A change is posted to the care team channel and the care team is alerted.">
            <select value={codeStatus} onChange={(e) => setCodeStatus(e.target.value as CodeStatus)}>
              {CODE_STATUSES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
          <Rows<string> label="Allergies" items={allergies} blank="" onChange={setAllergies} render={(a, up) => <input placeholder="Allergy" value={a} onChange={(e) => up(e.target.value)} />} />
        </fieldset>
        <fieldset className="fieldset">
          <legend>Medications</legend>
          <Rows<Med>
            label="Medication summary"
            items={meds}
            blank={{ name: '', dose: '', route: '', frequency: '' }}
            onChange={setMeds}
            render={(m, up) => (
              <>
                <input placeholder="Name" value={m.name} onChange={(e) => up({ ...m, name: e.target.value })} />
                <input placeholder="Dose" className="input-sm" value={m.dose} onChange={(e) => up({ ...m, dose: e.target.value })} />
                <input placeholder="Route" className="input-sm" value={m.route} onChange={(e) => up({ ...m, route: e.target.value })} />
                <input placeholder="Frequency" className="input-sm" value={m.frequency} onChange={(e) => up({ ...m, frequency: e.target.value })} />
              </>
            )}
          />
        </fieldset>
        <fieldset className="fieldset">
          <legend>Contacts</legend>
          <div className="form-grid">
            <Field label="Patient phone"><input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
            <Field label="Caregiver name"><input value={cg.name} onChange={(e) => setCg({ ...cg, name: e.target.value })} /></Field>
            <Field label="Caregiver relationship"><input value={cg.relationship} onChange={(e) => setCg({ ...cg, relationship: e.target.value })} /></Field>
            <Field label="Caregiver phone"><input type="tel" value={cg.phone} onChange={(e) => setCg({ ...cg, phone: e.target.value })} /></Field>
          </div>
          <div className="form-grid">
            <Field label="Address line 1"><input value={addr.line1} onChange={(e) => setAddr({ ...addr, line1: e.target.value })} /></Field>
            <Field label="Address line 2"><input value={addr.line2} onChange={(e) => setAddr({ ...addr, line2: e.target.value })} /></Field>
            <Field label="City"><input value={addr.city} onChange={(e) => setAddr({ ...addr, city: e.target.value })} /></Field>
            <Field label="State"><input value={addr.state} onChange={(e) => setAddr({ ...addr, state: e.target.value })} /></Field>
            <Field label="ZIP"><input value={addr.zip} onChange={(e) => setAddr({ ...addr, zip: e.target.value })} /></Field>
          </div>
        </fieldset>
        <fieldset className="fieldset">
          <legend>Attending physician</legend>
          {physFields(attending, setAttending)}
        </fieldset>
        <fieldset className="fieldset">
          <legend>Referring physician</legend>
          {physFields(referring, setReferring)}
        </fieldset>
        <fieldset className="fieldset">
          <legend>Diagnoses</legend>
          <div className="form-grid">
            <Field label="Primary diagnosis"><input value={pd.description} onChange={(e) => setPd({ ...pd, description: e.target.value })} /></Field>
            <Field label="ICD-10 code"><input value={pd.code} onChange={(e) => setPd({ ...pd, code: e.target.value })} /></Field>
          </div>
          <Rows<Dx>
            label="Secondary diagnoses"
            items={dxs}
            blank={{ code: '', description: '' }}
            onChange={setDxs}
            render={(d, up) => (
              <>
                <input placeholder="Description" value={d.description} onChange={(e) => up({ ...d, description: e.target.value })} />
                <input placeholder="ICD-10" className="input-sm" value={d.code} onChange={(e) => up({ ...d, code: e.target.value })} />
              </>
            )}
          />
        </fieldset>
        <Field label="Reason for change" hint="Recorded in the patient timeline and audit log.">
          <textarea rows={2} required value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <div className="row gap end">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" busy={act.busy}>Save changes</Button>
        </div>
      </form>
    </Modal>
  );
}
