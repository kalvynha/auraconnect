import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { doc, limit, orderBy, query, serverTimestamp, setDoc, where } from 'firebase/firestore';
import { ref as storageRef, uploadBytes } from 'firebase/storage';
import type { Referral, ReferralStatus, RetryReferralRequest } from '@shared/types';
import { useOrgSession } from '../lib/session';
import { orgCol, type WithId } from '../lib/firestore';
import { useLiveQuery } from '../lib/hooks';
import { call, storage } from '../lib/firebase';
import { REFERRAL_MIME_TYPES, REFERRAL_STATUSES } from '../lib/constants';
import { errorMessage, formatInstant } from '../lib/format';
import { patientName } from '../lib/patient';
import { activeClaimant, isStaleReferral, referralFileError, safeFileName, useNow } from '../lib/referrals';
import { PhoneReferralModal, RejectReferralModal } from '../components/intake';
import { Badge, Button, Card, ErrorBanner, Page, Table } from '../components/ui';

const ACTIVE_STATUSES: ReferralStatus[] = ['uploaded', 'extracting', 'needs_review', 'failed'];
const HISTORY_LIMIT = 200;
const ACCEPT = REFERRAL_MIME_TYPES.join(',');

export default function ReferralsPage() {
  const s = useOrgSession();
  const navigate = useNavigate();
  const now = useNow();
  const [status, setStatus] = useState<ReferralStatus | 'active' | 'all'>('active');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [phoneOpen, setPhoneOpen] = useState(false);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // The active queue is filtered on the server so it is never cut off by the newest-200 limit
  // (index: referrals(status, createdAt desc)). Other tabs show the newest 200 of that status.
  const referrals = useLiveQuery<Referral>(
    query(
      orgCol(s.orgId, 'referrals'),
      ...(status === 'active'
        ? [where('status', 'in', ACTIVE_STATUSES)]
        : status === 'all'
          ? []
          : [where('status', '==', status)]),
      orderBy('createdAt', 'desc'),
      ...(status === 'active' ? [] : [limit(HISTORY_LIMIT)]),
    ),
    [s.orgId, status],
  );
  const rows = referrals.data;

  async function uploadOne(file: File) {
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

  async function upload(list: FileList | null) {
    const files = list ? Array.from(list) : [];
    if (files.length === 0) return;
    setError(null);
    setInfo(null);
    // Validate every file first so a bad file never leaves a partial batch behind.
    const problems = files.map(referralFileError).filter((e): e is string => !!e);
    if (problems.length) {
      setError(`Nothing was uploaded. ${problems.join(' ')}`);
      if (fileInput.current) fileInput.current.value = '';
      return;
    }
    // Each file becomes its own referral. (Combining files would need PDF merging in the
    // browser; for a multi-page referral, scan or save it as one PDF instead.)
    setUploading(true);
    let done = 0;
    try {
      for (const file of files) {
        await uploadOne(file);
        done++;
      }
      if (files.length > 1) setInfo(`Created ${files.length} referrals, one per file.`);
    } catch (err) {
      setError(`${done} of ${files.length} file(s) uploaded. ${errorMessage(err)}`);
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function retry(r: WithId<Referral>) {
    setRetrying(r.id);
    setError(null);
    try {
      await call<RetryReferralRequest, Record<string, never>>('retryReferralExtraction', { orgId: s.orgId, referralId: r.id });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRetrying(null);
    }
  }

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
          <Button onClick={() => setPhoneOpen(true)}>New phone referral</Button>
          <Button variant="primary" busy={uploading} onClick={() => fileInput.current?.click()}>
            Upload referral
          </Button>
        </>
      }
    >
      <ErrorBanner error={error ?? referrals.error} />
      {info && <div className="banner banner-info">{info}</div>}
      <div
        className="dropzone"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void upload(e.dataTransfer.files);
        }}
      >
        Drop referral PDFs or images (PNG, JPEG, WebP, HEIC) here, or use <strong>Upload referral</strong>. Each file becomes one referral and AI extraction starts automatically.
      </div>
      <div className="toolbar">
        <div className="segmented">
          {(['active', ...REFERRAL_STATUSES, 'all'] as const).map((st) => (
            <button key={st} className={status === st ? 'active' : ''} onClick={() => setStatus(st)}>
              {st.replace('_', ' ')}
              {status === st && !referrals.loading && (
                <span className="count">{st !== 'active' && rows.length >= HISTORY_LIMIT ? `${HISTORY_LIMIT}+` : rows.length}</span>
              )}
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
              cell: (r) => (
                <>
                  {r.extracted?.patient ? patientName(r.extracted.patient) : <span className="muted">{r.fileName ?? 'Phone referral'}</span>}
                  {(r.possibleDuplicates?.length ?? 0) > 0 && r.status !== 'accepted' && <> <Badge tone="warn">possible duplicate</Badge></>}
                </>
              ),
              csv: (r) => (r.extracted?.patient ? patientName(r.extracted.patient) : r.fileName ?? ''),
            },
            { header: 'Source', cell: (r) => r.extracted?.referralSource ?? r.source },
            {
              header: 'Status',
              cell: (r) => (
                <>
                  <Badge value={r.status} />
                  {isStaleReferral(r, now) && <> <Badge tone="danger">stuck</Badge></>}
                </>
              ),
              csv: (r) => r.status,
            },
            {
              header: 'Reviewing',
              cell: (r) => {
                const who = activeClaimant(r, now);
                return who ? s.memberName(who) : <span className="muted">—</span>;
              },
            },
            { header: 'Uploaded by', cell: (r) => s.memberName(r.uploadedBy) },
            {
              header: '',
              cell: (r) =>
                r.status === 'accepted' && r.patientId ? (
                  <Link to={`/patients/${r.patientId}`} onClick={(e) => e.stopPropagation()}>Patient →</Link>
                ) : isStaleReferral(r, now) ? (
                  <div className="row gap-sm" onClick={(e) => e.stopPropagation()}>
                    <Button small busy={retrying === r.id} onClick={() => void retry(r)}>Retry</Button>
                    <Button small variant="danger" onClick={() => setRejecting(r.id)}>Reject</Button>
                  </div>
                ) : r.status === 'needs_review' || r.status === 'failed' ? (
                  <Link to={`/referrals/${r.id}`}>Review →</Link>
                ) : null,
            },
          ]}
        />
      </Card>
      {phoneOpen && (
        <PhoneReferralModal
          orgId={s.orgId}
          onClose={(id) => {
            setPhoneOpen(false);
            if (id) navigate(`/referrals/${id}`);
          }}
        />
      )}
      {rejecting && <RejectReferralModal orgId={s.orgId} referralId={rejecting} onClose={() => setRejecting(null)} />}
    </Page>
  );
}
