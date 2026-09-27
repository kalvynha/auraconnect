import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { getDoc } from 'firebase/firestore';
import type {
  AdmitPatientRequest,
  AdmitPatientResponse,
  Consents,
  Discipline,
  LevelOfCare,
  Patient,
  PatientInput,
  PatientStatus,
  Team,
  VisitFrequency,
} from '@shared/types';
import { useOrgSession } from '../lib/session';
import { orgCol, orgDoc } from '../lib/firestore';
import { useLiveQuery } from '../lib/hooks';
import { call } from '../lib/firebase';
import { DISCIPLINES, LEVELS_OF_CARE, LEVEL_OF_CARE_LABELS } from '../lib/constants';
import { addDaysISO, daysBetween, errorMessage, formatDate, todayISO } from '../lib/format';
import { emptyPatientInput, normalizePatientInput, patientName, toPatientInput } from '../lib/patient';
import { PatientForm } from '../components/PatientForm';
import { Button, Card, ErrorBanner, Field, Loading, MemberPicker, Page } from '../components/ui';

const STEPS = ['Demographics', 'Consents', 'Admission', 'Care team', 'Visit frequencies', 'Review'] as const;
const REVIEW_STEP = STEPS.length - 1;

const CONSENTS: { key: keyof Consents; label: string; required?: boolean }[] = [
  { key: 'electionStatement', label: 'Hospice election statement signed', required: true },
  { key: 'hipaaNotice', label: 'HIPAA notice of privacy practices acknowledged', required: true },
  { key: 'releaseOfInformation', label: 'Release of information signed' },
  { key: 'patientRights', label: 'Patient rights & responsibilities reviewed' },
  { key: 'polstOnFile', label: 'POLST / DNR form on file (DNR-type code status)' },
];

/** Licensed disciplines that join the care-team channel by default (mirrors the server). */
const LICENSED: readonly Discipline[] = ['RN', 'NP', 'MD'];
const TYPICAL_FREQUENCIES: VisitFrequency[] = [
  { discipline: 'RN', perWeek: 2, notes: null },
  { discipline: 'Aide', perWeek: 2, notes: null },
  { discipline: 'SW', perWeek: 0.5, notes: null },
  { discipline: 'Chaplain', perWeek: 0.5, notes: null },
];

const periodLength = (n: number) => (n <= 2 ? 90 : 60);

