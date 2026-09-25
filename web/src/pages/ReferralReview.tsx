import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { getDownloadURL, ref as storageRef } from 'firebase/storage';
import type {
  AcceptReferralRequest,
  AcceptReferralResponse,
  PatientInput,
  Referral,
  RejectReferralRequest,
  RetryReferralRequest,
} from '@shared/types';
import { useOrgSession } from '../lib/session';
import { orgDoc } from '../lib/firestore';
import { useLiveDoc } from '../lib/hooks';
import { call, storage } from '../lib/firebase';
import { errorMessage, formatDate, formatInstant } from '../lib/format';
import { normalizePatientInput, toPatientInput } from '../lib/patient';
import { PatientForm } from '../components/PatientForm';
import { Badge, Button, ErrorBanner, Field, Loading, Modal, Page } from '../components/ui';

const LOW_CONFIDENCE = 0.7;

function DocumentViewer({ referral }: { referral: Referral }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    getDownloadURL(storageRef(storage, referral.storagePath))
      .then((u) => !cancelled && setUrl(u))
      .catch((err) => !cancelled && setError(errorMessage(err)));
    return () => {
      cancelled = true;
    };
  }, [referral.storagePath]);

  if (error) return <ErrorBanner error={`Couldn't load document: ${error}`} />;
  if (!url) return <Loading label="Loading document…" />;
  if (referral.contentType.startsWith('image/')) {
    return (
      <div className="doc-image">
        <img src={url} alt="Referral document" />
      </div>
    );
  }
  return (
    <object data={url} type="application/pdf" className="doc-frame" aria-label="Referral document">
      <iframe src={url} title="Referral document" className="doc-frame" />
    </object>
  );
}

