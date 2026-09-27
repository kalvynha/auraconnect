import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Timestamp, orderBy, query, where } from 'firebase/firestore';
import type { Discipline, Visit } from '@shared/types';
import { useOrgSession } from '../lib/session';
import { orgCol, type WithId } from '../lib/firestore';
import { useLiveQuery } from '../lib/hooks';
import { usePatients } from '../lib/queries';
import { DISCIPLINES } from '../lib/constants';
import { useVisitPermissions } from '../lib/capabilities';
import { formatInstant, formatTime, tsToDate } from '../lib/format';
import { Badge, Button, Card, ErrorBanner, Field, MemberSelect, Modal, Page, Table } from '../components/ui';
import {
  PlanWeekModal,
  ReassignVisitsModal,
  ScheduleVisitModal,
  VisitActionModal,
  VisitActions,
  VISIT_TYPE_LABELS,
  type VisitActionMode,
} from '../components/visits';

const DAY_MS = 86400000;

function startOfWeek(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - x.getDay());
  return x;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

type Scope = 'mine' | 'discipline' | 'all';
type Layout = 'week' | 'lanes' | 'list';

function VisitDetail({
  visit,
  careTeamUids,
  onAction,
  onClose,
}: {
  visit: WithId<Visit>;
  careTeamUids?: readonly string[];
  onAction: (m: VisitActionMode) => void;
  onClose: () => void;
}) {
  const s = useOrgSession();
  return (
    <Modal title="Visit" onClose={onClose}>
      <dl className="dl">
        <div><dt>Patient</dt><dd><Link to={`/patients/${visit.patientId}?tab=visits`}>{visit.patientName}</Link></dd></div>
        <div><dt>Discipline</dt><dd>{visit.discipline}</dd></div>
        <div><dt>Type</dt><dd>{VISIT_TYPE_LABELS[visit.type ?? 'routine']}</dd></div>
        <div><dt>When</dt><dd>{formatInstant(visit.scheduledStart)} – {formatTime(visit.scheduledEnd)}</dd></div>
        <div><dt>Assignee</dt><dd>{visit.assignedUid ? s.memberName(visit.assignedUid) : 'Unassigned'}</dd></div>
        <div><dt>Status</dt><dd><Badge value={visit.status} /></dd></div>
        {visit.note && <div><dt>Note</dt><dd>{visit.note}</dd></div>}
        {visit.completedAt && <div><dt>Completed</dt><dd>{formatInstant(visit.completedAt)} by {s.memberName(visit.completedBy)}</dd></div>}
        {visit.cancelledReason && <div><dt>Cancelled</dt><dd>{visit.cancelledReason}</dd></div>}
      </dl>
      <div className="row end" style={{ marginTop: 16 }}>
        <VisitActions visit={visit} careTeamUids={careTeamUids} onAction={onAction} />
      </div>
    </Modal>
  );
}

function VisitChip({
  v,
  selected,
  showAssignee = true,
  onClick,
}: {
  v: WithId<Visit>;
  selected: boolean;
  showAssignee?: boolean;
  onClick: () => void;
}) {
  const s = useOrgSession();
  return (
    <button type="button" className={`visit-chip status-${v.status} ${selected ? 'visit-chip-selected' : ''}`} aria-pressed={selected} onClick={onClick}>
      <span className="visit-time">{formatTime(v.scheduledStart)}–{formatTime(v.scheduledEnd)}</span>
      <span className="visit-patient">{v.patientName}</span>
      <span className="visit-meta">
        {v.discipline}
        {v.type && v.type !== 'routine' ? ` · ${VISIT_TYPE_LABELS[v.type]}` : ''}
        {showAssignee ? ` · ${v.assignedUid ? s.memberName(v.assignedUid) : 'Unassigned'}` : ''}
      </span>
      {v.status !== 'scheduled' && <Badge value={v.status} />}
    </button>
  );
}

