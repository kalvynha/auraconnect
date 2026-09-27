import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { getBlob, ref as storageRef } from 'firebase/storage';
import type {
  AcceptReferralRequest,
  AcceptReferralResponse,
  ClaimReferralRequest,
  ClaimReferralResponse,
  PatientInput,
  Referral,
  RetryReferralRequest,
} from '@shared/types';
import { useOrgSession } from '../lib/session';
import { orgDoc } from '../lib/firestore';
import { useLiveDoc } from '../lib/hooks';
import { call, storage } from '../lib/firebase';
import { NON_ADMIT_REASON_LABELS } from '../lib/constants';
import { errorMessage, formatDate, formatInstant } from '../lib/format';
import { normalizePatientInput, toPatientInput } from '../lib/patient';
import { activeClaimant, isStaleReferral, useNow } from '../lib/referrals';
import { PatientForm } from '../components/PatientForm';
import { DuplicateBanner, NonAdmitModal, RejectReferralModal } from '../components/intake';
import { Badge, Button, ErrorBanner, Field, Loading, Page } from '../components/ui';

const LOW_CONFIDENCE = 0.7;
/** Re-claim while the page is open so the claim doesn't expire mid-review. */
const CLAIM_HEARTBEAT_MS = 10 * 60_000;
const OPEN_STATUSES: Referral['status'][] = ['uploaded', 'extracting', 'needs_review', 'failed'];

/**
 * M2: the file is fetched with the signed-in user's credentials (`getBlob`, checked by the
 * Storage rules) and shown from an object URL, instead of a long-lived `getDownloadURL`
 * token URL that works for anyone who gets hold of it.
 */
