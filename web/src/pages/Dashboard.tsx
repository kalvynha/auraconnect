import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { documentId, orderBy, query, where } from 'firebase/firestore';
import type { Alert, ComputeMetricsRequest, ComputeMetricsResponse, DailyMetrics, LevelOfCare, Patient, Referral, Task } from '@shared/types';
import { useOrgSession } from '../lib/session';
import { orgCol } from '../lib/firestore';
import { useLiveQuery } from '../lib/hooks';
import { useAction } from '../lib/hooks';
import { call } from '../lib/firebase';
import { INTAKE_ROLES, LEVELS_OF_CARE, LEVEL_OF_CARE_LABELS } from '../lib/constants';
import { addDaysISO, daysBetween, formatDate, formatInstant, formatMinutes, todayISO } from '../lib/format';
import { deadlinesWithin, milestoneKey } from '../lib/milestones';
import { Badge, Button, Card, ErrorBanner, Page, Sparkline, Table } from '../components/ui';

function pct(n: number, d: number): string {
  return d > 0 ? `${Math.round((n / d) * 100)}%` : '—';
}

function MetricTile({
  label,
  value,
  sub,
  trend,
  trendLabel,
}: {
  label: string;
  value: string | number;
  sub?: ReactNode;
  trend?: (number | null)[];
  trendLabel?: string;
}) {
  const last = trend?.filter((v) => v !== null).slice(-1)[0];
  return (
    <div className="stat metric">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="muted small">{sub}</div>}
      {trend && trend.length > 1 && (
        <div className="metric-trend" title={`${trendLabel ?? label}, last ${trend.length} days${last !== undefined ? ` · latest ${last}` : ''}`}>
          <Sparkline values={trend} width={140} height={28} label={`${trendLabel ?? label} trend`} />
          <span className="muted small">{trend.length}d</span>
        </div>
      )}
    </div>
  );
}

