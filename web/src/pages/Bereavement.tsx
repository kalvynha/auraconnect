import { useEffect, useMemo, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { limit, orderBy, query, updateDoc, where } from 'firebase/firestore';
import type {
  Address,
  BereavementContact,
  BereavementContactStatus,
  BereavementContactType,
  BereavementMailingRow,
  BereavementPlan,
  BereavementRisk,
  BereavementSurvivor,
  ExportBereavementMailingRequest,
  ExportBereavementMailingResponse,
  ReassessBereavementRiskRequest,
  ReassessBereavementRiskResponse,
  SurvivorPreferredContact,
  UpdateBereavementContactRequest,
  UpdateBereavementContactsRequest,
  UpdateBereavementContactsResponse,
  UpdateBereavementPlanRequest,
} from '@shared/types';
import { useOrgSession, type OrgSession } from '../lib/session';
import { orgCol, orgDoc, type WithId } from '../lib/firestore';
import { useAction, useLiveDoc, useLiveQuery } from '../lib/hooks';
import { call } from '../lib/firebase';
import { BEREAVEMENT_RISKS } from '../lib/constants';
import { csvFileName, downloadCsv, toCsv, type CsvColumn } from '../lib/csv';
import { addDaysISO, daysBetween, formatDate, formatInstant, optStr, todayISO } from '../lib/format';
import { emptyAddress } from '../lib/patient';
import { Badge, Button, Card, ErrorBanner, Field, MemberSelect, Modal, Page, Table, Tabs } from '../components/ui';

/** Active plans are loaded in one bounded live query (~450 at census 100). */
const ACTIVE_LIMIT = 1000;
/** Closed plans are paged from the server. */
const CLOSED_PAGE = 100;
/** Rows per page in the plan tables. */
const TABLE_PAGE = 25;
/** `updateBereavementContacts` accepts at most this many contacts per call. */
const BULK_MAX = 200;
const MAILING_TYPES: BereavementContactType[] = ['letter', 'mailing'];

type Plan = WithId<BereavementPlan>;

// ---------------------------------------------------------------------------
// Permissions (mirror of functions/src/domain/bereavement.ts canWorkBereavementPlan)
// ---------------------------------------------------------------------------

function canWorkAll(s: OrgSession): boolean {
  const m = s.member;
  return s.isAdmin || !!m?.capabilities?.includes('bereavement') || m?.discipline === 'SW' || m?.discipline === 'Chaplain';
}

function canWork(s: OrgSession, plan: Pick<BereavementPlan, 'assignedUid'>): boolean {
  return canWorkAll(s) || (!!plan.assignedUid && plan.assignedUid === s.user.uid);
}

function contactState(c: BereavementContact, today: string): 'done' | 'skipped' | 'overdue' | 'week' | 'later' {
  if (c.status !== 'pending') return c.status;
  const diff = daysBetween(today, c.dueDate);
  if (diff < 0) return 'overdue';
  if (diff <= 7) return 'week';
  return 'later';
}

function planSurvivors(plan: BereavementPlan): BereavementSurvivor[] {
  if (Array.isArray(plan.survivors)) return plan.survivors;
  const c = plan.primaryContact;
  if (!c) return [];
  return [{
    id: 'primary', name: c.name, relationship: c.relationship, phone: c.phone, email: c.email ?? null,
    address: c.address ?? emptyAddress(), preferredContact: 'phone', doNotContact: false, isPrimary: true,
  }];
}

function nextPending(plan: BereavementPlan): BereavementContact | null {
  return [...plan.contacts].filter((c) => c.status === 'pending').sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0] ?? null;
}

function formatAddress(a: Address | null | undefined): string {
  if (!a) return '';
  return [a.line1, a.line2, [a.city, a.state].filter(Boolean).join(', '), a.zip].filter(Boolean).join(' · ');
}

/** Client-side pager over already-loaded rows. */
function usePager<T>(rows: T[], size = TABLE_PAGE) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(rows.length / size));
  useEffect(() => {
    if (page > pages - 1) setPage(pages - 1);
  }, [page, pages]);
  const cur = Math.min(page, pages - 1);
  return { page: cur, pages, setPage, slice: rows.slice(cur * size, cur * size + size) };
}

