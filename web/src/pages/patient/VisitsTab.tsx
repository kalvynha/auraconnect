import { useMemo, useState } from 'react';
import { query, where } from 'firebase/firestore';
import type { Discipline, Patient, SetVisitFrequenciesRequest, Visit, VisitFrequency } from '@shared/types';
import { useOrgSession } from '../../lib/session';
import { orgCol, type WithId } from '../../lib/firestore';
import { useAction, useLiveQuery } from '../../lib/hooks';
import { call } from '../../lib/firebase';
import { DISCIPLINES } from '../../lib/constants';
import { formatInstant, formatTime, tsMillis } from '../../lib/format';
import { Badge, Button, Card, ErrorBanner, MemberSelect, Table } from '../../components/ui';
import { ScheduleVisitModal, VisitActionModal, VisitActions, useCanManageVisits, type VisitActionMode } from '../../components/visits';
import { useIsLicensed } from '../../lib/lifecycle';
import { LifecycleModal } from './Lifecycle';

interface FreqDraft {
  discipline: Discipline;
  perWeek: string;
  notes: string;
  // v3 (V2) planning hints used by "Plan week" (optional).
  preferredDays: number[];
  preferredStart: string;
  durationMinutes: string;
  assignedUid: string;
}

const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function toDraft(f: VisitFrequency): FreqDraft {
  return {
    discipline: f.discipline,
    perWeek: String(f.perWeek),
    notes: f.notes ?? '',
    preferredDays: f.preferredDays ?? [],
    preferredStart: f.preferredStart ?? '',
    durationMinutes: f.durationMinutes ? String(f.durationMinutes) : '',
    assignedUid: f.assignedUid ?? '',
  };
}

function hintSummary(f: VisitFrequency, memberName: (uid: string) => string): string {
  const parts: string[] = [];
  if (f.preferredDays?.length) parts.push([...f.preferredDays].sort().map((d) => DAY_NAMES[d]).join('/'));
  if (f.preferredStart) parts.push(`at ${f.preferredStart}`);
  if (f.durationMinutes) parts.push(`${f.durationMinutes} min`);
  if (f.assignedUid) parts.push(memberName(f.assignedUid));
  return parts.join(' · ');
}

