import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { updateDoc } from 'firebase/firestore';
import type {
  CancelVisitRequest,
  CompleteVisitRequest,
  Discipline,
  GenerateVisitPlanRequest,
  GenerateVisitPlanResponse,
  IdResponse,
  MissedVisitAlertMode,
  Patient,
  PlannedVisit,
  ReassignVisitsRequest,
  ReassignVisitsResponse,
  ScheduleVisitRequest,
  UpdateVisitRequest,
  Visit,
  VisitType,
} from '@shared/types';
import { useOrgSession } from '../lib/session';
import { orgDoc, type WithId } from '../lib/firestore';
import { useAction } from '../lib/hooks';
import { call } from '../lib/firebase';
import { DISCIPLINES, orgSettings } from '../lib/constants';
import { useVisitPermissions } from '../lib/capabilities';
import { addDaysISO, optStr, toDateTimeLocal, toISODate, tsToDate } from '../lib/format';
import { Badge, Button, Card, ErrorBanner, Field, MemberSelect, Modal, PatientSelect } from './ui';

/** Mirror of VISIT_TYPES in @shared/types. */
export const VISIT_TYPES: readonly VisitType[] = ['routine', 'admission', 'evaluation', 'prn', 'aide_supervision'];
export const VISIT_TYPE_LABELS: Record<VisitType, string> = {
  routine: 'Routine',
  admission: 'Admission',
  evaluation: 'Evaluation',
  prn: 'PRN',
  aide_supervision: 'Aide supervision',
};
/** Visit types the server accepts for a referral-status patient. */
const REFERRAL_VISIT_TYPES: readonly VisitType[] = ['admission', 'evaluation'];

export const MISSED_VISIT_ALERT_MODE_LABELS: Record<MissedVisitAlertMode, string> = {
  assignee: 'Assignee only (unassigned → care-team RN), plus a daily digest for schedulers',
  assignee_admins: 'Assignee and all admins, plus the daily digest',
  digest: 'Daily 07:00 digest only (admins and schedulers)',
  off: 'Off (visits are still marked missed)',
};

