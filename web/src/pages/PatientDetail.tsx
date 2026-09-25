import type { ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Consents, Patient } from '@shared/types';
import { useOrgSession } from '../lib/session';
import { orgDoc } from '../lib/firestore';
import { useLiveDoc } from '../lib/hooks';
import { INTAKE_ROLES, LEVEL_OF_CARE_LABELS } from '../lib/constants';
import { dueState, formatDate, formatInstant, todayISO, type DueState } from '../lib/format';
import { currentBenefitPeriodNumber } from '../lib/milestones';
import { patientName } from '../lib/patient';
import { Badge, Button, Card, ErrorBanner, Loading, Page, Table } from '../components/ui';

const CONSENT_LABELS: Record<keyof Consents, string> = {
  electionStatement: 'Hospice election statement',
  hipaaNotice: 'HIPAA notice of privacy practices',
  releaseOfInformation: 'Release of information',
  patientRights: 'Patient rights & responsibilities',
  polstOnFile: 'POLST / DNR form on file',
};

function DueBadge({ due, windowStart }: { due: string | null; windowStart?: string | null }) {
  if (!due) return null;
  const state: DueState = dueState(due);
  const today = todayISO();
  if (state === 'overdue') return <Badge tone="danger">past due</Badge>;
  if (windowStart && today < windowStart) return <Badge tone="neutral">upcoming</Badge>;
  if (state === 'soon') return <Badge tone="warn">due soon</Badge>;
  if (windowStart && today >= windowStart) return <Badge tone="info">window open</Badge>;
  return null;
}

function DL({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="dl">
      {items.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v === null || v === undefined || v === '' ? <span className="muted">—</span> : v}</dd>
        </div>
      ))}
    </dl>
  );
}

