import { useState } from 'react';
import type { CompleteMilestoneRequest, Patient, ReopenMilestoneRequest } from '@shared/types';
import { useOrgSession } from '../../lib/session';
import type { WithId } from '../../lib/firestore';
import { useAction } from '../../lib/hooks';
import { call } from '../../lib/firebase';
import { CLINICAL_ROLES } from '../../lib/constants';
import { daysBetween, dueState, formatDate, formatInstant, optStr, toISODate, todayISO, tsToDate } from '../../lib/format';
import { currentBenefitPeriodNumber, deadlinesOf, milestoneKey, type Deadline } from '../../lib/milestones';
import { Badge, Button, Card, ErrorBanner, Field, Modal, Table } from '../../components/ui';

function CompleteModal({ patient, deadline, onClose }: { patient: WithId<Patient>; deadline: Deadline; onClose: () => void }) {
  const s = useOrgSession();
  const act = useAction();
  const [note, setNote] = useState('');
  const key = milestoneKey(deadline);
  async function submit() {
    const req: CompleteMilestoneRequest = { orgId: s.orgId, patientId: patient.id, key };
    const n = optStr(note);
    if (n) req.note = n;
    if (await act.run(() => call<CompleteMilestoneRequest, unknown>('completeMilestone', req))) onClose();
  }
  return (
    <Modal
      title="Mark filed / completed"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={act.busy} onClick={() => void submit()}>Mark completed</Button>
        </>
      }
    >
      <ErrorBanner error={act.error} />
      <p>
        <strong>{deadline.label}</strong> · due {formatDate(deadline.due)} <span className="mono muted small">{key}</span>
      </p>
      <Field label="Note (optional)" hint="e.g. confirmation number, who filed it.">
        <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </Modal>
  );
}

function statusOf(p: Patient, d: Deadline): { tone: string; label: string } {
  const c = p.milestoneCompletions?.[milestoneKey(d)];
  if (c) {
    const done = tsToDate(c.completedAt);
    // Approximate on-time check in the browser's zone; the server compares in the org time zone.
    const late = done ? daysBetween(d.due, toISODate(done)) > 0 : false;
    return { tone: 'ok', label: late ? 'completed (late)' : 'completed' };
  }
  const st = dueState(d.due);
  const today = todayISO();
  if (st === 'overdue') return { tone: 'danger', label: 'overdue' };
  if (st === 'soon') return { tone: 'warn', label: 'due soon' };
  if (d.windowStart && today >= d.windowStart) return { tone: 'info', label: 'window open' };
  return { tone: 'neutral', label: 'upcoming' };
}

export function MilestonesTab({ patient }: { patient: WithId<Patient> }) {
  const s = useOrgSession();
  const [completing, setCompleting] = useState<Deadline | null>(null);
  const reopen = useAction();
  const canEdit = CLINICAL_ROLES.includes(s.role);
  const m = patient.milestones;
  if (!m) return <Card><p className="muted">Milestones are computed at admission.</p></Card>;
  const rows = deadlinesOf(m);
  const currentBp = currentBenefitPeriodNumber(m);

  async function doReopen(d: Deadline) {
    if (!window.confirm(`Reopen "${d.label}"? Deadline reminders will resume for it.`)) return;
    await reopen.run(() =>
      call<ReopenMilestoneRequest, unknown>('reopenMilestone', { orgId: s.orgId, patientId: patient.id, key: milestoneKey(d) }),
    );
  }

  return (
    <>
      <Card title="Deadlines">
        <ErrorBanner error={reopen.error} />
        <Table
          rows={rows}
          rowKey={(d) => milestoneKey(d)}
          exportName="milestones"
          columns={[
            {
              header: 'Milestone',
              csv: (d) => `${d.label} (${milestoneKey(d)})`,
              cell: (d) => (
                <>
                  <strong>{d.label}</strong>
                  <div className="mono muted small">{milestoneKey(d)}</div>
                </>
              ),
            },
            {
              header: 'Due',
              csv: (d) => (d.windowStart ? `${d.windowStart} to ${d.due}` : d.due),
              cell: (d) => (
                <>
                  {formatDate(d.due)}
                  {d.windowStart && <div className="muted small">window opens {formatDate(d.windowStart)}</div>}
                </>
              ),
            },
            {
              header: 'Status',
              csv: (d) => {
                const c = patient.milestoneCompletions?.[milestoneKey(d)];
                const st = statusOf(patient, d).label;
                return c ? `${st} — ${s.memberName(c.completedBy)} ${formatInstant(c.completedAt)}${c.note ? ` — ${c.note}` : ''}` : st;
              },
              cell: (d) => {
                const st = statusOf(patient, d);
                const c = patient.milestoneCompletions?.[milestoneKey(d)];
                return (
                  <>
                    <Badge tone={st.tone}>{st.label}</Badge>
                    {c && (
                      <div className="muted small">
                        {s.memberName(c.completedBy)} · {formatInstant(c.completedAt)}
                        {c.note && <div>“{c.note}”</div>}
                      </div>
                    )}
                  </>
                );
              },
            },
            {
              header: '',
              className: 'actions',
              cell: (d) =>
                !canEdit ? null : patient.milestoneCompletions?.[milestoneKey(d)] ? (
                  <Button small variant="ghost" busy={reopen.busy} onClick={() => void doReopen(d)}>Reopen</Button>
                ) : (
                  <Button small variant="primary" onClick={() => setCompleting(d)}>Mark filed/completed</Button>
                ),
            },
          ]}
        />
        <p className="muted small">
          Computed {formatDate(m.computedAt)}. Milestone rules follow CMS hospice regulations as understood at build time and
          must be verified by compliance staff. “On time” is judged in the organization's time zone.
        </p>
      </Card>

      <Card title="Benefit periods">
        <Table
          rows={m.benefitPeriods}
          rowKey={(bp) => String(bp.number)}
          rowClassName={(bp) => (bp.number === currentBp ? 'row-current' : undefined)}
          columns={[
            { header: 'Period', cell: (bp) => <>{bp.number}{bp.number === currentBp && <> <Badge tone="info">current</Badge></>}</> },
            { header: 'Start', cell: (bp) => formatDate(bp.start) },
            { header: 'End (recert due)', cell: (bp) => formatDate(bp.end) },
            { header: 'Length', cell: (bp) => `${bp.lengthDays} days` },
            {
              header: 'Face-to-face',
              cell: (bp) =>
                bp.f2fRequired ? <>{formatDate(bp.f2fWindowStart)} – {formatDate(bp.f2fDueBy)}</> : <span className="muted">Not required</span>,
            },
          ]}
        />
      </Card>
      {completing && <CompleteModal patient={patient} deadline={completing} onClose={() => setCompleting(null)} />}
    </>
  );
}
