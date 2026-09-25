import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { doc, limit, orderBy, query, serverTimestamp, setDoc } from 'firebase/firestore';
import { ref as storageRef, uploadBytes } from 'firebase/storage';
import type { Referral, ReferralStatus } from '@shared/types';
import { useOrgSession } from '../lib/session';
import { orgCol } from '../lib/firestore';
import { useLiveQuery } from '../lib/hooks';
import { storage } from '../lib/firebase';
import { REFERRAL_STATUSES } from '../lib/constants';
import { errorMessage, formatInstant } from '../lib/format';
import { patientName } from '../lib/patient';
import { Badge, Button, Card, ErrorBanner, Page, Table } from '../components/ui';

const MAX_BYTES = 25 * 1024 * 1024;
const ACCEPT = 'application/pdf,image/*';

function safeFileName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+/, '');
  const out = cleaned.slice(-120);
  return !out || /^\.+$/.test(out) ? 'referral' : out;
}

export default function ReferralsPage() {
  const s = useOrgSession();
  const navigate = useNavigate();
  const [status, setStatus] = useState<ReferralStatus | 'active' | 'all'>('active');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const referrals = useLiveQuery<Referral>(
    query(orgCol(s.orgId, 'referrals'), orderBy('createdAt', 'desc'), limit(200)),
    [s.orgId],
  );

  const rows = useMemo(
    () =>
      referrals.data.filter((r) =>
        status === 'all'
          ? true
          : status === 'active'
            ? ['uploaded', 'extracting', 'needs_review', 'failed'].includes(r.status)
            : r.status === status,
      ),
    [referrals.data, status],
  );

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError(null);
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const isPdf = file.type === 'application/pdf';
        const isImage = file.type.startsWith('image/');
        if (!isPdf && !isImage) throw new Error(`${file.name}: only PDF or image files are allowed.`);
        if (file.size > MAX_BYTES) throw new Error(`${file.name}: file exceeds 25 MB.`);

        const refDoc = doc(orgCol(s.orgId, 'referrals'));
        const fileName = safeFileName(file.name);
        const storagePath = `orgs/${s.orgId}/referrals/${refDoc.id}/${fileName}`;
        // 1) Create the referral record (status 'uploaded'), 2) upload the file; the storage trigger extracts.
        await setDoc(refDoc, {
          fileName,
          contentType: file.type,
          storagePath,
          source: 'upload',
          status: 'uploaded',
          extracted: null,
          error: null,
          model: null,
          patientId: null,
          uploadedBy: s.user.uid,
          reviewedBy: null,
          rejectionReason: null,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        await uploadBytes(storageRef(storage, storagePath), file, { contentType: file.type });
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: referrals.data.length, active: 0 };
    for (const r of referrals.data) {
      c[r.status] = (c[r.status] ?? 0) + 1;
      if (['uploaded', 'extracting', 'needs_review', 'failed'].includes(r.status)) c.active++;
    }
    return c;
  }, [referrals.data]);

  return (
    <Page
      title="Referrals"
      actions={
        <>
          <input
            ref={fileInput}
            type="file"
            accept={ACCEPT}
            multiple
            hidden
            onChange={(e) => void upload(e.target.files)}
          />
          <Button variant="primary" busy={uploading} onClick={() => fileInput.current?.click()}>
            Upload referral
          </Button>
        </>
      }
    >
      <ErrorBanner error={error ?? referrals.error} />
      <div
        className="dropzone"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void upload(e.dataTransfer.files);
        }}
      >
        Drop referral PDFs or images here, or use <strong>Upload referral</strong>. AI extraction starts automatically.
      </div>
      <div className="toolbar">
        <div className="segmented">
          {(['active', ...REFERRAL_STATUSES, 'all'] as const).map((st) => (
            <button key={st} className={status === st ? 'active' : ''} onClick={() => setStatus(st)}>
              {st.replace('_', ' ')} <span className="count">{counts[st] ?? 0}</span>
            </button>
          ))}
        </div>
      </div>
      <Card>
        <Table
          rows={rows}
          rowKey={(r) => r.id}
          onRowClick={(r) => navigate(`/referrals/${r.id}`)}
          empty={referrals.loading ? 'Loading…' : 'No referrals.'}
          columns={[
            { header: 'Received', cell: (r) => formatInstant(r.createdAt) },
            {
              header: 'Patient',
              cell: (r) =>
                r.extracted?.patient ? patientName(r.extracted.patient) : <span className="muted">{r.fileName}</span>,
            },
            { header: 'Source', cell: (r) => r.extracted?.referralSource ?? r.source },
            { header: 'Status', cell: (r) => <Badge value={r.status} /> },
            { header: 'Uploaded by', cell: (r) => s.memberName(r.uploadedBy) },
            {
              header: '',
              cell: (r) =>
                r.status === 'accepted' && r.patientId ? (
                  <Link to={`/patients/${r.patientId}`} onClick={(e) => e.stopPropagation()}>Patient →</Link>
                ) : r.status === 'needs_review' ? (
                  <Link to={`/referrals/${r.id}`}>Review →</Link>
                ) : null,
            },
          ]}
        />
      </Card>
    </Page>
  );
}
