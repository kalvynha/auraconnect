import { useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { orderBy, query, where } from 'firebase/firestore';
import type { LevelOfCare, Patient, PatientStatus } from '@shared/types';
import { useOrgSession } from '../lib/session';
import { orgCol, type WithId } from '../lib/firestore';
import { useLiveQuery } from '../lib/hooks';
import { INTAKE_ROLES, LEVELS_OF_CARE, LEVEL_OF_CARE_LABELS, PATIENT_STATUSES } from '../lib/constants';
import { formatDate, todayISO } from '../lib/format';
import { deadlineCounts } from '../lib/milestones';
import { patientName } from '../lib/patient';
import { Badge, Button, Card, ErrorBanner, Field, Page, Table } from '../components/ui';

/** Look-ahead for the "due soon" badge and filter. */
const SOON_DAYS = 7;

type DeadlineFilter = 'any' | 'overdue' | 'soon';

export default function PatientsPage() {
  const s = useOrgSession();
  const navigate = useNavigate();
  // Filter state lives in the URL so it survives navigation and can be shared/bookmarked.
  const [params, setParams] = useSearchParams();
  const status = (params.get('status') as PatientStatus | 'all' | null) ?? 'admitted';
  const loc = (params.get('loc') as LevelOfCare | null) ?? '';
  const mine = params.get('mine') === '1';
  const search = params.get('q') ?? '';
  const deadlines = (params.get('deadlines') as DeadlineFilter | null) ?? 'any';

  const setParam = (key: string, value: string | null, dflt = '') => {
    const next = new URLSearchParams(params);
    if (value === null || value === dflt) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  // "My patients" narrows on the server (array-contains; single-field index).
  const patients = useLiveQuery<Patient>(
    mine
      ? query(orgCol(s.orgId, 'patients'), where('careTeamUids', 'array-contains', s.user.uid))
      : query(orgCol(s.orgId, 'patients'), orderBy('lastName')),
    [s.orgId, mine, s.user.uid],
  );

  const today = todayISO();
  const rnByUid = useMemo(
    () => new Map(s.members.filter((m) => m.discipline === 'RN').map((m) => [m.uid ?? m.id, m.displayName || m.email])),
    [s.members],
  );
  const careTeamRns = (p: Patient) => (p.careTeamUids ?? []).map((u) => rnByUid.get(u)).filter((n): n is string => !!n);

  const withCounts = useMemo(
    () =>
      patients.data
        .map((p) => ({ p, dl: p.status === 'admitted' ? deadlineCounts(p, today, SOON_DAYS) : { overdue: 0, soon: 0 } }))
        .sort((a, b) => patientName(a.p).localeCompare(patientName(b.p))),
    [patients.data, today],
  );

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return withCounts.filter(({ p, dl }) => {
      if (status !== 'all' && p.status !== status) return false;
      if (loc && (p.status !== 'admitted' || p.levelOfCare !== loc)) return false;
      if (deadlines === 'overdue' && dl.overdue === 0) return false;
      if (deadlines === 'soon' && dl.soon === 0 && dl.overdue === 0) return false;
      if (!q) return true;
      return [p.firstName, p.lastName, p.mrn, p.medicareMbi, p.primaryDiagnosis?.description]
        .filter(Boolean)
        .some((x) => String(x).toLowerCase().includes(q));
    });
  }, [withCounts, status, loc, deadlines, search]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: patients.data.length };
    for (const p of patients.data) c[p.status] = (c[p.status] ?? 0) + 1;
    return c;
  }, [patients.data]);

  type Row = { p: WithId<Patient>; dl: { overdue: number; soon: number } };

  return (
    <Page
      title="Patients"
      actions={INTAKE_ROLES.includes(s.role) && <Button variant="primary" onClick={() => navigate('/patients/new')}>Admit patient</Button>}
    >
      <ErrorBanner error={patients.error} />
      <div className="toolbar">
        <div className="segmented">
          <button className={!mine ? 'active' : ''} onClick={() => setParam('mine', null)}>All patients</button>
          <button className={mine ? 'active' : ''} onClick={() => setParam('mine', '1')}>My patients</button>
        </div>
        <div className="segmented">
          {(['all', ...PATIENT_STATUSES] as const).map((st) => (
            <button key={st} className={status === st ? 'active' : ''} onClick={() => setParam('status', st, 'admitted')}>
              {st} <span className="count">{counts[st] ?? 0}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="toolbar">
        <Field label="Level of care" className="field-inline">
          <select value={loc} onChange={(e) => setParam('loc', e.target.value)}>
            <option value="">Any</option>
            {LEVELS_OF_CARE.map((l) => <option key={l} value={l}>{LEVEL_OF_CARE_LABELS[l]}</option>)}
          </select>
        </Field>
        <Field label="Deadlines" className="field-inline">
          <select value={deadlines} onChange={(e) => setParam('deadlines', e.target.value, 'any')}>
            <option value="any">Any</option>
            <option value="overdue">All overdue</option>
            <option value="soon">Overdue or due in {SOON_DAYS} days</option>
          </select>
        </Field>
        <input
          className="search"
          type="search"
          placeholder="Search name, MRN, MBI, diagnosis…"
          value={search}
          onChange={(e) => setParam('q', e.target.value)}
        />
      </div>
      <Card>
        <Table<Row>
          rows={rows}
          rowKey={(r) => r.p.id}
          onRowClick={(r) => navigate(`/patients/${r.p.id}`)}
          empty={patients.loading ? 'Loading…' : 'No patients match.'}
          exportName={mine ? 'my-patients' : `patients-${status}`}
          columns={[
            {
              header: 'Name',
              csv: (r) => patientName(r.p),
              cell: (r) => <Link to={`/patients/${r.p.id}`} onClick={(e) => e.stopPropagation()}>{patientName(r.p)}</Link>,
            },
            { header: 'DOB', csv: (r) => r.p.dob ?? '', cell: (r) => formatDate(r.p.dob) },
            { header: 'MRN', cell: (r) => r.p.mrn ?? '—', csv: (r) => r.p.mrn ?? '' },
            { header: 'Status', csv: (r) => r.p.status, cell: (r) => <Badge value={r.p.status} /> },
            { header: 'Admitted', csv: (r) => r.p.admissionDate ?? '', cell: (r) => formatDate(r.p.admissionDate) },
            {
              header: 'Level of care',
              csv: (r) => (r.p.status === 'admitted' ? LEVEL_OF_CARE_LABELS[r.p.levelOfCare] : ''),
              cell: (r) => (r.p.status === 'admitted' ? LEVEL_OF_CARE_LABELS[r.p.levelOfCare] : '—'),
            },
            {
              header: 'Care-team RN',
              csv: (r) => careTeamRns(r.p).join('; '),
              cell: (r) => {
                const rns = careTeamRns(r.p);
                return rns.length ? rns.join(', ') : <span className="muted">—</span>;
              },
            },
            { header: 'Primary diagnosis', csv: (r) => r.p.primaryDiagnosis?.description ?? '', cell: (r) => r.p.primaryDiagnosis?.description ?? '—' },
            {
              header: 'Deadlines',
              csv: (r) => [r.dl.overdue ? `${r.dl.overdue} overdue` : '', r.dl.soon ? `${r.dl.soon} due soon` : ''].filter(Boolean).join('; '),
              cell: (r) => (
                <div className="row gap-sm">
                  {r.dl.overdue > 0 && <Badge tone="danger">{r.dl.overdue} overdue</Badge>}
                  {r.dl.soon > 0 && <Badge tone="warn">{r.dl.soon} due soon</Badge>}
                </div>
              ),
            },
          ]}
        />
      </Card>
    </Page>
  );
}