function FrequencyEditor({ patient }: { patient: WithId<Patient> }) {
  const s = useOrgSession();
  const canEdit = useCanManageVisits() && (patient.status === 'admitted' || patient.status === 'referral');
  const saved = patient.visitFrequencies ?? [];
  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState<FreqDraft[]>([]);
  const act = useAction();
  const set = (i: number, patch: Partial<FreqDraft>) => setRows(rows.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  function start() {
    setRows(saved.map(toDraft));
    setEditing(true);
  }

  async function save() {
    const frequencies: VisitFrequency[] = [];
    for (const r of rows) {
      const n = Number(r.perWeek);
      if (!Number.isFinite(n) || n <= 0 || n > 28) return act.setError(`${r.discipline}: visits per week must be more than 0 and at most 28.`);
      const f: VisitFrequency = { discipline: r.discipline, perWeek: n, notes: r.notes.trim() || null };
      if (r.preferredDays.length) f.preferredDays = [...r.preferredDays].sort();
      if (r.preferredStart) f.preferredStart = r.preferredStart;
      if (r.durationMinutes) {
        const d = Number(r.durationMinutes);
        if (!Number.isInteger(d) || d < 15 || d > 1440) return act.setError(`${r.discipline}: duration must be 15–1440 minutes.`);
        f.durationMinutes = d;
      }
      if (r.assignedUid) f.assignedUid = r.assignedUid;
      frequencies.push(f);
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
                  {hintSummary(f, s.memberName) && <span className="muted small"> · {hintSummary(f, s.memberName)}</span>}
                </span>
                <span>{f.perWeek}× / week</span>
              </li>
            ))}
          </ul>
        )
      ) : (
        <div className="form">
          {rows.map((r, i) => (
            <div key={i} className="list-editor-row wrap">
              <select value={r.discipline} onChange={(e) => set(i, { discipline: e.target.value as Discipline })}>
                {DISCIPLINES.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
              <input
                className="input-sm"
                type="number"
                min={0.1}
                max={28}
                step={0.5}
                value={r.perWeek}
                aria-label="Visits per week"
                onChange={(e) => set(i, { perWeek: e.target.value })}
              />
              <span className="muted small">/ week</span>
              <input placeholder="Notes" value={r.notes} onChange={(e) => set(i, { notes: e.target.value })} />
              <span className="row gap-sm" role="group" aria-label="Preferred days" title="Preferred days (used by Plan week)">
                {DAY_LETTERS.map((l, d) => (
                  <label key={d} className="small" title={DAY_NAMES[d]}>
                    <input
                      type="checkbox"
                      checked={r.preferredDays.includes(d)}
                      onChange={(e) => set(i, { preferredDays: e.target.checked ? [...r.preferredDays, d] : r.preferredDays.filter((x) => x !== d) })}
                    />
                    {l}
                  </label>
                ))}
              </span>
              <input type="time" aria-label="Preferred start" title="Preferred start (organization time)" value={r.preferredStart} onChange={(e) => set(i, { preferredStart: e.target.value })} />
              <input className="input-sm" type="number" min={15} max={1440} step={15} placeholder="60" aria-label="Duration (minutes)" title="Duration (minutes)" value={r.durationMinutes} onChange={(e) => set(i, { durationMinutes: e.target.value })} />
              <MemberSelect members={s.members} value={r.assignedUid} onChange={(v) => set(i, { assignedUid: v })} placeholder="Care-team member" />
              <Button small variant="ghost" onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</Button>
            </div>
          ))}
          <p className="muted small">Days, start time, duration and assignee are optional; Visits → Plan week uses them.</p>
          <div className="row gap space-between">
            <Button small onClick={() => setRows([...rows, { discipline: 'RN', perWeek: '1', notes: '', preferredDays: [], preferredStart: '', durationMinutes: '', assignedUid: '' }])}>+ Add discipline</Button>
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
  // O1: a death recorded from a visit completes that visit instead of cancelling it.
  const [deathVisitId, setDeathVisitId] = useState<string | null>(null);
  const canRecordDeath = useIsLicensed() && patient.status === 'admitted';

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
          exportName="patient-visits"
          columns={[
            { header: 'When', cell: (v) => <>{formatInstant(v.scheduledStart)}–{formatTime(v.scheduledEnd)}</> },
            { header: 'Discipline', cell: (v) => v.discipline },
            { header: 'Assignee', cell: (v) => (v.assignedUid ? s.memberName(v.assignedUid) : <span className="muted">Unassigned</span>) },
            { header: 'Status', csv: (v) => v.status, cell: (v) => <Badge value={v.status} /> },
            {
              header: 'Note',
              cell: (v) => (
                <span className="small">
                  {v.note ?? ''}
                  {v.cancelledReason && <span className="muted"> Cancelled: {v.cancelledReason}</span>}
                </span>
              ),
            },
            {
              header: '',
              className: 'actions',
              cell: (v) => (
                <>
                  <VisitActions visit={v} careTeamUids={patient.careTeamUids ?? []} onAction={(mode) => setAction({ visit: v, mode })} />
                  {canRecordDeath && (v.status === 'scheduled' || v.status === 'missed') && tsMillis(v.scheduledStart) <= Date.now() + 3_600_000 && (
                    <Button small variant="danger" onClick={() => setDeathVisitId(v.id)}>Record death</Button>
                  )}
                </>
              ),
            },
          ]}
        />
      </Card>
      {scheduling && <ScheduleVisitModal patientId={patient.id} onClose={() => setScheduling(false)} />}
      {action && <VisitActionModal visit={action.visit} mode={action.mode} onClose={() => setAction(null)} />}
      {deathVisitId && <LifecycleModal action="death" patient={patient} visitId={deathVisitId} onClose={() => setDeathVisitId(null)} />}
    </>
  );
}
