import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Timestamp, orderBy, query, where } from 'firebase/firestore';
import type { Discipline, Visit } from '@shared/types';
import { useOrgSession } from '../lib/session';
import { orgCol, type WithId } from '../lib/firestore';
import { useLiveQuery } from '../lib/hooks';
import { usePatients } from '../lib/queries';
import { DISCIPLINES } from '../lib/constants';
import { formatInstant, formatTime, tsToDate } from '../lib/format';
import { Badge, Button, Card, ErrorBanner, Field, Modal, Page } from '../components/ui';
import { ScheduleVisitModal, VisitActionModal, VisitActions, useCanManageVisits, type VisitActionMode } from '../components/visits';

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

function VisitDetail({ visit, onAction, onClose }: { visit: WithId<Visit>; onAction: (m: VisitActionMode) => void; onClose: () => void }) {
  const s = useOrgSession();
  return (
    <Modal title="Visit" onClose={onClose}>
      <dl className="dl">
        <div><dt>Patient</dt><dd><Link to={`/patients/${visit.patientId}?tab=visits`}>{visit.patientName}</Link></dd></div>
        <div><dt>Discipline</dt><dd>{visit.discipline}</dd></div>
        <div><dt>When</dt><dd>{formatInstant(visit.scheduledStart)} – {formatTime(visit.scheduledEnd)}</dd></div>
        <div><dt>Assignee</dt><dd>{visit.assignedUid ? s.memberName(visit.assignedUid) : 'Unassigned'}</dd></div>
        <div><dt>Status</dt><dd><Badge value={visit.status} /></dd></div>
        {visit.note && <div><dt>Note</dt><dd>{visit.note}</dd></div>}
        {visit.completedAt && <div><dt>Completed</dt><dd>{formatInstant(visit.completedAt)} by {s.memberName(visit.completedBy)}</dd></div>}
        {visit.cancelledReason && <div><dt>Cancelled</dt><dd>{visit.cancelledReason}</dd></div>}
      </dl>
      <div className="row end" style={{ marginTop: 16 }}>
        <VisitActions visit={visit} onAction={onAction} />
      </div>
    </Modal>
  );
}

export default function VisitsPage() {
  const s = useOrgSession();
  const canManage = useCanManageVisits();
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const weekEnd = addDays(weekStart, 7);
  const [scope, setScope] = useState<Scope>(canManage ? 'mine' : 'all');
  const [discipline, setDiscipline] = useState<Discipline>(s.member?.discipline ?? 'RN');
  const [showCancelled, setShowCancelled] = useState(false);
  const [scheduling, setScheduling] = useState<Date | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [action, setAction] = useState<{ visit: WithId<Visit>; mode: VisitActionMode } | null>(null);
  const patients = usePatients(s.orgId, ['admitted']);

  const visits = useLiveQuery<Visit>(
    query(
      orgCol(s.orgId, 'visits'),
      where('scheduledStart', '>=', Timestamp.fromDate(weekStart)),
      where('scheduledStart', '<', Timestamp.fromDate(weekEnd)),
      orderBy('scheduledStart'),
    ),
    [s.orgId, weekStart.getTime()],
  );

  const filtered = useMemo(
    () =>
      visits.data.filter((v) => {
        if (!showCancelled && v.status === 'cancelled') return false;
        if (scope === 'mine') return v.assignedUid === s.user.uid;
        if (scope === 'discipline') return v.discipline === discipline;
        return true;
      }),
    [visits.data, scope, discipline, showCancelled, s.user.uid],
  );
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const todayStr = new Date().toDateString();
  const missedCount = filtered.filter((v) => v.status === 'missed').length;
  const selectedVisit = visits.data.find((v) => v.id === selected) ?? null;

  return (
    <Page
      title="Visits"
      actions={canManage && <Button variant="primary" onClick={() => setScheduling(new Date(Date.now() + DAY_MS))}>Schedule visit</Button>}
    >
      <ErrorBanner error={visits.error ?? patients.error} />
      <div className="toolbar">
        <div className="segmented">
          <button className={scope === 'mine' ? 'active' : ''} onClick={() => setScope('mine')}>Mine</button>
          <button className={scope === 'discipline' ? 'active' : ''} onClick={() => setScope('discipline')}>Discipline</button>
          <button className={scope === 'all' ? 'active' : ''} onClick={() => setScope('all')}>All</button>
        </div>
        {scope === 'discipline' && (
          <Field label="Discipline" className="field-inline">
            <select value={discipline} onChange={(e) => setDiscipline(e.target.value as Discipline)}>
              {DISCIPLINES.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </Field>
        )}
        <label className="row gap-sm small">
          <input type="checkbox" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} /> Show cancelled
        </label>
        {missedCount > 0 && <Badge tone="danger">{missedCount} missed this week</Badge>}
      </div>

      <Card
        title={`Week of ${weekStart.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`}
        actions={
          <>
            <Button small onClick={() => setWeekStart(addDays(weekStart, -7))}>← Prev</Button>
            <Button small onClick={() => setWeekStart(startOfWeek(new Date()))}>This week</Button>
            <Button small onClick={() => setWeekStart(addDays(weekStart, 7))}>Next →</Button>
          </>
        }
      >
        <div className="week-grid">
          {days.map((d) => {
            const a = d.getTime();
            const b = addDays(d, 1).getTime();
            const dayVisits = filtered.filter((v) => {
              const t = tsToDate(v.scheduledStart)?.getTime() ?? 0;
              return t >= a && t < b;
            });
            return (
              <div key={a} className={`week-day ${d.toDateString() === todayStr ? 'today' : ''}`}>
                <div className="week-day-head">
                  {d.toLocaleDateString(undefined, { weekday: 'short', month: 'numeric', day: 'numeric' })}
                </div>
                {dayVisits.map((v) => (
                  <button key={v.id} type="button" className={`visit-chip status-${v.status}`} onClick={() => setSelected(v.id)}>
                    <span className="visit-time">{formatTime(v.scheduledStart)}–{formatTime(v.scheduledEnd)}</span>
                    <span className="visit-patient">{v.patientName}</span>
                    <span className="visit-meta">
                      {v.discipline} · {v.assignedUid ? s.memberName(v.assignedUid) : 'Unassigned'}
                    </span>
                    {v.status !== 'scheduled' && <Badge value={v.status} />}
                  </button>
                ))}
                {canManage && (
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
            );
          })}
        </div>
        {visits.loading && <p className="muted">Loading…</p>}
        <p className="muted small">
          Scheduled visits are marked missed automatically once they end more than the organization's grace period ago.
        </p>
      </Card>

      {scheduling && <ScheduleVisitModal patients={patients.data} start={scheduling} onClose={() => setScheduling(null)} />}
      {selectedVisit && !action && (
        <VisitDetail
          visit={selectedVisit}
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