export default function AdmitWizardPage() {
  const { patientId } = useParams();
  const s = useOrgSession();
  const navigate = useNavigate();
  const teams = useLiveQuery<Team>(orgCol(s.orgId, 'teams'), [s.orgId]);
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(!!patientId);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [existingStatus, setExistingStatus] = useState<PatientStatus | null>(null);
  const [confirmReadmission, setConfirmReadmission] = useState(false);
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
  const [transfer, setTransfer] = useState(false);
  const [startingBenefitPeriod, setStartingBenefitPeriod] = useState(1);
  const [benefitPeriodStart, setBenefitPeriodStart] = useState('');
  const [teamId, setTeamId] = useState('');
  const [careTeamUids, setCareTeamUids] = useState<string[]>([]);
  const [careTeamTouched, setCareTeamTouched] = useState(false);
  const [joinChannel, setJoinChannel] = useState(s.member?.role !== 'intake' && LICENSED.includes(s.member?.discipline ?? 'Other'));
  const [frequencies, setFrequencies] = useState<VisitFrequency[]>([]);

  const mode: 'new' | 'update' | 'readmission' =
    existingStatus === 'admitted' ? 'update' : existingStatus === 'discharged' ? 'readmission' : 'new';

  useEffect(() => {
    if (!patientId) return;
    getDoc(orgDoc(s.orgId, 'patients', patientId))
      .then((snap) => {
        if (!snap.exists()) {
          setError('Patient not found.');
          return;
        }
        const p = snap.data() as Patient;
        setExistingStatus(p.status);
        setPatient(toPatientInput(p));
        if (p.consents) setConsents(p.consents);
        if (p.status === 'admitted') {
          // Update mode: show what's on file.
          if (p.careTeamUids?.length) {
            setCareTeamUids(p.careTeamUids);
            setCareTeamTouched(true);
          }
          if (p.admissionDate) setAdmissionDate(p.admissionDate);
          if (p.levelOfCare) setLevelOfCare(p.levelOfCare);
        }
        if (p.status === 'admitted' || p.status === 'discharged') {
          if (p.visitFrequencies?.length) setFrequencies(p.visitFrequencies);
        }
        if (p.status === 'admitted' && p.startingBenefitPeriod) {
          setStartingBenefitPeriod(p.startingBenefitPeriod);
          if (p.benefitPeriodStart) {
            setTransfer(true);
            setBenefitPeriodStart(p.benefitPeriodStart);
          } else if (p.startingBenefitPeriod > 1) {
            setTransfer(true);
          }
        }
      })
      .catch((err) => setError(errorMessage(err)))
      .finally(() => setLoading(false));
  }, [s.orgId, patientId]);

  // Default the care team to the caller's team (when they're on exactly one), not to the caller alone.
  useEffect(() => {
    if (careTeamTouched || teamId || teams.loading) return;
    const mine = teams.data.filter((t) => (s.member?.teamIds ?? []).includes(t.id));
    if (mine.length === 1) chooseTeam(mine[0]!.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teams.loading, teams.data, careTeamTouched]);

  function chooseTeam(id: string) {
    setTeamId(id);
    const team = teams.data.find((t) => t.id === id);
    if (!team) return;
    const active = new Set(s.members.filter((m) => m.active !== false).map((m) => m.uid ?? m.id));
    setCareTeamUids(team.memberUids.filter((u) => active.has(u)));
  }

  const dnrType = ['DNR', 'DNR/DNI', 'Comfort Care Only'].includes(patient.codeStatus);

  function validate(i: number): string | null {
    if (i === 0) {
      if (!patient.firstName.trim() || !patient.lastName.trim()) return 'First and last name are required.';
      if (!patient.dob) return 'Date of birth is required.';
      if (patient.dob > todayISO()) return 'Date of birth cannot be in the future.';
    }
    if (i === 1) {
      if (!consents.electionStatement) return 'The hospice election statement is required to admit.';
      if (!consents.hipaaNotice) return 'The HIPAA notice acknowledgement is required to admit.';
    }
    if (i === 2) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(admissionDate)) return 'Admission date is required.';
      if (mode === 'readmission' && !confirmReadmission) return 'Confirm that this is a readmission after discharge.';
      if (!(startingBenefitPeriod >= 1 && startingBenefitPeriod <= 100)) return 'Benefit period must be between 1 and 100.';
      if (transfer) {
        if (benefitPeriodStart) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(benefitPeriodStart)) return 'Enter a valid benefit period start date.';
          const d = daysBetween(benefitPeriodStart, admissionDate);
          if (d < 0) return 'The benefit period start cannot be after the admission date.';
          const len = periodLength(startingBenefitPeriod);
          if (d >= len) return `The admission date is outside benefit period ${startingBenefitPeriod} (${len} days from its start).`;
        }
      }
    }
    if (i === 3 && careTeamUids.length === 0) return 'Select at least one care team member.';
    if (i === 4) {
      const seen = new Set<string>();
      for (const f of frequencies) {
        if (!(f.perWeek > 0 && f.perWeek <= 28)) return `${f.discipline}: visits per week must be more than 0 and at most 28.`;
        if (seen.has(f.discipline)) return `${f.discipline} is listed twice.`;
        seen.add(f.discipline);
      }
    }
    return null;
  }

  function next() {
    const v = validate(step);
    if (v) return setError(v);
    setError(null);
    setStep(step + 1);
  }

  async function submit() {
    for (let i = 0; i < REVIEW_STEP; i++) {
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
        startingBenefitPeriod: transfer || mode === 'readmission' ? startingBenefitPeriod : 1,
        levelOfCare,
        careTeamUids,
        consents,
        joinChannel,
        visitFrequencies: frequencies.map((f) => ({ ...f, notes: f.notes?.trim() || null })),
      };
      if (transfer && benefitPeriodStart) req.benefitPeriodStart = benefitPeriodStart;
      if (patientId) req.patientId = patientId;
      if (mode === 'update') req.update = true;
      if (mode === 'readmission') req.readmission = true;
      const res = await call<AdmitPatientRequest, AdmitPatientResponse>('admitPatient', req);
      navigate(`/patients/${res.patientId}`, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  if (loading) return <Loading />;
  if (existingStatus === 'deceased' || existingStatus === 'non_admit') {
    return (
      <Page title="Admit patient">
        <ErrorBanner error={`This patient is ${existingStatus === 'deceased' ? 'deceased' : 'closed as a non-admit'} and can't be admitted.`} />
      </Page>
    );
  }

  const title = mode === 'update' ? `Update admission: ${patientName(patient)}` : mode === 'readmission' ? `Readmit ${patientName(patient)}` : patientId ? `Admit ${patientName(patient)}` : 'Admit patient';
  const usedDisciplines = new Set(frequencies.map((f) => f.discipline));

  return (
    <Page title={title}>
      {mode === 'update' && (
        <div className="banner banner-info">
          This patient is already admitted. Saving updates demographics, consents, admission dates and visit frequencies. Use the patient page to change the care team or level of care.
        </div>
      )}
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
            {mode === 'readmission' && (
              <label className="row gap-sm banner banner-warn">
                <input type="checkbox" checked={confirmReadmission} onChange={(e) => setConfirmReadmission(e.target.checked)} />
                This patient was discharged. Readmit them: a new admission starts, and the prior milestones are archived on the timeline.
              </label>
            )}
            <Field label="Admission / election date" hint="Day 1 for NOE, HOPE and benefit-period calculations.">
              <input type="date" required value={admissionDate} onChange={(e) => setAdmissionDate(e.target.value)} />
            </Field>
            <Field label="Level of care" hint={mode === 'update' ? 'Change the level of care from the patient page.' : undefined}>
              <select value={levelOfCare} disabled={mode === 'update'} onChange={(e) => setLevelOfCare(e.target.value as LevelOfCare)}>
                {LEVELS_OF_CARE.map((l) => <option key={l} value={l}>{LEVEL_OF_CARE_LABELS[l]}</option>)}
              </select>
            </Field>
            {mode === 'readmission' && !transfer && (
              <Field label="Starting benefit period" hint="The benefit period this readmission starts (the next one after the prior stay).">
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={startingBenefitPeriod}
                  onChange={(e) => setStartingBenefitPeriod(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
                />
              </Field>
            )}
            <fieldset className="fieldset">
              <legend>Transfer</legend>
              <label className="row gap-sm">
                <input
                  type="checkbox"
                  checked={transfer}
                  onChange={(e) => {
                    setTransfer(e.target.checked);
                    if (!e.target.checked) {
                      setStartingBenefitPeriod(1);
                      setBenefitPeriodStart('');
                    }
                  }}
                />
                Transferring from another hospice
              </label>
              {transfer && (
                <>
                  <Field label="Current benefit period number" hint="The period the patient is in at the prior hospice.">
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={startingBenefitPeriod}
                      onChange={(e) => setStartingBenefitPeriod(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
                    />
                  </Field>
                  <Field
                    label="Benefit period start date"
                    hint={`When period ${startingBenefitPeriod} started at the prior hospice (${periodLength(startingBenefitPeriod)} days long). Recertification dates continue from it.${
                      benefitPeriodStart ? ` Period ends ${formatDate(addDaysISO(benefitPeriodStart, periodLength(startingBenefitPeriod) - 1))}.` : ''
                    }`}
                  >
                    <input type="date" max={admissionDate} value={benefitPeriodStart} onChange={(e) => setBenefitPeriodStart(e.target.value)} />
                  </Field>
                </>
              )}
            </fieldset>
          </div>
        )}

        {step === 3 && (
          <div className="form">
            {mode === 'update' ? (
              <p className="muted">Care team: {careTeamUids.map((u) => s.memberName(u)).join(', ') || '—'}. Change it from the patient page.</p>
            ) : (
              <>
                <Field label="Team" hint="Fills the care team with the team's active members; adjust below.">
                  <select value={teamId} onChange={(e) => (e.target.value ? chooseTeam(e.target.value) : setTeamId(''))}>
                    <option value="">Choose a team…</option>
                    {teams.data.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </Field>
                <Field label="Care team" hint="A patient care-team channel is created with these members.">
                  <MemberPicker
                    members={s.members}
                    value={careTeamUids}
                    onChange={(v) => {
                      setCareTeamTouched(true);
                      setCareTeamUids(v);
                    }}
                  />
                </Field>
                <label className="row gap-sm">
                  <input type="checkbox" checked={joinChannel} onChange={(e) => setJoinChannel(e.target.checked)} />
                  Add me to the care-team channel
                </label>
              </>
            )}
          </div>
        )}

        {step === 4 && (
          <div className="form">
            <p className="muted small">Planned visits per week by discipline (0.5 = every other week). Used to generate the visit schedule.</p>
            {frequencies.length === 0 && (
              <div className="row gap-sm">
                <span className="muted">No frequencies yet.</span>
                <Button small onClick={() => setFrequencies(TYPICAL_FREQUENCIES.map((f) => ({ ...f })))}>Use a typical plan</Button>
              </div>
            )}
            {frequencies.map((f, i) => (
              <div key={i} className="form-grid">
                <Field label="Discipline">
                  <select
                    value={f.discipline}
                    onChange={(e) => setFrequencies(frequencies.map((x, j) => (j === i ? { ...x, discipline: e.target.value as Discipline } : x)))}
                  >
                    {DISCIPLINES.map((d) => <option key={d} value={d} disabled={d !== f.discipline && usedDisciplines.has(d)}>{d}</option>)}
                  </select>
                </Field>
                <Field label="Visits per week">
                  <input
                    type="number"
                    min={0.25}
                    max={28}
                    step={0.25}
                    value={f.perWeek}
                    onChange={(e) => setFrequencies(frequencies.map((x, j) => (j === i ? { ...x, perWeek: Number(e.target.value) } : x)))}
                  />
                </Field>
                <Field label="Notes">
                  <input value={f.notes ?? ''} onChange={(e) => setFrequencies(frequencies.map((x, j) => (j === i ? { ...x, notes: e.target.value } : x)))} />
                </Field>
                <div className="row end">
                  <Button small variant="ghost" onClick={() => setFrequencies(frequencies.filter((_, j) => j !== i))}>Remove</Button>
                </div>
              </div>
            ))}
            {frequencies.length > 0 && (
              <Button
                small
                disabled={usedDisciplines.size >= DISCIPLINES.length}
                onClick={() => {
                  const d = DISCIPLINES.find((x) => !usedDisciplines.has(x));
                  if (d) setFrequencies([...frequencies, { discipline: d, perWeek: 1, notes: null }]);
                }}
              >
                Add discipline
              </Button>
            )}
          </div>
        )}

        {step === REVIEW_STEP && (
          <dl className="dl">
            <div><dt>Patient</dt><dd>{patientName(patient)} · DOB {formatDate(patient.dob)}</dd></div>
            <div><dt>Primary diagnosis</dt><dd>{patient.primaryDiagnosis?.description || '—'}</dd></div>
            <div><dt>Code status</dt><dd>{patient.codeStatus}</dd></div>
            <div>
              <dt>Consents</dt>
              <dd>{CONSENTS.filter((c) => consents[c.key]).map((c) => c.label).join('; ') || 'None'}</dd>
            </div>
            <div><dt>Admission date</dt><dd>{formatDate(admissionDate)}{mode === 'readmission' ? ' (readmission)' : ''}</dd></div>
            <div><dt>Level of care</dt><dd>{LEVEL_OF_CARE_LABELS[levelOfCare]}</dd></div>
            <div>
              <dt>Benefit period</dt>
              <dd>
                {transfer || mode === 'readmission' ? startingBenefitPeriod : 1}
                {transfer && benefitPeriodStart ? ` (transfer; period started ${formatDate(benefitPeriodStart)})` : transfer ? ' (transfer)' : ''}
              </dd>
            </div>
            <div><dt>Care team</dt><dd>{careTeamUids.map((u) => s.memberName(u)).join(', ')}</dd></div>
            {mode !== 'update' && <div><dt>Care-team channel</dt><dd>{joinChannel ? 'Add me' : "Don't add me"}</dd></div>}
            <div>
              <dt>Visit frequencies</dt>
              <dd>{frequencies.map((f) => `${f.discipline} ${f.perWeek}/wk`).join(', ') || 'None'}</dd>
            </div>
          </dl>
        )}

        <div className="row space-between wizard-nav">
          <Button onClick={() => (step === 0 ? navigate(-1) : setStep(step - 1))}>{step === 0 ? 'Cancel' : 'Back'}</Button>
          {step < REVIEW_STEP ? (
            <Button variant="primary" onClick={next}>Next</Button>
          ) : (
            <Button variant="primary" busy={busy} onClick={() => void submit()}>
              {mode === 'update' ? 'Save changes' : mode === 'readmission' ? 'Readmit patient' : 'Admit patient'}
            </Button>
          )}
        </div>
      </Card>
    </Page>
  );
}
