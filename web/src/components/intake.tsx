/** v3 intake UI pieces shared by the referral queue and the review page. */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type {
  CloseReferralNonAdmitRequest,
  CreateManualReferralRequest,
  DuplicateMatch,
  IdResponse,
  NonAdmitReason,
  PatientInput,
  RejectReferralRequest,
} from '@shared/types';
import { call } from '../lib/firebase';
import { NON_ADMIT_REASON_LABELS, SEXES } from '../lib/constants';
import { errorMessage, todayISO } from '../lib/format';
import { emptyPatientInput, normalizePatientInput } from '../lib/patient';
import { Button, ErrorBanner, Field, Modal } from './ui';

export function DuplicateBanner({
  matches,
  confirmed,
  onConfirm,
}: {
  matches: DuplicateMatch[];
  confirmed?: boolean;
  onConfirm?: (v: boolean) => void;
}) {
  if (matches.length === 0) return null;
  return (
    <div className="banner banner-warn">
      <strong>Possible duplicate{matches.length > 1 ? 's' : ''}</strong>
      <ul>
        {matches.map((m) => (
          <li key={`${m.kind}/${m.id}`}>
            <Link to={m.kind === 'patient' ? `/patients/${m.id}` : `/referrals/${m.id}`}>{m.displayName}</Link>{' '}
            <span className="muted small">
              ({m.kind} · {m.status.replace(/_/g, ' ')} · same {m.matchedOn.map((o) => (o === 'mbi' ? 'Medicare MBI' : 'last name and DOB')).join(' and ')})
            </span>
          </li>
        ))}
      </ul>
      {onConfirm && (
        <label className="row gap-sm">
          <input type="checkbox" checked={!!confirmed} onChange={(e) => onConfirm(e.target.checked)} />
          I checked these records and this referral is not a duplicate.
        </label>
      )}
    </div>
  );
}

export function RejectReferralModal({ orgId, referralId, onClose }: { orgId: string; referralId: string; onClose: (done: boolean) => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await call<RejectReferralRequest, Record<string, never>>('rejectReferral', { orgId, referralId, reason: reason.trim() });
      onClose(true);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Reject referral"
      onClose={() => onClose(false)}
      footer={
        <>
          <Button onClick={() => onClose(false)}>Cancel</Button>
          <Button variant="danger" busy={busy} disabled={!reason.trim()} onClick={() => void submit()}>Reject</Button>
        </>
      }
    >
      <ErrorBanner error={error} />
      <p className="muted small">Use Reject for a referral that isn't a real patient referral (wrong fax, duplicate upload). Use Non-admit for a patient who won't be admitted.</p>
      <Field label="Reason">
        <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
      </Field>
    </Modal>
  );
}

export function NonAdmitModal({ orgId, referralId, onClose }: { orgId: string; referralId: string; onClose: (done: boolean) => void }) {
  const [reason, setReason] = useState<NonAdmitReason>('declined_hospice');
  const [note, setNote] = useState('');
  const [deathDate, setDeathDate] = useState(todayISO());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const died = reason === 'died_before_admission';
  const invalid = (reason === 'other' && !note.trim()) || (died && !deathDate);
  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await call<CloseReferralNonAdmitRequest, Record<string, never>>('closeReferralNonAdmit', {
        orgId,
        referralId,
        reason,
        note: note.trim() || null,
        ...(died ? { deathDate } : {}),
      });
      onClose(true);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Close as non-admit"
      onClose={() => onClose(false)}
      footer={
        <>
          <Button onClick={() => onClose(false)}>Cancel</Button>
          <Button variant="danger" busy={busy} disabled={invalid} onClick={() => void submit()}>Close referral</Button>
        </>
      }
    >
      <ErrorBanner error={error} />
      <Field label="Reason">
        <select value={reason} onChange={(e) => setReason(e.target.value as NonAdmitReason)}>
          {(Object.keys(NON_ADMIT_REASON_LABELS) as NonAdmitReason[]).map((r) => (
            <option key={r} value={r}>{NON_ADMIT_REASON_LABELS[r]}</option>
          ))}
        </select>
      </Field>
      {died && (
        <Field label="Date of death" hint="Recorded on the referral patient. No bereavement plan is created because the patient was never admitted.">
          <input type="date" max={todayISO()} value={deathDate} onChange={(e) => setDeathDate(e.target.value)} />
        </Field>
      )}
      <Field label={reason === 'other' ? 'Note (required)' : 'Note'}>
        <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </Modal>
  );
}

