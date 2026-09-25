import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { limit, orderBy, query, where } from 'firebase/firestore';
import type {
  Alert,
  AlertActionRequest,
  AlertStatus,
  CreateAlertRequest,
  CreateAlertResponse,
  EscalationPolicy,
  OnCallRole,
  Patient,
  Priority,
} from '@shared/types';
import { useOrgSession } from '../lib/session';
import { orgCol, type WithId } from '../lib/firestore';
import { useLiveQuery } from '../lib/hooks';
import { call } from '../lib/firebase';
import { PRIORITIES } from '../lib/constants';
import { errorMessage, formatDate, formatInstant } from '../lib/format';
import { MILESTONE_LABELS } from '../lib/milestones';
import { patientName } from '../lib/patient';
import { Badge, Button, Card, ErrorBanner, Field, MemberPicker, Modal, Page } from '../components/ui';

function NewAlertModal({ onClose }: { onClose: () => void }) {
  const s = useOrgSession();
  const roles = useLiveQuery<OnCallRole>(query(orgCol(s.orgId, 'onCallRoles'), orderBy('label')), [s.orgId]);
  const policies = useLiveQuery<EscalationPolicy>(query(orgCol(s.orgId, 'escalationPolicies'), orderBy('name')), [s.orgId]);
  const patients = useLiveQuery<Patient>(
    query(orgCol(s.orgId, 'patients'), where('status', 'in', ['referral', 'admitted'])),
    [s.orgId],
  );
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [priority, setPriority] = useState<Priority>('urgent');
  const [targetMode, setTargetMode] = useState<'members' | 'role'>('members');
  const [targetUids, setTargetUids] = useState<string[]>([]);
  const [roleKey, setRoleKey] = useState('');
  const [policyId, setPolicyId] = useState('');
  const [patientId, setPatientId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (targetMode === 'members' && targetUids.length === 0) return setError('Choose at least one recipient.');
    if (targetMode === 'role' && !roleKey) return setError('Choose an on-call role.');
    setBusy(true);
    try {
      const req: CreateAlertRequest = { orgId: s.orgId, title: title.trim(), body: body.trim(), priority };
      if (targetMode === 'members') req.targetUids = targetUids;
      else req.roleKey = roleKey;
      if (policyId) req.policyId = policyId;
      if (patientId) req.patientId = patientId;
      await call<CreateAlertRequest, CreateAlertResponse>('createAlert', req);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  const sortedPatients = [...patients.data].sort((a, b) => patientName(a).localeCompare(patientName(b)));

  return (
    <Modal title="New alert" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <ErrorBanner error={error} />
        <Field label="Title">
          <input required maxLength={140} value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Details" hint="Push notifications never include this text.">
          <textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} />
        </Field>
        <div className="form-grid">
          <Field label="Priority">
            <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
              {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </Field>
          <Field label="Escalation policy">
            <select value={policyId} onChange={(e) => setPolicyId(e.target.value)}>
              <option value="">Org default</option>
              {policies.data.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Patient (optional)">
          <select value={patientId} onChange={(e) => setPatientId(e.target.value)}>
            <option value="">None</option>
            {sortedPatients.map((p) => <option key={p.id} value={p.id}>{patientName(p)}</option>)}
          </select>
        </Field>
        <div className="segmented">
          <button type="button" className={targetMode === 'members' ? 'active' : ''} onClick={() => setTargetMode('members')}>
            Specific members
          </button>
          <button type="button" className={targetMode === 'role' ? 'active' : ''} onClick={() => setTargetMode('role')}>
            On-call role
          </button>
        </div>
        {targetMode === 'members' ? (
          <MemberPicker members={s.members} value={targetUids} onChange={setTargetUids} />
        ) : (
          <select value={roleKey} onChange={(e) => setRoleKey(e.target.value)}>
            <option value="">Select role…</option>
            {roles.data.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select>
        )}
        <div className="row gap end">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" busy={busy}>Send alert</Button>
        </div>
      </form>
    </Modal>
  );
}

function AlertSourceLine({ a }: { a: Alert }) {
  const src = a.source;
  if (src.type === 'message') return <Link to={`/messages/${src.channelId}`}>From message</Link>;
  if (src.type === 'deadline')
    return (
      <Link to={`/patients/${src.patientId}`}>
        Deadline: {MILESTONE_LABELS[src.milestone] ?? src.milestone} due {formatDate(src.dueDate)}
      </Link>
    );
  return src.patientId ? <Link to={`/patients/${src.patientId}`}>Manual · patient</Link> : <span>Manual</span>;
}

function AlertCard({ a }: { a: WithId<Alert> }) {
  const s = useOrgSession();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const canAct = s.isAdmin || a.targetUids.includes(s.user.uid);

  async function act(name: 'ackAlert' | 'resolveAlert') {
    setBusy(name);
    setError(null);
    try {
      await call<AlertActionRequest, Record<string, never>>(name, { orgId: s.orgId, alertId: a.id });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className={`alert-card prio-${a.priority} status-${a.status}`}>
      <div className="alert-main">
        <div className="row gap-sm wrap">
          <Badge value={a.priority} />
          <Badge value={a.status} />
          {a.level > 0 && <Badge tone="warn">escalated · level {a.level}</Badge>}
          {a.exhausted && <Badge tone="danger">escalation exhausted</Badge>}
          <span className="muted small">{formatInstant(a.createdAt)}</span>
        </div>
        <h3>{a.title}</h3>
        {a.body && <p className="alert-body">{a.body}</p>}
        <div className="small muted">
          <AlertSourceLine a={a} /> · from {a.createdBy === 'system' ? 'system' : s.memberName(a.createdBy)} · notifying{' '}
          {a.currentTargetUids.map((u) => s.memberName(u)).join(', ') || '—'}
          {a.ackedBy && <> · acked by {s.memberName(a.ackedBy)} {formatInstant(a.ackedAt)}</>}
        </div>
        {a.history.length > 0 && (
          <button className="link small" onClick={() => setShowHistory(!showHistory)}>
            {showHistory ? 'Hide' : 'Show'} escalation history ({a.history.length})
          </button>
        )}
        {showHistory && (
          <ol className="history">
            {a.history.map((h, i) => (
              <li key={i}>
                Level {h.level} · {formatInstant(h.at)} → {h.targetUids.map((u) => s.memberName(u)).join(', ') || 'nobody'}
              </li>
            ))}
          </ol>
        )}
        <ErrorBanner error={error} />
      </div>
      {canAct && a.status !== 'resolved' && (
        <div className="alert-actions">
          {a.status === 'open' && (
            <Button variant="primary" small busy={busy === 'ackAlert'} onClick={() => void act('ackAlert')}>
              Acknowledge
            </Button>
          )}
          <Button small busy={busy === 'resolveAlert'} onClick={() => void act('resolveAlert')}>
            Resolve
          </Button>
        </div>
      )}
    </div>
  );
}

export default function AlertsPage() {
  const s = useOrgSession();
  const [status, setStatus] = useState<AlertStatus | 'all'>('open');
  const [scope, setScope] = useState<'mine' | 'all'>(s.isAdmin ? 'all' : 'mine');
  const [creating, setCreating] = useState(false);

  const alerts = useLiveQuery<Alert>(
    scope === 'all' && s.isAdmin
      ? query(orgCol(s.orgId, 'alerts'), orderBy('createdAt', 'desc'), limit(200))
      : query(
          orgCol(s.orgId, 'alerts'),
          where('targetUids', 'array-contains', s.user.uid),
          orderBy('createdAt', 'desc'),
          limit(200),
        ),
    [s.orgId, s.user.uid, scope, s.isAdmin],
  );

  const rows = useMemo(() => alerts.data.filter((a) => status === 'all' || a.status === status), [alerts.data, status]);
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: alerts.data.length };
    for (const a of alerts.data) c[a.status] = (c[a.status] ?? 0) + 1;
    return c;
  }, [alerts.data]);

  return (
    <Page
      title="Alerts"
      actions={s.role !== 'viewer' && <Button variant="primary" onClick={() => setCreating(true)}>New alert</Button>}
    >
      <ErrorBanner error={alerts.error} />
      <div className="toolbar">
        <div className="segmented">
          {(['open', 'acked', 'resolved', 'all'] as const).map((st) => (
            <button key={st} className={status === st ? 'active' : ''} onClick={() => setStatus(st)}>
              {st} <span className="count">{counts[st] ?? 0}</span>
            </button>
          ))}
        </div>
        {s.isAdmin && (
          <div className="segmented">
            <button className={scope === 'mine' ? 'active' : ''} onClick={() => setScope('mine')}>Targeting me</button>
            <button className={scope === 'all' ? 'active' : ''} onClick={() => setScope('all')}>All alerts</button>
          </div>
        )}
      </div>
      <Card>
        {alerts.loading ? (
          <p className="muted">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="muted">No {status === 'all' ? '' : status} alerts.</p>
        ) : (
          <div className="alert-list">
            {rows.map((a) => <AlertCard key={a.id} a={a} />)}
          </div>
        )}
      </Card>
      {creating && <NewAlertModal onClose={() => setCreating(false)} />}
    </Page>
  );
}

