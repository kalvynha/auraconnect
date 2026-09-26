import { useState, type FormEvent } from 'react';
import type {
  ChangeLevelOfCareRequest,
  DischargePatientRequest,
  DischargeReason,
  LevelOfCare,
  Patient,
  RecordDeathRequest,
  RecordRecertificationRequest,
} from '@shared/types';
import { useOrgSession } from '../../lib/session';
import type { WithId } from '../../lib/firestore';
import { useAction } from '../../lib/hooks';
import { call } from '../../lib/firebase';
import {
  BEREAVEMENT_RISKS,
  DISCHARGE_REASON_LABELS,
  LEVELS_OF_CARE,
  LEVEL_OF_CARE_LABELS,
  type BereavementRisk,
} from '../../lib/constants';
import { formatDate, optStr, todayISO } from '../../lib/format';
import { currentBenefitPeriodNumber } from '../../lib/milestones';
import { patientName } from '../../lib/patient';
import { Button, ErrorBanner, Field, MemberSelect, Modal } from '../../components/ui';

export type LifecycleAction = 'loc' | 'recert' | 'discharge' | 'death';

function Footer({ onClose, busy, label, danger }: { onClose: () => void; busy: boolean; label: string; danger?: boolean }) {
  return (
    <div className="row gap end">
      <Button onClick={onClose}>Cancel</Button>
      <Button type="submit" variant={danger ? 'danger' : 'primary'} busy={busy}>{label}</Button>
    </div>
  );
}

function LevelOfCareModal({ patient, onClose }: { patient: WithId<Patient>; onClose: () => void }) {
  const s = useOrgSession();
  const act = useAction();
  const [levelOfCare, setLevel] = useState<LevelOfCare>(patient.levelOfCare);
  const [effectiveDate, setDate] = useState(todayISO());
  const [reason, setReason] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (levelOfCare === patient.levelOfCare) return act.setError('Choose a different level of care.');
    if (!reason.trim()) return act.setError('A reason is required.');
    const req: ChangeLevelOfCareRequest = { orgId: s.orgId, patientId: patient.id, levelOfCare, effectiveDate, reason: reason.trim() };
    if (await act.run(() => call<ChangeLevelOfCareRequest, unknown>('changeLevelOfCare', req))) onClose();
  }

  return (
    <Modal title="Change level of care" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <ErrorBanner error={act.error} />
        <p className="muted">Current: {LEVEL_OF_CARE_LABELS[patient.levelOfCare]}</p>
        <div className="form-grid">
          <Field label="New level of care">
            <select value={levelOfCare} onChange={(e) => setLevel(e.target.value as LevelOfCare)}>
              {LEVELS_OF_CARE.map((l) => <option key={l} value={l}>{LEVEL_OF_CARE_LABELS[l]}</option>)}
            </select>
          </Field>
          <Field label="Effective date">
            <input type="date" required value={effectiveDate} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>
        <Field label="Reason">
          <textarea rows={2} required value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <Footer onClose={onClose} busy={act.busy} label="Change level of care" />
      </form>
    </Modal>
  );
}

function RecertModal({ patient, onClose }: { patient: WithId<Patient>; onClose: () => void }) {
  const s = useOrgSession();
  const act = useAction();
  const periods = patient.milestones?.benefitPeriods ?? [];
  const cur = currentBenefitPeriodNumber(patient.milestones);
  const defaultPeriod = periods.find((p) => cur !== null && p.number === cur + 1) ?? periods.find((p) => p.number > (cur ?? 0)) ?? periods[0];
  const [periodNumber, setPeriodNumber] = useState<number>(defaultPeriod?.number ?? 1);
  const [certifyingPhysician, setPhysician] = useState(patient.attendingPhysician?.name ?? '');
  const [certificationDate, setCertDate] = useState(todayISO());
  const [f2fDate, setF2fDate] = useState('');
  const [f2fBy, setF2fBy] = useState('');
  const period = periods.find((p) => p.number === periodNumber);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!period) return act.setError('Choose a benefit period.');
    if (!certifyingPhysician.trim()) return act.setError('Certifying physician is required.');
    if (period.f2fRequired && !f2fDate) return act.setError('A face-to-face encounter date is required for this period.');
    const req: RecordRecertificationRequest = {
      orgId: s.orgId,
      patientId: patient.id,
      periodNumber,
      certifyingPhysician: certifyingPhysician.trim(),
      certificationDate,
    };
    if (period.f2fRequired) {
      req.f2fDate = f2fDate;
      const by = optStr(f2fBy);
      if (by) req.f2fBy = by;
    }
    if (await act.run(() => call<RecordRecertificationRequest, unknown>('recordRecertification', req))) onClose();
  }

  if (periods.length === 0) {
    return (
      <Modal title="Record recertification" onClose={onClose}>
        <p className="muted">This patient has no computed benefit periods.</p>
      </Modal>
    );
  }

  return (
    <Modal title="Record recertification" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <ErrorBanner error={act.error} />
        <Field label="Benefit period being certified">
          <select value={periodNumber} onChange={(e) => setPeriodNumber(Number(e.target.value))}>
            {periods.map((p) => (
              <option key={p.number} value={p.number}>
                Period {p.number}: {formatDate(p.start)} – {formatDate(p.end)} ({p.lengthDays} days){p.number === cur ? ' · current' : ''}
                {p.f2fRequired ? ' · F2F required' : ''}
              </option>
            ))}
          </select>
        </Field>
        <div className="form-grid">
          <Field label="Certifying physician">
            <input required value={certifyingPhysician} onChange={(e) => setPhysician(e.target.value)} />
          </Field>
          <Field label="Certification date">
            <input type="date" required value={certificationDate} onChange={(e) => setCertDate(e.target.value)} />
          </Field>
        </div>
        {period?.f2fRequired && (
          <fieldset className="fieldset">
            <legend>Face-to-face encounter (required)</legend>
            <p className="muted small">
              Window: {formatDate(period.f2fWindowStart)} – {formatDate(period.f2fDueBy)}
            </p>
            <div className="form-grid">
              <Field label="F2F date">
                <input type="date" required value={f2fDate} onChange={(e) => setF2fDate(e.target.value)} />
              </Field>
              <Field label="Performed by">
                <input value={f2fBy} onChange={(e) => setF2fBy(e.target.value)} placeholder="Physician or NP" />
              </Field>
            </div>
          </fieldset>
        )}
        <Footer onClose={onClose} busy={act.busy} label="Record recertification" />
      </form>
    </Modal>
  );
}