export default function ReferralReviewPage() {
  const { referralId = '' } = useParams();
  const s = useOrgSession();
  const navigate = useNavigate();
  const { data: referral, loading, error: loadError } = useLiveDoc<Referral>(
    orgDoc(s.orgId, 'referrals', referralId),
    [s.orgId, referralId],
  );

  const [patient, setPatient] = useState<PatientInput | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [acceptedPatientId, setAcceptedPatientId] = useState<string | null>(null);

  // Seed the editable form once extraction data arrives (don't clobber edits on later snapshots).
  const hasExtracted = !!referral?.extracted;
  useEffect(() => {
    if (referral && patient === null && (hasExtracted || referral.status === 'failed')) {
      setPatient(toPatientInput(referral.extracted?.patient));
    }
  }, [referral, hasExtracted, patient]);

  const confidence = referral?.extracted?.fieldConfidence ?? {};
  const isLow = useMemo(() => {
    return (path: string) => {
      const parts = path.split('.');
      for (let i = parts.length; i >= 2; i--) {
        const c = confidence[parts.slice(0, i).join('.')];
        if (typeof c === 'number' && c < LOW_CONFIDENCE) return true;
      }
      return false;
    };
  }, [confidence]);
  const lowCount = Object.values(confidence).filter((c) => c < LOW_CONFIDENCE).length;

  if (loading) return <Loading />;
  if (!referral) return <Page title="Referral"><ErrorBanner error={loadError ?? 'Referral not found.'} /></Page>;

  const ex = referral.extracted;
  const reviewable = referral.status === 'needs_review' || referral.status === 'failed';

  async function accept() {
    if (!patient) return;
    const p = normalizePatientInput(patient);
    if (!p.firstName || !p.lastName) return setError('First and last name are required.');
    setBusy('accept');
    setError(null);
    try {
      const res = await call<AcceptReferralRequest, AcceptReferralResponse>('acceptReferral', {
        orgId: s.orgId,
        referralId,
        patient: p,
      });
      setAcceptedPatientId(res.patientId);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function reject() {
    if (!reason.trim()) return;
    setBusy('reject');
    setError(null);
    try {
      await call<RejectReferralRequest, Record<string, never>>('rejectReferral', { orgId: s.orgId, referralId, reason: reason.trim() });
      setRejecting(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function retry() {
    setBusy('retry');
    setError(null);
    try {
      await call<RetryReferralRequest, Record<string, never>>('retryReferralExtraction', { orgId: s.orgId, referralId });
      setPatient(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const admitTarget = acceptedPatientId ?? referral.patientId;

  return (
    <Page
      title="Review referral"
      actions={
        <>
          <Badge value={referral.status} />
          <Link to="/referrals">← Back to queue</Link>
        </>
      }
    >
      <ErrorBanner error={error ?? loadError} />
      {admitTarget && (
        <div className="banner banner-ok row space-between">
          <span>Referral accepted — a referral-status patient was created.</span>
          <div className="row gap-sm">
            <Button small onClick={() => navigate(`/patients/${admitTarget}`)}>View patient</Button>
            <Button small variant="primary" onClick={() => navigate(`/patients/${admitTarget}/admit`)}>
              Continue to admission
            </Button>
          </div>
        </div>
      )}
      <div className="split">
        <div className="split-left">
          <DocumentViewer referral={referral} />
        </div>
        <div className="split-right">
          <div className="meta small muted">
            {referral.fileName} · uploaded {formatInstant(referral.createdAt)} by {s.memberName(referral.uploadedBy)}
            {referral.model && <> · extracted by {referral.model}</>}
          </div>

          {(referral.status === 'uploaded' || referral.status === 'extracting') && (
            <div className="banner banner-info">
              {referral.status === 'uploaded' ? 'Waiting for extraction to start…' : 'Extracting fields with AI…'} This page updates automatically.
            </div>
          )}
          {referral.status === 'failed' && (
            <div className="banner banner-error row space-between">
              <span>Extraction failed{referral.error ? `: ${referral.error}` : '.'} You can retry or enter the fields manually.</span>
              <Button small busy={busy === 'retry'} onClick={() => void retry()}>Retry extraction</Button>
            </div>
          )}
          {referral.status === 'rejected' && (
            <div className="banner banner-warn">
              Rejected by {s.memberName(referral.reviewedBy)}{referral.rejectionReason ? `: ${referral.rejectionReason}` : ''}
            </div>
          )}

          {ex && ex.warnings.length > 0 && (
            <div className="banner banner-warn">
              <strong>Extraction warnings</strong>
              <ul>{ex.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
            </div>
          )}
          {lowCount > 0 && reviewable && (
            <p className="small"><span className="swatch-warn" /> {lowCount} field(s) with confidence below {LOW_CONFIDENCE * 100}% are highlighted — verify them against the document.</p>
          )}

          {ex && (
            <dl className="dl dl-compact">
              <div className={(confidence.referralDate ?? 1) < LOW_CONFIDENCE ? 'field-warn' : ''}>
                <dt>Referral date</dt><dd>{formatDate(ex.referralDate)}</dd>
              </div>
              <div className={(confidence.referralSource ?? 1) < LOW_CONFIDENCE ? 'field-warn' : ''}>
                <dt>Referral source</dt><dd>{ex.referralSource ?? '—'}</dd>
              </div>
              <div className={(confidence.reasonForReferral ?? 1) < LOW_CONFIDENCE ? 'field-warn' : ''}>
                <dt>Reason</dt><dd>{ex.reasonForReferral ?? '—'}</dd>
              </div>
            </dl>
          )}

          {patient && (
            <PatientForm value={patient} onChange={setPatient} isLow={isLow} readOnly={!reviewable || !!admitTarget} />
          )}

          {reviewable && !admitTarget && patient && (
            <div className="row gap end sticky-actions">
              <Button variant="danger" onClick={() => setRejecting(true)} disabled={!!busy}>Reject</Button>
              <Button variant="primary" busy={busy === 'accept'} onClick={() => void accept()}>Accept referral</Button>
            </div>
          )}
        </div>
      </div>

      {rejecting && (
        <Modal
          title="Reject referral"
          onClose={() => setRejecting(false)}
          footer={
            <>
              <Button onClick={() => setRejecting(false)}>Cancel</Button>
              <Button variant="danger" busy={busy === 'reject'} disabled={!reason.trim()} onClick={() => void reject()}>
                Reject
              </Button>
            </>
          }
        >
          <Field label="Reason">
            <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
          </Field>
        </Modal>
      )}
    </Page>
  );
}
