import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { addDoc, deleteDoc, limit, orderBy, query, serverTimestamp, setDoc, updateDoc, where } from 'firebase/firestore';
import type {
  Patient,
  StaffHours,
  VolunteerActivity,
  VolunteerAssignment,
  VolunteerComplianceReportRequest,
  VolunteerComplianceReportResponse,
  VolunteerLog,
  VoidVolunteerLogRequest,
} from '@shared/types';
import { useOrgSession, type OrgSession } from '../lib/session';
import { orgCol, orgDoc, type WithId } from '../lib/firestore';
import { useAction, useLiveQuery } from '../lib/hooks';
import { usePatients } from '../lib/queries';
import { call } from '../lib/firebase';
import { VOLUNTEER_ACTIVITIES } from '../lib/constants';
import { addDaysISO, formatDate, formatInstant, formatMinutes, todayISO } from '../lib/format';
import { patientName } from '../lib/patient';
import { Badge, Button, Card, ErrorBanner, Field, MemberSelect, Modal, Page, PatientSelect, Table } from '../components/ui';

/** Server-side page sizes (lists grow with "Load more"). */
const ASSIGNMENT_PAGE = 200;
const LOG_PAGE = 200;
const MY_LOG_PAGE = 100;
const TARGET = 0.05;

type PatientLite = WithId<Pick<Patient, 'firstName' | 'lastName' | 'status'>>;

function isCoordinator(s: OrgSession): boolean {
  return s.isAdmin || !!s.member?.capabilities?.includes('volunteers');
}
function canReport(s: OrgSession): boolean {
  return s.isAdmin || !!s.member?.capabilities?.includes('reports');
}
function isVolunteerMember(s: OrgSession): boolean {
  return s.member?.discipline === 'Volunteer' && !s.isAdmin;
}

const pct = (r: number | null) => (r === null ? '—' : `${(r * 100).toFixed(1)}%`);

// ---------------------------------------------------------------------------
// Log time (self, or a coordinator for any volunteer)
// ---------------------------------------------------------------------------

