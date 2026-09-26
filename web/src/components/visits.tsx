import { useState, type FormEvent } from 'react';
import type {
  CancelVisitRequest,
  CompleteVisitRequest,
  Discipline,
  IdResponse,
  Patient,
  ScheduleVisitRequest,
  UpdateVisitRequest,
  Visit,
} from '@shared/types';
import { useOrgSession } from '../lib/session';
import type { WithId } from '../lib/firestore';
import { useAction } from '../lib/hooks';
import { call } from '../lib/firebase';
import { CLINICAL_ROLES, DISCIPLINES } from '../lib/constants';
import { optStr, toDateTimeLocal, tsToDate } from '../lib/format';
import { Button, ErrorBanner, Field, MemberSelect, Modal, PatientSelect } from './ui';

export function useCanManageVisits(): boolean {
  const s = useOrgSession();
  return CLINICAL_ROLES.includes(s.role);
}

function defaultStart(): Date {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d;
}

export function ScheduleVisitModal({
  patientId: fixedPatientId,
  patients,
  start: initialStart,
  onClose,
}: {
  /** Fixed patient (patient detail); otherwise the user picks from `patients`. */
  patientId?: string;
  patients?: WithId<Patient>[];
  start?: Date;
  onClose: () => void;
}) {
  const s = useOrgSession();
  const start0 = initialStart ?? defaultStart();
  const [patientId, setPatientId] = useState(fixedPatientId ?? '');
  const [discipline, setDiscipline] = useState<Discipline>(s.member?.discipline && s.member.discipline !== 'Admin' ? s.member.discipline : 'RN');
  const [assignedUid, setAssignedUid] = useState('');
  const [start, setStart] = useState(toDateTimeLocal(start0));
  const [end, setEnd] = useState(toDateTimeLocal(new Date(start0.getTime() + 60 * 60000)));
  const [note, setNote] = useState('');
  const act = useAction();

  async function submit(e: FormEvent) {
    e.preventDefault();
    const a = new Date(start);
    const b = new Date(end);
    if (!patientId) return act.setError('Choose a patient.');
    if (!(b > a)) return act.setError('End must be after start.');
    const req: ScheduleVisitRequest = {
      orgId: s.orgId,
      patientId,
      discipline,
      assignedUid: assignedUid || null,
      start: a.toISOString(),
      end: b.toISOString(),
    };
    const n = optStr(note);
    if (n) req.note = n;
    if (await act.run(() => call<ScheduleVisitRequest, IdResponse>('scheduleVisit', req))) onClose();
  }

  return (
    <Modal title="Schedule visit" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <ErrorBanner error={act.error} />
        {!fixedPatientId && (
          <Field label="Patient">
            <PatientSelect patients={patients ?? []} value={patientId} onChange={setPatientId} placeholder="Select patient…" required />
          </Field>
        )}
        <div className="form-grid">
          <Field label="Discipline">
            <select value={discipline} onChange={(e) => setDiscipline(e.target.value as Discipline)}>
              {DISCIPLINES.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </Field>
          <Field label="Assignee">
            <MemberSelect members={s.members} value={assignedUid} onChange={setAssignedUid} placeholder="Unassigned" />
          </Field>
          <Field label="Start">
            <input
              type="datetime-local"
              required
              value={start}
              onChange={(e) => {
                const prevLen = new Date(end).getTime() - new Date(start).getTime();
                setStart(e.target.value);
                const ns = new Date(e.target.value);
                if (!Number.isNaN(ns.getTime()) && prevLen > 0) setEnd(toDateTimeLocal(new Date(ns.getTime() + prevLen)));
              }}
            />
          </Field>
          <Field label="End">
            <input type="datetime-local" required value={end} onChange={(e) => setEnd(e.target.value)} />
          </Field>
        </div>
        <Field label="Note (optional)">
          <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <div className="row gap end">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" busy={act.busy}>Schedule</Button>
        </div>
      </form>
    </Modal>
  );
}

export type VisitActionMode = 'complete' | 'cancel' | 'edit';

export function VisitActionModal({ visit, mode, onClose }: { visit: WithId<Visit>; mode: VisitActionMode; onClose: () => void }) {
  const s = useOrgSession();
  const act = useAction();
  const [note, setNote] = useState(mode === 'edit' ? visit.note ?? '' : '');
  const [reason, setReason] = useState('');
  const [assignedUid, setAssignedUid] = useState(visit.assignedUid ?? '');
  const [start, setStart] = useState(toDateTimeLocal(tsToDate(visit.scheduledStart) ?? new Date()));
  const [end, setEnd] = useState(toDateTimeLocal(tsToDate(visit.scheduledEnd) ?? new Date()));

  async function submit(e: FormEvent) {
    e.preventDefault();
    let ok = false;
    if (mode === 'complete') {
      const req: CompleteVisitRequest = { orgId: s.orgId, visitId: visit.id };
      const n = optStr(note);
      if (n) req.note = n;
      ok = await act.run(() => call<CompleteVisitRequest, unknown>('completeVisit', req));
    } else if (mode === 'cancel') {
      const r = reason.trim();
      if (!r) return act.setError('A reason is required.');
      ok = await act.run(() => call<CancelVisitRequest, unknown>('cancelVisit', { orgId: s.orgId, visitId: visit.id, reason: r }));
    } else {
      const a = new Date(start);
      const b = new Date(end);
      if (!(b > a)) return act.setError('End must be after start.');
      const req: UpdateVisitRequest = { orgId: s.orgId, visitId: visit.id };
      if ((assignedUid || null) !== visit.assignedUid) req.assignedUid = assignedUid || null;
      if (a.getTime() !== tsToDate(visit.scheduledStart)?.getTime()) req.start = a.toISOString();
      if (b.getTime() !== tsToDate(visit.scheduledEnd)?.getTime()) req.end = b.toISOString();
      const n = note.trim() || null;
      if (n !== (visit.note ?? null)) req.note = n;
      ok = await act.run(() => call<UpdateVisitRequest, unknown>('updateVisit', req));
    }
    if (ok) onClose();
  }

  const title = mode === 'complete' ? 'Complete visit' : mode === 'cancel' ? 'Cancel visit' : 'Reassign / reschedule visit';
  return (
    <Modal title={title} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <ErrorBanner error={act.error} />
        <p className="muted">
          {visit.patientName} · {visit.discipline} · {tsToDate(visit.scheduledStart)?.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
        </p>
        {mode === 'complete' && (
          <Field label="Visit note (optional)">
            <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        )}
        {mode === 'cancel' && (
          <Field label="Reason">
            <input required value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        )}
        {mode === 'edit' && (
          <>
            <Field label="Assignee">
              <MemberSelect members={s.members} value={assignedUid} onChange={setAssignedUid} placeholder="Unassigned" />
            </Field>
            <div className="form-grid">
              <Field label="Start">
                <input type="datetime-local" required value={start} onChange={(e) => setStart(e.target.value)} />
              </Field>
              <Field label="End">
                <input type="datetime-local" required value={end} onChange={(e) => setEnd(e.target.value)} />
              </Field>
            </div>
            <Field label="Note">
              <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
          </>
        )}
        <div className="row gap end">
          <Button onClick={onClose}>Close</Button>
          <Button type="submit" variant={mode === 'cancel' ? 'danger' : 'primary'} busy={act.busy}>
            {mode === 'complete' ? 'Mark completed' : mode === 'cancel' ? 'Cancel visit' : 'Save'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Complete / Cancel / Reassign buttons for a visit (clinical roles; server enforces assignee/care team/admin). */
export function VisitActions({ visit, onAction }: { visit: WithId<Visit>; onAction: (mode: VisitActionMode) => void }) {
  const can = useCanManageVisits();
  if (!can || (visit.status !== 'scheduled' && visit.status !== 'missed')) return null;
  return (
    <div className="row gap-sm end" onClick={(e) => e.stopPropagation()}>
      <Button small variant="primary" onClick={() => onAction('complete')}>Complete</Button>
      {visit.status === 'scheduled' && <Button small onClick={() => onAction('edit')}>Reassign</Button>}
      <Button small variant="ghost" onClick={() => onAction('cancel')}>Cancel</Button>
    </div>
  );
}
