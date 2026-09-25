import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getDocs, limit, orderBy, query, startAfter, type DocumentData, type QueryDocumentSnapshot } from 'firebase/firestore';
import type { AuditLog } from '@shared/types';
import { useOrgSession } from '../lib/session';
import { fromSnap, orgCol, type WithId } from '../lib/firestore';
import { errorMessage, formatInstant } from '../lib/format';
import { Badge, Button, Card, ErrorBanner, Page, Table } from '../components/ui';

const PAGE_SIZE = 50;

export default function AuditLogPage() {
  const s = useOrgSession();
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
        const base = query(orgCol(s.orgId, 'auditLogs'), orderBy('at', 'desc'), limit(PAGE_SIZE));
        const snap = await getDocs(after ? query(base, startAfter(after)) : base);
        const docs = snap.docs.map((d) => fromSnap<AuditLog>(d));
        setRows((prev) => (after ? [...prev, ...docs] : docs));
        setCursor(snap.docs[snap.docs.length - 1] ?? after);
        setHasMore(snap.docs.length === PAGE_SIZE);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setLoading(false);
      }
    },
    [s.orgId],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  return (
    <Page title="Audit log" actions={<Button onClick={() => void load(null)} disabled={loading}>Refresh</Button>}>
      <ErrorBanner error={error} />
      <Card>
        <Table
          rows={rows}
          rowKey={(r) => r.id}
          empty={loading ? 'Loading…' : 'No audit entries.'}
          columns={[
            { header: 'When', cell: (r) => formatInstant(r.at) },
            { header: 'Actor', cell: (r) => (r.actorUid === 'system' ? 'system' : s.memberName(r.actorUid)) },
            { header: 'Action', cell: (r) => <Badge tone="info">{r.action}</Badge> },
            { header: 'Resource', cell: (r) => <span className="mono small">{r.resourceType}/{r.resourceId}</span> },
            { header: 'Patient', cell: (r) => (r.patientId ? <Link to={`/patients/${r.patientId}`}>View</Link> : '—') },
            {
              header: 'Details',
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
      </Card>
    </Page>
  );
}
