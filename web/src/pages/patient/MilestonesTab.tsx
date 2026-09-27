import { useState } from 'react';
import type { CompleteMilestoneRequest, Patient, ReopenMilestoneRequest } from '@shared/types';
import { useOrgSession } from '../../lib/session';
import type { WithId } from '../../lib/firestore';
import { useAction } from '../../lib/hooks';
import { call } from '../../lib/firebase';
import { CLINICAL_ROLES } from '../../lib/constants';
import { daysBetween, dueState, formatDate, formatInstant, optStr, toISODate, todayISO, tsToDate } from '../../lib/format';
import { canCompleteMilestoneKind, useIsLicensed } from '../../lib/lifecycle';
import { currentBenefitPeriodNumber, deadlinesOf, milestoneKey, MILESTONE_LABELS, type Deadline } from '../../lib/milestones';
import { Badge, Button, Card, ErrorBanner, Field, Modal, Table } from '../../components/ui';

function CompleteModal({ patient, deadline, onClose }: { patient: WithId<Patient>; deadline: Deadline; onClose: () => void }) {
  const s = useOrgSession();
  const act = useAction();
  const [note, setNote] = useState('');
  const today = todayISO();
  const [effectiveDate, setEffectiveDate] = useState(today);
  const key = milestoneKey(deadline);
  async function submit() {
    if (!effectiveDate) return act.setError('Enter the date it was filed or completed.');
    if (effectiveDate > today) return act.setError('The filing date cannot be in the future.');
    const req: CompleteMilestoneRequest = { orgId: s.orgId, patientId: patient.id, key, effectiveDate };
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
      <Field label="Date filed / completed" hint="The actual filing date. On time is judged from this date, not from when you record it.">
        <input type="date" required max={today} value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} />
      </Field>
      {effectiveDate > deadline.due && <div className="banner banner-warn small">This date is after the due date; it will be recorded as late.</div>}
      <Field label="Note (optional)" hint="e.g. confirmation number, who filed it.">
        <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </Modal>
  );
}

function statusOf(p: Patient, d: Deadline): { tone: string; label: string } {
  const c = p.milestoneCompletions?.[milestoneKey(d)];
  if (c) {
    // S5: on time is judged from the filing date (effectiveDate). Older completions fall back to the
    // browser-local date of completedAt (the server compares those in the org time zone).
    const done = c.effectiveDate ?? (tsToDate(c.completedAt) ? toISODate(tsToDate(c.completedAt)!) : null);
    const late = done ? daysBetween(d.due, done) > 0 : false;
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
  const clinical = CLINICAL_ROLES.includes(s.role);
  const licensed = useIsLicensed();
  const m = patient.milestones;
  if (!m) return <Card><p className="muted">Milestones are computed at admission.</p></Card>;
  const rows = deadlinesOf(m);
  const currentBp = currentBenefitPeriodNumber(m);

  async function doReopen(d: Deadline) {
    const reason = window.prompt(`Reopen "${d.label}"? The completion is kept in the milestone history.\n\nReason (optional):`, '');
    if (reason === null) return;
    const req: ReopenMilestoneRequest = { orgId: s.orgId, patientId: patient.id, key: milestoneKey(d) };
    const r = optStr(reason);
    if (r) req.reason = r;
    await reopen.run(() => call<ReopenMilestoneRequest, unknown>('reopenMilestone', req));
  }
  const history = [...(patient.milestoneHistory ?? [])].reverse();

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
                return c
                  ? `${st} — filed ${c.effectiveDate ?? ''} — ${s.memberName(c.completedBy)} ${formatInstant(c.completedAt)}${c.note ? ` — ${c.note}` : ''}`
                  : st;
              },
              cell: (d) => {
                const st = statusOf(patient, d);
                const c = patient.milestoneCompletions?.[milestoneKey(d)];
                return (
                  <>
                    <Badge tone={st.tone}>{st.label}</Badge>
                    {c && (
                      <div className="muted small">
                        {c.effectiveDate && <>Filed {formatDate(c.effectiveDate)} · </>}
                        recorded by {s.memberName(c.completedBy)} · {formatInstant(c.completedAt)}
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
                !clinical ? null : patient.milestoneCompletions?.[milestoneKey(d)] ? (
                  licensed ? <Button small variant="ghost" busy={reopen.busy} onClick={() => void doReopen(d)}>Reopen</Button> : null
                ) : canCompleteMilestoneKind(licensed, s.role, d.kind) ? (
                  <Button small variant="primary" onClick={() => setCompleting(d)}>Mark filed/completed</Button>
                ) : null,
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
      {history.length > 0 && (
        <Card title="Milestone history">
          <Table
            rows={history}
            rowKey={(h) => `${h.key}-${formatInstant(h.reopenedAt)}`}
            exportName="milestone-history"
            columns={[
              {
                header: 'Milestone',
                csv: (h) => h.key,
                cell: (h) => {
                  const kind = h.key.split(':')[0] as keyof typeof MILESTONE_LABELS;
                  return (
                    <>
                      <strong>{MILESTONE_LABELS[kind] ?? kind}</strong>
                      <div className="mono muted small">{h.key}</div>
                    </>
                  );
                },
              },
              {
                header: 'Was completed',
                csv: (h) => `${h.effectiveDate ?? ''} ${s.memberName(h.completedBy)} ${formatInstant(h.completedAt)}`,
                cell: (h) => (
                  <span className="small">
                    {h.effectiveDate && <>Filed {formatDate(h.effectiveDate)} · </>}
                    {s.memberName(h.completedBy)} · {formatInstant(h.completedAt)}
                    {h.note && <div className="muted">“{h.note}”</div>}
                  </span>
                ),
              },
              {
                header: 'Reopened',
                csv: (h) => `${s.memberName(h.reopenedBy)} ${formatInstant(h.reopenedAt)}${h.reopenReason ? ` — ${h.reopenReason}` : ''}`,
                cell: (h) => (
                  <span className="small">
                    {s.memberName(h.reopenedBy)} · {formatInstant(h.reopenedAt)}
                    {h.reopenReason && <div className="muted">“{h.reopenReason}”</div>}
                  </span>
                ),
              },
            ]}
          />
        </Card>
      )}
      {completing && <CompleteModal patient={patient} deadline={completing} onClose={() => setCompleting(null)} />}
    </>
  );
}
