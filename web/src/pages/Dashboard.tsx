import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { orderBy, query, where } from 'firebase/firestore';
import type { Alert, Patient, Referral } from '@shared/types';
import { useOrgSession } from '../lib/session';
import { orgCol } from '../lib/firestore';
import { useLiveQuery } from '../lib/hooks';
import { INTAKE_ROLES } from '../lib/constants';
import { daysBetween, formatDate, todayISO } from '../lib/format';
import { deadlinesWithin } from '../lib/milestones';
import { Badge, Card, ErrorBanner, Page, Table } from '../components/ui';

function Stat({ label, value, to, loading }: { label: string; value: number; to: string; loading: boolean }) {
  return (
    <Link to={to} className="stat">
      <div className="stat-value">{loading ? '…' : value}</div>
      <div className="stat-label">{label}</div>
    </Link>
  );
}

export default function DashboardPage() {
  const s = useOrgSession();
  const canReferrals = INTAKE_ROLES.includes(s.role);

  const alerts = useLiveQuery<Alert>(
    query(orgCol(s.orgId, 'alerts'), where('targetUids', 'array-contains', s.user.uid), where('status', '==', 'open'), orderBy('createdAt', 'desc')),
    [s.orgId, s.user.uid],
  );
  const referrals = useLiveQuery<Referral>(
    canReferrals ? query(orgCol(s.orgId, 'referrals'), where('status', '==', 'needs_review')) : null,
    [s.orgId, canReferrals],
  );
  const patients = useLiveQuery<Patient>(
    query(orgCol(s.orgId, 'patients'), where('status', '==', 'admitted')),
    [s.orgId],
  );

  const deadlines = useMemo(() => {
    const rows = patients.data.flatMap((p) =>
      deadlinesWithin(p.milestones, -7, 7).map((d) => ({ ...d, patient: p, key: `${p.id}:${d.kind}:${d.due}` })),
    );
    return rows.sort((a, b) => a.due.localeCompare(b.due));
  }, [patients.data]);
  const today = todayISO();
  const upcomingCount = deadlines.filter((d) => d.due >= today).length;

  return (
    <Page title="Dashboard">
      <ErrorBanner error={alerts.error ?? referrals.error ?? patients.error} />
      <div className="stats">
        <Stat label="Open alerts for me" value={alerts.data.length} to="/alerts" loading={alerts.loading} />
        {canReferrals && (
          <Stat label="Referrals needing review" value={referrals.data.length} to="/referrals" loading={referrals.loading} />
        )}
        <Stat label="Admitted patients" value={patients.data.length} to="/patients" loading={patients.loading} />
        <Stat label="Deadlines in next 7 days" value={upcomingCount} to="/patients" loading={patients.loading} />
      </div>

      <Card title="Deadlines (past 7 days to next 7 days)">
        <Table
          rows={deadlines}
          rowKey={(r) => r.key}
          empty="No deadlines in this window."
          columns={[
            {
              header: 'Patient',
              cell: (r) => (
                <Link to={`/patients/${r.patient.id}`}>
                  {r.patient.lastName}, {r.patient.firstName}
                </Link>
              ),
            },
            { header: 'Milestone', cell: (r) => r.label },
            { header: 'Due', cell: (r) => formatDate(r.due) },
            {
              header: '',
              cell: (r) => {
                const diff = daysBetween(today, r.due);
                if (diff < 0) return <Badge tone="danger">{-diff}d overdue</Badge>;
                if (diff === 0) return <Badge tone="warn">due today</Badge>;
                return <Badge tone="warn">in {diff}d</Badge>;
              },
            },
          ]}
        />
        <p className="muted small">Milestones do not track completion; confirm filing status in your EMR.</p>
      </Card>

      {alerts.data.length > 0 && (
        <Card title="My open alerts" actions={<Link to="/alerts">View all</Link>}>
          <ul className="list">
            {alerts.data.slice(0, 5).map((a) => (
              <li key={a.id} className="list-row">
                <span>
                  <Badge value={a.priority} /> {a.title}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </Page>
  );
}