/** May the signed-in user schedule visits at all (clinical role or `scheduling`)? */
export function useCanManageVisits(): boolean {
  return useVisitPermissions().canSchedule;
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
  /** Admitted and referral patients (referral patients accept admission/evaluation visits only). */
  patients?: WithId<Patient>[];
  start?: Date;
  onClose: () => void;
}) {
  const s = useOrgSession();
  const start0 = initialStart ?? defaultStart();
  const [patientId, setPatientId] = useState(fixedPatientId ?? '');
  const [discipline, setDiscipline] = useState<Discipline>(s.member?.discipline && s.member.discipline !== 'Admin' ? s.member.discipline : 'RN');
  const [type, setType] = useState<VisitType>('routine');
  const [assignedUid, setAssignedUid] = useState('');
  const [start, setStart] = useState(toDateTimeLocal(start0));
  const [end, setEnd] = useState(toDateTimeLocal(new Date(start0.getTime() + 60 * 60000)));
  const [note, setNote] = useState('');
  const act = useAction();
  const selected = patients?.find((p) => p.id === patientId);
  const isReferral = selected?.status === 'referral';
  const types = isReferral ? REFERRAL_VISIT_TYPES : VISIT_TYPES;

  useEffect(() => {
    if (isReferral && !REFERRAL_VISIT_TYPES.includes(type)) setType('admission');
  }, [isReferral, type]);

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
      type,
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
          <Field label="Patient" hint="Referral patients (not yet admitted) can have admission or evaluation visits.">
            <PatientSelect patients={patients ?? []} value={patientId} onChange={setPatientId} placeholder="Select patient…" required />
          </Field>
        )}
        <div className="form-grid">
          <Field label="Discipline">
            <select value={discipline} onChange={(e) => setDiscipline(e.target.value as Discipline)}>
              {DISCIPLINES.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </Field>
          <Field label="Visit type">
            <select value={type} onChange={(e) => setType(e.target.value as VisitType)}>
              {types.map((t) => <option key={t} value={t}>{VISIT_TYPE_LABELS[t]}</option>)}
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

export type VisitActionMode = 'complete' | 'cancel' | 'edit' | 'reschedule';

export function VisitActionModal({ visit, mode, onClose }: { visit: WithId<Visit>; mode: VisitActionMode; onClose: () => void }) {
  const s = useOrgSession();
  const act = useAction();
  const [note, setNote] = useState(mode === 'edit' ? visit.note ?? '' : '');
  const [reason, setReason] = useState('');
  const [assignedUid, setAssignedUid] = useState(visit.assignedUid ?? '');
  // Rescheduling a missed visit starts from tomorrow at the same time of day.
  const initial = useMemo(() => {
    const a = tsToDate(visit.scheduledStart) ?? new Date();
    const b = tsToDate(visit.scheduledEnd) ?? new Date(a.getTime() + 3_600_000);
    if (mode !== 'reschedule') return { a, b };
    const t = new Date();
    t.setDate(t.getDate() + 1);
    t.setHours(a.getHours(), a.getMinutes(), 0, 0);
    return { a: t, b: new Date(t.getTime() + (b.getTime() - a.getTime())) };
  }, [visit, mode]);
  const [start, setStart] = useState(toDateTimeLocal(initial.a));
  const [end, setEnd] = useState(toDateTimeLocal(initial.b));

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
      if (mode === 'reschedule' && a.getTime() <= Date.now()) return act.setError('Choose a time in the future.');
      const req: UpdateVisitRequest = { orgId: s.orgId, visitId: visit.id };
      if ((assignedUid || null) !== visit.assignedUid) req.assignedUid = assignedUid || null;
      // A missed visit always sends the new start (that is what reschedules it).
      if (mode === 'reschedule' || a.getTime() !== tsToDate(visit.scheduledStart)?.getTime()) req.start = a.toISOString();
      if (mode === 'reschedule' || b.getTime() !== tsToDate(visit.scheduledEnd)?.getTime()) req.end = b.toISOString();
      const n = note.trim() || null;
      if (mode === 'edit' && n !== (visit.note ?? null)) req.note = n;
      ok = await act.run(() => call<UpdateVisitRequest, unknown>('updateVisit', req));
    }
    if (ok) onClose();
  }

  const title =
    mode === 'complete'
      ? visit.status === 'missed' ? 'Document missed visit as completed' : 'Complete visit'
      : mode === 'cancel' ? 'Cancel visit' : mode === 'reschedule' ? 'Reschedule missed visit' : 'Reassign / reschedule visit';
  return (
    <Modal title={title} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <ErrorBanner error={act.error} />
        <p className="muted">
          {visit.patientName} · {visit.discipline} · {tsToDate(visit.scheduledStart)?.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
        </p>
        {mode === 'complete' && visit.status === 'missed' && (
          <div className="banner banner-info">Late documentation: the visit is marked completed now and its missed-visit alert is resolved.</div>
        )}
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
        {(mode === 'edit' || mode === 'reschedule') && (
          <>
            {mode === 'reschedule' && <p className="muted small">The visit goes back to scheduled and its missed-visit alert is resolved.</p>}
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
            {mode === 'edit' && (
              <Field label="Note">
                <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
              </Field>
            )}
          </>
        )}
        <div className="row gap end">
          <Button onClick={onClose}>Close</Button>
          <Button type="submit" variant={mode === 'cancel' ? 'danger' : 'primary'} busy={act.busy}>
            {mode === 'complete' ? 'Mark completed' : mode === 'cancel' ? 'Cancel visit' : mode === 'reschedule' ? 'Reschedule' : 'Save'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Complete / Reassign / Reschedule / Cancel buttons, shown only where the server allows them.
 * Pass the patient's `careTeamUids` when known; otherwise the care-team check is left to the server.
 */
export function VisitActions({
  visit,
  onAction,
  careTeamUids,
}: {
  visit: WithId<Visit>;
  onAction: (mode: VisitActionMode) => void;
  careTeamUids?: readonly string[];
}) {
  const perms = useVisitPermissions();
  if (visit.status !== 'scheduled' && visit.status !== 'missed') return null;
  const canComplete = perms.canComplete(visit, careTeamUids);
  const canReassign = perms.canReassign(visit, careTeamUids);
  const canReschedule = perms.canReschedule(visit, careTeamUids);
  const canCancel = perms.canCancel(visit, careTeamUids);
  if (!canComplete && !canReassign && !canReschedule && !canCancel) return null;
  return (
    <div className="row gap-sm end" onClick={(e) => e.stopPropagation()}>
      {canComplete && <Button small variant="primary" onClick={() => onAction('complete')}>Complete</Button>}
      {canReassign && <Button small onClick={() => onAction('edit')}>Reassign</Button>}
      {canReschedule && <Button small onClick={() => onAction('reschedule')}>Reschedule</Button>}
      {canCancel && <Button small variant="ghost" onClick={() => onAction('cancel')}>Cancel</Button>}
    </div>
  );
}

/** V3: move many scheduled visits to one clinician (sick calls). */
export function ReassignVisitsModal({ visitIds, onClose, onDone }: { visitIds: string[]; onClose: () => void; onDone?: () => void }) {
  const s = useOrgSession();
  const act = useAction();
  const [assignedUid, setAssignedUid] = useState('');
  const [reason, setReason] = useState('Sick call');
  const [result, setResult] = useState<ReassignVisitsResponse | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!assignedUid) return act.setError('Choose who takes these visits.');
    const r = reason.trim();
    if (!r) return act.setError('A reason is required.');
    await act.run(async () => {
      const res = await call<ReassignVisitsRequest, ReassignVisitsResponse>('reassignVisits', { orgId: s.orgId, visitIds, assignedUid, reason: r });
      setResult(res);
      onDone?.();
    });
  }

  return (
    <Modal title={`Reassign ${visitIds.length} visit${visitIds.length === 1 ? '' : 's'}`} onClose={onClose}>
      {result ? (
        <div className="form">
          <div className="banner banner-ok">
            {result.reassigned} visit{result.reassigned === 1 ? '' : 's'} reassigned to {s.memberName(assignedUid)}. They were notified.
          </div>
          {result.skipped.length > 0 && (
            <p className="muted small">
              {result.skipped.length} skipped (only scheduled visits move; some were already theirs, completed, missed or cancelled).
            </p>
          )}
          <div className="row end"><Button variant="primary" onClick={onClose}>Done</Button></div>
        </div>
      ) : (
        <form className="form" onSubmit={submit}>
          <ErrorBanner error={act.error} />
          <Field label="New assignee">
            <MemberSelect members={s.members} value={assignedUid} onChange={setAssignedUid} required />
          </Field>
          <Field label="Reason" hint="Kept in the audit log. Don't include patient details.">
            <input required maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <div className="row gap end">
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" busy={act.busy}>Reassign</Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

const CONFLICT_LABELS: Record<string, string> = {
  unassigned: 'Unassigned',
  overlap: 'Overlaps',
  past: 'In the past',
  inactive_assignee: 'Planned assignee inactive',
};

/** V2: preview a week generated from visit frequencies, then confirm to create it. */
export function PlanWeekModal({ weekStart, onClose }: { weekStart: Date; onClose: () => void }) {
  const s = useOrgSession();
  const act = useAction();
  const weekISO = toISODate(weekStart);
  const [preview, setPreview] = useState<GenerateVisitPlanResponse | null>(null);
  const [created, setCreated] = useState<GenerateVisitPlanResponse | null>(null);

  useEffect(() => {
    void act.run(async () => {
      setPreview(await call<GenerateVisitPlanRequest, GenerateVisitPlanResponse>('generateVisitPlan', { orgId: s.orgId, weekStart: weekISO, dryRun: true }));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.orgId, weekISO]);

  async function confirm() {
    await act.run(async () => {
      setCreated(await call<GenerateVisitPlanRequest, GenerateVisitPlanResponse>('generateVisitPlan', { orgId: s.orgId, weekStart: weekISO, dryRun: false }));
    });
  }

  const days = Array.from({ length: 7 }, (_, i) => addDaysISO(weekISO, i));
  const conflictsByVisit = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const c of preview?.conflicts ?? []) if (c.visitId) m.set(c.visitId, [...(m.get(c.visitId) ?? []), c.kind]);
    return m;
  }, [preview]);
  const rows = useMemo(() => {
    const byPatient = new Map<string, { name: string; visits: PlannedVisit[] }>();
    for (const v of preview?.visits ?? []) {
      const r = byPatient.get(v.patientId) ?? { name: v.patientName, visits: [] };
      r.visits.push(v);
      byPatient.set(v.patientId, r);
    }
    return [...byPatient.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name));
  }, [preview]);
  const general = (preview?.conflicts ?? []).filter((c) => !c.visitId || c.kind === 'past');

  return (
    <Modal title={`Plan week of ${new Date(weekStart).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`} onClose={onClose} wide>
      <ErrorBanner error={act.error} />
      {!preview && act.busy && <p className="muted">Building the plan from visit frequencies…</p>}
      {created ? (
        <div className="form">
          <div className="banner banner-ok">
            Created {created.created} visit{created.created === 1 ? '' : 's'}.
            {created.visits.length > created.created ? ` ${created.visits.length - created.created} already existed.` : ''}
          </div>
          <div className="row end"><Button variant="primary" onClick={onClose}>Done</Button></div>
        </div>
      ) : preview && (
        <>
          <p className="muted small">
            {preview.visits.length} visit{preview.visits.length === 1 ? '' : 's'} to create · {preview.existing} already scheduled count toward the frequencies ·{' '}
            {preview.conflicts.length} conflict{preview.conflicts.length === 1 ? '' : 's'}. Re-running the plan never duplicates visits.
          </p>
          {preview.visits.length === 0 ? (
            <p className="muted">Nothing to add: every admitted patient with visit frequencies is already planned for this week.</p>
          ) : (
            <div className="plan-grid-wrap">
              <table className="table plan-grid">
                <thead>
                  <tr>
                    <th>Patient</th>
                    {days.map((d) => (
                      <th key={d}>{new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'numeric', day: 'numeric' })}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(([pid, r]) => (
                    <tr key={pid}>
                      <td><strong>{r.name}</strong></td>
                      {days.map((d) => (
                        <td key={d}>
                          {r.visits
                            .filter((v) => toISODate(new Date(v.start)) === d)
                            .map((v) => {
                              const kinds = conflictsByVisit.get(v.id) ?? [];
                              return (
                                <div key={v.id} className={`visit-chip ${kinds.length ? 'status-missed' : ''}`} title={kinds.map((k) => CONFLICT_LABELS[k] ?? k).join(', ')}>
                                  <span className="visit-time">{new Date(v.start).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>
                                  <span className="visit-meta">{v.discipline} · {v.assignedUid ? s.memberName(v.assignedUid) : 'Unassigned'}</span>
                                  {kinds.filter((k) => k !== 'past').map((k) => <Badge key={k} tone="warn">{CONFLICT_LABELS[k] ?? k}</Badge>)}
                                </div>
                              );
                            })}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {general.length > 0 && (
            <details style={{ marginTop: 8 }}>
              <summary>{general.length} other note{general.length === 1 ? '' : 's'}</summary>
              <ul className="small">
                {general.map((c, i) => <li key={i}>{c.discipline}: {c.message}</li>)}
              </ul>
            </details>
          )}
          <div className="row gap end" style={{ marginTop: 12 }}>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" busy={act.busy} disabled={preview.visits.length === 0} onClick={() => void confirm()}>
              Create {preview.visits.length} visit{preview.visits.length === 1 ? '' : 's'}
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}

/** V1 setting (rendered on the Settings page): who hears about missed visits. */
export function MissedVisitAlertCard() {
  const s = useOrgSession();
  const act = useAction();
  const current = orgSettings(s.org).missedVisitAlertMode;
  const [mode, setMode] = useState<MissedVisitAlertMode>(current);
  const [saved, setSaved] = useState(false);
  useEffect(() => setMode(current), [current]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaved(false);
    if (mode === s.org?.missedVisitAlertMode) return setSaved(true);
    if (await act.run(() => updateDoc(orgDoc(s.orgId), { missedVisitAlertMode: mode }))) setSaved(true);
  }

  return (
    <Card title="Missed-visit alerts">
      <form className="form form-narrow" onSubmit={save}>
        <ErrorBanner error={act.error} />
        {saved && <div className="banner banner-ok">Missed-visit alerts saved.</div>}
        <Field label="Who is alerted when a visit is missed" hint="The digest goes to admins and members with the Scheduling capability at 07:00 organization time.">
          <div className="picker">
            {(Object.keys(MISSED_VISIT_ALERT_MODE_LABELS) as MissedVisitAlertMode[]).map((m) => (
              <label key={m} className="picker-item">
                <input type="radio" name="missedVisitAlertMode" checked={mode === m} onChange={() => setMode(m)} />
                <span>{MISSED_VISIT_ALERT_MODE_LABELS[m]}</span>
              </label>
            ))}
          </div>
        </Field>
        <div>
          <Button type="submit" variant="primary" busy={act.busy}>Save</Button>
        </div>
      </form>
    </Card>
  );
}
