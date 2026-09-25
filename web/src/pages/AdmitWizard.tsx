import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { getDoc } from 'firebase/firestore';
import type {
  AdmitPatientRequest,
  AdmitPatientResponse,
  Consents,
  LevelOfCare,
  Patient,
  PatientInput,
} from '@shared/types';
import { useOrgSession } from '../lib/session';
import { orgDoc } from '../lib/firestore';
import { call } from '../lib/firebase';
import { LEVELS_OF_CARE, LEVEL_OF_CARE_LABELS } from '../lib/constants';
import { errorMessage, formatDate, todayISO } from '../lib/format';
import { emptyPatientInput, normalizePatientInput, patientName, toPatientInput } from '../lib/patient';
import { PatientForm } from '../components/PatientForm';
import { Button, Card, ErrorBanner, Field, Loading, MemberPicker, Page } from '../components/ui';

const STEPS = ['Demographics', 'Consents', 'Admission', 'Care team', 'Review'] as const;

const CONSENTS: { key: keyof Consents; label: string; required?: boolean }[] = [
  { key: 'electionStatement', label: 'Hospice election statement signed', required: true },
  { key: 'hipaaNotice', label: 'HIPAA notice of privacy practices acknowledged' },
  { key: 'releaseOfInformation', label: 'Release of information signed' },
  { key: 'patientRights', label: 'Patient rights & responsibilities reviewed' },
  { key: 'polstOnFile', label: 'POLST / DNR form on file (DNR-type code status)' },
];

