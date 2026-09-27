import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { orderBy, query, where } from 'firebase/firestore';
import type {
  BereavementContact,
  BereavementContactStatus,
  BereavementPlan,
  UpdateBereavementContactRequest,
  UpdateBereavementPlanRequest,
} from '@shared/types';
import { useOrgSession } from '../lib/session';
import { orgCol, type WithId } from '../lib/firestore';
import { useAction, useLiveQuery } from '../lib/hooks';
import { call } from '../lib/firebase';
import { BEREAVEMENT_RISKS, type BereavementRisk } from '../lib/constants';
import { addDaysISO, daysBetween, formatDate, formatInstant, optStr, todayISO } from '../lib/format';
import { Badge, Button, Card, ErrorBanner, Field, MemberSelect, Modal, Page, Table } from '../components/ui';

function contactState(c: BereavementContact, today: string): 'done' | 'skipped' | 'overdue' | 'week' | 'later' {
  if (c.status !== 'pending') return c.status;
  const diff = daysBetween(today, c.dueDate);
  if (diff < 0) return 'overdue';
  if (diff <= 7) return 'week';
  return 'later';
}

function ContactModal({
  plan,
  contact,
  status,
  onClose,
}: {
  plan: WithId<BereavementPlan>;
  contact: BereavementContact;
  status: BereavementContactStatus;
  onClose: () => void;
}) {
  const s = useOrgSession();
  const act = useAction();
  const [note, setNote] = useState(contact.note ?? '');
  async function submit() {
    const req: UpdateBereavementContactRequest = { orgId: s.orgId, planId: plan.id, contactId: contact.id, status };
    const n = optStr(note);
    if (n) req.note = n;
    if (await act.run(() => call<UpdateBereavementContactRequest, unknown>('updateBereavementContact', req))) onClose();
  }
  const verb = status === 'done' ? 'Mark done' : status === 'skipped' ? 'Skip' : 'Reopen';
  return (
    <Modal
      title={`${verb}: ${contact.label}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={act.busy} onClick={() => void submit()}>{verb}</Button>
        </>
      }
    >
      <ErrorBanner error={act.error} />
      <p className="muted">
        {plan.patientName} · {contact.type} · due {formatDate(contact.dueDate)}
      </p>
      <Field label="Note (optional)">
        <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </Modal>
  );
}

function PlanCard({ plan, canEdit }: { plan: WithId<BereavementPlan>; canEdit: boolean }) {
  const s = useOrgSession();
  const act = useAction();
  const [contactAction, setContactAction] = useState<{ contact: BereavementContact; status: BereavementContactStatus } | null>(null);
  const today = todayISO();
  const contacts = [...plan.contacts].sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  const updatePlan = (patch: Omit<UpdateBereavementPlanRequest, 'orgId' | 'planId'>) =>
    void act.run(() =>
      call<UpdateBereavementPlanRequest, unknown>('updateBereavementPlan', { orgId: s.orgId, planId: plan.id, ...patch }),
    );

  return (
    <Card
      title={plan.patientName}
      actions={
        <>
          <Badge value={plan.status} />
          <Badge value={plan.riskLevel}>{plan.riskLevel} risk</Badge>
          <Link to={`/patients/${plan.patientId}`}>Chart</Link>
        </>
      }
    >
      <ErrorBanner error={act.error} />
      <div className="row gap wrap small muted" style={{ marginBottom: 12 }}>
        <span>Died {formatDate(plan.deathDate)}</span>
        <span>Plan closes {formatDate(plan.closesOn)}</span>
        {plan.primaryContact && (
          <span>
            Primary contact: <strong>{plan.primaryContact.name}</strong>
            {plan.primaryContact.relationship && ` (${plan.primaryContact.relationship})`}
            {plan.primaryContact.phone && ` · ${plan.primaryContact.phone}`}
          </span>
        )}
      </div>
      {canEdit && (
        <div className="form-grid" style={{ marginBottom: 12 }}>
          <Field label="Coordinator">
            <MemberSelect
              members={s.members}
              value={plan.assignedUid ?? ''}
              onChange={(uid) => updatePlan({ assignedUid: uid || null })}
              placeholder="Unassigned"
            />
          </Field>
          <Field label="Risk level">
            <select value={plan.riskLevel} onChange={(e) => updatePlan({ riskLevel: e.target.value as BereavementRisk })}>
              {BEREAVEMENT_RISKS.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </Field>
          <Field label="Plan status">
            <select
              value={plan.status}
              onChange={(e) => {
                const st = e.target.value as 'active' | 'closed';
                if (st === 'closed' && !window.confirm('Close this bereavement plan?')) return;
                updatePlan({ status: st });
              }}
            >
              <option value="active">active</option>
              <option value="closed">closed</option>
            </select>
          </Field>
        </div>
      )}
      {!canEdit && <p className="small">Coordinator: {plan.assignedUid ? s.memberName(plan.assignedUid) : 'Unassigned'}</p>}
      <Table
        rows={contacts}
        rowKey={(c) => c.id}
        rowClassName={(c) => (contactState(c, today) === 'overdue' ? 'row-missed' : c.status !== 'pending' ? 'row-muted' : undefined)}
        exportName="bereavement-plan"
        columns={[
          { header: 'Due', csv: (c) => c.dueDate, cell: (c) => formatDate(c.dueDate) },
          { header: 'Contact', cell: (c) => <><strong>{c.label}</strong> <span className="muted small">{c.type}</span></> },
          {
            header: 'Status',
            csv: (c) => {
              const st = contactState(c, today);
              const label = st === 'overdue' ? 'overdue' : c.status;
              return [label, c.completedAt ? `${s.memberName(c.completedBy)} ${formatInstant(c.completedAt)}` : '', c.note ?? ''].filter(Boolean).join(' — ');
            },
            cell: (c) => {
              const st = contactState(c, today);
              return (
                <>
                  {st === 'overdue' ? <Badge tone="danger">overdue</Badge> : st === 'week' ? <Badge tone="warn">due this week</Badge> : <Badge value={c.status} tone={c.status === 'pending' ? 'neutral' : undefined} />}
                  {c.completedAt && <div className="muted small">{s.memberName(c.completedBy)} · {formatInstant(c.completedAt)}</div>}
                  {c.note && <div className="muted small">“{c.note}”</div>}
                </>
              );
            },
          },
          {
            header: '',
            className: 'actions',
            cell: (c) =>
              !canEdit || plan.status !== 'active' ? null : c.status === 'pending' ? (
                <div className="row gap-sm end">
                  <Button small variant="primary" onClick={() => setContactAction({ contact: c, status: 'done' })}>Done</Button>
                  <Button small variant="ghost" onClick={() => setContactAction({ contact: c, status: 'skipped' })}>Skip</Button>
                </div>
              ) : (
                <Button small variant="ghost" onClick={() => setContactAction({ contact: c, status: 'pending' })}>Reopen</Button>
              ),
          },
        ]}
      />
      {contactAction && (
        <ContactModal plan={plan} contact={contactAction.contact} status={contactAction.status} onClose={() => setContactAction(null)} />
      )}
    </Card>
  );
}

export default function BereavementPage() {
  const s = useOrgSession();
  const canEdit = s.role !== 'viewer';
  const [showClosed, setShowClosed] = useState(false);
  const [mineOnly, setMineOnly] = useState(false);
  const plans = useLiveQuery<BereavementPlan>(
    showClosed
      ? query(orgCol(s.orgId, 'bereavementPlans'), orderBy('deathDate', 'desc'))
      : query(orgCol(s.orgId, 'bereavementPlans'), where('status', '==', 'active')),
    [s.orgId, showClosed],
  );
  const today = todayISO();
  const weekEnd = addDaysISO(today, 7);

  const visible = useMemo(
    () =>
      plans.data
        .filter((p) => !mineOnly || p.assignedUid === s.user.uid)
        .sort((a, b) => (a.status === b.status ? b.deathDate.localeCompare(a.deathDate) : a.status === 'active' ? -1 : 1)),
    [plans.data, mineOnly, s.user.uid],
  );

  const due = useMemo(() => {
    const rows: { plan: WithId<BereavementPlan>; contact: BereavementContact; overdue: boolean }[] = [];
    for (const p of visible) {
      if (p.status !== 'active') continue;
      for (const c of p.contacts) {
        if (c.status !== 'pending') continue;
        if (c.dueDate < today) rows.push({ plan: p, contact: c, overdue: true });
        else if (c.dueDate <= weekEnd) rows.push({ plan: p, contact: c, overdue: false });
      }
    }
    return rows.sort((a, b) => a.contact.dueDate.localeCompare(b.contact.dueDate));
  }, [visible, today, weekEnd]);

  const overdueCount = due.filter((d) => d.overdue).length;

  return (
    <Page title="Bereavement">
      <ErrorBanner error={plans.error} />
      <div className="stats">
        <div className="stat"><div className="stat-value">{plans.loading ? '…' : visible.filter((p) => p.status === 'active').length}</div><div className="stat-label">Active plans</div></div>
        <div className="stat"><div className="stat-value">{due.length - overdueCount}</div><div className="stat-label">Contacts due this week</div></div>
        <div className="stat"><div className="stat-value stat-danger">{overdueCount}</div><div className="stat-label">Contacts overdue</div></div>
      </div>
      <div className="toolbar">
        <label className="row gap-sm small">
          <input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} /> Only plans assigned to me
        </label>
        <label className="row gap-sm small">
          <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} /> Include closed plans
        </label>
      </div>

      <Card title="Due this week and overdue">
        <Table
          rows={due}
          rowKey={(r) => `${r.plan.id}:${r.contact.id}`}
          empty="Nothing due in the next 7 days."
          rowClassName={(r) => (r.overdue ? 'row-missed' : undefined)}
          exportName="bereavement-due"
          columns={[
            { header: 'Due', csv: (r) => `${r.contact.dueDate}${r.overdue ? ' (overdue)' : ''}`, cell: (r) => <>{formatDate(r.contact.dueDate)} {r.overdue && <Badge tone="danger">overdue</Badge>}</> },
            { header: 'Family of', cell: (r) => r.plan.patientName },
            { header: 'Contact', cell: (r) => `${r.contact.label} (${r.contact.type})` },
            { header: 'Primary contact', cell: (r) => r.plan.primaryContact ? [r.plan.primaryContact.name, r.plan.primaryContact.phone].filter(Boolean).join(' · ') : '—' },
            { header: 'Coordinator', cell: (r) => (r.plan.assignedUid ? s.memberName(r.plan.assignedUid) : <span className="muted">Unassigned</span>) },
          ]}
        />
      </Card>

      {plans.loading && <p className="muted">Loading…</p>}
      {!plans.loading && visible.length === 0 && <p className="muted">No bereavement plans. Plans are created when a death is recorded.</p>}
      {visible.map((p) => <PlanCard key={p.id} plan={p} canEdit={canEdit} />)}
    </Page>
  );
}
