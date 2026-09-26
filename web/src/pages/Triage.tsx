import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { limit, orderBy, query, where } from 'firebase/firestore';
import type {
  AssignTriageCallRequest,
  LogTriageCallRequest,
  LogTriageCallResponse,
  OnCallRole,
  ResolveTriageCallRequest,
  TriageCall,
  TriageDisposition,
  TriageUrgency,
} from '@shared/types';
import { useOrgSession } from '../lib/session';
import { orgCol, type WithId } from '../lib/firestore';
import { useAction, useLiveQuery } from '../lib/hooks';
import { usePatients } from '../lib/queries';
import { call } from '../lib/firebase';
import { CLINICAL_ROLES, TRIAGE_DISPOSITION_LABELS, TRIAGE_URGENCIES, orgSettings } from '../lib/constants';
import { formatInstant, optStr, tsMillis } from '../lib/format';
import { Badge, Button, Card, ErrorBanner, Field, MemberSelect, Modal, Page, PatientSelect, Table } from '../components/ui';

const URGENCY_RANK: Record<TriageUrgency, number> = { emergent: 0, urgent: 1, routine: 2 };

function LogCallModal({ roles, onClose }: { roles: WithId<OnCallRole>[]; onClose: () => void }) {
  const s = useOrgSession();
  const act = useAction();
  const patients = usePatients(s.orgId, ['admitted']);
  const defaultRole = orgSettings(s.org).triageRoleKey;
  const [patientId, setPatientId] = useState('');
  const [callerName, setCallerName] = useState('');
  const [callerRelationship, setRel] = useState('');
  const [callerPhone, setPhone] = useState('');
  const [reason, setReason] = useState('');
  const [symptoms, setSymptoms] = useState('');
  const [urgency, setUrgency] = useState<TriageUrgency>('routine');
  const [routing, setRouting] = useState<'default' | 'role' | 'member'>(defaultRole ? 'default' : 'role');
  const [roleKey, setRoleKey] = useState('');
  const [assignedUid, setAssignedUid] = useState('');
  const [result, setResult] = useState<LogTriageCallResponse | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (routing === 'role' && !roleKey) return act.setError('Choose an on-call role.');
    if (routing === 'member' && !assignedUid) return act.setError('Choose a member.');
    const req: LogTriageCallRequest = {
      orgId: s.orgId,
      callerName: callerName.trim(),
      reason: reason.trim(),
      urgency,
      symptoms: symptoms.split(/[,\n]/).map((x) => x.trim()).filter(Boolean),
    };
    if (patientId) req.patientId = patientId;
    const rel = optStr(callerRelationship);
    if (rel) req.callerRelationship = rel;
    const ph = optStr(callerPhone);
    if (ph) req.callerPhone = ph;
    if (routing === 'role') req.roleKey = roleKey;
    if (routing === 'member') req.assignedUid = assignedUid;
    let res: LogTriageCallResponse | null = null;
    const ok = await act.run(async () => {
      res = await call<LogTriageCallRequest, LogTriageCallResponse>('logTriageCall', req);
    });
    if (ok) setResult(res);
  }

  if (result) {
    return (
      <Modal title="Call logged" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
        <p>
          {result.assignedUid ? <>Routed to <strong>{s.memberName(result.assignedUid)}</strong>.</> : <>Nobody could be resolved as on call — assign the call from the queue.</>}
        </p>
        {result.alertId && <p><Badge tone="danger">alert raised</Badge> An escalating alert was sent to the on-call clinician.</p>}
      </Modal>
    );
  }

  return (
    <Modal title="Log triage call" onClose={onClose} wide>
      <form className="form" onSubmit={submit}>
        <ErrorBanner error={act.error ?? patients.error} />
        <div className="form-grid">
          <Field label="Patient (optional)">
            <PatientSelect patients={patients.data} value={patientId} onChange={setPatientId} placeholder="Unknown / not a patient" />
          </Field>
          <Field label="Urgency">
            <select value={urgency} onChange={(e) => setUrgency(e.target.value as TriageUrgency)}>
              {TRIAGE_URGENCIES.map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
          </Field>
          <Field label="Caller name">
            <input required value={callerName} onChange={(e) => setCallerName(e.target.value)} />
          </Field>
          <Field label="Relationship">
            <input value={callerRelationship} onChange={(e) => setRel(e.target.value)} placeholder="Daughter, facility nurse…" />
          </Field>
          <Field label="Callback phone">
            <input type="tel" value={callerPhone} onChange={(e) => setPhone(e.target.value)} />
          </Field>
        </div>
        <Field label="Reason for call">
          <textarea rows={3} required value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <Field label="Symptoms" hint="Comma-separated, e.g. pain, dyspnea, agitation">
          <input value={symptoms} onChange={(e) => setSymptoms(e.target.value)} />
        </Field>
        <Field label="Route to">
          <div className="segmented">
            <button type="button" className={routing === 'default' ? 'active' : ''} disabled={!defaultRole} onClick={() => setRouting('default')}>
              Default triage role
            </button>
            <button type="button" className={routing === 'role' ? 'active' : ''} onClick={() => setRouting('role')}>On-call role</button>
            <button type="button" className={routing === 'member' ? 'active' : ''} onClick={() => setRouting('member')}>Specific member</button>
          </div>
        </Field>
        {routing === 'default' && defaultRole && (
          <p className="muted small">Routes to whoever is on call for {roles.find((r) => r.id === defaultRole)?.label ?? defaultRole}.</p>
        )}
        {!defaultRole && routing !== 'member' && (
          <p className="muted small">No default triage role is configured (Settings). Choose a role or a member.</p>
        )}
        {routing === 'role' && (
          <Field label="On-call role">
            <select value={roleKey} onChange={(e) => setRoleKey(e.target.value)} required>
              <option value="">Select role…</option>
              {roles.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
          </Field>
        )}
        {routing === 'member' && (
          <Field label="Assign to">
            <MemberSelect members={s.members} value={assignedUid} onChange={setAssignedUid} required />
          </Field>
        )}
        {urgency !== 'routine' && (
          <div className="banner banner-warn">An {urgency === 'emergent' ? 'critical' : 'urgent'} escalating alert will be raised to the on-call clinician.</div>
        )}
        <div className="row gap end">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant={urgency === 'routine' ? 'primary' : 'danger'} busy={act.busy}>Log call</Button>
        </div>
      </form>
    </Modal>
  );
}

function AssignModal({ tc, onClose }: { tc: WithId<TriageCall>; onClose: () => void }) {
  const s = useOrgSession();
  const act = useAction();
  const [uid, setUid] = useState(tc.assignedUid ?? '');
  async function submit() {
    if (!uid) return act.setError('Choose a member.');
    if (await act.run(() => call<AssignTriageCallRequest, unknown>('assignTriageCall', { orgId: s.orgId, callId: tc.id, assignedUid: uid }))) onClose();
  }
  return (
    <Modal
      title="Assign call"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={act.busy} onClick={() => void submit()}>Assign</Button>
        </>
      }
    >
      <ErrorBanner error={act.error} />
      <Field label="Assign to">
        <MemberSelect members={s.members} value={uid} onChange={setUid} required />
      </Field>
    </Modal>
  );
}

