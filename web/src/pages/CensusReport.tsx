import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { CensusReportRequest, CensusReportResponse, CensusRosterRow, DischargeReason } from '@shared/types';
import { useOrgSession } from '../lib/session';
import { useAction } from '../lib/hooks';
import { call } from '../lib/firebase';
import { useHasCapability } from '../lib/capabilities';
import { DISCHARGE_REASON_LABELS, LEVEL_OF_CARE_LABELS } from '../lib/constants';
import { addDaysISO, formatDate, todayISO } from '../lib/format';
import { Badge, Button, Card, ErrorBanner, Field, Page, Table, Tabs, type TabDef } from '../components/ui';
import { NotAuthorized } from './ComplianceReport';

type View = 'roster' | 'admissions' | 'discharges';

const inRange = (d: string | null, from: string, to: string) => !!d && d >= from && d <= to;

function endLabel(r: CensusRosterRow): string {
  if (!r.endReason) return '';
  return r.endReason === 'death' ? 'Death' : DISCHARGE_REASON_LABELS[r.endReason as DischargeReason] ?? r.endReason;
}

/** L4 / W10: census, admissions and discharges roster for a date range. */
export default function CensusReportPage() {
  const s = useOrgSession();
  const allowed = useHasCapability('reports');
  const act = useAction();
  const [from, setFrom] = useState(() => addDaysISO(todayISO(), -30));
  const [to, setTo] = useState(todayISO);
  const [view, setView] = useState<View>('roster');
  const [report, setReport] = useState<CensusReportResponse | null>(null);

  async function run(e?: FormEvent) {
    e?.preventDefault();
    if (!from || !to || from > to) return act.setError('Choose a valid date range.');
    await act.run(async () => setReport(await call<CensusReportRequest, CensusReportResponse>('censusReport', { orgId: s.orgId, from, to })));
  }

  const rows = useMemo(() => {
    if (!report) return [];
    if (view === 'admissions') return report.roster.filter((r) => inRange(r.admissionDate, report.from, report.to));
    if (view === 'discharges') return report.roster.filter((r) => inRange(r.endDate, report.from, report.to));
    return report.roster;
  }, [report, view]);

  if (!allowed) return <NotAuthorized />;

  const tabs: TabDef<View>[] = [
    { key: 'roster', label: `Everyone served (${report?.roster.length ?? 0})` },
    { key: 'admissions', label: `Admissions (${report?.admissions ?? 0})` },
    { key: 'discharges', label: `Discharges and deaths (${(report?.discharges ?? 0) + (report?.deaths ?? 0)})` },
  ];

  return (
    <Page title="Census report" actions={<Link to="/reports/compliance">Compliance report →</Link>}>
      <Card>
        <form className="toolbar" onSubmit={run}>
          <Field label="From" className="field-inline">
            <input type="date" required value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To" className="field-inline">
            <input type="date" required value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <Button type="submit" variant="primary" busy={act.busy}>Run report</Button>
        </form>
        <ErrorBanner error={act.error} />
        <p className="muted small">A patient is on census from the admission date until the day before discharge or death.</p>
      </Card>

      {report && (
        <Card title={`${formatDate(report.from)} – ${formatDate(report.to)}`}>
          <div className="stats">
            <div className="stat"><div className="stat-label">Census at start</div><div className="stat-value">{report.censusAtStart}</div></div>
            <div className="stat"><div className="stat-label">Census at end</div><div className="stat-value">{report.censusAtEnd}</div></div>
            <div className="stat"><div className="stat-label">Average daily census</div><div className="stat-value">{report.averageDailyCensus}</div></div>
            <div className="stat"><div className="stat-label">Admissions</div><div className="stat-value">{report.admissions}</div></div>
            <div className="stat"><div className="stat-label">Live discharges</div><div className="stat-value">{report.discharges}</div></div>
            <div className="stat"><div className="stat-label">Deaths</div><div className="stat-value">{report.deaths}</div></div>
          </div>
          {Object.keys(report.dischargesByReason).length > 0 && (
            <p className="small">
              Discharge reasons:{' '}
              {Object.entries(report.dischargesByReason).map(([k, n]) => (
                <Badge key={k} tone="neutral">{DISCHARGE_REASON_LABELS[k as DischargeReason] ?? k}: {n}</Badge>
              ))}
            </p>
          )}
          <Tabs tabs={tabs} value={view} onChange={setView} />
          <Table<CensusRosterRow>
            rows={rows}
            rowKey={(r) => r.patientId}
            empty="No patients."
            exportName={`census-${view}-${report.from}-${report.to}`}
            columns={[
              { header: 'Patient', csv: (r) => r.patientName, cell: (r) => <Link to={`/patients/${r.patientId}`}>{r.patientName}</Link> },
              { header: 'MRN', csv: (r) => r.mrn ?? '', cell: (r) => r.mrn ?? '—' },
              { header: 'Status', csv: (r) => r.status, cell: (r) => <Badge value={r.status} /> },
              { header: 'Level of care', csv: (r) => LEVEL_OF_CARE_LABELS[r.levelOfCare] ?? r.levelOfCare, cell: (r) => LEVEL_OF_CARE_LABELS[r.levelOfCare] ?? r.levelOfCare },
              { header: 'Admitted', csv: (r) => r.admissionDate ?? '', cell: (r) => formatDate(r.admissionDate) },
              { header: 'Ended', csv: (r) => r.endDate ?? '', cell: (r) => formatDate(r.endDate) },
              { header: 'Reason', csv: endLabel, cell: (r) => endLabel(r) || '—' },
              { header: 'Days in range', csv: (r) => String(r.daysInRange), cell: (r) => r.daysInRange },
            ]}
          />
        </Card>
      )}
    </Page>
  );
}