function AdminMetrics() {
  const s = useOrgSession();
  const act = useAction();
  const [lastComputed, setLastComputed] = useState<DailyMetrics | null>(null);
  const since = addDaysISO(todayISO(), -30);
  const metrics = useLiveQuery<DailyMetrics>(
    query(orgCol(s.orgId, 'metrics'), where(documentId(), '>=', since), orderBy(documentId())),
    [s.orgId, since],
  );
  const series = metrics.data;
  const latest = series[series.length - 1] ?? lastComputed;
  const t = <T,>(f: (m: DailyMetrics) => T) => series.map(f);

  async function refresh() {
    await act.run(async () => {
      const res = await call<ComputeMetricsRequest, ComputeMetricsResponse>('computeMetrics', { orgId: s.orgId });
      setLastComputed(res.metrics);
    });
  }

  const header = (
    <Button small busy={act.busy} onClick={() => void refresh()}>Refresh now</Button>
  );

  if (!latest) {
    return (
      <Card title="Operations (last 30 days)" actions={header}>
        <ErrorBanner error={act.error ?? metrics.error} />
        <p className="muted">{metrics.loading ? 'Loading…' : 'No metrics yet. They are computed nightly; use “Refresh now” to compute today’s.'}</p>
      </Card>
    );
  }

  const locTotal = LEVELS_OF_CARE.reduce((n, l) => n + (latest.levelOfCare?.[l] ?? 0), 0);
  const dl = latest.deadlines;
  const doneDl = dl.completedOnTime30d + dl.completedLate30d;
  const v = latest.visits;
  const volHours = latest.volunteers.minutesLast30d / 60;

  return (
    <Card
      title="Operations (last 30 days)"
      actions={
        <>
          <span className="muted small">Latest: {formatDate(latest.date)} · computed {formatInstant(latest.computedAt)}</span>
          {header}
        </>
      }
    >
      <ErrorBanner error={act.error ?? metrics.error} />
      <div className="stats metrics">
        <MetricTile
          label="Census (admitted)"
          value={latest.census.admitted}
          sub={<>{latest.census.referral} referrals · {latest.census.dischargedToday} discharged · {latest.census.deathsToday} deaths</>}
          trend={t((m) => m.census.admitted)}
        />
        <div className="stat metric">
          <div className="stat-label">Level-of-care mix</div>
          <ul className="loc-mix">
            {LEVELS_OF_CARE.map((l: LevelOfCare) => {
              const n = latest.levelOfCare?.[l] ?? 0;
              return (
                <li key={l} title={`${LEVEL_OF_CARE_LABELS[l]}: ${n}`}>
                  <span className="loc-label">{LEVEL_OF_CARE_LABELS[l]}</span>
                  <span className="loc-bar"><span style={{ width: locTotal ? `${(n / locTotal) * 100}%` : 0 }} /></span>
                  <span className="loc-n">{n}</span>
                </li>
              );
            })}
          </ul>
        </div>
        <MetricTile
          label="Median alert ack time"
          value={formatMinutes(latest.alerts.medianAckMinutes)}
          sub={<>{latest.alerts.created} alerts · {latest.alerts.exhausted} exhausted</>}
          trend={t((m) => m.alerts.medianAckMinutes)}
          trendLabel="Median ack minutes"
        />
        <MetricTile
          label="Deadline compliance (30d)"
          value={pct(dl.completedOnTime30d, doneDl)}
          sub={<>{dl.completedOnTime30d} on time · {dl.completedLate30d} late · <strong>{dl.overdue} overdue</strong> · {dl.dueNext7Days} due in 7d</>}
          trend={t((m) => {
            const d = m.deadlines.completedOnTime30d + m.deadlines.completedLate30d;
            return d ? Math.round((m.deadlines.completedOnTime30d / d) * 100) : null;
          })}
          trendLabel="On-time %"
        />
        <MetricTile
          label="Visit completion"
          value={pct(v.completed, v.completed + v.missed)}
          sub={<>{v.completed} completed · {v.missed} missed · {v.scheduled} scheduled · {v.cancelled} cancelled</>}
          trend={t((m) => (m.visits.completed + m.visits.missed ? Math.round((m.visits.completed / (m.visits.completed + m.visits.missed)) * 100) : null))}
          trendLabel="Completion %"
        />
        <MetricTile
          label="Triage calls"
          value={latest.triage.calls}
          sub={<>{latest.triage.emergent} emergent · median resolve {formatMinutes(latest.triage.medianResolveMinutes)}</>}
          trend={t((m) => m.triage.calls)}
        />
        <MetricTile
          label="Volunteer hours (30d)"
          value={volHours.toFixed(1)}
          sub={<>{latest.volunteers.activeAssignments} active assignments. CMS: volunteer hours must be ≥ 5% of paid patient-care hours.</>}
          trend={t((m) => Math.round(m.volunteers.minutesLast30d / 6) / 10)}
        />
        <MetricTile
          label="Bereavement contacts"
          value={`${latest.bereavement.contactsDueNext7Days} due`}
          sub={<><strong>{latest.bereavement.contactsOverdue} overdue</strong> · {latest.bereavement.activePlans} active plans</>}
          trend={t((m) => m.bereavement.contactsOverdue)}
          trendLabel="Overdue contacts"
        />
      </div>
      <p className="muted small">One row per day ({series.length} days loaded). Daily counts are for that date; “30d” figures are rolling.</p>
    </Card>
  );
}

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
      deadlinesWithin(p.milestones, -7, 7)
        .filter((d) => !p.milestoneCompletions?.[milestoneKey(d)])
        .map((d) => ({ ...d, patient: p, key: `${p.id}:${d.kind}:${d.due}` })),
    );
    return rows.sort((a, b) => a.due.localeCompare(b.due));
  }, [patients.data]);
  const myTasks = useLiveQuery<Task>(query(orgCol(s.orgId, 'tasks'), where('assigneeUid', '==', s.user.uid)), [s.orgId, s.user.uid]);
  const openTasks = myTasks.data.filter((t) => t.status === 'open').length;
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
        <Stat label="My open tasks" value={openTasks} to="/tasks" loading={myTasks.loading} />
      </div>

      {s.isAdmin && <AdminMetrics />}

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
        <p className="muted small">Milestones marked filed/completed on the patient chart are hidden here.</p>
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