function ResolveModal({ tc, onClose }: { tc: WithId<TriageCall>; onClose: () => void }) {
  const s = useOrgSession();
  const act = useAction();
  const [disposition, setDisposition] = useState<TriageDisposition | ''>('');
  const [note, setNote] = useState('');
  const [followUp, setFollowUp] = useState(false);
  const [taskTitle, setTaskTitle] = useState('');
  const [taskAssignee, setTaskAssignee] = useState('');
  const [taskDue, setTaskDue] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!disposition) return act.setError('Choose a disposition.');
    const req: ResolveTriageCallRequest = { orgId: s.orgId, callId: tc.id, disposition };
    const n = optStr(note);
    if (n) req.dispositionNote = n;
    if (followUp) {
      if (!taskTitle.trim()) return act.setError('Follow-up task needs a title.');
      req.followUpTask = { title: taskTitle.trim() };
      if (taskAssignee) req.followUpTask.assigneeUid = taskAssignee;
      if (taskDue) req.followUpTask.dueDate = taskDue;
    }
    if (await act.run(() => call<ResolveTriageCallRequest, unknown>('resolveTriageCall', req))) onClose();
  }

  return (
    <Modal title="Resolve call" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <ErrorBanner error={act.error} />
        <p className="muted">{tc.callerName}{tc.patientName ? ` re: ${tc.patientName}` : ''} — {tc.reason}</p>
        <Field label="Disposition">
          <select required value={disposition} onChange={(e) => setDisposition(e.target.value as TriageDisposition)}>
            <option value="">Select…</option>
            {(Object.keys(TRIAGE_DISPOSITION_LABELS) as TriageDisposition[]).map((d) => (
              <option key={d} value={d}>{TRIAGE_DISPOSITION_LABELS[d]}</option>
            ))}
          </select>
        </Field>
        <Field label="Note">
          <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <label className="row gap-sm">
          <input type="checkbox" checked={followUp} onChange={(e) => setFollowUp(e.target.checked)} /> Create a follow-up task
        </label>
        {followUp && (
          <div className="form-grid">
            <Field label="Task title">
              <input required value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} />
            </Field>
            <Field label="Assignee">
              <MemberSelect members={s.members} value={taskAssignee} onChange={setTaskAssignee} placeholder="Unassigned" />
            </Field>
            <Field label="Due date">
              <input type="date" value={taskDue} onChange={(e) => setTaskDue(e.target.value)} />
            </Field>
          </div>
        )}
        <div className="row gap end">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" busy={act.busy}>Resolve</Button>
        </div>
      </form>
    </Modal>
  );
}