export default function AdmitWizardPage() {
  const { patientId } = useParams();
  const s = useOrgSession();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(!!patientId);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [patient, setPatient] = useState<PatientInput>(emptyPatientInput());
  const [consents, setConsents] = useState<Consents>({
    electionStatement: false,
    hipaaNotice: false,
    releaseOfInformation: false,
    patientRights: false,
    polstOnFile: false,
  });
  const [admissionDate, setAdmissionDate] = useState(todayISO());
  const [levelOfCare, setLevelOfCare] = useState<LevelOfCare>('routine');
  const [startingBenefitPeriod, setStartingBenefitPeriod] = useState(1);
  const [careTeamUids, setCareTeamUids] = useState<string[]>([s.user.uid]);

  useEffect(() => {
    if (!patientId) return;
    getDoc(orgDoc(s.orgId, 'patients', patientId))
      .then((snap) => {
        if (!snap.exists()) {
          setError('Patient not found.');
          return;
        }
        const p = snap.data() as Patient;
        setPatient(toPatientInput(p));
        if (p.consents) setConsents(p.consents);
        if (p.careTeamUids?.length) setCareTeamUids(p.careTeamUids);
        if (p.admissionDate) setAdmissionDate(p.admissionDate);
        if (p.levelOfCare) setLevelOfCare(p.levelOfCare);
        if (p.startingBenefitPeriod) setStartingBenefitPeriod(p.startingBenefitPeriod);
      })
      .catch((err) => setError(errorMessage(err)))
      .finally(() => setLoading(false));
  }, [s.orgId, patientId]);

  const dnrType = ['DNR', 'DNR/DNI', 'Comfort Care Only'].includes(patient.codeStatus);

  function validate(i: number): string | null {
    if (i === 0) {
      if (!patient.firstName.trim() || !patient.lastName.trim()) return 'First and last name are required.';
      if (!patient.dob) return 'Date of birth is required.';
    }
    if (i === 1 && !consents.electionStatement) return 'The hospice election statement is required to admit.';
    if (i === 2) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(admissionDate)) return 'Admission date is required.';
      if (!(startingBenefitPeriod >= 1)) return 'Starting benefit period must be 1 or greater.';
    }
    if (i === 3 && careTeamUids.length === 0) return 'Select at least one care team member.';
    return null;
  }

  function next() {
    const v = validate(step);
    if (v) return setError(v);
    setError(null);
    setStep(step + 1);
  }

  async function submit() {
    for (let i = 0; i < 4; i++) {
      const v = validate(i);
      if (v) {
        setStep(i);
        return setError(v);
      }
    }
    setBusy(true);
    setError(null);
    try {
      const req: AdmitPatientRequest = {
        orgId: s.orgId,
        patient: normalizePatientInput(patient),
        admissionDate,
        startingBenefitPeriod,
        levelOfCare,
        careTeamUids,
        consents,
      };
      if (patientId) req.patientId = patientId;
      const res = await call<AdmitPatientRequest, AdmitPatientResponse>('admitPatient', req);
      navigate(`/patients/${res.patientId}`, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  if (loading) return <Loading />;

  return (
    <Page title={patientId ? `Admit ${patientName(patient)}` : 'Admit patient'}>
      <ol className="wizard-steps">
        {STEPS.map((label, i) => (
          <li key={label} className={i === step ? 'active' : i < step ? 'done' : ''}>
            <button type="button" disabled={i > step} onClick={() => setStep(i)}>
              <span className="num">{i + 1}</span> {label}
            </button>
          </li>
        ))}
      </ol>
      <ErrorBanner error={error} />
      <Card>
        {step === 0 && <PatientForm value={patient} onChange={setPatient} />}

        {step === 1 && (
          <div className="form">
            <ul className="checklist checklist-edit">
              {CONSENTS.map((c) => (
                <li key={c.key}>
                  <label className="row gap-sm">
                    <input
                      type="checkbox"
                      checked={consents[c.key]}
                      onChange={(e) => setConsents({ ...consents, [c.key]: e.target.checked })}
                    />
                    {c.label} {c.required && <span className="muted small">(required)</span>}
                  </label>
                </li>
              ))}
            </ul>
            {dnrType && !consents.polstOnFile && (
              <div className="banner banner-warn">Code status is {patient.codeStatus}; confirm a POLST/DNR form is on file.</div>
            )}
          </div>
        )}

        {step === 2 && (
          <div className="form form-narrow">
            <Field label="Admission / election date" hint="Day 1 for NOE, HOPE and benefit-period calculations.">
              <input type="date" required value={admissionDate} onChange={(e) => setAdmissionDate(e.target.value)} />
            </Field>
            <Field label="Level of care">
              <select value={levelOfCare} onChange={(e) => setLevelOfCare(e.target.value as LevelOfCare)}>
                {LEVELS_OF_CARE.map((l) => <option key={l} value={l}>{LEVEL_OF_CARE_LABELS[l]}</option>)}
              </select>
            </Field>
            <Field label="Starting benefit period" hint="Greater than 1 when transferring from another hospice.">
              <input
                type="number"
                min={1}
                value={startingBenefitPeriod}
                onChange={(e) => setStartingBenefitPeriod(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
              />
            </Field>
          </div>
        )}

        {step === 3 && (
          <Field label="Care team" hint="A patient care-team channel is created with these members (and you).">
            <MemberPicker members={s.members} value={careTeamUids} onChange={setCareTeamUids} />
          </Field>
        )}

        {step === 4 && (
          <dl className="dl">
            <div><dt>Patient</dt><dd>{patientName(patient)} · DOB {formatDate(patient.dob)}</dd></div>
            <div><dt>Primary diagnosis</dt><dd>{patient.primaryDiagnosis?.description || '—'}</dd></div>
            <div><dt>Code status</dt><dd>{patient.codeStatus}</dd></div>
            <div>
              <dt>Consents</dt>
              <dd>{CONSENTS.filter((c) => consents[c.key]).map((c) => c.label).join('; ') || 'None'}</dd>
            </div>
            <div><dt>Admission date</dt><dd>{formatDate(admissionDate)}</dd></div>
            <div><dt>Level of care</dt><dd>{LEVEL_OF_CARE_LABELS[levelOfCare]}</dd></div>
            <div><dt>Starting benefit period</dt><dd>{startingBenefitPeriod}</dd></div>
            <div><dt>Care team</dt><dd>{careTeamUids.map((u) => s.memberName(u)).join(', ')}</dd></div>
          </dl>
        )}

        <div className="row space-between wizard-nav">
          <Button onClick={() => (step === 0 ? navigate(-1) : setStep(step - 1))}>{step === 0 ? 'Cancel' : 'Back'}</Button>
          {step < STEPS.length - 1 ? (
            <Button variant="primary" onClick={next}>Next</Button>
          ) : (
            <Button variant="primary" busy={busy} onClick={() => void submit()}>Admit patient</Button>
          )}
        </div>
      </Card>
    </Page>
  );
}