export default function VisitsPage() {
  const s = useOrgSession();
  const perms = useVisitPermissions();
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const weekEnd = addDays(weekStart, 7);
  // Admins and schedulers coordinate the whole agency's schedule, so they start on "All".
  const [scope, setScope] = useState<Scope>(s.isAdmin || perms.scheduler ? 'all' : perms.canSchedule ? 'mine' : 'all');
  const [assignee, setAssignee] = useState('');
  const [layout, setLayout] = useState<Layout>('week');
  const [laneDay, setLaneDay] = useState(() => new Date().getDay());
  const [discipline, setDiscipline] = useState<Discipline>(s.member?.discipline && s.member.discipline !== 'Admin' ? s.member.discipline : 'RN');
  const [showCancelled, setShowCancelled] = useState(false);
  const [scheduling, setScheduling] = useState<Date | null>(null);
  const [planning, setPlanning] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState(false);
  const [action, setAction] = useState<{ visit: WithId<Visit>; mode: VisitActionMode } | null>(null);
  // Active patients only (referral patients can get admission/evaluation visits).
  const patients = usePatients(s.orgId, ['admitted', 'referral']);
  const careTeams = useMemo(() => new Map(patients.data.map((p) => [p.id, p.careTeamUids ?? []])), [patients.data]);

  // The server narrows the week: by assignee (visits(assignedUid, scheduledStart)), "Mine", or
  // discipline (visits(discipline, scheduledStart)). Only "All" loads the org-wide week.
  const serverWho = assignee || (scope === 'mine' ? s.user.uid : '');
  const serverDiscipline = !serverWho && scope === 'discipline' ? discipline : '';
  const visits = useLiveQuery<Visit>(
    query(
      orgCol(s.orgId, 'visits'),
      ...(serverWho ? [where('assignedUid', '==', serverWho)] : []),
      ...(serverDiscipline ? [where('discipline', '==', serverDiscipline)] : []),
      where('scheduledStart', '>=', Timestamp.fromDate(weekStart)),
      where('scheduledStart', '<', Timestamp.fromDate(weekEnd)),
      orderBy('scheduledStart'),
    ),
    [s.orgId, weekStart.getTime(), serverWho, serverDiscipline],
  );

  const filtered = useMemo(
    () => visits.data.filter((v) => showCancelled || v.status !== 'cancelled'),
    [visits.data, showCancelled],
  );
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const todayStr = new Date().toDateString();
  const missedCount = filtered.filter((v) => v.status === 'missed').length;
  const selectedVisit = visits.data.find((v) => v.id === selected) ?? null;
  const pickable = (v: WithId<Visit>) => v.status === 'scheduled';

  const togglePick = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const onChip = (v: WithId<Visit>) => {
    if (selecting) {
      if (pickable(v)) togglePick(v.id);
    } else setSelected(v.id);
  };
  const pickedIds = [...picked].filter((id) => filtered.some((v) => v.id === id && pickable(v)));

  const dayVisits = (d: Date) => {
    const a = d.getTime();
    const b = addDays(d, 1).getTime();
    return filtered.filter((v) => {
      const t = tsToDate(v.scheduledStart)?.getTime() ?? 0;
      return t >= a && t < b;
    });
  };

  // "By clinician": one lane per assignee for the chosen day.
  const laneDate = days[laneDay] ?? days[0]!;
  const lanes = useMemo(() => {
    const list = dayVisits(laneDate);
    const byUid = new Map<string, WithId<Visit>[]>();
    for (const v of list) {
      const k = v.assignedUid ?? '';
      byUid.set(k, [...(byUid.get(k) ?? []), v]);
    }
    return [...byUid.entries()].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : s.memberName(a).localeCompare(s.memberName(b))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, laneDate.getTime(), s.members]);

  return (
    <Page
      title="Visits"
      actions={
        <>
          {perms.scheduler && <Button onClick={() => setPlanning(true)}>Plan week…</Button>}
          {perms.canSchedule && <Button variant="primary" onClick={() => setScheduling(new Date(Date.now() + DAY_MS))}>Schedule visit</Button>}
        </>
      }
    >
      <ErrorBanner error={visits.error ?? patients.error} />
      <div className="toolbar">
        <div className="segmented" title={assignee ? 'Clear the assignee filter to use scopes.' : undefined}>
          <button className={scope === 'mine' && !assignee ? 'active' : ''} onClick={() => { setAssignee(''); setScope('mine'); }}>Mine</button>
          <button className={scope === 'discipline' && !assignee ? 'active' : ''} onClick={() => { setAssignee(''); setScope('discipline'); }}>Discipline</button>
          <button className={scope === 'all' && !assignee ? 'active' : ''} onClick={() => { setAssignee(''); setScope('all'); }}>All</button>
        </div>
        {scope === 'discipline' && !assignee && (
          <Field label="Discipline" className="field-inline">
            <select value={discipline} onChange={(e) => setDiscipline(e.target.value as Discipline)}>
              {DISCIPLINES.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </Field>
        )}
        <Field label="Assignee" className="field-inline">
          <MemberSelect members={s.members} value={assignee} onChange={setAssignee} placeholder="Anyone (use scope)" />
        </Field>
        <div className="segmented">
          <button className={layout === 'week' ? 'active' : ''} onClick={() => setLayout('week')}>Week</button>
          <button className={layout === 'lanes' ? 'active' : ''} onClick={() => setLayout('lanes')}>By clinician</button>
          <button className={layout === 'list' ? 'active' : ''} onClick={() => setLayout('list')}>List</button>
        </div>
        <label className="row gap-sm small">
          <input type="checkbox" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} /> Show cancelled
        </label>
        {perms.canBulkReassign && layout !== 'list' && (
          <label className="row gap-sm small" title="Click scheduled visits to select them for bulk reassignment.">
            <input type="checkbox" checked={selecting} onChange={(e) => { setSelecting(e.target.checked); if (!e.target.checked) setPicked(new Set()); }} /> Select visits
          </label>
        )}
        {missedCount > 0 && <Badge tone="danger">{missedCount} missed this week</Badge>}
      </div>

      {perms.canBulkReassign && pickedIds.length > 0 && (
        <div className="banner banner-info row gap space-between">
          <span>{pickedIds.length} scheduled visit{pickedIds.length === 1 ? '' : 's'} selected</span>
          <span className="row gap-sm">
            <Button small variant="primary" onClick={() => setBulk(true)}>Reassign…</Button>
            <Button small variant="ghost" onClick={() => setPicked(new Set())}>Clear</Button>
          </span>
        </div>
      )}

      <Card
        title={`Week of ${weekStart.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`}
        actions={
          <>
            <Button small onClick={() => { setWeekStart(addDays(weekStart, -7)); setPicked(new Set()); }}>← Prev</Button>
            <Button small onClick={() => { setWeekStart(startOfWeek(new Date())); setPicked(new Set()); }}>This week</Button>
            <Button small onClick={() => { setWeekStart(addDays(weekStart, 7)); setPicked(new Set()); }}>Next →</Button>
          </>
        }
      >
        {layout === 'list' ? (
          <Table
            rows={filtered}
            rowKey={(v) => v.id}
            onRowClick={(v) => setSelected(v.id)}
            rowClassName={(v) => (v.status === 'missed' ? 'row-missed' : v.status === 'cancelled' ? 'row-muted' : undefined)}
            empty={visits.loading ? 'Loading…' : 'No visits this week.'}
            exportName={`visits-${weekStart.toISOString().slice(0, 10)}`}
            columns={[
              ...(perms.canBulkReassign
                ? [{
                    header: (
                      <input
                        type="checkbox"
                        aria-label="Select all scheduled visits"
                        checked={filtered.some(pickable) && filtered.filter(pickable).every((v) => picked.has(v.id))}
                        onChange={(e) => setPicked(e.target.checked ? new Set(filtered.filter(pickable).map((v) => v.id)) : new Set())}
                      />
                    ),
                    csvHeader: '',
                    className: 'select',
                    cell: (v: WithId<Visit>) =>
                      pickable(v) ? (
                        <input type="checkbox" aria-label="Select visit" checked={picked.has(v.id)} onClick={(e) => e.stopPropagation()} onChange={() => togglePick(v.id)} />
                      ) : null,
                  }]
                : []),
              { header: 'Start', csv: (v) => formatInstant(v.scheduledStart), cell: (v) => formatInstant(v.scheduledStart) },
              { header: 'End', csv: (v) => formatTime(v.scheduledEnd), cell: (v) => formatTime(v.scheduledEnd) },
              {
                header: 'Patient',
                csv: (v) => v.patientName,
                cell: (v) => <Link to={`/patients/${v.patientId}?tab=visits`} onClick={(e) => e.stopPropagation()}>{v.patientName}</Link>,
              },
              { header: 'Discipline', cell: (v) => v.discipline },
              { header: 'Type', csv: (v) => v.type ?? 'routine', cell: (v) => VISIT_TYPE_LABELS[v.type ?? 'routine'] },
              { header: 'Assignee', csv: (v) => (v.assignedUid ? s.memberName(v.assignedUid) : 'Unassigned'), cell: (v) => (v.assignedUid ? s.memberName(v.assignedUid) : <span className="muted">Unassigned</span>) },
              { header: 'Status', csv: (v) => v.status, cell: (v) => <Badge value={v.status} /> },
              { header: 'Note', csv: (v) => v.note ?? '', cell: (v) => <span className="small">{v.note ?? ''}</span> },
              { header: 'Completed', csv: (v) => (v.completedAt ? `${formatInstant(v.completedAt)} by ${s.memberName(v.completedBy)}` : ''), cell: (v) => (v.completedAt ? <span className="small">{formatInstant(v.completedAt)}</span> : null) },
              { header: '', className: 'actions', cell: (v) => <VisitActions visit={v} careTeamUids={careTeams.get(v.patientId)} onAction={(mode) => setAction({ visit: v, mode })} /> },
            ]}
          />
        ) : layout === 'lanes' ? (
          <>
            <div className="segmented" style={{ marginBottom: 8 }}>
              {days.map((d, i) => (
                <button key={i} className={laneDay === i ? 'active' : ''} onClick={() => setLaneDay(i)}>
                  {d.toLocaleDateString(undefined, { weekday: 'short', month: 'numeric', day: 'numeric' })}
                </button>
              ))}
            </div>
            {lanes.length === 0 ? (
              <p className="muted">{visits.loading ? 'Loading…' : 'No visits this day.'}</p>
            ) : (
              <div className="lane-grid" style={{ gridTemplateColumns: `repeat(${lanes.length}, minmax(170px, 1fr))` }}>
                {lanes.map(([uid, list]) => (
                  <div key={uid || 'none'} className="week-day">
                    <div className="week-day-head">
                      {uid ? s.memberName(uid) : 'Unassigned'} <span className="muted small">· {list.length}</span>
                    </div>
                    {list.map((v) => (
                      <VisitChip key={v.id} v={v} showAssignee={false} selected={picked.has(v.id)} onClick={() => onChip(v)} />
                    ))}
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <div className="week-grid">
            {days.map((d) => (
              <div key={d.getTime()} className={`week-day ${d.toDateString() === todayStr ? 'today' : ''}`}>
                <div className="week-day-head">
                  {d.toLocaleDateString(undefined, { weekday: 'short', month: 'numeric', day: 'numeric' })}
                </div>
                {dayVisits(d).map((v) => (
                  <VisitChip key={v.id} v={v} selected={picked.has(v.id)} onClick={() => onChip(v)} />
                ))}
                {perms.canSchedule && (
                  <button
                    type="button"
                    className="add-shift"
                    aria-label="Schedule visit this day"
                    onClick={() => {
                      const st = new Date(d);
                      st.setHours(9, 0, 0, 0);
                      setScheduling(st);
                    }}
                  >
                    +
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {visits.loading && <p className="muted">Loading…</p>}
        <p className="muted small">
          Scheduled visits are marked missed automatically once they end more than the organization's grace period ago. Missed visits can be
          rescheduled or documented late.
          {scope === 'all' && !assignee ? ' Tip: filter by assignee or discipline to load less.' : ''}
        </p>
      </Card>

      {scheduling && <ScheduleVisitModal patients={patients.data} start={scheduling} onClose={() => setScheduling(null)} />}
      {planning && <PlanWeekModal weekStart={weekStart} onClose={() => setPlanning(false)} />}
      {bulk && (
        <ReassignVisitsModal
          visitIds={pickedIds}
          onDone={() => setPicked(new Set())}
          onClose={() => setBulk(false)}
        />
      )}
      {selectedVisit && !action && (
        <VisitDetail
          visit={selectedVisit}
          careTeamUids={careTeams.get(selectedVisit.patientId)}
          onClose={() => setSelected(null)}
          onAction={(mode) => setAction({ visit: selectedVisit, mode })}
        />
      )}
      {action && (
        <VisitActionModal
          visit={action.visit}
          mode={action.mode}
          onClose={() => {
            setAction(null);
            setSelected(null);
          }}
        />
      )}
    </Page>
  );
}
