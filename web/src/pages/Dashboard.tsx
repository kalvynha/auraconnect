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
import { addDaysISO, formatDate, formatInstant, formatMinutes, todayISO } from '../lib/format';
import { openDeadlines } from '../lib/milestones';
import { Badge, Button, Card, ErrorBanner, Page, Sparkline, Table } from '../components/ui';
import { useHasCapability } from '../lib/capabilities';

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

const RANGE_PRESETS = [7, 30, 90] as const;
type RangeDays = (typeof RANGE_PRESETS)[number];

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

function avg(xs: (number | null)[]): number | null {
  const v = xs.filter((x): x is number => x !== null && Number.isFinite(x));
  return v.length ? sum(v) / v.length : null;
}

function AdminMetrics() {
  const s = useOrgSession();
  const act = useAction();
  const [range, setRange] = useState<RangeDays>(30);
  const today = todayISO();
  // One `metrics/{YYYY-MM-DD}` doc per day; the range includes today (usually partial).
  const since = addDaysISO(today, -(range - 1));
  const metrics = useLiveQuery<DailyMetrics>(
    query(orgCol(s.orgId, 'metrics'), where(documentId(), '>=', since), orderBy(documentId())),
    [s.orgId, since],
  );
  const series = metrics.data.filter((m) => (m.date ?? m.id) <= today);
  const latest = series[series.length - 1] ?? null;
  const t = <T,>(f: (m: DailyMetrics) => T) => series.map(f);

  async function refresh() {
    await act.run(() => call<ComputeMetricsRequest, ComputeMetricsResponse>('computeMetrics', { orgId: s.orgId }));
  }

  const rangeLabel = `last ${range} days`;
  const header = (
    <>
      <div className="segmented" role="group" aria-label="Date range">
        {RANGE_PRESETS.map((r) => (
          <button key={r} type="button" className={range === r ? 'active' : ''} onClick={() => setRange(r)}>
            {r}d
          </button>
        ))}
      </div>
      <Button small busy={act.busy} onClick={() => void refresh()}>Refresh today</Button>
    </>
  );

  if (!latest) {
    return (
      <Card title={`Operations (${rangeLabel})`} actions={header}>
        <ErrorBanner error={act.error ?? metrics.error} />
        <p className="muted">{metrics.loading ? 'Loading…' : 'No metrics in this range yet. They are computed nightly; use “Refresh today” to compute today’s.'}</p>
      </Card>
    );
  }

  const hasPartial = series.some((m) => (m.date ?? m.id) === today);
  const days = series.length;
  // Daily counts summed across the range.
  const visits = {
    scheduled: sum(t((m) => m.visits?.scheduled ?? 0)),
    completed: sum(t((m) => m.visits?.completed ?? 0)),
    missed: sum(t((m) => m.visits?.missed ?? 0)),
    cancelled: sum(t((m) => m.visits?.cancelled ?? 0)),
  };
  const alerts = {
    created: sum(t((m) => m.alerts?.created ?? 0)),
    acked: sum(t((m) => m.alerts?.acked ?? 0)),
    exhausted: sum(t((m) => m.alerts?.exhausted ?? 0)),
    medianAck: avg(t((m) => m.alerts?.medianAckMinutes ?? null)),
  };
  const triage = {
    calls: sum(t((m) => m.triage?.calls ?? 0)),
    emergent: sum(t((m) => m.triage?.emergent ?? 0)),
    medianResolve: avg(t((m) => m.triage?.medianResolveMinutes ?? null)),
  };
  const census = {
    adc: avg(t((m) => m.census?.admitted ?? null)),
    discharges: sum(t((m) => m.census?.dischargedToday ?? 0)),
    deaths: sum(t((m) => m.census?.deathsToday ?? 0)),
  };

  const locTotal = LEVELS_OF_CARE.reduce((n, l) => n + (latest.levelOfCare?.[l] ?? 0), 0);
  const dl = latest.deadlines;
  const doneDl = dl.completedOnTime30d + dl.completedLate30d;
  const volHours = latest.volunteers.minutesLast30d / 60;
  const partialNote = (date: string) => (date === today ? ' (partial — today so far)' : '');

  return (
    <Card
      title={`Operations (${rangeLabel})`}
      actions={
        <>
          <span className="muted small">
            {days} of {range} days loaded · latest {formatDate(latest.date)}
            {partialNote(latest.date)} · computed {formatInstant(latest.computedAt)}
          </span>
          {header}
        </>
      }
    >
      <ErrorBanner error={act.error ?? metrics.error} />
      <div className="stats metrics">
        <MetricTile
          label="Average daily census (ADC)"
          value={census.adc === null ? '—' : census.adc.toFixed(1)}
          sub={<>Today {latest.census.admitted} admitted · {latest.census.referral} referrals · {census.discharges} discharges · {census.deaths} deaths in range</>}
          trend={t((m) => m.census.admitted)}
          trendLabel="Admitted census"
        />
        <div className="stat metric">
          <div className="stat-label">Level-of-care mix (latest)</div>
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
          label="Alerts"
          value={alerts.created}
          sub={<>{alerts.acked} acked · {alerts.exhausted} exhausted · avg daily median ack {formatMinutes(alerts.medianAck)}</>}
          trend={t((m) => m.alerts.created)}
          trendLabel="Alerts created"
        />
        <MetricTile
          label="Deadline compliance (rolling 30d, latest)"
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
          value={pct(visits.completed, visits.completed + visits.missed)}
          sub={<>{visits.completed} completed · {visits.missed} missed · {visits.scheduled} scheduled · {visits.cancelled} cancelled</>}
          trend={t((m) => (m.visits.completed + m.visits.missed ? Math.round((m.visits.completed / (m.visits.completed + m.visits.missed)) * 100) : null))}
          trendLabel="Completion %"
        />
        <MetricTile
          label="Triage calls"
          value={triage.calls}
          sub={<>{triage.emergent} emergent · avg daily median resolve {formatMinutes(triage.medianResolve)}</>}
          trend={t((m) => m.triage.calls)}
        />
        <MetricTile
          label="Volunteer hours (rolling 30d, latest)"
          value={volHours.toFixed(1)}
          sub={<>{latest.volunteers.activeAssignments} active assignments. CMS: volunteer hours must be ≥ 5% of paid patient-care hours.</>}
          trend={t((m) => Math.round(m.volunteers.minutesLast30d / 6) / 10)}
        />
        <MetricTile
          label="Bereavement contacts (latest)"
          value={`${latest.bereavement.contactsDueNext7Days} due`}
          sub={<><strong>{latest.bereavement.contactsOverdue} overdue</strong> · {latest.bereavement.activePlans} active plans</>}
          trend={t((m) => m.bereavement.contactsOverdue)}
          trendLabel="Overdue contacts"
        />
      </div>
      <p className="muted small">
        Visits, alerts, triage, discharges and deaths are daily counts summed over the {days} day(s) loaded; ADC is the average of
        each day’s admitted census. Tiles marked “latest” or “rolling 30d” show the most recent day only.
        {hasPartial && ' Today’s figures are partial until the nightly run.'}
      </p>
    </Card>
  );
}

