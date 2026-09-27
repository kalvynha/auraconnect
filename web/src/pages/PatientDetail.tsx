import { useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { orderBy, query, where } from 'firebase/firestore';
import type { Consents, Patient, PatientEvent, PatientEventType, Task } from '@shared/types';
import { useOrgSession } from '../lib/session';
import { orgCol, orgDoc, type WithId } from '../lib/firestore';
import { useLiveDoc, useLiveQuery } from '../lib/hooks';
import { CLINICAL_ROLES, DISCHARGE_REASON_LABELS, INTAKE_ROLES, LEVEL_OF_CARE_LABELS } from '../lib/constants';
import { dueState, formatDate, formatInstant } from '../lib/format';
import { currentBenefitPeriodNumber, milestoneKey, openDeadlines } from '../lib/milestones';
import { patientName } from '../lib/patient';
import { Badge, Button, Card, ErrorBanner, Loading, Page, Table, Tabs, Timeline, type TabDef } from '../components/ui';
import { TaskEditorModal, TaskTable } from '../components/tasks';
import { LifecycleModal, type LifecycleAction } from './patient/Lifecycle';
import { MilestonesTab } from './patient/MilestonesTab';
import { VisitsTab } from './patient/VisitsTab';
import { DocumentsTab } from './patient/DocumentsTab';

const CONSENT_LABELS: Record<keyof Consents, string> = {
  electionStatement: 'Hospice election statement',
  hipaaNotice: 'HIPAA notice of privacy practices',
  releaseOfInformation: 'Release of information',
  patientRights: 'Patient rights & responsibilities',
  polstOnFile: 'POLST / DNR form on file',
};

type TabKey = 'overview' | 'timeline' | 'milestones' | 'visits' | 'tasks' | 'documents' | 'careteam';
const TAB_KEYS: TabKey[] = ['overview', 'timeline', 'milestones', 'visits', 'tasks', 'documents', 'careteam'];

const EVENT_TONES: Record<PatientEventType, string> = {
  admission: 'ok',
  level_of_care_change: 'info',
  recertification: 'accent',
  discharge: 'neutral',
  death: 'neutral',
};

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

function OverviewTab({ p }: { p: WithId<Patient> }) {
  const addr = [p.address.line1, p.address.line2, [p.address.city, p.address.state].filter(Boolean).join(', '), p.address.zip]
    .filter(Boolean)
    .join(' · ');
  // Every overdue deadline (no look-back cap) plus those due in the next 14 days.
  const openDl = openDeadlines(p).filter((d) => d.overdue || d.diff <= 14);
  return (
    <>
      {(p.status === 'discharged' || p.status === 'deceased') && (
        <Card title={p.status === 'deceased' ? 'Death' : 'Discharge'}>
          {p.status === 'deceased' && p.death ? (
            <DL
              items={[
                ['Date', formatDate(p.death.date)],
                ['Time', p.death.time],
                ['Pronounced by', p.death.pronouncedBy],
                ['Location', p.death.location],
                ['Notes', p.death.notes],
                ['Bereavement plan', p.bereavementPlanId ? <Link to="/bereavement">View plan</Link> : null],
              ]}
            />
          ) : (
            <DL
              items={[
                ['Discharge date', formatDate(p.dischargeDate ?? null)],
                ['Reason', p.dischargeReason ? DISCHARGE_REASON_LABELS[p.dischargeReason] : null],
              ]}
            />
          )}
        </Card>
      )}
      {p.status === 'admitted' && (
        <Card title="Care status">
          <DL
            items={[
              ['Level of care', LEVEL_OF_CARE_LABELS[p.levelOfCare]],
              ['Benefit period', currentBenefitPeriodNumber(p.milestones)],
              ['Last IDG review', formatDate(p.lastIdgReviewDate ?? null)],
              [
                'Next IDG review due',
                p.nextIdgDueDate ? (
                  <>
                    {formatDate(p.nextIdgDueDate)}{' '}
                    {dueState(p.nextIdgDueDate, 3) === 'overdue' && <Badge tone="danger">overdue</Badge>}
                  </>
                ) : null,
              ],
              [
                'Open deadlines',
                openDl.length ? (
                  <span className="row gap-sm wrap">
                    {openDl.map((d) => (
                      <Badge key={milestoneKey(d)} tone={d.overdue ? 'danger' : 'warn'}>
                        {d.label} · {formatDate(d.due)}
                      </Badge>
                    ))}
                  </span>
                ) : (
                  'None overdue or due in the next 14 days'
                ),
              ],
            ]}
          />
        </Card>
      )}
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
      </div>
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
    </>
  );
}

function TimelineTab({ p }: { p: WithId<Patient> }) {
  const s = useOrgSession();
  const events = useLiveQuery<PatientEvent>(
    query(orgCol(s.orgId, 'patients', p.id, 'events'), orderBy('createdAt', 'desc')),
    [s.orgId, p.id],
  );
  const items = [...events.data]
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((e) => ({
      id: e.id,
      tone: EVENT_TONES[e.type] ?? 'neutral',
      when: (
        <>
          {formatDate(e.date)} · recorded by {s.memberName(e.recordedBy)} · {formatInstant(e.createdAt)}
        </>
      ),
      title: (
        <>
          <Badge tone={EVENT_TONES[e.type] ?? 'neutral'}>{e.type.replace(/_/g, ' ')}</Badge> {e.summary}
        </>
      ),
    }));
  return (
    <Card title="Timeline">
      <ErrorBanner error={events.error} />
      {events.loading ? <Loading /> : <Timeline items={items} empty="No timeline events yet. Admission, level-of-care, recertification, discharge and death events appear here." />}
    </Card>
  );
}

function TasksTab({ p }: { p: WithId<Patient> }) {
  const s = useOrgSession();
  const tasks = useLiveQuery<Task>(query(orgCol(s.orgId, 'tasks'), where('patientId', '==', p.id)), [s.orgId, p.id]);
  const [editing, setEditing] = useState<WithId<Task> | 'new' | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const rows = useMemo(
    () =>
      tasks.data
        .filter((t) => showClosed || t.status === 'open')
        .sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999')),
    [tasks.data, showClosed],
  );
  return (
    <Card
      title="Tasks"
      actions={
        <>
          <label className="row gap-sm small">
            <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} /> Show completed / cancelled
          </label>
          {s.role !== 'viewer' && <Button small variant="primary" onClick={() => setEditing('new')}>New task</Button>}
        </>
      }
    >
      <ErrorBanner error={tasks.error} />
      <TaskTable rows={rows} showPatient={false} onEdit={setEditing} empty={tasks.loading ? 'Loading…' : 'No tasks.'} />
      {editing && <TaskEditorModal task={editing === 'new' ? null : editing} patientId={p.id} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function CareTeamTab({ p }: { p: WithId<Patient> }) {
  const s = useOrgSession();
  return (
    <div className="grid-2">
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
      </Card>
      <Card title="Consents">
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
  );
}

export default function PatientDetailPage() {
  const { patientId = '' } = useParams();
  const s = useOrgSession();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [lifecycle, setLifecycle] = useState<LifecycleAction | null>(null);
  const { data: p, loading, error } = useLiveDoc<Patient>(orgDoc(s.orgId, 'patients', patientId), [s.orgId, patientId]);

  const rawTab = params.get('tab') as TabKey | null;
  const tab: TabKey = rawTab && TAB_KEYS.includes(rawTab) ? rawTab : 'overview';
  const setTab = (k: TabKey) => setParams(k === 'overview' ? {} : { tab: k }, { replace: true });

  if (loading) return <Loading />;
  if (!p) return <Page title="Patient"><ErrorBanner error={error ?? 'Patient not found.'} /></Page>;

  const currentBp = currentBenefitPeriodNumber(p.milestones);
  const canAdmit = INTAKE_ROLES.includes(s.role) && p.status === 'referral';
  const clinical = CLINICAL_ROLES.includes(s.role);
  const canLifecycle = clinical && p.status === 'admitted';
  const archived = p.status === 'discharged' || p.status === 'deceased';
  const overdueCount = openDeadlines(p).filter((d) => d.overdue).length;

  const tabs: TabDef<TabKey>[] = [
    { key: 'overview', label: 'Overview' },
    { key: 'timeline', label: 'Timeline' },
    { key: 'milestones', label: <>Milestones{overdueCount > 0 && <span className="tab-count danger">{overdueCount}</span>}</> },
    { key: 'visits', label: 'Visits' },
    { key: 'tasks', label: 'Tasks' },
    { key: 'documents', label: 'Documents' },
    { key: 'careteam', label: 'Care team' },
  ];

  return (
    <Page
      title={patientName(p)}
      actions={
        <>
          {p.channelId && (
            <Button onClick={() => navigate(`/messages/${p.channelId}`)}>
              Care team chat{archived ? ' (archived, read-only)' : ''}
            </Button>
          )}
          {canAdmit && <Button variant="primary" onClick={() => navigate(`/patients/${p.id}/admit`)}>Admit patient</Button>}
        </>
      }
    >
      <ErrorBanner error={error} />
      <div className="row gap wrap summary">
        <Badge value={p.status} />
        {p.status === 'admitted' && <span>{LEVEL_OF_CARE_LABELS[p.levelOfCare]}</span>}
        {p.admissionDate && <span className="muted">Admitted {formatDate(p.admissionDate)}</span>}
        {currentBp && p.status === 'admitted' && <span className="muted">Benefit period {currentBp}</span>}
        <span className="muted">Code status: <strong>{p.codeStatus}</strong></span>
        {p.referralId && <Link to={`/referrals/${p.referralId}`}>Source referral</Link>}
      </div>
      {canLifecycle && (
        <div className="row gap-sm wrap lifecycle-actions">
          <span className="muted small">Lifecycle:</span>
          <Button small onClick={() => setLifecycle('loc')}>Change level of care</Button>
          <Button small onClick={() => setLifecycle('recert')}>Record recertification</Button>
          <Button small onClick={() => setLifecycle('discharge')}>Discharge</Button>
          <Button small variant="danger" onClick={() => setLifecycle('death')}>Record death</Button>
        </div>
      )}

      <Tabs tabs={tabs} value={tab} onChange={setTab} />

      {tab === 'overview' && <OverviewTab p={p} />}
      {tab === 'timeline' && <TimelineTab p={p} />}
      {tab === 'milestones' && <MilestonesTab patient={p} />}
      {tab === 'visits' && <VisitsTab patient={p} />}
      {tab === 'tasks' && <TasksTab p={p} />}
      {tab === 'documents' && <DocumentsTab patient={p} />}
      {tab === 'careteam' && <CareTeamTab p={p} />}

      <p className="muted small">Record created {formatInstant(p.createdAt)} · updated {formatInstant(p.updatedAt)}</p>
      {lifecycle && <LifecycleModal action={lifecycle} patient={p} onClose={() => setLifecycle(null)} />}
    </Page>
  );
}