function DischargeModal({ patient, onClose }: { patient: WithId<Patient>; onClose: () => void }) {
  const s = useOrgSession();
  const act = useAction();
  const [dischargeDate, setDate] = useState(todayISO());
  const [reason, setReason] = useState<DischargeReason | ''>('');
  const [notes, setNotes] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!reason) return act.setError('Choose a discharge reason.');
    if (!window.confirm(`Discharge ${patientName(patient)}? The care team channel will be archived and future visits and open tasks cancelled.`)) return;
    const req: DischargePatientRequest = { orgId: s.orgId, patientId: patient.id, dischargeDate, reason };
    const n = optStr(notes);
    if (n) req.notes = n;
    if (await act.run(() => call<DischargePatientRequest, unknown>('dischargePatient', req))) onClose();
  }

  return (
    <Modal title="Discharge patient" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <ErrorBanner error={act.error} />
        <div className="form-grid">
          <Field label="Discharge date">
            <input type="date" required value={dischargeDate} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Reason">
            <select required value={reason} onChange={(e) => setReason(e.target.value as DischargeReason)}>
              <option value="">Select reason…</option>
              {(Object.keys(DISCHARGE_REASON_LABELS) as DischargeReason[]).map((r) => (
                <option key={r} value={r}>{DISCHARGE_REASON_LABELS[r]}</option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Notes">
          <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <Footer onClose={onClose} busy={act.busy} label="Discharge" danger />
      </form>
    </Modal>
  );
}

function DeathModal({ patient, onClose }: { patient: WithId<Patient>; onClose: () => void }) {
  const s = useOrgSession();
  const act = useAction();
  const [date, setDate] = useState(todayISO());
  const [time, setTime] = useState('');
  const [pronouncedBy, setPronouncedBy] = useState('');
  const [location, setLocation] = useState('');
  const [notes, setNotes] = useState('');
  const [risk, setRisk] = useState<BereavementRisk>('low');
  const [assignee, setAssignee] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!window.confirm(`Record the death of ${patientName(patient)}? This archives the care team channel and starts a bereavement plan.`)) return;
    const req: RecordDeathRequest = { orgId: s.orgId, patientId: patient.id, date, bereavementRisk: risk };
    if (time) req.time = time;
    const pb = optStr(pronouncedBy);
    if (pb) req.pronouncedBy = pb;
    const loc = optStr(location);
    if (loc) req.location = loc;
    const n = optStr(notes);
    if (n) req.notes = n;
    if (assignee) req.bereavementAssigneeUid = assignee;
    if (await act.run(() => call<RecordDeathRequest, unknown>('recordDeath', req))) onClose();
  }

  return (
    <Modal title="Record death" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <ErrorBanner error={act.error} />
        <div className="form-grid">
          <Field label="Date of death">
            <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Time of death" hint="Local time in the organization's time zone.">
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </Field>
          <Field label="Pronounced by">
            <input value={pronouncedBy} onChange={(e) => setPronouncedBy(e.target.value)} />
          </Field>
          <Field label="Location">
            <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Home, facility…" />
          </Field>
        </div>
        <Field label="Notes">
          <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <fieldset className="fieldset">
          <legend>Bereavement plan</legend>
          <div className="form-grid">
            <Field label="Bereavement risk">
              <select value={risk} onChange={(e) => setRisk(e.target.value as BereavementRisk)}>
                {BEREAVEMENT_RISKS.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </Field>
            <Field label="Bereavement coordinator">
              <MemberSelect members={s.members} value={assignee} onChange={setAssignee} placeholder="Unassigned" />
            </Field>
          </div>
        </fieldset>
        <Footer onClose={onClose} busy={act.busy} label="Record death" danger />
      </form>
    </Modal>
  );
}

export function LifecycleModal({ action, patient, onClose }: { action: LifecycleAction; patient: WithId<Patient>; onClose: () => void }) {
  switch (action) {
    case 'loc':
      return <LevelOfCareModal patient={patient} onClose={onClose} />;
    case 'recert':
      return <RecertModal patient={patient} onClose={onClose} />;
    case 'discharge':
      return <DischargeModal patient={patient} onClose={onClose} />;
    case 'death':
      return <DeathModal patient={patient} onClose={onClose} />;
  }
}