function Pager({ page, pages, setPage, total, extra }: { page: number; pages: number; setPage: (n: number) => void; total: number; extra?: ReactNode }) {
  return (
    <div className="row gap-sm end no-print" style={{ marginTop: 8 }}>
      <span className="muted small">{total} total · page {page + 1} of {pages}</span>
      <Button small disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</Button>
      <Button small disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>Next</Button>
      {extra}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Contact actions
// ---------------------------------------------------------------------------

function ContactModal({ plan, contact, status, onClose }: { plan: Plan; contact: BereavementContact; status: BereavementContactStatus; onClose: () => void }) {
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
      <p className="muted">{plan.patientName} · {contact.type} · due {formatDate(contact.dueDate)}</p>
      <Field label="Note (optional)">
        <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </Modal>
  );
}

function BulkModal({ items, status, onClose, onDone }: {
  items: { planId: string; contactId: string }[];
  status: Exclude<BereavementContactStatus, 'pending'>;
  onClose: () => void;
  onDone: (res: UpdateBereavementContactsResponse) => void;
}) {
  const s = useOrgSession();
  const act = useAction();
  const [note, setNote] = useState('');
  async function submit() {
    const total: UpdateBereavementContactsResponse = { updated: 0, failed: [] };
    const ok = await act.run(async () => {
      for (let i = 0; i < items.length; i += BULK_MAX) {
        const req: UpdateBereavementContactsRequest = { orgId: s.orgId, items: items.slice(i, i + BULK_MAX), status };
        const n = optStr(note);
        if (n) req.note = n;
        const res = await call<UpdateBereavementContactsRequest, UpdateBereavementContactsResponse>('updateBereavementContacts', req);
        total.updated += res.updated;
        total.failed.push(...res.failed);
      }
    });
    if (ok) onDone(total);
  }
  const verb = status === 'done' ? 'Mark done' : 'Skip';
  return (
    <Modal
      title={`${verb}: ${items.length} contact${items.length === 1 ? '' : 's'}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={act.busy} onClick={() => void submit()}>{verb}</Button>
        </>
      }
    >
      <ErrorBanner error={act.error} />
      <Field label="Note for every selected contact (optional)">
        <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder={status === 'done' ? 'e.g. Letter mailed' : 'e.g. Family declined'} />
      </Field>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Survivors
// ---------------------------------------------------------------------------

function blankSurvivor(): BereavementSurvivor {
  return { id: '', name: '', relationship: null, phone: null, email: null, address: emptyAddress(), preferredContact: 'mail', doNotContact: false, isPrimary: false };
}

function SurvivorEditor({ plan, onClose }: { plan: Plan; onClose: () => void }) {
  const s = useOrgSession();
  const act = useAction();
  const [list, setList] = useState<BereavementSurvivor[]>(() => planSurvivors(plan).map((x) => ({ ...x, address: { ...emptyAddress(), ...x.address } })));
  const set = (i: number, patch: Partial<BereavementSurvivor>) => setList((l) => l.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const setAddr = (i: number, patch: Partial<Address>) => setList((l) => l.map((x, j) => (j === i ? { ...x, address: { ...x.address, ...patch } } : x)));
  const txt = (v: string) => (v.trim() ? v : null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (list.some((x) => !x.name.trim())) return act.setError('Every survivor needs a name.');
    if (list.some((x) => x.preferredContact === 'email' && !x.email?.trim())) return act.setError('A survivor who prefers email needs an email address.');
    const survivors = list.map((x) => ({ ...x, id: x.id || undefined })) as unknown as BereavementSurvivor[];
    const req: UpdateBereavementPlanRequest = { orgId: s.orgId, planId: plan.id, survivors };
    if (await act.run(() => call<UpdateBereavementPlanRequest, unknown>('updateBereavementPlan', req))) onClose();
  }

  return (
    <Modal title={`Survivors: family of ${plan.patientName}`} onClose={onClose} wide>
      <form className="form" onSubmit={submit}>
        <ErrorBanner error={act.error} />
        {list.length === 0 && <p className="muted">No survivors yet.</p>}
        {list.map((x, i) => (
          <fieldset key={i} className="card" style={{ padding: 12 }}>
            <div className="form-grid">
              <Field label="Name"><input required maxLength={200} value={x.name} onChange={(e) => set(i, { name: e.target.value })} /></Field>
              <Field label="Relationship"><input maxLength={100} value={x.relationship ?? ''} onChange={(e) => set(i, { relationship: txt(e.target.value) })} /></Field>
              <Field label="Phone"><input maxLength={40} value={x.phone ?? ''} onChange={(e) => set(i, { phone: txt(e.target.value) })} /></Field>
              <Field label="Email"><input type="email" maxLength={200} value={x.email ?? ''} onChange={(e) => set(i, { email: txt(e.target.value) })} /></Field>
              <Field label="Address line 1"><input maxLength={200} value={x.address.line1 ?? ''} onChange={(e) => setAddr(i, { line1: txt(e.target.value) })} /></Field>
              <Field label="Address line 2"><input maxLength={200} value={x.address.line2 ?? ''} onChange={(e) => setAddr(i, { line2: txt(e.target.value) })} /></Field>
              <Field label="City"><input maxLength={100} value={x.address.city ?? ''} onChange={(e) => setAddr(i, { city: txt(e.target.value) })} /></Field>
              <Field label="State"><input maxLength={50} value={x.address.state ?? ''} onChange={(e) => setAddr(i, { state: txt(e.target.value) })} /></Field>
              <Field label="ZIP"><input maxLength={20} value={x.address.zip ?? ''} onChange={(e) => setAddr(i, { zip: txt(e.target.value) })} /></Field>
              <Field label="Preferred contact">
                <select value={x.preferredContact} onChange={(e) => set(i, { preferredContact: e.target.value as SurvivorPreferredContact })}>
                  <option value="mail">Mail</option>
                  <option value="email">Email</option>
                  <option value="phone">Phone only (no mailings)</option>
                </select>
              </Field>
            </div>
            <div className="row gap wrap small" style={{ marginTop: 8 }}>
              <label className="row gap-sm">
                <input type="radio" name="primary" checked={x.isPrimary} onChange={() => setList((l) => l.map((y, j) => ({ ...y, isPrimary: j === i })))} /> Primary contact
              </label>
              <label className="row gap-sm">
                <input type="checkbox" checked={x.doNotContact} onChange={(e) => set(i, { doNotContact: e.target.checked })} /> Do not contact
              </label>
              <Button small variant="ghost" onClick={() => setList((l) => l.filter((_, j) => j !== i))}>Remove</Button>
            </div>
          </fieldset>
        ))}
        <div className="row gap space-between">
          <Button onClick={() => setList((l) => [...l, blankSurvivor()])} disabled={list.length >= 20}>Add survivor</Button>
          <div className="row gap">
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" busy={act.busy}>Save survivors</Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

function ReassessModal({ plan, onClose }: { plan: Plan; onClose: () => void }) {
  const s = useOrgSession();
  const act = useAction();
  const [level, setLevel] = useState<BereavementRisk>(plan.riskLevel);
  const [note, setNote] = useState('');
  const [added, setAdded] = useState<string[] | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!note.trim()) return act.setError('Describe the reassessment.');
    await act.run(async () => {
      const res = await call<ReassessBereavementRiskRequest, ReassessBereavementRiskResponse>('reassessBereavementRisk', { orgId: s.orgId, planId: plan.id, level, note: note.trim() });
      setAdded(res.addedContactIds);
    });
  }
  return (
    <Modal title={`Reassess risk: ${plan.patientName}`} onClose={onClose}>
      {added ? (
        <>
          <div className="banner banner-ok">
            Reassessment recorded.{added.length > 0 && ` ${added.length} high-risk contact${added.length === 1 ? ' was' : 's were'} added (SW visit, monthly calls).`}
          </div>
          <div className="row end"><Button variant="primary" onClick={onClose}>Close</Button></div>
        </>
      ) : (
        <form className="form" onSubmit={submit}>
          <ErrorBanner error={act.error} />
          <Field label="Risk level" hint="High adds an SW visit at 2 weeks and monthly calls for the first 3 months.">
            <select value={level} onChange={(e) => setLevel(e.target.value as BereavementRisk)}>
              {BEREAVEMENT_RISKS.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </Field>
          <Field label="Reassessment note">
            <textarea rows={3} required maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <div className="row gap end">
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" busy={act.busy}>Record reassessment</Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Plan detail drawer
// ---------------------------------------------------------------------------

const drawerBackdrop: CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.25)', zIndex: 40 };
const drawerPanel: CSSProperties = {
  position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(760px, 100vw)', background: 'var(--surface)',
  boxShadow: '-8px 0 30px rgba(0,0,0,0.15)', zIndex: 41, overflowY: 'auto', padding: 20,
};

function PlanDrawer({ plan, onClose }: { plan: Plan; onClose: () => void }) {
  const s = useOrgSession();
  const act = useAction();
  const [contactAction, setContactAction] = useState<{ contact: BereavementContact; status: BereavementContactStatus } | null>(null);
  const [editSurvivors, setEditSurvivors] = useState(false);
  const [reassess, setReassess] = useState(false);
  const editable = canWork(s, plan);
  const active = plan.status === 'active';
  const today = todayISO();
  const contacts = [...plan.contacts].sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const survivors = planSurvivors(plan);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !contactAction && !editSurvivors && !reassess && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, contactAction, editSurvivors, reassess]);

  const updatePlan = (patch: Omit<UpdateBereavementPlanRequest, 'orgId' | 'planId'>) =>
    void act.run(() => call<UpdateBereavementPlanRequest, unknown>('updateBereavementPlan', { orgId: s.orgId, planId: plan.id, ...patch }));

  return (
    <>
      <div style={drawerBackdrop} onMouseDown={onClose} />
      <aside style={drawerPanel} role="dialog" aria-modal="true" aria-label={`Bereavement plan: ${plan.patientName}`}>
        <div className="row gap space-between" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>{plan.patientName}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">×</button>
        </div>
        <ErrorBanner error={act.error} />
        <div className="row gap wrap small muted" style={{ marginBottom: 12 }}>
          <Badge value={plan.status} />
          <Badge value={plan.riskLevel}>{plan.riskLevel} risk</Badge>
          {plan.needsReview && <Badge tone="warn">needs review</Badge>}
          <span>Died {formatDate(plan.deathDate)}</span>
          <span>Closes {formatDate(plan.closesOn)}</span>
          <Link to={`/patients/${plan.patientId}`}>Chart</Link>
        </div>
        {plan.needsReview && active && (
          <div className="banner banner-warn">This plan passed its 13-month close date with contacts still pending. Mark them done or skipped; the plan then closes automatically overnight.</div>
        )}

        {editable ? (
          <div className="form-grid" style={{ marginBottom: 12 }}>
            <Field label="Coordinator">
              <MemberSelect members={s.members.filter((m) => m.discipline !== 'Volunteer')} value={plan.assignedUid ?? ''} onChange={(uid) => updatePlan({ assignedUid: uid || null })} placeholder="Unassigned" />
            </Field>
            <Field label="Risk level">
              <div className="row gap-sm">
                <Badge value={plan.riskLevel}>{plan.riskLevel}</Badge>
                {active && <Button small onClick={() => setReassess(true)}>Reassess…</Button>}
              </div>
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
        ) : (
          <p className="small">Coordinator: {plan.assignedUid ? s.memberName(plan.assignedUid) : 'Unassigned'}. Only the coordinator, a social worker or chaplain, or someone with the bereavement permission can change this plan.</p>
        )}

        <Card title="Survivors" actions={editable && <Button small onClick={() => setEditSurvivors(true)}>Edit survivors</Button>}>
          <Table
            rows={survivors}
            rowKey={(x) => x.id}
            empty="No survivors recorded."
            rowClassName={(x) => (x.doNotContact ? 'row-muted' : undefined)}
            columns={[
              { header: 'Name', cell: (x) => <><strong>{x.name}</strong>{x.isPrimary && <> <Badge tone="info">primary</Badge></>}</> },
              { header: 'Relationship', cell: (x) => x.relationship ?? '—' },
              { header: 'Contact', cell: (x) => [x.phone, x.email].filter(Boolean).join(' · ') || '—' },
              { header: 'Address', cell: (x) => <span className="small">{formatAddress(x.address) || '—'}</span> },
              { header: 'Prefers', cell: (x) => (x.doNotContact ? <Badge tone="danger">do not contact</Badge> : x.preferredContact) },
            ]}
          />
        </Card>

        <Card title="Contact schedule">
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
                csv: (c) => [c.status, c.completedAt ? `${s.memberName(c.completedBy)} ${formatInstant(c.completedAt)}` : '', c.note ?? ''].filter(Boolean).join(' — '),
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
                  !editable || !active ? null : c.status === 'pending' ? (
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
        </Card>

        {(plan.riskHistory?.length ?? 0) > 0 && (
          <Card title="Risk history">
            <ul className="list">
              {[...(plan.riskHistory ?? [])].reverse().map((h, i) => (
                <li key={i} className="list-row">
                  <span>
                    <Badge value={h.previous}>{h.previous}</Badge> → <Badge value={h.level}>{h.level}</Badge>
                    {h.note && <span className="small"> “{h.note}”</span>}
                  </span>
                  <span className="muted small">{s.memberName(h.by)} · {formatInstant(h.at)}</span>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </aside>
      {contactAction && <ContactModal plan={plan} contact={contactAction.contact} status={contactAction.status} onClose={() => setContactAction(null)} />}
      {editSurvivors && <SurvivorEditor plan={plan} onClose={() => setEditSurvivors(false)} />}
      {reassess && <ReassessModal plan={plan} onClose={() => setReassess(false)} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Plan table (active and closed)
// ---------------------------------------------------------------------------

function PlanTable({ plans, onOpen, extra, exportName }: { plans: Plan[]; onOpen: (p: Plan) => void; extra?: ReactNode; exportName: string }) {
  const s = useOrgSession();
  const pager = usePager(plans);
  const today = todayISO();
  return (
    <>
      <Table
        rows={pager.slice}
        rowKey={(p) => p.id}
        onRowClick={onOpen}
        empty="No plans."
        exportName={exportName}
        rowClassName={(p) => (p.needsReview ? 'row-missed' : undefined)}
        columns={[
          { header: 'Family of', cell: (p) => <strong>{p.patientName}</strong> },
          { header: 'Died', csv: (p) => p.deathDate, cell: (p) => formatDate(p.deathDate) },
          { header: 'Risk', csv: (p) => p.riskLevel, cell: (p) => <Badge value={p.riskLevel} /> },
          { header: 'Coordinator', cell: (p) => (p.assignedUid ? s.memberName(p.assignedUid) : <span className="muted">Unassigned</span>) },
          {
            header: 'Next contact',
            csv: (p) => nextPending(p)?.dueDate ?? '',
            cell: (p) => {
              const n = nextPending(p);
              if (!n) return <span className="muted">—</span>;
              return <>{formatDate(n.dueDate)} <span className="muted small">{n.label}</span>{n.dueDate < today && <> <Badge tone="danger">overdue</Badge></>}</>;
            },
          },
          { header: 'Pending', csv: (p) => String(p.contacts.filter((c) => c.status === 'pending').length), cell: (p) => p.contacts.filter((c) => c.status === 'pending').length },
          { header: 'Status', csv: (p) => (p.needsReview ? `${p.status} (needs review)` : p.status), cell: (p) => <>{<Badge value={p.status} />}{p.needsReview && <> <Badge tone="warn">needs review</Badge></>}</> },
        ]}
      />
      <Pager page={pager.page} pages={pager.pages} setPage={pager.setPage} total={plans.length} extra={extra} />
    </>
  );
}

interface DueRow {
  key: string;
  plan: Plan;
  contact: BereavementContact;
  overdue: boolean;
}

function ActiveTab({ onOpen }: { onOpen: (p: Plan) => void }) {
  const s = useOrgSession();
  const [mineOnly, setMineOnly] = useState(false);
  const [reviewOnly, setReviewOnly] = useState(false);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState<'done' | 'skipped' | null>(null);
  const [result, setResult] = useState<UpdateBereavementContactsResponse | null>(null);
  const plans = useLiveQuery<BereavementPlan>(
    query(orgCol(s.orgId, 'bereavementPlans'), where('status', '==', 'active'), orderBy('deathDate', 'desc'), limit(ACTIVE_LIMIT)),
    [s.orgId],
  );
  const today = todayISO();
  const weekEnd = addDaysISO(today, 7);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return plans.data.filter(
      (p) => (!mineOnly || p.assignedUid === s.user.uid) && (!reviewOnly || p.needsReview) && (!q || p.patientName.toLowerCase().includes(q)),
    );
  }, [plans.data, mineOnly, reviewOnly, search, s.user.uid]);

  const due = useMemo(() => {
    const rows: DueRow[] = [];
    for (const p of visible) {
      for (const c of p.contacts) {
        if (c.status !== 'pending' || c.dueDate > weekEnd) continue;
        rows.push({ key: `${p.id}:${c.id}`, plan: p, contact: c, overdue: c.dueDate < today });
      }
    }
    return rows.sort((a, b) => a.contact.dueDate.localeCompare(b.contact.dueDate) || a.plan.patientName.localeCompare(b.plan.patientName));
  }, [visible, today, weekEnd]);

  // Drop selections that are no longer due (e.g. completed elsewhere).
  useEffect(() => {
    setSelected((sel) => {
      const keys = new Set(due.map((d) => d.key));
      const next = new Set([...sel].filter((k) => keys.has(k)));
      return next.size === sel.size ? sel : next;
    });
  }, [due]);

  const selectable = due.filter((d) => canWork(s, d.plan));
  const allSelected = selectable.length > 0 && selectable.every((d) => selected.has(d.key));
  const toggle = (k: string) => setSelected((sel) => {
    const next = new Set(sel);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    return next;
  });
  const selectedItems = due.filter((d) => selected.has(d.key)).map((d) => ({ planId: d.plan.id, contactId: d.contact.id }));
  const overdueCount = due.filter((d) => d.overdue).length;
  const duePager = usePager(due, 50);

  return (
    <>
      <ErrorBanner error={plans.error} />
      {plans.data.length >= ACTIVE_LIMIT && <div className="banner banner-warn">Showing the {ACTIVE_LIMIT} most recent active plans.</div>}
      <div className="stats">
        <div className="stat"><div className="stat-value">{plans.loading ? '…' : visible.length}</div><div className="stat-label">Active plans</div></div>
        <div className="stat"><div className="stat-value">{due.length - overdueCount}</div><div className="stat-label">Contacts due this week</div></div>
        <div className="stat"><div className="stat-value stat-danger">{overdueCount}</div><div className="stat-label">Contacts overdue</div></div>
        <div className="stat"><div className="stat-value">{visible.filter((p) => p.needsReview).length}</div><div className="stat-label">Past close date, needs review</div></div>
      </div>
      <div className="toolbar">
        <input placeholder="Search family…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 240 }} />
        <label className="row gap-sm small"><input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} /> Only plans assigned to me</label>
        <label className="row gap-sm small"><input type="checkbox" checked={reviewOnly} onChange={(e) => setReviewOnly(e.target.checked)} /> Needs review only</label>
      </div>

      <Card
        title="Due this week and overdue"
        actions={
          <>
            <span className="muted small">{selected.size} selected</span>
            <Button small variant="primary" disabled={selected.size === 0} onClick={() => setBulk('done')}>Mark selected done</Button>
            <Button small disabled={selected.size === 0} onClick={() => setBulk('skipped')}>Mark selected skipped</Button>
          </>
        }
      >
        {result && (
          <div className={`banner ${result.failed.length ? 'banner-warn' : 'banner-ok'}`}>
            {result.updated} contact{result.updated === 1 ? '' : 's'} updated.
            {result.failed.length > 0 && ` ${result.failed.length} not updated: ${[...new Set(result.failed.map((f) => f.reason))].join(' ')}`}
          </div>
        )}
        <Table
          rows={duePager.slice}
          rowKey={(r) => r.key}
          empty="Nothing due in the next 7 days."
          rowClassName={(r) => (r.overdue ? 'row-missed' : undefined)}
          exportName="bereavement-due"
          columns={[
            {
              header: <input type="checkbox" aria-label="Select all" checked={allSelected} disabled={selectable.length === 0} onChange={() => setSelected(allSelected ? new Set() : new Set(selectable.map((d) => d.key)))} />,
              csvHeader: '',
              className: 'no-print',
              cell: (r) => <input type="checkbox" aria-label="Select" checked={selected.has(r.key)} disabled={!canWork(s, r.plan)} onChange={() => toggle(r.key)} />,
            },
            { header: 'Due', csv: (r) => `${r.contact.dueDate}${r.overdue ? ' (overdue)' : ''}`, cell: (r) => <>{formatDate(r.contact.dueDate)} {r.overdue && <Badge tone="danger">overdue</Badge>}</> },
            { header: 'Family of', cell: (r) => <button type="button" className="link" onClick={() => onOpen(r.plan)}>{r.plan.patientName}</button>, csv: (r) => r.plan.patientName },
            { header: 'Contact', cell: (r) => `${r.contact.label} (${r.contact.type})` },
            {
              header: 'Primary contact',
              cell: (r) => {
                const p = planSurvivors(r.plan).find((x) => x.isPrimary) ?? planSurvivors(r.plan)[0];
                return p ? [p.name, p.phone].filter(Boolean).join(' · ') : '—';
              },
            },
            { header: 'Coordinator', cell: (r) => (r.plan.assignedUid ? s.memberName(r.plan.assignedUid) : <span className="muted">Unassigned</span>) },
          ]}
        />
        {due.length > 50 && <Pager page={duePager.page} pages={duePager.pages} setPage={duePager.setPage} total={due.length} />}
      </Card>

      <Card title="Active plans">
        {plans.loading ? <p className="muted">Loading…</p> : <PlanTable plans={visible} onOpen={onOpen} exportName="bereavement-active-plans" />}
      </Card>

      {bulk && (
        <BulkModal
          items={selectedItems}
          status={bulk}
          onClose={() => setBulk(null)}
          onDone={(res) => {
            setBulk(null);
            setResult(res);
            setSelected(new Set());
          }}
        />
      )}
    </>
  );
}

function ClosedTab({ onOpen }: { onOpen: (p: Plan) => void }) {
  const s = useOrgSession();
  const [count, setCount] = useState(CLOSED_PAGE);
  const plans = useLiveQuery<BereavementPlan>(
    query(orgCol(s.orgId, 'bereavementPlans'), where('status', '==', 'closed'), orderBy('deathDate', 'desc'), limit(count)),
    [s.orgId, count],
  );
  const more = plans.data.length >= count;
  return (
    <Card title="Closed plans">
      <ErrorBanner error={plans.error} />
      {plans.loading && plans.data.length === 0 ? (
        <p className="muted">Loading…</p>
      ) : (
        <PlanTable
          plans={plans.data}
          onOpen={onOpen}
          exportName="bereavement-closed-plans"
          extra={more && <Button small onClick={() => setCount((n) => n + CLOSED_PAGE)} busy={plans.loading}>Load {CLOSED_PAGE} more</Button>}
        />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Mailings
// ---------------------------------------------------------------------------

const MAILING_COLUMNS: CsvColumn<BereavementMailingRow>[] = [
  { header: 'Survivor', value: (r) => r.survivorName },
  { header: 'Relationship', value: (r) => r.relationship },
  { header: 'Address line 1', value: (r) => r.address.line1 },
  { header: 'Address line 2', value: (r) => r.address.line2 },
  { header: 'City', value: (r) => r.address.city },
  { header: 'State', value: (r) => r.address.state },
  { header: 'ZIP', value: (r) => r.address.zip },
  { header: 'Email', value: (r) => r.email },
  { header: 'Preferred', value: (r) => r.preferredContact },
  { header: 'Family of', value: (r) => r.patientName },
  { header: 'Mailing', value: (r) => r.contactLabel },
  { header: 'Due', value: (r) => r.dueDate },
];

function MailingsTab() {
  const s = useOrgSession();
  const act = useAction();
  const [from, setFrom] = useState(todayISO());
  const [to, setTo] = useState(addDaysISO(todayISO(), 14));
  const [types, setTypes] = useState<BereavementContactType[]>(['letter']);
  const [preview, setPreview] = useState<(ExportBereavementMailingResponse & { from: string; to: string; types: BereavementContactType[] }) | null>(null);
  const [marked, setMarked] = useState<number | null>(null);
  const pager = usePager(preview?.rows ?? [], 50);

  const req = (markDone: boolean): ExportBereavementMailingRequest => ({ orgId: s.orgId, from, to, types, markDone });

  async function runPreview(e: FormEvent) {
    e.preventDefault();
    setMarked(null);
    if (from > to) return act.setError('The start date must be on or before the end date.');
    if (types.length === 0) return act.setError('Choose at least one contact type.');
    await act.run(async () => {
      const res = await call<ExportBereavementMailingRequest, ExportBereavementMailingResponse>('exportBereavementMailing', req(false));
      setPreview({ ...res, from, to, types });
    });
  }

  async function markSent() {
    if (!preview) return;
    if (!window.confirm(`Mark ${preview.contactCount} mailing contact${preview.contactCount === 1 ? '' : 's'} as done?`)) return;
    await act.run(async () => {
      const res = await call<ExportBereavementMailingRequest, ExportBereavementMailingResponse>('exportBereavementMailing', {
        orgId: s.orgId, from: preview.from, to: preview.to, types: preview.types, markDone: true,
      });
      setMarked(res.marked);
    });
  }

  const stale = !!preview && (preview.from !== from || preview.to !== to || preview.types.join() !== types.join());

  return (
    <Card title="Mailings">
      <p className="muted small">
        Pending letters due in the range, one row per survivor who accepts mail or email and is not marked do-not-contact.
        {!canWorkAll(s) && ' You see only the plans you coordinate.'}
      </p>
      <form className="toolbar" onSubmit={runPreview}>
        <Field label="From"><input type="date" required value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><input type="date" required value={to} max={addDaysISO(from, 92)} onChange={(e) => setTo(e.target.value)} /></Field>
        {MAILING_TYPES.map((t) => (
          <label key={t} className="row gap-sm small">
            <input type="checkbox" checked={types.includes(t)} onChange={(e) => setTypes((l) => (e.target.checked ? [...l, t] : l.filter((x) => x !== t)))} /> {t}s
          </label>
        ))}
        <Button type="submit" variant="primary" busy={act.busy}>Preview</Button>
      </form>
      <ErrorBanner error={act.error} />
      {preview && (
        <>
          {stale && <div className="banner banner-info">The filters changed since this preview. Preview again before exporting.</div>}
          {preview.truncated && <div className="banner banner-warn">Too many active plans to scan in one export; narrow the range or split by coordinator.</div>}
          {marked !== null && <div className="banner banner-ok">{marked} contact{marked === 1 ? '' : 's'} marked sent.</div>}
          <div className="row gap wrap" style={{ margin: '8px 0' }}>
            <span className="small">{preview.rows.length} label{preview.rows.length === 1 ? '' : 's'} for {preview.contactCount} contact{preview.contactCount === 1 ? '' : 's'}</span>
            <Button small disabled={preview.rows.length === 0 || stale} onClick={() => downloadCsv(csvFileName(`bereavement-mailing-${preview.from}-to-${preview.to}`), toCsv(preview.rows, MAILING_COLUMNS))}>
              Download CSV
            </Button>
            <Button small variant="primary" disabled={preview.contactCount === 0 || marked !== null || stale} busy={act.busy} onClick={() => void markSent()}>
              Mark {preview.contactCount} letter{preview.contactCount === 1 ? '' : 's'} sent
            </Button>
          </div>
          <Table
            rows={pager.slice}
            rowKey={(r) => `${r.planId}:${r.contactId}:${r.survivorId}`}
            empty="No mailings in this range."
            columns={[
              { header: 'Due', cell: (r) => formatDate(r.dueDate) },
              { header: 'Survivor', cell: (r) => <><strong>{r.survivorName}</strong>{r.relationship && <span className="muted small"> ({r.relationship})</span>}</> },
              { header: 'Address', cell: (r) => <span className="small">{formatAddress(r.address) || (r.email ?? '—')}</span> },
              { header: 'Prefers', cell: (r) => r.preferredContact },
              { header: 'Family of', cell: (r) => r.patientName },
              { header: 'Mailing', cell: (r) => r.contactLabel },
            ]}
          />
          {preview.rows.length > 50 && <Pager page={pager.page} pages={pager.pages} setPage={pager.setPage} total={preview.rows.length} />}
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Settings card (rendered on the Settings page)
// ---------------------------------------------------------------------------

/** Org setting `defaultBereavementCoordinatorUid` (admin; rules validate a string ≤ 128 or null). */
export function BereavementSettingsCard() {
  const s = useOrgSession();
  const act = useAction();
  const [saved, setSaved] = useState(false);
  const current = s.org?.defaultBereavementCoordinatorUid ?? '';
  return (
    <Card title="Bereavement">
      <div className="form form-narrow">
        <ErrorBanner error={act.error} />
        {saved && <div className="banner banner-ok">Default bereavement coordinator saved.</div>}
        <Field label="Default bereavement coordinator" hint="New bereavement plans are assigned to this member. When unset or inactive, the care team's social worker is used.">
          <MemberSelect
            members={s.members.filter((m) => m.discipline !== 'Volunteer')}
            value={current}
            placeholder="Care-team social worker"
            onChange={(uid) => {
              setSaved(false);
              void act.run(() => updateDoc(orgDoc(s.orgId), { defaultBereavementCoordinatorUid: uid || null })).then((ok) => ok && setSaved(true));
            }}
          />
        </Field>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

type TabKey = 'active' | 'closed' | 'mailings';

export default function BereavementPage() {
  const s = useOrgSession();
  const [tab, setTab] = useState<TabKey>('active');
  const [openId, setOpenId] = useState<string | null>(null);
  const [openPlan, setOpenPlan] = useState<Plan | null>(null);
  // Keep the drawer live: re-read the open plan from its own listener.
  const live = useLiveDoc<BereavementPlan>(openId ? orgDoc(s.orgId, 'bereavementPlans', openId) : null, [s.orgId, openId]);
  const drawerPlan = (openId && live.data) || openPlan;

  if (s.member?.discipline === 'Volunteer' && !s.isAdmin) {
    return (
      <Page title="Bereavement">
        <p className="muted">Bereavement plans are not available to volunteers.</p>
      </Page>
    );
  }

  const open = (p: Plan) => {
    setOpenPlan(p);
    setOpenId(p.id);
  };

  return (
    <Page title="Bereavement">
      <Tabs<TabKey>
        tabs={[
          { key: 'active', label: 'Active plans' },
          { key: 'closed', label: 'Closed plans' },
          { key: 'mailings', label: 'Mailings' },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'active' && <ActiveTab onOpen={open} />}
      {tab === 'closed' && <ClosedTab onOpen={open} />}
      {tab === 'mailings' && <MailingsTab />}
      {drawerPlan && (
        <PlanDrawer
          plan={drawerPlan}
          onClose={() => {
            setOpenId(null);
            setOpenPlan(null);
          }}
        />
      )}
    </Page>
  );
}