export default function TriagePage() {
  const s = useOrgSession();
  const clinical = CLINICAL_ROLES.includes(s.role);
  const roles = useLiveQuery<OnCallRole>(query(orgCol(s.orgId, 'onCallRoles'), orderBy('label')), [s.orgId]);
  const openCalls = useLiveQuery<TriageCall>(query(orgCol(s.orgId, 'triageCalls'), where('status', '==', 'open')), [s.orgId]);
  const recent = useLiveQuery<TriageCall>(query(orgCol(s.orgId, 'triageCalls'), orderBy('receivedAt', 'desc'), limit(50)), [s.orgId]);
  const [logging, setLogging] = useState(false);
  const [assigning, setAssigning] = useState<WithId<TriageCall> | null>(null);
  const [resolving, setResolving] = useState<WithId<TriageCall> | null>(null);
  const [mineOnly, setMineOnly] = useState(false);

  const queue = useMemo(
    () =>
      openCalls.data
        .filter((c) => !mineOnly || c.assignedUid === s.user.uid)
        .sort((a, b) => URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency] || tsMillis(a.receivedAt) - tsMillis(b.receivedAt)),
    [openCalls.data, mineOnly, s.user.uid],
  );
  const resolved = recent.data.filter((c) => c.status === 'resolved');
  const roleLabel = (k: string | null) => (k ? roles.data.find((r) => r.id === k)?.label ?? k : null);

  return (
    <Page title="After-hours triage" actions={clinical && <Button variant="primary" onClick={() => setLogging(true)}>Log call</Button>}>
      <ErrorBanner error={openCalls.error ?? recent.error ?? roles.error} />
      <Card
        title={`Open calls (${queue.length})`}
        actions={
          <label className="row gap-sm small">
            <input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} /> Assigned to me
          </label>
        }
      >
        <Table
          rows={queue}
          rowKey={(c) => c.id}
          empty={openCalls.loading ? 'Loading…' : 'No open calls.'}
          rowClassName={(c) => (c.urgency === 'emergent' ? 'row-missed' : undefined)}
          columns={[
            { header: 'Received', cell: (c) => <>{formatInstant(c.receivedAt)}<div className="muted small">by {s.memberName(c.receivedBy)}</div></> },
            { header: 'Urgency', cell: (c) => <Badge value={c.urgency} /> },
            {
              header: 'Caller',
              cell: (c) => (
                <>
                  <strong>{c.callerName}</strong>
                  {c.callerRelationship && <span className="muted"> ({c.callerRelationship})</span>}
                  {c.callerPhone && <div className="small">{c.callerPhone}</div>}
                </>
              ),
            },
            { header: 'Patient', cell: (c) => (c.patientId ? <Link to={`/patients/${c.patientId}`}>{c.patientName ?? 'Patient'}</Link> : <span className="muted">—</span>) },
            {
              header: 'Reason',
              cell: (c) => (
                <>
                  <div className="clamp">{c.reason}</div>
                  {c.symptoms.length > 0 && <div className="muted small">{c.symptoms.join(', ')}</div>}
                </>
              ),
            },
            {
              header: 'Assigned',
              cell: (c) => (
                <>
                  {c.assignedUid ? s.memberName(c.assignedUid) : <Badge tone="warn">unassigned</Badge>}
                  {c.roleKey && <div className="muted small">{roleLabel(c.roleKey)}</div>}
                  {c.alertId && <div><span className="tag">alert</span></div>}
                </>
              ),
            },
            {
              header: '',
              className: 'actions',
              cell: (c) =>
                clinical && (
                  <div className="row gap-sm end">
                    <Button small onClick={() => setAssigning(c)}>Assign</Button>
                    <Button small variant="primary" onClick={() => setResolving(c)}>Resolve</Button>
                  </div>
                ),
            },
          ]}
        />
      </Card>
      <Card title="Recently resolved">
        <Table
          rows={resolved}
          rowKey={(c) => c.id}
          empty="No resolved calls yet."
          columns={[
            { header: 'Received', cell: (c) => formatInstant(c.receivedAt) },
            { header: 'Urgency', cell: (c) => <Badge value={c.urgency} /> },
            { header: 'Caller', cell: (c) => c.callerName },
            { header: 'Patient', cell: (c) => (c.patientId ? <Link to={`/patients/${c.patientId}`}>{c.patientName ?? 'Patient'}</Link> : '—') },
            { header: 'Disposition', cell: (c) => (c.disposition ? TRIAGE_DISPOSITION_LABELS[c.disposition] : '—') },
            { header: 'Note', cell: (c) => <span className="small">{c.dispositionNote ?? ''}</span> },
            { header: 'Resolved', cell: (c) => <>{formatInstant(c.resolvedAt)}<div className="muted small">{s.memberName(c.resolvedBy)}</div></> },
          ]}
        />
      </Card>
      {logging && <LogCallModal roles={roles.data} onClose={() => setLogging(false)} />}
      {assigning && <AssignModal tc={assigning} onClose={() => setAssigning(null)} />}
      {resolving && <ResolveModal tc={resolving} onClose={() => setResolving(null)} />}
    </Page>
  );
}