function LogTimeForm({ patients, coordinator, defaultActivity }: { patients: PatientLite[]; coordinator: boolean; defaultActivity?: VolunteerActivity }) {
  const s = useOrgSession();
  const act = useAction();
  const volunteers = s.members.filter((m) => m.discipline === 'Volunteer');
  const [volunteerUid, setVolunteerUid] = useState(s.user.uid);
  const [date, setDate] = useState(todayISO());
  const [hours, setHours] = useState('1');
  const [mins, setMins] = useState('0');
  const [activity, setActivity] = useState<VolunteerActivity>(defaultActivity ?? 'companionship');
  const [patientId, setPatientId] = useState('');
  const [note, setNote] = useState('');
  const [ok, setOk] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setOk(false);
    const minutes = Math.round(Number(hours || 0) * 60 + Number(mins || 0));
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) return act.setError('Time must be between 1 minute and 24 hours.');
    if (date > todayISO()) return act.setError('The date cannot be in the future.');
    const forOther = volunteerUid !== s.user.uid;
    // Exact VolunteerLog create shape; a coordinator logging for someone else must set enteredBy.
    const data = {
      volunteerUid,
      patientId: patientId || null,
      date,
      minutes,
      activity,
      note: note.trim() || null,
      createdAt: serverTimestamp(),
      ...(forOther ? { enteredBy: s.user.uid } : {}),
    };
    if (await act.run(() => addDoc(orgCol(s.orgId, 'volunteerLogs'), data))) {
      setOk(true);
      setNote('');
    }
  }

  return (
    <form className="form" onSubmit={submit}>
      <ErrorBanner error={act.error} />
      {ok && <div className="banner banner-ok">Time logged. Logs cannot be edited; a volunteer coordinator can void one with a reason.</div>}
      <div className="form-grid">
        {coordinator && (
          <Field label="Volunteer">
            <MemberSelect members={volunteers.length ? volunteers : s.members} value={volunteerUid} onChange={(u) => setVolunteerUid(u || s.user.uid)} placeholder="Myself" />
          </Field>
        )}
        <Field label="Date">
          <input type="date" required max={todayISO()} value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Time spent">
          <div className="row gap-sm">
            <input className="input-sm" type="number" min={0} max={24} value={hours} onChange={(e) => setHours(e.target.value)} aria-label="Hours" />
            <span className="muted small">h</span>
            <input className="input-sm" type="number" min={0} max={59} value={mins} onChange={(e) => setMins(e.target.value)} aria-label="Minutes" />
            <span className="muted small">m</span>
          </div>
        </Field>
        <Field label="Activity">
          <select value={activity} onChange={(e) => setActivity(e.target.value as VolunteerActivity)}>
            {VOLUNTEER_ACTIVITIES.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </Field>
        <Field label="Patient (optional)">
          <PatientSelect patients={patients} value={patientId} onChange={setPatientId} placeholder="No specific patient" />
        </Field>
      </div>
      <Field label="Note">
        <input maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <div>
        <Button type="submit" variant="primary" busy={act.busy}>{coordinator && volunteerUid !== s.user.uid ? `Log time for ${s.memberName(volunteerUid)}` : 'Log my time'}</Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Volunteer's own view: assignments, my patients, my logs (own data only)
// ---------------------------------------------------------------------------

function MyVolunteering() {
  const s = useOrgSession();
  const [logCount, setLogCount] = useState(MY_LOG_PAGE);
  const assignments = useLiveQuery<VolunteerAssignment>(
    query(orgCol(s.orgId, 'volunteerAssignments'), where('volunteerUid', '==', s.user.uid), limit(ASSIGNMENT_PAGE)),
    [s.orgId, s.user.uid],
  );
  // Rules: a volunteer may list only patients whose volunteerUids contains them.
  const patients = useLiveQuery<Patient>(
    query(orgCol(s.orgId, 'patients'), where('volunteerUids', 'array-contains', s.user.uid), limit(200)),
    [s.orgId, s.user.uid],
  );
  const logs = useLiveQuery<VolunteerLog>(
    query(orgCol(s.orgId, 'volunteerLogs'), where('volunteerUid', '==', s.user.uid), orderBy('date', 'desc'), limit(logCount)),
    [s.orgId, s.user.uid, logCount],
  );
  const since = addDaysISO(todayISO(), -30);
  const last30 = logs.data.filter((l) => !l.voidedAt && l.date >= since).reduce((n, l) => n + l.minutes, 0);
  const sortedAssignments = [...assignments.data].sort((a, b) => (a.status === b.status ? b.startDate.localeCompare(a.startDate) : a.status === 'active' ? -1 : 1));
  const pName = (id: string | null) => (id ? (patients.data.find((p) => p.id === id) ? patientName(patients.data.find((p) => p.id === id)!) : assignments.data.find((a) => a.patientId === id)?.patientName ?? 'Patient') : null);
  const activeDefault = sortedAssignments.find((a) => a.status === 'active')?.activity;

  return (
    <>
      <ErrorBanner error={assignments.error ?? patients.error ?? logs.error} />
      <div className="stats">
        <div className="stat"><div className="stat-value">{formatMinutes(last30)}</div><div className="stat-label">My time, last 30 days</div></div>
        <div className="stat"><div className="stat-value">{assignments.data.filter((a) => a.status === 'active').length}</div><div className="stat-label">My active assignments</div></div>
      </div>
      <Card title="Log my time">
        <LogTimeForm patients={patients.data} coordinator={false} defaultActivity={activeDefault} />
      </Card>
      <Card title="My assignments">
        <Table
          rows={sortedAssignments}
          rowKey={(a) => a.id}
          empty={assignments.loading ? 'Loading…' : 'No assignments yet.'}
          rowClassName={(a) => (a.status === 'ended' ? 'row-muted' : undefined)}
          columns={[
            { header: 'Patient', cell: (a) => (a.status === 'active' ? <Link to={`/patients/${a.patientId}`}>{a.patientName}</Link> : a.patientName) },
            { header: 'Activity', cell: (a) => a.activity },
            { header: 'Dates', cell: (a) => <>{formatDate(a.startDate)} – {a.endDate ? formatDate(a.endDate) : 'ongoing'}</> },
            { header: 'Status', cell: (a) => <Badge value={a.status} /> },
            { header: 'Notes', cell: (a) => <span className="small">{a.notes ?? ''}</span> },
          ]}
        />
      </Card>
      <Card title="My time logs">
        <Table
          rows={logs.data}
          rowKey={(l) => l.id}
          empty={logs.loading ? 'Loading…' : 'No time logged yet.'}
          rowClassName={(l) => (l.voidedAt ? 'row-muted' : undefined)}
          columns={[
            { header: 'Date', cell: (l) => formatDate(l.date) },
            { header: 'Time', cell: (l) => <>{formatMinutes(l.minutes)} {l.voidedAt && <Badge tone="neutral">voided</Badge>}</> },
            { header: 'Activity', cell: (l) => l.activity },
            { header: 'Patient', cell: (l) => pName(l.patientId) ?? <span className="muted">—</span> },
            { header: 'Note', cell: (l) => <span className="small">{l.note ?? ''}</span> },
          ]}
        />
        {logs.data.length >= logCount && <div className="row end"><Button small onClick={() => setLogCount((n) => n + MY_LOG_PAGE)}>Load more</Button></div>}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Coordinator view
// ---------------------------------------------------------------------------

function AssignmentModal({ patients, onClose }: { patients: PatientLite[]; onClose: () => void }) {
  const s = useOrgSession();
  const act = useAction();
  const [onlyVolunteers, setOnlyVolunteers] = useState(true);
  const [volunteerUid, setVolunteerUid] = useState('');
  const [patientId, setPatientId] = useState('');
  const [activity, setActivity] = useState<VolunteerActivity>('companionship');
  const [startDate, setStartDate] = useState(todayISO());
  const [notes, setNotes] = useState('');
  const candidates = onlyVolunteers ? s.members.filter((m) => m.discipline === 'Volunteer') : s.members;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const p = patients.find((x) => x.id === patientId);
    if (!volunteerUid || !p) return act.setError('Choose a volunteer and a patient.');
    // Exact VolunteerAssignment shape. The backend then adds the volunteer to patients/{id}.volunteerUids.
    const data = {
      volunteerUid, patientId: p.id, patientName: patientName(p), activity, status: 'active' as const,
      startDate, endDate: null, notes: notes.trim() || null, createdBy: s.user.uid, createdAt: serverTimestamp(),
    };
    if (await act.run(() => addDoc(orgCol(s.orgId, 'volunteerAssignments'), data))) onClose();
  }

  return (
    <Modal title="New volunteer assignment" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <ErrorBanner error={act.error} />
        <Field label="Volunteer">
          <MemberSelect members={candidates} value={volunteerUid} onChange={setVolunteerUid} required />
        </Field>
        <label className="row gap-sm small">
          <input type="checkbox" checked={onlyVolunteers} onChange={(e) => setOnlyVolunteers(e.target.checked)} /> Only members with the Volunteer discipline
        </label>
        <Field label="Patient">
          <PatientSelect patients={patients} value={patientId} onChange={setPatientId} placeholder="Select patient…" required />
        </Field>
        <div className="form-grid">
          <Field label="Activity">
            <select value={activity} onChange={(e) => setActivity(e.target.value as VolunteerActivity)}>
              {VOLUNTEER_ACTIVITIES.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </Field>
          <Field label="Start date">
            <input type="date" required value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </Field>
        </div>
        <Field label="Notes">
          <textarea rows={2} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <div className="row gap end">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" busy={act.busy}>Create assignment</Button>
        </div>
      </form>
    </Modal>
  );
}

function VoidModal({ log, onClose }: { log: WithId<VolunteerLog>; onClose: () => void }) {
  const s = useOrgSession();
  const act = useAction();
  const [reason, setReason] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!reason.trim()) return act.setError('A reason is required.');
    if (await act.run(() => call<VoidVolunteerLogRequest, unknown>('voidVolunteerLog', { orgId: s.orgId, logId: log.id, reason: reason.trim() }))) onClose();
  }
  return (
    <Modal title="Void time log" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <ErrorBanner error={act.error} />
        <p className="muted">{s.memberName(log.volunteerUid)} · {formatDate(log.date)} · {formatMinutes(log.minutes)} · {log.activity}</p>
        <Field label="Reason" hint="Voided logs stay on record but are excluded from reports and metrics.">
          <input required maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Duplicate entry" />
        </Field>
        <div className="row gap end">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="danger" busy={act.busy}>Void log</Button>
        </div>
      </form>
    </Modal>
  );
}

function StaffHoursEditor() {
  const s = useOrgSession();
  const act = useAction();
  const [month, setMonth] = useState(todayISO().slice(0, 7));
  const [hoursValue, setHoursValue] = useState('');
  const [saved, setSaved] = useState(false);
  const overrides = useLiveQuery<StaffHours>(query(orgCol(s.orgId, 'staffHours'), limit(36)), [s.orgId]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaved(false);
    const h = Number(hoursValue);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return act.setError('Choose a month.');
    if (!Number.isFinite(h) || h < 0 || h > 100000) return act.setError('Hours must be between 0 and 100,000.');
    // Exact staffHours shape (rules): paidCareHours, updatedBy == caller, updatedAt == request.time.
    if (await act.run(() => setDoc(orgDoc(s.orgId, 'staffHours', month), { paidCareHours: h, updatedBy: s.user.uid, updatedAt: serverTimestamp() }))) setSaved(true);
  }

  const rows = [...overrides.data].sort((a, b) => b.id.localeCompare(a.id));
  return (
    <details>
      <summary className="small">Paid patient-care hours from payroll (overrides visit durations for a month)</summary>
      <form className="toolbar" onSubmit={submit} style={{ marginTop: 8 }}>
        <Field label="Month"><input type="month" required value={month} onChange={(e) => setMonth(e.target.value)} /></Field>
        <Field label="Paid care hours"><input type="number" min={0} max={100000} step="0.25" required value={hoursValue} onChange={(e) => setHoursValue(e.target.value)} /></Field>
        <Button type="submit" busy={act.busy}>Save</Button>
      </form>
      <ErrorBanner error={act.error ?? overrides.error} />
      {saved && <div className="banner banner-ok">Saved. Run the report again to use it.</div>}
      {rows.length > 0 && (
        <ul className="list">
          {rows.map((r) => (
            <li key={r.id} className="list-row">
              <span>{r.id}: <strong>{r.paidCareHours} h</strong> <span className="muted small">{s.memberName(r.updatedBy)} · {formatInstant(r.updatedAt)}</span></span>
              <Button small variant="ghost" onClick={() => void act.run(() => deleteDoc(orgDoc(s.orgId, 'staffHours', r.id)))}>Remove</Button>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

function ComplianceCard() {
  const s = useOrgSession();
  const act = useAction();
  const today = todayISO();
  const [from, setFrom] = useState(`${addDaysISO(`${today.slice(0, 7)}-01`, -1).slice(0, 7)}-01`);
  const [to, setTo] = useState(addDaysISO(`${today.slice(0, 7)}-01`, -1));
  const [report, setReport] = useState<VolunteerComplianceReportResponse | null>(null);

  async function run(e: FormEvent) {
    e.preventDefault();
    if (from > to) return act.setError('The start date must be on or before the end date.');
    await act.run(async () => setReport(await call<VolunteerComplianceReportRequest, VolunteerComplianceReportResponse>('volunteerComplianceReport', { orgId: s.orgId, from, to })));
  }

  return (
    <Card title="Volunteer 5% report">
      <p className="muted small">
        CMS requires volunteer time to equal at least 5% of patient-care hours provided by paid staff (42 CFR 418.78(e)). Staff time defaults to the
        scheduled length of visits completed in the range; enter payroll hours to override a month.
      </p>
      <form className="toolbar" onSubmit={run}>
        <Field label="From"><input type="date" required value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><input type="date" required value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <Button type="submit" variant="primary" busy={act.busy}>Run report</Button>
      </form>
      <ErrorBanner error={act.error} />
      {report && (
        <>
          <div className="stats">
            <div className="stat"><div className="stat-value">{formatMinutes(report.volunteerMinutes)}</div><div className="stat-label">Volunteer time</div></div>
            <div className="stat"><div className="stat-value">{formatMinutes(report.staffMinutes)}</div><div className="stat-label">Staff patient-care time</div></div>
            <div className="stat">
              <div className={`stat-value ${report.meetsTarget ? '' : 'stat-danger'}`}>{pct(report.ratio)}</div>
              <div className="stat-label">Ratio (target {pct(report.target ?? TARGET)}) {report.meetsTarget ? <Badge tone="ok">meets</Badge> : <Badge tone="danger">below</Badge>}</div>
            </div>
          </div>
          {report.truncated && <div className="banner banner-warn">Some data was not read (limits reached); totals are lower bounds.</div>}
          {report.voidedLogsExcluded > 0 && <p className="muted small">{report.voidedLogsExcluded} voided log{report.voidedLogsExcluded === 1 ? '' : 's'} excluded.</p>}
          <Table
            rows={report.months}
            rowKey={(m) => m.month}
            exportName={`volunteer-5pct-${report.from}-to-${report.to}`}
            columns={[
              { header: 'Month', cell: (m) => m.month },
              { header: 'Volunteer minutes', cell: (m) => String(m.volunteerMinutes) },
              { header: 'Staff minutes', cell: (m) => String(m.staffMinutes) },
              { header: 'Staff source', cell: (m) => (m.staffSource === 'override' ? 'payroll override' : 'completed visits') },
              { header: 'Ratio', cell: (m) => pct(m.staffMinutes > 0 ? m.volunteerMinutes / m.staffMinutes : null) },
            ]}
          />
        </>
      )}
      {canReport(s) && <StaffHoursEditor />}
    </Card>
  );
}

function CoordinatorView() {
  const s = useOrgSession();
  const act = useAction();
  const [creating, setCreating] = useState(false);
  const [showEnded, setShowEnded] = useState(false);
  const [assignmentCount, setAssignmentCount] = useState(ASSIGNMENT_PAGE);
  const [logCount, setLogCount] = useState(LOG_PAGE);
  const [voiding, setVoiding] = useState<WithId<VolunteerLog> | null>(null);
  const [volunteerFilter, setVolunteerFilter] = useState('');
  const patients = usePatients(s.orgId, ['admitted']);
  const assignments = useLiveQuery<VolunteerAssignment>(
    showEnded
      ? query(orgCol(s.orgId, 'volunteerAssignments'), orderBy('startDate', 'desc'), limit(assignmentCount))
      : query(orgCol(s.orgId, 'volunteerAssignments'), where('status', '==', 'active'), limit(assignmentCount)),
    [s.orgId, showEnded, assignmentCount],
  );
  const logs = useLiveQuery<VolunteerLog>(
    volunteerFilter
      ? query(orgCol(s.orgId, 'volunteerLogs'), where('volunteerUid', '==', volunteerFilter), orderBy('date', 'desc'), limit(logCount))
      : query(orgCol(s.orgId, 'volunteerLogs'), orderBy('date', 'desc'), limit(logCount)),
    [s.orgId, logCount, volunteerFilter],
  );
  const roster = s.members.filter((m) => m.discipline === 'Volunteer' && m.active !== false);
  const since = addDaysISO(todayISO(), -30);
  const byVolunteer = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of logs.data) if (!l.voidedAt && l.date >= since) m.set(l.volunteerUid, (m.get(l.volunteerUid) ?? 0) + l.minutes);
    return m;
  }, [logs.data, since]);
  const activeByVolunteer = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of assignments.data) if (a.status === 'active') m.set(a.volunteerUid, (m.get(a.volunteerUid) ?? 0) + 1);
    return m;
  }, [assignments.data]);
  const sortedAssignments = [...assignments.data].sort((a, b) => b.startDate.localeCompare(a.startDate));
  const pName = (id: string | null) => {
    if (!id) return null;
    const p = patients.data.find((x) => x.id === id);
    return p ? patientName(p) : assignments.data.find((a) => a.patientId === id)?.patientName ?? 'Patient';
  };

  async function endAssignment(a: WithId<VolunteerAssignment>) {
    if (!window.confirm(`End ${s.memberName(a.volunteerUid)}'s assignment with ${a.patientName}?`)) return;
    await act.run(() => updateDoc(orgDoc(s.orgId, 'volunteerAssignments', a.id), { status: 'ended', endDate: todayISO() }));
  }
  async function reactivate(a: WithId<VolunteerAssignment>) {
    await act.run(() => updateDoc(orgDoc(s.orgId, 'volunteerAssignments', a.id), { status: 'active', endDate: null }));
  }
  async function remove(a: WithId<VolunteerAssignment>) {
    if (!window.confirm('Delete this assignment? Use "End" to keep a record instead.')) return;
    await act.run(() => deleteDoc(orgDoc(s.orgId, 'volunteerAssignments', a.id)));
  }

  return (
    <>
      <div className="row end" style={{ marginBottom: 12 }}>
        <Button variant="primary" onClick={() => setCreating(true)}>New assignment</Button>
      </div>
      <ErrorBanner error={act.error ?? assignments.error ?? logs.error ?? patients.error} />

      <ComplianceCard />

      <div className="grid-2">
        <Card title={`Volunteer roster (${roster.length})`}>
          <Table
            rows={roster}
            rowKey={(m) => m.id}
            empty="No members have the Volunteer discipline."
            exportName="volunteer-roster"
            columns={[
              { header: 'Volunteer', cell: (m) => m.displayName || m.email },
              { header: 'Phone', cell: (m) => m.phone ?? '—' },
              { header: 'Active assignments', cell: (m) => String(activeByVolunteer.get(m.uid ?? m.id) ?? 0) },
              { header: 'Last 30 days', csv: (m) => String(byVolunteer.get(m.uid ?? m.id) ?? 0), cell: (m) => formatMinutes(byVolunteer.get(m.uid ?? m.id) ?? 0) },
            ]}
          />
          {logs.data.length >= logCount && <p className="muted small">"Last 30 days" counts the loaded logs only.</p>}
        </Card>
        <Card title="Log time for a volunteer">
          <LogTimeForm patients={patients.data} coordinator />
        </Card>
      </div>

      <Card
        title="Assignments"
        actions={<label className="row gap-sm small"><input type="checkbox" checked={showEnded} onChange={(e) => setShowEnded(e.target.checked)} /> Include ended</label>}
      >
        <Table
          rows={sortedAssignments}
          rowKey={(a) => a.id}
          empty={assignments.loading ? 'Loading…' : 'No assignments.'}
          rowClassName={(a) => (a.status === 'ended' ? 'row-muted' : undefined)}
          exportName="volunteer-assignments"
          columns={[
            { header: 'Volunteer', cell: (a) => s.memberName(a.volunteerUid) },
            { header: 'Patient', cell: (a) => <Link to={`/patients/${a.patientId}`}>{a.patientName}</Link> },
            { header: 'Activity', cell: (a) => a.activity },
            { header: 'Dates', csv: (a) => `${a.startDate} – ${a.endDate ?? 'ongoing'}`, cell: (a) => <>{formatDate(a.startDate)} – {a.endDate ? formatDate(a.endDate) : 'ongoing'}</> },
            { header: 'Status', csv: (a) => a.status, cell: (a) => <Badge value={a.status} /> },
            { header: 'Notes', cell: (a) => <span className="small">{a.notes ?? ''}</span> },
            {
              header: '',
              className: 'actions',
              cell: (a) => (
                <div className="row gap-sm end">
                  {a.status === 'active' ? <Button small onClick={() => void endAssignment(a)}>End</Button> : <Button small onClick={() => void reactivate(a)}>Reactivate</Button>}
                  <Button small variant="ghost" onClick={() => void remove(a)}>Delete</Button>
                </div>
              ),
            },
          ]}
        />
        {assignments.data.length >= assignmentCount && <div className="row end"><Button small onClick={() => setAssignmentCount((n) => n + ASSIGNMENT_PAGE)}>Load more</Button></div>}
      </Card>

      <Card
        title="Time logs"
        actions={
          <select value={volunteerFilter} onChange={(e) => setVolunteerFilter(e.target.value)} aria-label="Filter by volunteer">
            <option value="">All volunteers</option>
            {roster.map((m) => <option key={m.id} value={m.uid ?? m.id}>{m.displayName || m.email}</option>)}
          </select>
        }
      >
        <Table
          rows={logs.data}
          rowKey={(l) => l.id}
          empty={logs.loading ? 'Loading…' : 'No time logged yet.'}
          rowClassName={(l) => (l.voidedAt ? 'row-muted' : undefined)}
          exportName="volunteer-logs"
          columns={[
            { header: 'Date', csv: (l) => l.date, cell: (l) => formatDate(l.date) },
            { header: 'Volunteer', cell: (l) => s.memberName(l.volunteerUid) },
            { header: 'Minutes', csv: (l) => String(l.minutes), cell: (l) => formatMinutes(l.minutes) },
            { header: 'Activity', cell: (l) => l.activity },
            { header: 'Patient', csv: (l) => pName(l.patientId) ?? '', cell: (l) => (l.patientId ? <Link to={`/patients/${l.patientId}`}>{pName(l.patientId)}</Link> : <span className="muted">—</span>) },
            { header: 'Note', cell: (l) => <span className="small">{l.note ?? ''}</span> },
            { header: 'Entered by', csv: (l) => (l.enteredBy ? s.memberName(l.enteredBy) : ''), cell: (l) => (l.enteredBy ? <span className="small">{s.memberName(l.enteredBy)}</span> : <span className="muted small">self</span>) },
            {
              header: 'Status',
              csv: (l) => (l.voidedAt ? `voided: ${l.voidReason ?? ''}` : 'counted'),
              cell: (l) =>
                l.voidedAt ? (
                  <><Badge tone="neutral">voided</Badge><div className="muted small">{s.memberName(l.voidedBy)} · “{l.voidReason}”</div></>
                ) : (
                  <Button small variant="ghost" onClick={() => setVoiding(l)}>Void</Button>
                ),
            },
          ]}
        />
        {logs.data.length >= logCount && <div className="row end"><Button small onClick={() => setLogCount((n) => n + LOG_PAGE)}>Load more</Button></div>}
      </Card>
      {creating && <AssignmentModal patients={patients.data} onClose={() => setCreating(false)} />}
      {voiding && <VoidModal log={voiding} onClose={() => setVoiding(null)} />}
    </>
  );
}

export default function VolunteersPage() {
  const s = useOrgSession();
  const coordinator = isCoordinator(s);
  return (
    <Page title={coordinator ? 'Volunteers' : 'My volunteering'}>
      {coordinator ? (
        <CoordinatorView />
      ) : (
        <>
          {!isVolunteerMember(s) && <div className="banner banner-info">Volunteer program management needs the "volunteers" permission. You can log your own volunteer time here.</div>}
          <MyVolunteering />
        </>
      )}
    </Page>
  );
}