function DocumentViewer({ referral }: { referral: Referral }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { storagePath } = referral;
  useEffect(() => {
    if (!storagePath) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    setUrl(null);
    setError(null);
    getBlob(storageRef(storage, storagePath))
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => !cancelled && setError("Couldn't load the document. Check your connection and reload."));
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [storagePath]);

  if (!storagePath) {
    return (
      <div className="banner banner-info">
        Phone referral{referral.source === 'phone' ? '' : ' (no file)'}: there is no document. Verify the details with the referral source.
      </div>
    );
  }
  if (error) return <ErrorBanner error={error} />;
  if (!url) return <Loading label="Loading document…" />;
  if ((referral.contentType ?? '').startsWith('image/')) {
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
  const now = useNow(15_000);
  const { data: referral, loading, error: loadError } = useLiveDoc<Referral>(
    orgDoc(s.orgId, 'referrals', referralId),
    [s.orgId, referralId],
  );

  const [patient, setPatient] = useState<PatientInput | null>(null);
  const [meta, setMeta] = useState<{ referralDate: string; referralSource: string; reasonForReferral: string } | null>(null);
  const [confirmNotDuplicate, setConfirmNotDuplicate] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [closing, setClosing] = useState(false);
  const [acceptedPatientId, setAcceptedPatientId] = useState<string | null>(null);

  // Seed the editable form once extraction data arrives (don't clobber edits on later snapshots).
  const hasExtracted = !!referral?.extracted;
  useEffect(() => {
    if (referral && patient === null && (hasExtracted || referral.status === 'failed')) {
      setPatient(toPatientInput(referral.extracted?.patient));
      setMeta({
        referralDate: referral.extracted?.referralDate ?? '',
        referralSource: referral.extracted?.referralSource ?? '',
        reasonForReferral: referral.extracted?.reasonForReferral ?? '',
      });
    }
  }, [referral, hasExtracted, patient]);

  // I2: claim the review while the page is open; show who else is reviewing.
  const status = referral?.status;
  const holder = referral ? activeClaimant(referral, now) : null;
  const mine = holder === s.user.uid;
  const otherReviewer = holder && !mine ? holder : null;
  const isOpen = !!status && OPEN_STATUSES.includes(status);
  const mineRef = useRef(false);
  mineRef.current = mine;

  async function claim(force = false) {
    try {
      await call<ClaimReferralRequest, ClaimReferralResponse>('claimReferral', { orgId: s.orgId, referralId, force });
    } catch (err) {
      if (force) setError(errorMessage(err));
    }
  }
  useEffect(() => {
    if (isOpen && holder === null) void claim(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, holder === null, referralId]);
  useEffect(() => {
    if (!mine || !isOpen) return;
    const t = window.setInterval(() => void claim(false), CLAIM_HEARTBEAT_MS);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mine, isOpen, referralId]);
  useEffect(
    () => () => {
      if (mineRef.current) {
        void call<ClaimReferralRequest, ClaimReferralResponse>('claimReferral', { orgId: s.orgId, referralId, release: true }).catch(() => undefined);
      }
    },
    [s.orgId, referralId],
  );

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
  const stale = isStaleReferral(referral, now);
  const duplicates = referral.possibleDuplicates ?? [];
  const admitTarget = acceptedPatientId ?? referral.patientId;
  const canEdit = reviewable && !admitTarget && !otherReviewer;
  const lowMeta = (k: string) => ((confidence[k] ?? 1) < LOW_CONFIDENCE ? 'field-warn' : '');

  async function accept() {
    if (!patient || !meta) return;
    const p = normalizePatientInput(patient);
    if (!p.firstName || !p.lastName) return setError('First and last name are required.');
    if (duplicates.length > 0 && !confirmNotDuplicate) return setError('Review the possible duplicates and confirm this is not one of them.');
    setBusy('accept');
    setError(null);
    try {
      const res = await call<AcceptReferralRequest, AcceptReferralResponse>('acceptReferral', {
        orgId: s.orgId,
        referralId,
        patient: p,
        referralDate: meta.referralDate || null,
        referralSource: meta.referralSource.trim() || null,
        reasonForReferral: meta.reasonForReferral.trim() || null,
        confirmNotDuplicate,
      });
      setAcceptedPatientId(res.patientId);
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
      setMeta(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

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
      {otherReviewer && isOpen && (
        <div className="banner banner-warn row space-between">
          <span>
            <strong>{s.memberName(otherReviewer)} is reviewing</strong> this referral (since {formatInstant(referral.claimedAt ?? null)}). You can look, but only the reviewer can accept or reject it.
          </span>
          <Button small onClick={() => void claim(true)}>Take over</Button>
        </div>
      )}
      {admitTarget && referral.status === 'accepted' && (
        <div className="banner banner-ok row space-between">
          <span>Referral accepted — a referral-status patient was created.</span>
          <div className="row gap-sm">
            <Button small onClick={() => navigate(`/patients/${admitTarget}`)}>View patient</Button>
            <Button small onClick={() => setClosing(true)}>Non-admit…</Button>
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
            {referral.source === 'phone' ? 'Phone referral' : referral.fileName} · received {formatInstant(referral.createdAt)} by {s.memberName(referral.uploadedBy)}
            {referral.model && <> · extracted by {referral.model}</>}
          </div>

          {(referral.status === 'uploaded' || referral.status === 'extracting') && (
            stale ? (
              <div className="banner banner-error row space-between">
                <span>Extraction looks stuck (no progress for several minutes). Retry it, or reject the referral.</span>
                <div className="row gap-sm">
                  <Button small busy={busy === 'retry'} onClick={() => void retry()}>Retry extraction</Button>
                  <Button small variant="danger" disabled={!!otherReviewer} onClick={() => setRejecting(true)}>Reject</Button>
                </div>
              </div>
            ) : (
              <div className="banner banner-info">
                {referral.status === 'uploaded' ? 'Waiting for extraction to start…' : 'Extracting fields with AI…'} This page updates automatically.
              </div>
            )
          )}
          {referral.status === 'failed' && (
            <div className="banner banner-error row space-between">
              <span>Extraction failed{referral.error ? `: ${referral.error}` : '.'} You can retry or enter the fields manually.</span>
              {referral.storagePath && <Button small busy={busy === 'retry'} onClick={() => void retry()}>Retry extraction</Button>}
            </div>
          )}
          {referral.status === 'rejected' && (
            <div className="banner banner-warn">
              Rejected by {s.memberName(referral.reviewedBy)}{referral.rejectionReason ? `: ${referral.rejectionReason}` : ''}
            </div>
          )}
          {referral.status === 'non_admit' && referral.nonAdmit && (
            <div className="banner banner-warn">
              Closed as a non-admit by {s.memberName(referral.nonAdmit.closedBy)}: {NON_ADMIT_REASON_LABELS[referral.nonAdmit.reason]}
              {referral.nonAdmit.deathDate ? ` (died ${formatDate(referral.nonAdmit.deathDate)})` : ''}
              {referral.nonAdmit.note ? ` — ${referral.nonAdmit.note}` : ''}
            </div>
          )}

          {referral.status !== 'accepted' && (
            <DuplicateBanner
              matches={duplicates}
              confirmed={confirmNotDuplicate}
              onConfirm={canEdit ? setConfirmNotDuplicate : undefined}
            />
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

          {meta && (
            <div className="form-grid">
              <Field label="Referral date" className={lowMeta('referralDate')}>
                <input type="date" value={meta.referralDate} disabled={!canEdit} onChange={(e) => setMeta({ ...meta, referralDate: e.target.value })} />
              </Field>
              <Field label="Referral source" className={lowMeta('referralSource')}>
                <input value={meta.referralSource} disabled={!canEdit} onChange={(e) => setMeta({ ...meta, referralSource: e.target.value })} />
              </Field>
              <Field label="Reason for referral" className={lowMeta('reasonForReferral')}>
                <input value={meta.reasonForReferral} disabled={!canEdit} onChange={(e) => setMeta({ ...meta, reasonForReferral: e.target.value })} />
              </Field>
            </div>
          )}

          {patient && <PatientForm value={patient} onChange={setPatient} isLow={isLow} readOnly={!canEdit} />}

          {canEdit && patient && (
            <div className="row gap end sticky-actions">
              <Button variant="danger" onClick={() => setRejecting(true)} disabled={!!busy}>Reject</Button>
              <Button onClick={() => setClosing(true)} disabled={!!busy}>Non-admit…</Button>
              <Button
                variant="primary"
                busy={busy === 'accept'}
                disabled={duplicates.length > 0 && !confirmNotDuplicate}
                onClick={() => void accept()}
              >
                Accept referral
              </Button>
            </div>
          )}
        </div>
      </div>

      {rejecting && <RejectReferralModal orgId={s.orgId} referralId={referralId} onClose={() => setRejecting(false)} />}
      {closing && <NonAdmitModal orgId={s.orgId} referralId={referralId} onClose={() => setClosing(false)} />}
    </Page>
  );
}