/** "New phone referral": the essentials taken on a call; the rest is completed on the review page. */
export function PhoneReferralModal({ orgId, onClose }: { orgId: string; onClose: (referralId: string | null) => void }) {
  const [p, setP] = useState<PatientInput>(emptyPatientInput());
  const [referralDate, setReferralDate] = useState(todayISO());
  const [referralSource, setReferralSource] = useState('');
  const [reasonForReferral, setReason] = useState('');
  const [diagnosis, setDiagnosis] = useState('');
  const [caregiverName, setCaregiverName] = useState('');
  const [caregiverPhone, setCaregiverPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof PatientInput>(k: K, v: PatientInput[K]) => setP({ ...p, [k]: v });

  async function submit() {
    if (!p.firstName.trim() || !p.lastName.trim()) return setError('First and last name are required.');
    setBusy(true);
    setError(null);
    try {
      const patient = normalizePatientInput({
        ...p,
        primaryDiagnosis: diagnosis.trim() ? { code: null, description: diagnosis.trim() } : null,
        caregiver: caregiverName.trim() ? { name: caregiverName.trim(), relationship: null, phone: caregiverPhone.trim() || null } : null,
      });
      const res = await call<CreateManualReferralRequest, IdResponse>('createManualReferral', {
        orgId,
        patient,
        referralDate: referralDate || null,
        referralSource: referralSource.trim() || null,
        reasonForReferral: reasonForReferral.trim() || null,
      });
      onClose(res.id);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal
      title="New phone referral"
      wide
      onClose={() => onClose(null)}
      footer={
        <>
          <Button onClick={() => onClose(null)}>Cancel</Button>
          <Button variant="primary" busy={busy} onClick={() => void submit()}>Create referral</Button>
        </>
      }
    >
      <ErrorBanner error={error} />
      <div className="form-grid">
        <Field label="First name"><input value={p.firstName} onChange={(e) => set('firstName', e.target.value)} autoFocus /></Field>
        <Field label="Last name"><input value={p.lastName} onChange={(e) => set('lastName', e.target.value)} /></Field>
        <Field label="Date of birth"><input type="date" value={p.dob ?? ''} onChange={(e) => set('dob', e.target.value || null)} /></Field>
        <Field label="Sex">
          <select value={p.sex} onChange={(e) => set('sex', e.target.value as PatientInput['sex'])}>
            {SEXES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </Field>
        <Field label="Patient phone"><input value={p.phone ?? ''} onChange={(e) => set('phone', e.target.value || null)} /></Field>
        <Field label="Medicare MBI" hint="Used to check for duplicates."><input value={p.medicareMbi ?? ''} onChange={(e) => set('medicareMbi', e.target.value || null)} /></Field>
        <Field label="Primary diagnosis"><input value={diagnosis} onChange={(e) => setDiagnosis(e.target.value)} /></Field>
        <Field label="Caregiver name"><input value={caregiverName} onChange={(e) => setCaregiverName(e.target.value)} /></Field>
        <Field label="Caregiver phone"><input value={caregiverPhone} onChange={(e) => setCaregiverPhone(e.target.value)} /></Field>
        <Field label="Referral date"><input type="date" value={referralDate} onChange={(e) => setReferralDate(e.target.value)} /></Field>
        <Field label="Referral source" hint="Facility, agency or person who called."><input value={referralSource} onChange={(e) => setReferralSource(e.target.value)} /></Field>
      </div>
      <Field label="Reason for referral"><textarea rows={2} value={reasonForReferral} onChange={(e) => setReason(e.target.value)} /></Field>
      <p className="muted small">The referral opens for review, where you can complete the remaining fields before accepting it.</p>
    </Modal>
  );
}
