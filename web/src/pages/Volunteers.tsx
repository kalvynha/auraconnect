import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { addDoc, deleteDoc, limit, orderBy, query, serverTimestamp, updateDoc, where } from 'firebase/firestore';
import type { VolunteerActivity, VolunteerAssignment, VolunteerLog } from '@shared/types';
import { useOrgSession } from '../lib/session';
import { orgCol, orgDoc, type WithId } from '../lib/firestore';
import { useAction, useLiveQuery } from '../lib/hooks';
import { usePatients } from '../lib/queries';
import { VOLUNTEER_ACTIVITIES } from '../lib/constants';
import { addDaysISO, formatDate, formatMinutes, todayISO } from '../lib/format';
import { patientName } from '../lib/patient';
import { Badge, Button, Card, ErrorBanner, Field, MemberSelect, Modal, Page, PatientSelect, Table } from '../components/ui';

function AssignmentModal({ onClose }: { onClose: () => void }) {
  const s = useOrgSession();
  const act = useAction();
  const patients = usePatients(s.orgId, ['admitted']);
  const [onlyVolunteers, setOnlyVolunteers] = useState(true);
  const [volunteerUid, setVolunteerUid] = useState('');
  const [patientId, setPatientId] = useState('');
  const [activity, setActivity] = useState<VolunteerActivity>('companionship');
  const [startDate, setStartDate] = useState(todayISO());
  const [notes, setNotes] = useState('');
  const candidates = onlyVolunteers ? s.members.filter((m) => m.discipline === 'Volunteer') : s.members;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const p = patients.data.find((x) => x.id === patientId);
    if (!volunteerUid || !p) return act.setError('Choose a volunteer and a patient.');
    // Exact VolunteerAssignment shape.
    const data = {
      volunteerUid,
      patientId: p.id,
      patientName: patientName(p),
      activity,
      status: 'active' as const,
      startDate,
      endDate: null,
      notes: notes.trim() || null,
      createdBy: s.user.uid,
      createdAt: serverTimestamp(),
    };
    if (await act.run(() => addDoc(orgCol(s.orgId, 'volunteerAssignments'), data))) onClose();
  }

  return (
    <Modal title="New volunteer assignment" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <ErrorBanner error={act.error ?? patients.error} />
        <Field label="Volunteer">
          <MemberSelect members={candidates} value={volunteerUid} onChange={setVolunteerUid} required />
        </Field>
        <label className="row gap-sm small">
          <input type="checkbox" checked={onlyVolunteers} onChange={(e) => setOnlyVolunteers(e.target.checked)} /> Only members with the Volunteer discipline
        </label>
        <Field label="Patient">
          <PatientSelect patients={patients.data} value={patientId} onChange={setPatientId} placeholder="Select patient…" required />
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
          <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <div className="row gap end">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" busy={act.busy}>Create assignment</Button>
        </div>
      </form>
    </Modal>
  );
}

function LogTimeForm({ assignments }: { assignments: WithId<VolunteerAssignment>[] }) {
  const s = useOrgSession();
  const act = useAction();
  const patients = usePatients(s.orgId, ['admitted']);
  const myAssigned = assignments.filter((a) => a.volunteerUid === s.user.uid && a.status === 'active');
  const [date, setDate] = useState(todayISO());
  const [hours, setHours] = useState('1');
  const [mins, setMins] = useState('0');
  const [activity, setActivity] = useState<VolunteerActivity>(myAssigned[0]?.activity ?? 'companionship');
  const [patientId, setPatientId] = useState('');
  const [note, setNote] = useState('');
  const [ok, setOk] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setOk(false);
    const minutes = Math.round(Number(hours || 0) * 60 + Number(mins || 0));
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) return act.setError('Time must be between 1 minute and 24 hours.');
    if (date > todayISO()) return act.setError('The date cannot be in the future.');
    // Exact VolunteerLog shape.
    const data = {
      volunteerUid: s.user.uid,
      patientId: patientId || null,
      date,
      minutes,
      activity,
      note: note.trim() || null,
      createdAt: serverTimestamp(),
    };
    if (await act.run(() => addDoc(orgCol(s.orgId, 'volunteerLogs'), data))) {
      setOk(true);
      setNote('');
    }
  }

  // Assigned patients first, then everyone admitted.
  const patientOptions = [
    ...patients.data.filter((p) => myAssigned.some((a) => a.patientId === p.id)),
    ...patients.data.filter((p) => !myAssigned.some((a) => a.patientId === p.id)),
  ];

  return (
    <form className="form" onSubmit={submit}>
      <ErrorBanner error={act.error} />
      {ok && <div className="banner banner-ok">Time logged. Logs cannot be edited; contact an admin to correct one.</div>}
      <div className="form-grid">
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
          <PatientSelect patients={patientOptions} value={patientId} onChange={setPatientId} placeholder="No specific patient" />
        </Field>
      </div>
      <Field label="Note">
        <input value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <div>
        <Button type="submit" variant="primary" busy={act.busy}>Log my time</Button>
      </div>
    </form>
  );
}