type DeadlineWindow = 'overdue' | '7' | '30';

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
  // Metrics docs are readable by admins and the `reports` capability (firestore.rules).
  const canReports = useHasCapability('reports');

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

  const today = todayISO();
  const [window_, setWindow] = useState<DeadlineWindow>('7');
  // No look-back cap: overdue deadlines stay listed until they are marked filed/completed.
  const allOpen = useMemo(
    () =>
      patients.data
        .flatMap((p) => openDeadlines(p, today).map((d) => ({ ...d, patient: p, key: `${p.id}:${d.kind}:${d.due}` })))
        .sort((a, b) => a.due.localeCompare(b.due)),
    [patients.data, today],
  );
  const deadlines = useMemo(
    () => allOpen.filter((d) => d.overdue || (window_ !== 'overdue' && d.diff <= Number(window_))),
    [allOpen, window_],
  );
  const overdueCount = allOpen.filter((d) => d.overdue).length;
  const upcomingCount = allOpen.filter((d) => !d.overdue && d.diff <= 7).length;
  // Only open tasks: done/cancelled tasks accumulate forever and are not shown here.
  const myTasks = useLiveQuery<Task>(
    query(orgCol(s.orgId, 'tasks'), where('assigneeUid', '==', s.user.uid), where('status', '==', 'open')),
    [s.orgId, s.user.uid],
  );
  const openTasks = myTasks.data.length;

  return (
    <Page title="Dashboard">
      <ErrorBanner error={alerts.error ?? referrals.error ?? patients.error} />
      <div className="stats">
        <Stat label="Open alerts for me" value={alerts.data.length} to="/alerts" loading={alerts.loading} />
        {canReferrals && (
          <Stat label="Referrals needing review" value={referrals.data.length} to="/referrals" loading={referrals.loading} />
        )}
        <Stat label="Admitted patients" value={patients.data.length} to="/patients" loading={patients.loading} />
        <Stat label="Deadlines in next 7 days" value={upcomingCount} to="/patients?deadlines=soon" loading={patients.loading} />
        <Stat label="Overdue deadlines" value={overdueCount} to="/patients?deadlines=overdue" loading={patients.loading} />
        <Stat label="My open tasks" value={openTasks} to="/tasks" loading={myTasks.loading} />
      </div>

      {canReports && <AdminMetrics />}
      {canReports && (
        <Card title="Reports">
          <div className="row gap wrap">
            <Link to="/reports/compliance">Compliance report (NOE, recert, F2F, HOPE timeliness)</Link>
            <Link to="/reports/census">Census, admissions and discharges</Link>
          </div>
        </Card>
      )}

      <Card
        title={window_ === 'overdue' ? 'Deadlines: all overdue' : `Deadlines: overdue and next ${window_} days`}
        actions={
          <select value={window_} onChange={(e) => setWindow(e.target.value as DeadlineWindow)} aria-label="Deadline window">
            <option value="overdue">All overdue</option>
            <option value="7">Overdue + next 7 days</option>
            <option value="30">Overdue + next 30 days</option>
          </select>
        }
      >
        <Table
          rows={deadlines}
          rowKey={(r) => r.key}
          empty="No open deadlines in this window."
          exportName="deadlines"
          columns={[
            {
              header: 'Patient',
              csv: (r) => `${r.patient.lastName}, ${r.patient.firstName}`,
              cell: (r) => (
                <Link to={`/patients/${r.patient.id}`}>
                  {r.patient.lastName}, {r.patient.firstName}
                </Link>
              ),
            },
            { header: 'Milestone', cell: (r) => r.label },
            { header: 'Due', csv: (r) => r.due, cell: (r) => formatDate(r.due) },
            {
              header: 'When',
              csv: (r) => (r.diff < 0 ? `${-r.diff}d overdue` : r.diff === 0 ? 'due today' : `in ${r.diff}d`),
              cell: (r) => {
                const diff = r.diff;
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
