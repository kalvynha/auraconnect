import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { limit, orderBy, query } from 'firebase/firestore';
import type {
  CompleteIdgMeetingRequest,
  CompleteIdgMeetingResponse,
  Discipline,
  GenerateIdgPrepResponse,
  IdgAiPrepNote,
  IdgDisciplineNote,
  IdgNoteDoc,
  SaveIdgDisciplineNoteRequest,
  CreateIdgMeetingRequest,
  GenerateIdgPrepRequest,
  IdResponse,
  IdgActionItem,
  IdgMeeting,
  IdgPatientNote,
  Patient,
  SaveIdgNoteRequest,
  Team,
  UpdateIdgMeetingRequest,
} from '@shared/types';
import { useOrgSession } from '../lib/session';
import { orgCol, orgDoc, type WithId } from '../lib/firestore';
import { useAction, useLiveDoc, useLiveQuery } from '../lib/hooks';
import { usePatients } from '../lib/queries';
import { call } from '../lib/firebase';
import { CLINICAL_ROLES, DISCIPLINES, orgSettings } from '../lib/constants';
import { addDaysISO, dueState, formatDate, formatInstant, toDateTimeLocal, toISODate, tsToDate } from '../lib/format';
import { patientName } from '../lib/patient';
import {
  AI_DISCLAIMER_FALLBACK,
  Badge,
  Button,
  Card,
  CopyButton,
  ErrorBanner,
  Field,
  Loading,
  MemberPicker,
  MemberSelect,
  Modal,
  Page,
  Table,
} from '../components/ui';

