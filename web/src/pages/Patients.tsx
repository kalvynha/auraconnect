import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { orderBy, query } from 'firebase/firestore';
import type { Patient, PatientStatus } from '@shared/types';
import { useOrgSession } from '../lib/session';
import { orgCol } from '../lib/firestore';
import { useLiveQuery } from '../lib/hooks';
import { INTAKE_ROLES, LEVEL_OF_CARE_LABELS, PATIENT_STATUSES } from '../lib/constants';
import { formatDate } from '../lib/format';
import { deadlinesWithin } from '../lib/milestones';
import { patientName } from '../lib/patient';
import { Badge, Button, Card, ErrorBanner, Page, Table } from '../components/ui';

export default function PatientsPage() {
  const s = useOrgSession();
  const navigate = useNavigate();
  const [status, setStatus] = useState<PatientStatus | 'all'>('admitted');
  const [search, setSearch] = useState('');
  const patients = useLiveQuery<Patient>(query(orgCol(s.orgId, 'patients'), orderBy('lastName')), [s.orgId]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return patients.data.filter((p) => {
      if (status !== 'all' && p.status !== status) return false;
      if (!q) return true;
      return [p.firstName, p.lastName, p.mrn, p.medicareMbi, p.primaryDiagnosis?.description]
        .filter(Boolean)
        .some((x) => String(x).toLowerCase().includes(q));
    });
  }, [patients.data, status, search]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: patients.data.length };
    for (const p of patients.data) c[p.status] = (c[p.status] ?? 0) + 1;
    return c;
  }, [patients.data]);

  return (
    <Page
      title="Patients"
      actions={INTAKE_ROLES.includes(s.role) && <Button variant="primary" onClick={() => navigate('/patients/new')}>Admit patient</Button>}
    >
      <ErrorBanner error={patients.error} />
      <div className="toolbar">
        <div className="segmented">
          {(['all', ...PATIENT_STATUSES] as const).map((st) => (
            <button key={st} className={status === st ? 'active' : ''} onClick={() => setStatus(st)}>
              {st} <span className="count">{counts[st] ?? 0}</span>
            </button>
          ))}
        </div>
        <input
          className="search"
          type="search"
          placeholder="Search name, MRN, MBI, diagnosis…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <Card>
        <Table
          rows={rows}
          rowKey={(p) => p.id}
          onRowClick={(p) => navigate(`/patients/${p.id}`)}
          empty={patients.loading ? 'Loading…' : 'No patients match.'}
          columns={[
            { header: 'Name', cell: (p) => <Link to={`/patients/${p.id}`} onClick={(e) => e.stopPropagation()}>{patientName(p)}</Link> },
            { header: 'DOB', cell: (p) => formatDate(p.dob) },
            { header: 'MRN', cell: (p) => p.mrn ?? '—' },
            { header: 'Status', cell: (p) => <Badge value={p.status} /> },
            { header: 'Admitted', cell: (p) => formatDate(p.admissionDate) },
            { header: 'Level of care', cell: (p) => (p.status === 'admitted' ? LEVEL_OF_CARE_LABELS[p.levelOfCare] : '—') },
            { header: 'Primary diagnosis', cell: (p) => p.primaryDiagnosis?.description ?? '—' },
            {
              header: 'Deadlines',
              cell: (p) => {
                if (p.status !== 'admitted') return null;
                const overdue = deadlinesWithin(p.milestones, -7, -1).length;
                const soon = deadlinesWithin(p.milestones, 0, 7).length;
                return (
                  <div className="row gap-sm">
                    {overdue > 0 && <Badge tone="danger">{overdue} overdue</Badge>}
                    {soon > 0 && <Badge tone="warn">{soon} due soon</Badge>}
                  </div>
                );
              },
            },
          ]}
        />
      </Card>
    </Page>
  );
}