export default function VolunteersPage() {
  const s = useOrgSession();
  const [creating, setCreating] = useState(false);
  const [showEnded, setShowEnded] = useState(false);
  const act = useAction();
  const assignments = useLiveQuery<VolunteerAssignment>(query(orgCol(s.orgId, 'volunteerAssignments'), orderBy('startDate', 'desc')), [s.orgId]);
  // Non-admins may only list their own logs.
  const logs = useLiveQuery<VolunteerLog>(
    s.isAdmin
      ? query(orgCol(s.orgId, 'volunteerLogs'), orderBy('date', 'desc'), limit(1000))
      : query(orgCol(s.orgId, 'volunteerLogs'), where('volunteerUid', '==', s.user.uid)),
    [s.orgId, s.isAdmin, s.user.uid],
  );
  const patients = usePatients(s.orgId);
  const pName = (id: string | null) => {
    if (!id) return null;
    const p = patients.data.find((x) => x.id === id);
    return p ? patientName(p) : 'Patient';
  };

  const sortedLogs = useMemo(() => [...logs.data].sort((a, b) => b.date.localeCompare(a.date)), [logs.data]);
  const since = addDaysISO(todayISO(), -30);
  const totals = useMemo(() => {
    let last30 = 0;
    let all = 0;
    const byVolunteer = new Map<string, number>();
    const byActivity = new Map<string, number>();
    for (const l of logs.data) {
      all += l.minutes;
      if (l.date >= since) {
        last30 += l.minutes;
        byVolunteer.set(l.volunteerUid, (byVolunteer.get(l.volunteerUid) ?? 0) + l.minutes);
        byActivity.set(l.activity, (byActivity.get(l.activity) ?? 0) + l.minutes);
      }
    }
    return {
      last30,
      all,
      byVolunteer: [...byVolunteer.entries()].sort((a, b) => b[1] - a[1]),
      byActivity: [...byActivity.entries()].sort((a, b) => b[1] - a[1]),
    };
  }, [logs.data, since]);

  const visibleAssignments = assignments.data.filter((a) => showEnded || a.status === 'active');

  async function endAssignment(a: WithId<VolunteerAssignment>) {
    if (!window.confirm(`End ${s.memberName(a.volunteerUid)}'s assignment with ${a.patientName}?`)) return;
    // Update may not touch createdBy/createdAt; the doc keeps every VolunteerAssignment key.
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
    <Page title="Volunteers" actions={s.isAdmin && <Button variant="primary" onClick={() => setCreating(true)}>New assignment</Button>}>
      <ErrorBanner error={act.error ?? assignments.error ?? logs.error} />
      <div className="stats">
        <div className="stat">
          <div className="stat-value">{formatMinutes(totals.last30)}</div>
          <div className="stat-label">{s.isAdmin ? 'Volunteer time, last 30 days' : 'My time, last 30 days'}</div>
        </div>
        <div className="stat">
          <div className="stat-value">{formatMinutes(totals.all)}</div>
          <div className="stat-label">{s.isAdmin ? 'Logged (loaded logs)' : 'My total logged time'}</div>
        </div>
        <div className="stat">
          <div className="stat-value">{assignments.data.filter((a) => a.status === 'active').length}</div>
          <div className="stat-label">Active assignments</div>
        </div>
      </div>
      {s.isAdmin && (
        <p className="muted small">
          CMS requires volunteer hours to equal at least 5% of total patient-care hours provided by paid staff and contractors
          (42 CFR 418.78). Compare these totals against staff hours from payroll.
        </p>
      )}

      <Card title="Log my time">
        <LogTimeForm assignments={assignments.data} />
      </Card>

      <Card
        title="Assignments"
        actions={
          <label className="row gap-sm small">
            <input type="checkbox" checked={showEnded} onChange={(e) => setShowEnded(e.target.checked)} /> Show ended
          </label>
        }
      >
        <Table
          rows={visibleAssignments}
          rowKey={(a) => a.id}
          empty={assignments.loading ? 'Loading…' : 'No assignments.'}
          rowClassName={(a) => (a.status === 'ended' ? 'row-muted' : undefined)}
          columns={[
            { header: 'Volunteer', cell: (a) => s.memberName(a.volunteerUid) },
            { header: 'Patient', cell: (a) => <Link to={`/patients/${a.patientId}`}>{a.patientName}</Link> },
            { header: 'Activity', cell: (a) => a.activity },
            { header: 'Dates', cell: (a) => <>{formatDate(a.startDate)} – {a.endDate ? formatDate(a.endDate) : 'ongoing'}</> },
            { header: 'Status', cell: (a) => <Badge value={a.status} /> },
            { header: 'Notes', cell: (a) => <span className="small">{a.notes ?? ''}</span> },
            ...(s.isAdmin
              ? [
                  {
                    header: '',
                    className: 'actions',
                    cell: (a: WithId<VolunteerAssignment>) => (
                      <div className="row gap-sm end">
                        {a.status === 'active' ? (
                          <Button small onClick={() => void endAssignment(a)}>End</Button>
                        ) : (
                          <Button small onClick={() => void reactivate(a)}>Reactivate</Button>
                        )}
                        <Button small variant="ghost" onClick={() => void remove(a)}>Delete</Button>
                      </div>
                    ),
                  },
                ]
              : []),
          ]}
        />
      </Card>

      {s.isAdmin && totals.byVolunteer.length > 0 && (
        <div className="grid-2">
          <Card title="Last 30 days by volunteer">
            <ul className="list">
              {totals.byVolunteer.map(([uid, m]) => (
                <li key={uid} className="list-row"><span>{s.memberName(uid)}</span><strong>{formatMinutes(m)}</strong></li>
              ))}
            </ul>
          </Card>
          <Card title="Last 30 days by activity">
            <ul className="list">
              {totals.byActivity.map(([a, m]) => (
                <li key={a} className="list-row"><span>{a}</span><strong>{formatMinutes(m)}</strong></li>
              ))}
            </ul>
          </Card>
        </div>
      )}

      <Card title={s.isAdmin ? 'Time logs' : 'My time logs'}>
        <Table
          rows={sortedLogs}
          rowKey={(l) => l.id}
          empty={logs.loading ? 'Loading…' : 'No time logged yet.'}
          columns={[
            { header: 'Date', cell: (l) => formatDate(l.date) },
            ...(s.isAdmin ? [{ header: 'Volunteer', cell: (l: WithId<VolunteerLog>) => s.memberName(l.volunteerUid) }] : []),
            { header: 'Time', cell: (l) => formatMinutes(l.minutes) },
            { header: 'Activity', cell: (l) => l.activity },
            { header: 'Patient', cell: (l) => (l.patientId ? <Link to={`/patients/${l.patientId}`}>{pName(l.patientId)}</Link> : <span className="muted">—</span>) },
            { header: 'Note', cell: (l) => <span className="small">{l.note ?? ''}</span> },
          ]}
        />
      </Card>
      {creating && <AssignmentModal onClose={() => setCreating(false)} />}
    </Page>
  );
}