function PatientChecklist({
  patients,
  value,
  onChange,
}: {
  patients: WithId<Patient>[];
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  const sorted = [...patients].sort((a, b) => (a.nextIdgDueDate ?? '9999').localeCompare(b.nextIdgDueDate ?? '9999'));
  if (sorted.length === 0) return <div className="muted">No admitted patients.</div>;
  return (
    <div className="picker">
      {sorted.map((p) => {
        const checked = value.includes(p.id);
        return (
          <label key={p.id} className="picker-item">
            <input type="checkbox" checked={checked} onChange={() => onChange(checked ? value.filter((x) => x !== p.id) : [...value, p.id])} />
            <span>
              {patientName(p)}{' '}
              <span className="muted small">· next review {formatDate(p.nextIdgDueDate ?? null)}</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

function MeetingModal({ meeting, onClose, onCreated }: { meeting?: WithId<IdgMeeting>; onClose: () => void; onCreated?: (id: string) => void }) {
  const s = useOrgSession();
  const act = useAction();
  const teams = useLiveQuery<Team>(query(orgCol(s.orgId, 'teams'), orderBy('name')), [s.orgId]);
  const patients = usePatients(s.orgId, ['admitted']);
  const defaultAt = (() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(10, 0, 0, 0);
    return d;
  })();
  const [title, setTitle] = useState(meeting?.title ?? `IDG meeting ${defaultAt.toLocaleDateString()}`);
  const [at, setAt] = useState(toDateTimeLocal(tsToDate(meeting?.scheduledAt) ?? defaultAt));
  const [teamId, setTeamId] = useState(meeting?.teamId ?? '');
  const [attendees, setAttendees] = useState<string[]>(meeting?.attendeeUids ?? [s.user.uid]);
  const [agendaMode, setAgendaMode] = useState<'auto' | 'pick'>(meeting ? 'pick' : 'auto');
  const [patientIds, setPatientIds] = useState<string[]>(meeting?.patientIds ?? []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const when = new Date(at);
    if (Number.isNaN(when.getTime())) return act.setError('Choose a date and time.');
    if (meeting) {
      const req: UpdateIdgMeetingRequest = {
        orgId: s.orgId,
        meetingId: meeting.id,
        title: title.trim(),
        scheduledAt: when.toISOString(),
        attendeeUids: attendees,
        patientIds,
      };
      if (await act.run(() => call<UpdateIdgMeetingRequest, unknown>('updateIdgMeeting', req))) onClose();
      return;
    }
    const req: CreateIdgMeetingRequest = { orgId: s.orgId, title: title.trim(), scheduledAt: when.toISOString(), attendeeUids: attendees };
    if (teamId) req.teamId = teamId;
    if (agendaMode === 'pick') req.patientIds = patientIds;
    let id = '';
    const ok = await act.run(async () => {
      id = (await call<CreateIdgMeetingRequest, IdResponse>('createIdgMeeting', req)).id;
    });
    if (ok) onCreated?.(id);
  }

  // Patients the server would auto-add: nextIdgDueDate ≤ meeting date + 7 days.
  const cutoff = addDaysISO(toISODate(new Date(at || Date.now())), 7);
  const autoCount = patients.data.filter((p) => p.nextIdgDueDate && p.nextIdgDueDate <= cutoff).length;

  return (
    <Modal title={meeting ? 'Edit meeting' : 'New IDG meeting'} onClose={onClose} wide>
      <form className="form" onSubmit={submit}>
        <ErrorBanner error={act.error ?? teams.error ?? patients.error} />
        <div className="form-grid">
          <Field label="Title">
            <input required value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="Date and time">
            <input type="datetime-local" required value={at} onChange={(e) => setAt(e.target.value)} />
          </Field>
          {!meeting && (
            <Field label="Team">
              <select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
                <option value="">All teams</option>
                {teams.data.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Field>
          )}
        </div>
        <Field label="Attendees">
          <MemberPicker members={s.members} value={attendees} onChange={setAttendees} />
        </Field>
        <Field label="Agenda">
          {!meeting && (
            <div className="segmented">
              <button type="button" className={agendaMode === 'auto' ? 'active' : ''} onClick={() => setAgendaMode('auto')}>
                Patients due for review
              </button>
              <button type="button" className={agendaMode === 'pick' ? 'active' : ''} onClick={() => setAgendaMode('pick')}>
                Choose patients
              </button>
            </div>
          )}
        </Field>
        {agendaMode === 'auto' ? (
          <p className="muted">
            The agenda is filled with admitted patients whose next IDG review is due within 7 days of the meeting (about {autoCount} now).
          </p>
        ) : (
          <PatientChecklist patients={patients.data} value={patientIds} onChange={setPatientIds} />
        )}
        <div className="row gap end">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" busy={act.busy}>{meeting ? 'Save' : 'Create meeting'}</Button>
        </div>
      </form>
    </Modal>
  );
}

interface ItemDraft {
  title: string;
  assigneeUid: string;
  dueDate: string;
}

function NoteForm({
  meeting,
  patientId,
  note,
  editable,
}: {
  meeting: WithId<IdgMeeting>;
  patientId: string;
  note: IdgPatientNote | undefined;
  editable: boolean;
}) {
  const s = useOrgSession();
  const act = useAction();
  const [summary, setSummary] = useState(note?.summary ?? '');
  const [poc, setPoc] = useState(note?.planOfCareChanges ?? '');
  const [goals, setGoals] = useState(note?.goalsOfCare ?? '');
  const [items, setItems] = useState<ItemDraft[]>(
    (note?.actionItems ?? []).map((i) => ({ title: i.title, assigneeUid: i.assigneeUid ?? '', dueDate: i.dueDate ?? '' })),
  );
  const [reviewed, setReviewed] = useState(note?.reviewed ?? false);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);

  // Pick up other people's saves while this form is untouched.
  useEffect(() => {
    if (dirty || !note) return;
    setSummary(note.summary);
    setPoc(note.planOfCareChanges ?? '');
    setGoals(note.goalsOfCare ?? '');
    setItems(note.actionItems.map((i) => ({ title: i.title, assigneeUid: i.assigneeUid ?? '', dueDate: i.dueDate ?? '' })));
    setReviewed(note.reviewed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note?.updatedAt?.seconds]);

  const touch = () => {
    setDirty(true);
    setSaved(false);
  };

  async function save() {
    const actionItems: IdgActionItem[] = items
      .filter((i) => i.title.trim())
      .map((i) => ({ title: i.title.trim(), assigneeUid: i.assigneeUid || null, dueDate: i.dueDate || null }));
    const req: SaveIdgNoteRequest = {
      orgId: s.orgId,
      meetingId: meeting.id,
      patientId,
      summary: summary.trim(),
      planOfCareChanges: poc.trim() || null,
      goalsOfCare: goals.trim() || null,
      actionItems,
      reviewed,
    };
    if (await act.run(() => call<SaveIdgNoteRequest, unknown>('saveIdgNote', req))) {
      setSaved(true);
      setDirty(false);
    }
  }

  return (
    <div className="form">
      <ErrorBanner error={act.error} />
      <Field label="Summary">
        <textarea rows={3} value={summary} disabled={!editable} onChange={(e) => { touch(); setSummary(e.target.value); }} />
      </Field>
      <div className="form-grid-2">
        <Field label="Plan-of-care changes">
          <textarea rows={2} value={poc} disabled={!editable} onChange={(e) => { touch(); setPoc(e.target.value); }} />
        </Field>
        <Field label="Goals of care">
          <textarea rows={2} value={goals} disabled={!editable} onChange={(e) => { touch(); setGoals(e.target.value); }} />
        </Field>
      </div>
      <div>
        <div className="field-label">Action items {editable && <span className="muted small">(become tasks when the meeting is completed)</span>}</div>
        {items.length === 0 && <p className="muted small">None.</p>}
        {items.map((it, i) => (
          <div key={i} className="list-editor-row">
            <input
              placeholder="Action item"
              value={it.title}
              disabled={!editable}
              onChange={(e) => { touch(); setItems(items.map((x, j) => (j === i ? { ...x, title: e.target.value } : x))); }}
            />
            <MemberSelect
              members={s.members}
              value={it.assigneeUid}
              disabled={!editable}
              placeholder="Unassigned"
              onChange={(uid) => { touch(); setItems(items.map((x, j) => (j === i ? { ...x, assigneeUid: uid } : x))); }}
            />
            <input
              type="date"
              className="input-date"
              value={it.dueDate}
              disabled={!editable}
              aria-label="Due date"
              onChange={(e) => { touch(); setItems(items.map((x, j) => (j === i ? { ...x, dueDate: e.target.value } : x))); }}
            />
            {editable && <Button small variant="ghost" onClick={() => { touch(); setItems(items.filter((_, j) => j !== i)); }}>Remove</Button>}
          </div>
        ))}
        {editable && (
          <Button small onClick={() => { touch(); setItems([...items, { title: '', assigneeUid: '', dueDate: '' }]); }}>+ Add action item</Button>
        )}
      </div>
      <div className="row gap space-between">
        <label className="row gap-sm">
          <input type="checkbox" checked={reviewed} disabled={!editable} onChange={(e) => { touch(); setReviewed(e.target.checked); }} />
          <strong>Reviewed</strong> <span className="muted small">(updates the patient's IDG review dates on completion)</span>
        </label>
        {editable && (
          <div className="row gap-sm">
            {saved && <span className="muted small">Saved</span>}
            {note && !dirty && !saved && <span className="muted small">Last saved by {s.memberName(note.updatedBy)} · {formatInstant(note.updatedAt)}</span>}
            <Button variant="primary" small busy={act.busy} disabled={!summary.trim()} onClick={() => void save()}>Save note</Button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Prep is "fresh" (skipped by Generate prep for all) when generated within this many hours. */
const FRESH_PREP_HOURS = 12;
/** Patients per generateIdgPrep call (the server's cap). */
const PREP_BATCH = 25;

/**
 * F5: per-discipline notes, one document each (`notes/{patientId}_{discipline}`), so two clinicians
 * saving at once never overwrite each other.
 */
function DisciplineNotes({
  meeting,
  patientId,
  notes,
  editable,
}: {
  meeting: WithId<IdgMeeting>;
  patientId: string;
  notes: IdgDisciplineNote[];
  editable: boolean;
}) {
  const s = useOrgSession();
  const act = useAction();
  const mineDefault = (s.member?.discipline ?? 'RN') as Discipline;
  const [discipline, setDiscipline] = useState<Discipline>(mineDefault);
  const existing = notes.find((n) => n.discipline === discipline);
  const [text, setText] = useState(existing?.text ?? '');
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) setText(existing?.text ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [discipline, existing?.updatedAt?.seconds]);

  async function save() {
    const req: SaveIdgDisciplineNoteRequest = { orgId: s.orgId, meetingId: meeting.id, patientId, discipline, text: text.trim() };
    if (await act.run(() => call<SaveIdgDisciplineNoteRequest, unknown>('saveIdgDisciplineNote', req))) setDirty(false);
  }

  const sorted = [...notes].filter((n) => n.text).sort((a, b) => a.discipline.localeCompare(b.discipline));
  return (
    <div className="form">
      <div className="field-label">Discipline notes</div>
      {sorted.length === 0 && <p className="muted small">None yet.</p>}
      {sorted.map((n) => (
        <div key={n.discipline} className="list-row">
          <strong>{n.discipline}</strong> <span className="muted small">· {s.memberName(n.updatedBy)} · {formatInstant(n.updatedAt)}</span>
          <div style={{ whiteSpace: 'pre-wrap' }}>{n.text}</div>
        </div>
      ))}
      {editable && (
        <>
          <ErrorBanner error={act.error} />
          <div className="row gap-sm">
            <select value={discipline} aria-label="Discipline" onChange={(e) => { setDirty(false); setDiscipline(e.target.value as Discipline); }}>
              {DISCIPLINES.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
            <span className="muted small">{existing ? `Editing the ${discipline} note` : `New ${discipline} note`}</span>
          </div>
          <textarea rows={2} value={text} onChange={(e) => { setDirty(true); setText(e.target.value); }} placeholder={`${discipline} update for the team`} />
          <div>
            <Button small busy={act.busy} disabled={!dirty} onClick={() => void save()}>Save {discipline} note</Button>
          </div>
        </>
      )}
    </div>
  );
}

function AgendaItem({
  meeting,
  patientId,
  patient,
  editable,
  canPrep,
  prep: prepDoc,
  disciplineNotes,
}: {
  meeting: WithId<IdgMeeting>;
  patientId: string;
  patient: WithId<Patient> | undefined;
  editable: boolean;
  canPrep: boolean;
  prep: IdgAiPrepNote | undefined;
  disciplineNotes: IdgDisciplineNote[];
}) {
  const s = useOrgSession();
  const prepAct = useAction();
  // v3 prep lives in the notes subcollection; older meetings kept it on the meeting doc.
  const prep = prepDoc ?? meeting.aiPrep?.[patientId];
  const note = meeting.notes?.[patientId];
  const name = meeting.patientNames?.[patientId] ?? (patient ? patientName(patient) : 'Patient');
  const [showPrep, setShowPrep] = useState(true);

  return (
    <Card
      title={name}
      actions={
        <>
          {note?.reviewed ? <Badge tone="ok">reviewed</Badge> : <Badge tone="neutral">not reviewed</Badge>}
          {patient?.nextIdgDueDate && (
            <span className="muted small">
              next review {formatDate(patient.nextIdgDueDate)}{' '}
              {dueState(patient.nextIdgDueDate, 0) === 'overdue' && <Badge tone="danger">overdue</Badge>}
            </span>
          )}
          <Link to={`/patients/${patientId}`}>Chart</Link>
        </>
      }
    >
      <ErrorBanner error={prepAct.error} />
      {prep ? (
        <div className="ai-prep">
          <div className="row space-between">
            <button type="button" className="link" onClick={() => setShowPrep(!showPrep)}>
              {showPrep ? '▾' : '▸'} AI prep · {formatInstant(prep.generatedAt)}
            </button>
            <div className="row gap-sm">
              <CopyButton text={prep.text} />
              {canPrep && (
                <Button
                  small
                  busy={prepAct.busy}
                  onClick={() =>
                    void prepAct.run(() =>
                      call<GenerateIdgPrepRequest, unknown>('generateIdgPrep', { orgId: s.orgId, meetingId: meeting.id, patientId }),
                    )
                  }
                >
                  Regenerate
                </Button>
              )}
            </div>
          </div>
          {showPrep && (
            <>
              <div className="banner banner-warn small">{AI_DISCLAIMER_FALLBACK} Model: {prep.model}.</div>
              <div className="ai-text">{prep.text}</div>
            </>
          )}
        </div>
      ) : (
        canPrep && (
          <Button
            small
            busy={prepAct.busy}
            onClick={() =>
              void prepAct.run(() =>
                call<GenerateIdgPrepRequest, unknown>('generateIdgPrep', { orgId: s.orgId, meetingId: meeting.id, patientId }),
              )
            }
          >
            Generate AI prep for this patient
          </Button>
        )
      )}
      <DisciplineNotes meeting={meeting} patientId={patientId} notes={disciplineNotes} editable={editable} />
      <NoteForm meeting={meeting} patientId={patientId} note={note} editable={editable} />
    </Card>
  );
}

function MeetingView({ meetingId }: { meetingId: string }) {
  const s = useOrgSession();
  const navigate = useNavigate();
  const { data: meeting, loading, error } = useLiveDoc<IdgMeeting>(orgDoc(s.orgId, 'idgMeetings', meetingId), [s.orgId, meetingId]);
  // Bounded: admitted patients only (used for review dates and care-team checks).
  const patients = usePatients(s.orgId, ['admitted']);
  const notes = useLiveQuery<IdgNoteDoc>(orgCol(s.orgId, 'idgMeetings', meetingId, 'notes'), [s.orgId, meetingId]);
  const prepAct = useAction();
  const completeAct = useAction();
  const [editing, setEditing] = useState(false);
  const [prepProgress, setPrepProgress] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const clinical = CLINICAL_ROLES.includes(s.role);
  const prepByPatient = useMemo(() => {
    const m = new Map<string, IdgAiPrepNote>();
    for (const n of notes.data) if (n.kind === 'ai_prep') m.set(n.patientId, n);
    return m;
  }, [notes.data]);
  const disciplineByPatient = useMemo(() => {
    const m = new Map<string, IdgDisciplineNote[]>();
    for (const n of notes.data) if (n.kind === 'discipline') m.set(n.patientId, [...(m.get(n.patientId) ?? []), n]);
    return m;
  }, [notes.data]);

  if (loading) return <Loading />;
  if (!meeting) return <Page title="IDG meeting"><ErrorBanner error={error ?? 'Meeting not found.'} /></Page>;

  const open = meeting.status === 'scheduled';
  const editable = clinical && open;
  // H3: attendee/agenda edits are for the creator or an admin; prep is for the patient's care team or an admin.
  const canEditMeeting = editable && (s.isAdmin || meeting.createdBy === s.user.uid);
  const canPrepFor = (pid: string) => editable && (s.isAdmin || !!patients.data.find((p) => p.id === pid)?.careTeamUids.includes(s.user.uid));
  const reviewedCount = meeting.patientIds.filter((id) => meeting.notes?.[id]?.reviewed).length;

  /** F5: generate prep for every agenda patient I may prep, 25 per call, skipping fresh prep. */
  async function prepAll() {
    if (!meeting) return;
    const freshSince = Date.now() - FRESH_PREP_HOURS * 3_600_000;
    const pending = meeting.patientIds.filter((pid) => {
      if (!canPrepFor(pid)) return false;
      const p = prepByPatient.get(pid);
      return !(p && tsToDate(p.generatedAt) && tsToDate(p.generatedAt)!.getTime() >= freshSince);
    });
    if (pending.length === 0) return prepAct.setError('Every patient you can prep already has prep from the last 12 hours.');
    let done = 0;
    let failed = 0;
    await prepAct.run(async () => {
      for (let i = 0; i < pending.length; i += PREP_BATCH) {
        const batch = pending.slice(i, i + PREP_BATCH);
        setPrepProgress(`Generating prep… ${done} of ${pending.length} done`);
        const res = await call<GenerateIdgPrepRequest, GenerateIdgPrepResponse>('generateIdgPrep', {
          orgId: s.orgId,
          meetingId: meeting.id,
          patientIds: batch,
          skipFreshHours: FRESH_PREP_HOURS,
        });
        done += res.generatedPatientIds.length + (res.skippedPatientIds?.length ?? 0);
        failed += res.failedPatientIds.length;
      }
    });
    setPrepProgress(`Prep ready for ${done} of ${pending.length} patient(s)${failed ? `; ${failed} failed (try again)` : ''}.`);
  }

  async function complete() {
    if (!meeting) return;
    const unreviewed = meeting.patientIds.length - reviewedCount;
    const msg =
      `Complete this meeting? It will be locked. ${reviewedCount} reviewed patient(s) will have their IDG dates updated and action items turned into tasks.` +
      (unreviewed ? ` ${unreviewed} patient(s) are not marked reviewed and will not be updated.` : '');
    if (!window.confirm(msg)) return;
    await completeAct.run(async () => {
      const res = await call<CompleteIdgMeetingRequest, CompleteIdgMeetingResponse>('completeIdgMeeting', { orgId: s.orgId, meetingId: meeting.id });
      setWarnings(res?.warnings ?? []);
    });
  }

  return (
    <Page
      title={meeting.title}
      actions={
        <>
          <Button onClick={() => navigate('/idg')}>← Meetings</Button>
          {canEditMeeting && <Button onClick={() => setEditing(true)}>Edit</Button>}
          {editable && meeting.patientIds.some(canPrepFor) && (
            <Button busy={prepAct.busy} onClick={() => void prepAll()}>
              Generate prep for all
            </Button>
          )}
          {editable && <Button variant="primary" busy={completeAct.busy} onClick={() => void complete()}>Complete meeting</Button>}
        </>
      }
    >
      <ErrorBanner error={error ?? prepAct.error ?? completeAct.error ?? patients.error ?? notes.error} />
      {warnings.map((w) => <div key={w} className="banner banner-warn">{w}</div>)}
      {prepProgress && !prepAct.busy && <div className="banner banner-info">{prepProgress}</div>}
      <div className="row gap wrap summary">
        <Badge value={meeting.status} tone={open ? 'info' : 'ok'} />
        <span>{formatInstant(meeting.scheduledAt)}</span>
        <span className="muted">Attendees: {meeting.attendeeUids.map((u) => s.memberName(u)).join(', ') || '—'}</span>
        <span className="muted">{reviewedCount} of {meeting.patientIds.length} reviewed</span>
        {meeting.completedAt && <span className="muted">Completed {formatInstant(meeting.completedAt)} by {s.memberName(meeting.completedBy)}</span>}
      </div>
      {prepAct.busy && <div className="banner banner-info">{prepProgress ?? 'Generating AI prep packets…'} This can take a few minutes.</div>}
      {!open && <div className="banner banner-info">This meeting is completed and locked.</div>}
      {meeting.patientIds.length === 0 && <p className="muted">No patients on the agenda.</p>}
      {meeting.patientIds.map((pid) => (
        <AgendaItem
          key={pid}
          meeting={meeting}
          patientId={pid}
          patient={patients.data.find((p) => p.id === pid)}
          editable={editable}
          canPrep={canPrepFor(pid)}
          prep={prepByPatient.get(pid)}
          disciplineNotes={disciplineByPatient.get(pid) ?? []}
        />
      ))}
      {editing && <MeetingModal meeting={meeting} onClose={() => setEditing(false)} />}
    </Page>
  );
}

function MeetingList() {
  const s = useOrgSession();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const meetings = useLiveQuery<IdgMeeting>(query(orgCol(s.orgId, 'idgMeetings'), orderBy('scheduledAt', 'desc'), limit(100)), [s.orgId]);
  const patients = usePatients(s.orgId, ['admitted']);
  const cadence = orgSettings(s.org).idgCadenceDays;
  const dueSoon = useMemo(() => {
    const cutoff = addDaysISO(toISODate(new Date()), 7);
    return patients.data
      .filter((p) => !p.nextIdgDueDate || p.nextIdgDueDate <= cutoff)
      .sort((a, b) => (a.nextIdgDueDate ?? '').localeCompare(b.nextIdgDueDate ?? ''));
  }, [patients.data]);

  return (
    <Page title="IDG meetings" actions={CLINICAL_ROLES.includes(s.role) && <Button variant="primary" onClick={() => setCreating(true)}>New meeting</Button>}>
      <ErrorBanner error={meetings.error ?? patients.error} />
      <Card title="Meetings">
        <Table
          rows={meetings.data}
          rowKey={(m) => m.id}
          onRowClick={(m) => navigate(`/idg/${m.id}`)}
          empty={meetings.loading ? 'Loading…' : 'No meetings yet.'}
          columns={[
            { header: 'When', cell: (m) => formatInstant(m.scheduledAt) },
            { header: 'Title', cell: (m) => <strong>{m.title}</strong> },
            { header: 'Patients', cell: (m) => m.patientIds.length },
            { header: 'Reviewed', cell: (m) => m.patientIds.filter((id) => m.notes?.[id]?.reviewed).length },
            { header: 'Status', cell: (m) => <Badge value={m.status} tone={m.status === 'scheduled' ? 'info' : 'ok'} /> },
          ]}
        />
      </Card>
      <Card title={`Patients due for IDG review (next 7 days) · cadence ${cadence} days`}>
        <Table
          rows={dueSoon}
          rowKey={(p) => p.id}
          empty="No patients due."
          columns={[
            { header: 'Patient', cell: (p) => <Link to={`/patients/${p.id}`}>{patientName(p)}</Link> },
            { header: 'Last review', cell: (p) => formatDate(p.lastIdgReviewDate ?? null) },
            {
              header: 'Next review due',
              cell: (p) =>
                p.nextIdgDueDate ? (
                  <>
                    {formatDate(p.nextIdgDueDate)} {dueState(p.nextIdgDueDate, 0) === 'overdue' && <Badge tone="danger">overdue</Badge>}
                  </>
                ) : (
                  <span className="muted">not set</span>
                ),
            },
          ]}
        />
      </Card>
      {creating && (
        <MeetingModal
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            navigate(`/idg/${id}`);
          }}
        />
      )}
    </Page>
  );
}

export default function IdgPage() {
  const { meetingId } = useParams();
  return meetingId ? <MeetingView key={meetingId} meetingId={meetingId} /> : <MeetingList />;
}
