import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  Timestamp,
  getDocs,
  limit,
  orderBy,
  query,
  startAfter,
  where,
  type DocumentData,
  type QueryConstraint,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import type { AuditLog } from '@shared/types';
import { useOrgSession } from '../lib/session';
import { fromSnap, orgCol, type WithId } from '../lib/firestore';
import { AUDIT_ACTIONS } from '../lib/constants';
import { errorMessage, formatInstant } from '../lib/format';
import { Badge, Button, Card, ErrorBanner, Field, MemberSelect, Page, Table } from '../components/ui';

const PAGE_SIZE = 50;

interface Filters {
  action: string;
  actorUid: string;
  patientId: string;
  /** `YYYY-MM-DD`, local time, inclusive. */
  from: string;
  to: string;
}

const EMPTY: Filters = { action: '', actorUid: '', patientId: '', from: '', to: '' };

function localDayStart(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/**
 * Server-side filters. Each equality filter has its own composite index with `at desc`
 * (auditLogs(action, at desc), (actorUid, at desc), (patientId, at desc)); Firestore merges
 * them when several are combined. The date range is on `at`, the ordering field.
 */
function constraintsFor(f: Filters): QueryConstraint[] {
  const out: QueryConstraint[] = [];
  if (f.action) out.push(where('action', '==', f.action));
  if (f.actorUid) out.push(where('actorUid', '==', f.actorUid));
  if (f.patientId) out.push(where('patientId', '==', f.patientId));
  if (f.from) out.push(where('at', '>=', Timestamp.fromDate(localDayStart(f.from))));
  if (f.to) {
    const end = localDayStart(f.to);
    end.setDate(end.getDate() + 1);
    out.push(where('at', '<', Timestamp.fromDate(end)));
  }
  return out;
}

export default function AuditLogPage() {
  const s = useOrgSession();
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [rows, setRows] = useState<WithId<AuditLog>[]>([]);
  const [cursor, setCursor] = useState<QueryDocumentSnapshot<DocumentData> | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (after: QueryDocumentSnapshot<DocumentData> | null) => {
      setLoading(true);
      setError(null);
      try {
        const base = query(orgCol(s.orgId, 'auditLogs'), ...constraintsFor(filters), orderBy('at', 'desc'), limit(PAGE_SIZE));
        const snap = await getDocs(after ? query(base, startAfter(after)) : base);
        const docs = snap.docs.map((d) => fromSnap<AuditLog>(d));
        setRows((prev) => (after ? [...prev, ...docs] : docs));
        setCursor(snap.docs[snap.docs.length - 1] ?? after);
        setHasMore(snap.docs.length === PAGE_SIZE);
      } catch (err) {
        if (!after) setRows([]);
        setError(errorMessage(err));
      } finally {
        setLoading(false);
      }
    },
    [s.orgId, filters],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  function apply(e: FormEvent) {
    e.preventDefault();
    if (draft.from && draft.to && draft.to < draft.from) return setError('"To" must be on or after "From".');
    setFilters({ ...draft, action: draft.action.trim(), patientId: draft.patientId.trim() });
  }

  const active = Object.values(filters).some(Boolean);

  return (
    <Page title="Audit log" actions={<Button onClick={() => void load(null)} disabled={loading}>Refresh</Button>}>
      <ErrorBanner error={error} />
      <Card>
        <form className="filters-grid" onSubmit={apply}>
          <Field label="Action">
            <input
              list="audit-actions"
              placeholder="Any action"
              value={draft.action}
              onChange={(e) => setDraft({ ...draft, action: e.target.value })}
            />
            <datalist id="audit-actions">
              {AUDIT_ACTIONS.map((a) => <option key={a} value={a} />)}
            </datalist>
          </Field>
          <Field label="Actor">
            <MemberSelect
              members={s.members.map((m) => ({ ...m, active: true }))}
              value={draft.actorUid}
              onChange={(uid) => setDraft({ ...draft, actorUid: uid })}
              placeholder="Anyone"
            />
          </Field>
          <Field label="Patient ID">
            <input placeholder="Any patient" value={draft.patientId} onChange={(e) => setDraft({ ...draft, patientId: e.target.value })} />
          </Field>
          <Field label="From">
            <input type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
          </Field>
          <Field label="To">
            <input type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
          </Field>
          <div className="row gap-sm">
            <Button type="submit" variant="primary" busy={loading}>Apply</Button>
            {active && (
              <Button
                onClick={() => {
                  setDraft(EMPTY);
                  setFilters(EMPTY);
                }}
              >
                Clear
              </Button>
            )}
          </div>
        </form>
        <Table
          rows={rows}
          rowKey={(r) => r.id}
          empty={loading ? 'Loading…' : active ? 'No audit entries match these filters.' : 'No audit entries.'}
          exportName="audit-log"
          columns={[
            { header: 'When', cell: (r) => formatInstant(r.at) },
            { header: 'Actor', cell: (r) => (r.actorUid === 'system' ? 'system' : s.memberName(r.actorUid)) },
            { header: 'Action', csv: (r) => r.action, cell: (r) => <Badge tone="info">{r.action}</Badge> },
            { header: 'Resource', csv: (r) => `${r.resourceType}/${r.resourceId}`, cell: (r) => <span className="mono small">{r.resourceType}/{r.resourceId}</span> },
            {
              header: 'Patient',
              csv: (r) => r.patientId ?? '',
              cell: (r) =>
                r.patientId ? (
                  <span className="row gap-sm">
                    <Link to={`/patients/${r.patientId}`}>View</Link>
                    <button
                      type="button"
                      className="link small"
                      title="Filter by this patient"
                      onClick={() => {
                        const next = { ...filters, patientId: r.patientId ?? '' };
                        setDraft(next);
                        setFilters(next);
                      }}
                    >
                      filter
                    </button>
                  </span>
                ) : (
                  '—'
                ),
            },
            {
              header: 'Details',
              csv: (r) => (Object.keys(r.metadata ?? {}).length ? JSON.stringify(r.metadata) : ''),
              cell: (r) => {
                const keys = Object.keys(r.metadata ?? {});
                if (!keys.length) return <span className="muted">—</span>;
                return (
                  <details>
                    <summary className="small">{keys.length} field(s)</summary>
                    <pre className="meta-pre">{JSON.stringify(r.metadata, null, 2)}</pre>
                  </details>
                );
              },
            },
          ]}
        />
        {hasMore && rows.length > 0 && (
          <div className="row center">
            <Button onClick={() => void load(cursor)} busy={loading}>Load more</Button>
          </div>
        )}
        <p className="muted small">CSV export includes the rows loaded so far; use “Load more” first to export further back.</p>
      </Card>
    </Page>
  );
}
