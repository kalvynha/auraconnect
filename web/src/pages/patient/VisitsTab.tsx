import { useMemo, useState } from 'react';
import { query, where } from 'firebase/firestore';
import type { Discipline, Patient, SetVisitFrequenciesRequest, Visit, VisitFrequency } from '@shared/types';
import { useOrgSession } from '../../lib/session';
import { orgCol, type WithId } from '../../lib/firestore';
import { useAction, useLiveQuery } from '../../lib/hooks';
import { call } from '../../lib/firebase';
import { DISCIPLINES } from '../../lib/constants';
import { formatInstant, formatTime, tsMillis } from '../../lib/format';
import { Badge, Button, Card, ErrorBanner, Table } from '../../components/ui';
import { ScheduleVisitModal, VisitActionModal, VisitActions, useCanManageVisits, type VisitActionMode } from '../../components/visits';

interface FreqDraft {
  discipline: Discipline;
  perWeek: string;
  notes: string;
}

function FrequencyEditor({ patient }: { patient: WithId<Patient> }) {
  const s = useOrgSession();
  const canEdit = useCanManageVisits() && patient.status === 'admitted';
  const saved = patient.visitFrequencies ?? [];
  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState<FreqDraft[]>([]);
  const act = useAction();

  function start() {
    setRows(saved.map((f) => ({ discipline: f.discipline, perWeek: String(f.perWeek), notes: f.notes ?? '' })));
    setEditing(true);
  }

  async function save() {
    const frequencies: VisitFrequency[] = [];
    for (const r of rows) {
      const n = Number(r.perWeek);
      if (!Number.isFinite(n) || n <= 0 || n > 50) return act.setError(`${r.discipline}: visits per week must be between 0 and 50.`);
      frequencies.push({ discipline: r.discipline, perWeek: n, notes: r.notes.trim() || null });
    }
    const dup = frequencies.find((f, i) => frequencies.findIndex((g) => g.discipline === f.discipline) !== i);
    if (dup) return act.setError(`${dup.discipline} is listed twice.`);
    const ok = await act.run(() =>
      call<SetVisitFrequenciesRequest, unknown>('setVisitFrequencies', { orgId: s.orgId, patientId: patient.id, frequencies }),
    );
    if (ok) setEditing(false);
  }

  return (
    <Card
      title="Visit frequencies"
      actions={canEdit && !editing && <Button small onClick={start}>Edit</Button>}
    >
      <ErrorBanner error={act.error} />
      {!editing ? (
        saved.length === 0 ? (
          <p className="muted">No planned visit frequencies.</p>
        ) : (
          <ul className="list">
            {saved.map((f) => (
              <li key={f.discipline} className="list-row">
                <span>
                  <strong>{f.discipline}</strong> {f.notes && <span className="muted">· {f.notes}</span>}
                </span>
                <span>{f.perWeek}× / week</span>
              </li>
            ))}
          </ul>
        )
      ) : (
        <div className="form">
          {rows.map((r, i) => (
            <div key={i} className="list-editor-row">
              <select
                value={r.discipline}
                onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, discipline: e.target.value as Discipline } : x)))}
              >
                {DISCIPLINES.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
              <input
                className="input-sm"
                type="number"
                min={0.1}
                step={0.5}
                value={r.perWeek}
                aria-label="Visits per week"
                onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, perWeek: e.target.value } : x)))}
              />
              <span className="muted small">/ week</span>
              <input
                placeholder="Notes"
                value={r.notes}
                onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, notes: e.target.value } : x)))}
              />
              <Button small variant="ghost" onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</Button>
            </div>
          ))}
          <div className="row gap space-between">
            <Button small onClick={() => setRows([...rows, { discipline: 'RN', perWeek: '1', notes: '' }])}>+ Add discipline</Button>
            <div className="row gap">
              <Button onClick={() => setEditing(false)}>Cancel</Button>
              <Button variant="primary" busy={act.busy} onClick={() => void save()}>Save frequencies</Button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

export function VisitsTab({ patient }: { patient: WithId<Patient> }) {
  const s = useOrgSession();
  const canManage = useCanManageVisits();
  const visits = useLiveQuery<Visit>(query(orgCol(s.orgId, 'visits'), where('patientId', '==', patient.id)), [s.orgId, patient.id]);
  const [scheduling, setScheduling] = useState(false);
  const [action, setAction] = useState<{ visit: WithId<Visit>; mode: VisitActionMode } | null>(null);
  const [showPast, setShowPast] = useState(false);

  const rows = useMemo(() => {
    const sorted = [...visits.data].sort((a, b) => tsMillis(b.scheduledStart) - tsMillis(a.scheduledStart));
    if (showPast) return sorted;
    const cutoff = Date.now() - 14 * 86400000;
    return sorted.filter((v) => v.status === 'scheduled' || v.status === 'missed' || tsMillis(v.scheduledStart) >= cutoff);
  }, [visits.data, showPast]);

  return (
    <>
      <FrequencyEditor patient={patient} />
      <Card
        title="Visits"
        actions={
          <>
            <label className="row gap-sm small">
              <input type="checkbox" checked={showPast} onChange={(e) => setShowPast(e.target.checked)} /> Show all history
            </label>
            {canManage && patient.status === 'admitted' && (
              <Button small variant="primary" onClick={() => setScheduling(true)}>Schedule visit</Button>
            )}
          </>
        }
      >
        <ErrorBanner error={visits.error} />
        <Table
          rows={rows}
          rowKey={(v) => v.id}
          empty={visits.loading ? 'Loading…' : 'No visits.'}
          rowClassName={(v) => (v.status === 'missed' ? 'row-missed' : undefined)}
          columns={[
            { header: 'When', cell: (v) => <>{formatInstant(v.scheduledStart)}–{formatTime(v.scheduledEnd)}</> },
            { header: 'Discipline', cell: (v) => v.discipline },
            { header: 'Assignee', cell: (v) => (v.assignedUid ? s.memberName(v.assignedUid) : <span className="muted">Unassigned</span>) },
            { header: 'Status', cell: (v) => <Badge value={v.status} /> },
            {
              header: 'Note',
              cell: (v) => (
                <span className="small">
                  {v.note ?? ''}
                  {v.cancelledReason && <span className="muted"> Cancelled: {v.cancelledReason}</span>}
                </span>
              ),
            },
            { header: '', className: 'actions', cell: (v) => <VisitActions visit={v} onAction={(mode) => setAction({ visit: v, mode })} /> },
          ]}
        />
      </Card>
      {scheduling && <ScheduleVisitModal patientId={patient.id} onClose={() => setScheduling(false)} />}
      {action && <VisitActionModal visit={action.visit} mode={action.mode} onClose={() => setAction(null)} />}
    </>
  );
}