export default function PatientDetailPage() {
  const { patientId = '' } = useParams();
  const s = useOrgSession();
  const navigate = useNavigate();
  const { data: p, loading, error } = useLiveDoc<Patient>(orgDoc(s.orgId, 'patients', patientId), [s.orgId, patientId]);

  if (loading) return <Loading />;
  if (!p) return <Page title="Patient"><ErrorBanner error={error ?? 'Patient not found.'} /></Page>;

  const m = p.milestones;
  const currentBp = currentBenefitPeriodNumber(m);
  const canAdmit = INTAKE_ROLES.includes(s.role) && p.status === 'referral';
  const addr = [p.address.line1, p.address.line2, [p.address.city, p.address.state].filter(Boolean).join(', '), p.address.zip]
    .filter(Boolean)
    .join(' · ');

  return (
    <Page
      title={patientName(p)}
      actions={
        <>
          {p.channelId && <Button onClick={() => navigate(`/messages/${p.channelId}`)}>Care team chat</Button>}
          {canAdmit && <Button variant="primary" onClick={() => navigate(`/patients/${p.id}/admit`)}>Admit patient</Button>}
        </>
      }
    >
      <ErrorBanner error={error} />
      <div className="row gap wrap summary">
        <Badge value={p.status} />
        {p.status === 'admitted' && <span>{LEVEL_OF_CARE_LABELS[p.levelOfCare]}</span>}
        {p.admissionDate && <span className="muted">Admitted {formatDate(p.admissionDate)}</span>}
        {currentBp && <span className="muted">Benefit period {currentBp}</span>}
        <span className="muted">Code status: <strong>{p.codeStatus}</strong></span>
        {p.referralId && <Link to={`/referrals/${p.referralId}`}>Source referral</Link>}
      </div>

      <div className="grid-2">
        <Card title="Demographics">
          <DL
            items={[
              ['Date of birth', formatDate(p.dob)],
              ['Sex', p.sex],
              ['Phone', p.phone],
              ['Address', addr],
              ['MRN', p.mrn],
              ['Medicare MBI', p.medicareMbi],
              ['Insurance', [p.insurance.payer, p.insurance.memberId].filter(Boolean).join(' · ')],
              ['Caregiver', p.caregiver ? [p.caregiver.name, p.caregiver.relationship, p.caregiver.phone].filter(Boolean).join(' · ') : null],
              ['Referring physician', p.referringPhysician ? [p.referringPhysician.name, p.referringPhysician.npi && `NPI ${p.referringPhysician.npi}`, p.referringPhysician.phone].filter(Boolean).join(' · ') : null],
              ['Attending physician', p.attendingPhysician ? [p.attendingPhysician.name, p.attendingPhysician.npi && `NPI ${p.attendingPhysician.npi}`, p.attendingPhysician.phone].filter(Boolean).join(' · ') : null],
            ]}
          />
        </Card>

        <Card title="Care team">
          {p.careTeamUids.length === 0 ? (
            <p className="muted">No care team assigned.</p>
          ) : (
            <ul className="list">
              {p.careTeamUids.map((uid) => {
                const mem = s.members.find((x) => (x.uid ?? x.id) === uid);
                return (
                  <li key={uid} className="list-row">
                    <span>{s.memberName(uid)}</span>
                    <span className="muted">{mem?.discipline}</span>
                  </li>
                );
              })}
            </ul>
          )}
          <h3>Consents</h3>
          {p.consents ? (
            <ul className="checklist">
              {(Object.keys(CONSENT_LABELS) as (keyof Consents)[]).map((k) => (
                <li key={k} className={p.consents![k] ? 'yes' : 'no'}>
                  <span>{p.consents![k] ? '✓' : '✗'}</span> {CONSENT_LABELS[k]}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No consents recorded.</p>
          )}
        </Card>
      </div>

      <div className="grid-2">
        <Card title="Diagnoses">
          {p.primaryDiagnosis ? (
            <p>
              <strong>{p.primaryDiagnosis.description}</strong>{' '}
              {p.primaryDiagnosis.code && <span className="mono muted">{p.primaryDiagnosis.code}</span>}
            </p>
          ) : (
            <p className="muted">No primary diagnosis.</p>
          )}
          {p.secondaryDiagnoses.length > 0 && (
            <ul>
              {p.secondaryDiagnoses.map((d, i) => (
                <li key={i}>
                  {d.description} {d.code && <span className="mono muted">{d.code}</span>}
                </li>
              ))}
            </ul>
          )}
          <h3>Allergies</h3>
          <p>{p.allergies.length ? p.allergies.join(', ') : <span className="muted">None recorded (NKDA not confirmed)</span>}</p>
        </Card>
        <Card title="Medications">
          <Table
            rows={p.medications.map((med, i) => ({ ...med, i }))}
            rowKey={(r) => String(r.i)}
            empty="No medications recorded."
            columns={[
              { header: 'Name', cell: (r) => r.name },
              { header: 'Dose', cell: (r) => r.dose ?? '—' },
              { header: 'Route', cell: (r) => r.route ?? '—' },
              { header: 'Frequency', cell: (r) => r.frequency ?? '—' },
            ]}
          />
        </Card>
      </div>

      <Card title="Hospice milestones">
        {!m ? (
          <p className="muted">Milestones are computed at admission.</p>
        ) : (
          <>
            <div className="milestones">
              <div className={`milestone ms-${dueState(m.noeDueDate)}`}>
                <div className="ms-label">NOE due</div>
                <div className="ms-date">{formatDate(m.noeDueDate)}</div>
                <DueBadge due={m.noeDueDate} />
              </div>
              <div className={`milestone ms-${dueState(m.hopeAdmissionDue)}`}>
                <div className="ms-label">HOPE admission</div>
                <div className="ms-date">{formatDate(m.hopeAdmissionDue)}</div>
                <DueBadge due={m.hopeAdmissionDue} />
              </div>
              <div className={`milestone ms-${dueState(m.hopeHuv1Window.end)}`}>
                <div className="ms-label">HOPE HUV1 window</div>
                <div className="ms-date">
                  {formatDate(m.hopeHuv1Window.start)} – {formatDate(m.hopeHuv1Window.end)}
                </div>
                <DueBadge due={m.hopeHuv1Window.end} windowStart={m.hopeHuv1Window.start} />
              </div>
              <div className={`milestone ms-${dueState(m.hopeHuv2Window.end)}`}>
                <div className="ms-label">HOPE HUV2 window</div>
                <div className="ms-date">
                  {formatDate(m.hopeHuv2Window.start)} – {formatDate(m.hopeHuv2Window.end)}
                </div>
                <DueBadge due={m.hopeHuv2Window.end} windowStart={m.hopeHuv2Window.start} />
              </div>
            </div>
            <h3>Benefit periods</h3>
            <Table
              rows={m.benefitPeriods}
              rowKey={(bp) => String(bp.number)}
              rowClassName={(bp) => (bp.number === currentBp ? 'row-current' : undefined)}
              columns={[
                { header: 'Period', cell: (bp) => <>{bp.number}{bp.number === currentBp && <> <Badge tone="info">current</Badge></>}</> },
                { header: 'Start', cell: (bp) => formatDate(bp.start) },
                { header: 'End (recert due)', cell: (bp) => <>{formatDate(bp.end)} <DueBadge due={bp.end} windowStart={bp.start} /></> },
                { header: 'Length', cell: (bp) => `${bp.lengthDays} days` },
                {
                  header: 'Face-to-face',
                  cell: (bp) =>
                    bp.f2fRequired ? (
                      <>
                        {formatDate(bp.f2fWindowStart)} – {formatDate(bp.f2fDueBy)}{' '}
                        <DueBadge due={bp.f2fDueBy} windowStart={bp.f2fWindowStart} />
                      </>
                    ) : (
                      <span className="muted">Not required</span>
                    ),
                },
              ]}
            />
            <p className="muted small">
              Computed {formatDate(m.computedAt)}. Milestone rules follow CMS hospice regulations as understood at build
              time and must be verified by compliance staff.
            </p>
          </>
        )}
      </Card>
      <p className="muted small">Record created {formatInstant(p.createdAt)} · updated {formatInstant(p.updatedAt)}</p>
    </Page>
  );
}
