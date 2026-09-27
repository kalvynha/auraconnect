import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { ComplianceReportRequest, ComplianceReportResponse, ComplianceRow, ComplianceRowStatus, MilestoneKind } from '@shared/types';
import { useOrgSession } from '../lib/session';
import { useAction } from '../lib/hooks';
import { call } from '../lib/firebase';
import { useHasCapability } from '../lib/capabilities';
import { MILESTONE_LABELS } from '../lib/milestones';
import { addDaysISO, formatDate, todayISO } from '../lib/format';
import { Badge, Button, Card, ErrorBanner, Field, Page, Table, Tabs, type TabDef } from '../components/ui';

const KINDS = Object.keys(MILESTONE_LABELS) as MilestoneKind[];
const STATUS_TONE: Record<ComplianceRowStatus, string> = { on_time: 'ok', late: 'warn', overdue: 'danger', open: 'info' };
const STATUS_LABEL: Record<ComplianceRowStatus, string> = { on_time: 'On time', late: 'Late', overdue: 'Overdue', open: 'Not yet due' };

type Tab = 'all' | MilestoneKind;

function pct(n: number, d: number): string {
  return d > 0 ? `${Math.round((n / d) * 100)}%` : '—';
}

export function NotAuthorized() {
  return (
    <div className="page">
      <h1>Not authorized</h1>
      <p className="muted">Reports need the Reports capability. Ask an administrator.</p>
    </div>
  );
}

/** L4: NOE, recert, F2F and HOPE timeliness for a date range (CSV and print). */
export default function ComplianceReportPage() {
  const s = useOrgSession();
  const allowed = useHasCapability('reports');
  const act = useAction();
  const [from, setFrom] = useState(() => addDaysISO(todayISO(), -30));
  const [to, setTo] = useState(todayISO);
  const [kinds, setKinds] = useState<MilestoneKind[]>(KINDS);
  const [tab, setTab] = useState<Tab>('all');
  const [report, setReport] = useState<ComplianceReportResponse | null>(null);

  async function run(e?: FormEvent) {
    e?.preventDefault();
    if (!from || !to || from > to) return act.setError('Choose a valid date range.');
    if (kinds.length === 0) return act.setError('Choose at least one milestone.');
    await act.run(async () => {
      setReport(await call<ComplianceReportRequest, ComplianceReportResponse>('complianceReport', { orgId: s.orgId, from, to, kinds }));
    });
  }

  const rows = useMemo(() => (report?.rows ?? []).filter((r) => tab === 'all' || r.kind === tab), [report, tab]);
  const summary = useMemo(() => {
    const due = rows.filter((r) => r.status !== 'open');
    const onTime = due.filter((r) => r.status === 'on_time').length;
    return { due: due.length, onTime, late: due.filter((r) => r.status === 'late').length, overdue: due.filter((r) => r.status === 'overdue').length };
  }, [rows]);

  if (!allowed) return <NotAuthorized />;

  const tabs: TabDef<Tab>[] = [
    { key: 'all', label: `All (${report?.rows.length ?? 0})` },
    ...KINDS.filter((k) => kinds.includes(k)).map((k) => ({
      key: k,
      label: `${MILESTONE_LABELS[k]} (${report?.rows.filter((r) => r.kind === k).length ?? 0})`,
    })),
  ];

  return (
    <Page title="Compliance report" actions={<Link to="/reports/census">Census report →</Link>}>
      <Card>
        <form className="toolbar" onSubmit={run}>
          <Field label="From" className="field-inline">
            <input type="date" required value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To" className="field-inline">
            <input type="date" required value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <div className="picker picker-inline no-print">
            {KINDS.map((k) => (
              <label key={k} className="picker-item">
                <input type="checkbox" checked={kinds.includes(k)} onChange={(e) => setKinds(e.target.checked ? [...kinds, k] : kinds.filter((x) => x !== k))} />
                {MILESTONE_LABELS[k]}
              </label>
            ))}
          </div>
          <Button type="submit" variant="primary" busy={act.busy}>Run report</Button>
        </form>
        <ErrorBanner error={act.error} />
        <p className="muted small">
          Milestones due in the range for admitted patients and those discharged or deceased since the start date. The filing date is the
          recorded effective date when there is one, otherwise the day it was marked complete (organization time zone).
        </p>
      </Card>

      {report && (
        <Card title={`${formatDate(report.from)} – ${formatDate(report.to)} · ${report.patientsScanned} patients`}>
          <Tabs tabs={tabs} value={tab} onChange={setTab} />
          <div className="stats">
            <div className="stat"><div className="stat-label">Due in range</div><div className="stat-value">{summary.due}</div></div>
            <div className="stat"><div className="stat-label">On time</div><div className="stat-value">{pct(summary.onTime, summary.due)}</div></div>
            <div className="stat"><div className="stat-label">Filed late</div><div className="stat-value">{summary.late}</div></div>
            <div className="stat"><div className="stat-label">Overdue (not filed)</div><div className="stat-value">{summary.overdue}</div></div>
          </div>
          <Table<ComplianceRow>
            rows={rows}
            rowKey={(r) => `${r.patientId}:${r.key}`}
            empty="No milestones due in this range."
            exportName={`compliance-${tab}-${report.from}-${report.to}`}
            rowClassName={(r) => (r.status === 'overdue' ? 'row-missed' : undefined)}
            columns={[
              { header: 'Patient', csv: (r) => r.patientName, cell: (r) => <Link to={`/patients/${r.patientId}?tab=milestones`}>{r.patientName}</Link> },
              { header: 'MRN', csv: (r) => r.mrn ?? '', cell: (r) => r.mrn ?? '—' },
              { header: 'Milestone', csv: (r) => MILESTONE_LABELS[r.kind] ?? r.kind, cell: (r) => MILESTONE_LABELS[r.kind] ?? r.kind },
              { header: 'Due', csv: (r) => r.due, cell: (r) => formatDate(r.due) },
              { header: 'Filed', csv: (r) => r.effectiveDate ?? '', cell: (r) => formatDate(r.effectiveDate) },
              { header: 'Completed by', csv: (r) => (r.completedBy ? s.memberName(r.completedBy) : ''), cell: (r) => (r.completedBy ? s.memberName(r.completedBy) : '—') },
              { header: 'Days late', csv: (r) => String(r.daysLate), cell: (r) => (r.daysLate > 0 ? r.daysLate : '—') },
              { header: 'Status', csv: (r) => STATUS_LABEL[r.status], cell: (r) => <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge> },
            ]}
          />
        </Card>
      )}
    </Page>
  );
}
