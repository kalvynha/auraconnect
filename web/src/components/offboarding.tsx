import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Discipline, Member, OffboardCounts, OffboardMemberRequest, OffboardMemberResponse } from '@shared/types';
import { useOrgSession } from '../lib/session';
import type { WithId } from '../lib/firestore';
import { useAction } from '../lib/hooks';
import { call } from '../lib/firebase';
import { DISCIPLINES } from '../lib/constants';
import { Badge, Button, ErrorBanner, Field, MemberSelect, Modal } from './ui';

const COUNT_LABELS: Record<keyof OffboardCounts, string> = {
  careTeams: 'Patient care teams',
  tasks: 'Open tasks',
  visits: 'Future visits',
  bereavementPlans: 'Bereavement plans',
  triageCalls: 'Open triage calls',
  shifts: 'Future on-call shifts',
  onCallRoles: 'On-call fallback lists',
  teams: 'Teams',
  volunteerAssignments: 'Volunteer assignments (ended)',
};

function CountsTable({ res }: { res: OffboardMemberResponse }) {
  const keys = Object.keys(COUNT_LABELS) as (keyof OffboardCounts)[];
  return (
    <table className="table">
      <thead>
        <tr><th>Work</th><th>Items</th><th>Left unassigned</th></tr>
      </thead>
      <tbody>
        {keys.map((k) => (
          <tr key={k} className={res.counts[k] === 0 ? 'row-muted' : undefined}>
            <td>{COUNT_LABELS[k]}</td>
            <td>{res.counts[k]}</td>
            <td>
              {res.unassigned[k] ? (
                <Badge tone="warn">{k === 'shifts' ? `${res.unassigned[k]} deleted` : res.unassigned[k]}</Badge>
              ) : (
                <span className="muted">—</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** L1: dry-run preview, then hand a member's work to replacements and deactivate them. */
export function OffboardWizard({ member, onClose }: { member: WithId<Member>; onClose: () => void }) {
  const s = useOrgSession();
  const act = useAction();
  const uid = member.uid ?? member.id;
  const others = s.members.filter((m) => (m.uid ?? m.id) !== uid);
  const [defaultUid, setDefaultUid] = useState('');
  const [byDiscipline, setByDiscipline] = useState<Partial<Record<Discipline, string>>>({});
  const [shiftAction, setShiftAction] = useState<'delete' | 'reassign'>('reassign');
  const [preview, setPreview] = useState<OffboardMemberResponse | null>(null);
  const [done, setDone] = useState<OffboardMemberResponse | null>(null);
  const [confirmText, setConfirmText] = useState('');

  const request = (dryRun: boolean): OffboardMemberRequest => {
    const map = Object.fromEntries(Object.entries(byDiscipline).filter(([, v]) => !!v)) as Partial<Record<Discipline, string>>;
    return {
      orgId: s.orgId,
      uid,
      reassignTo: { ...(defaultUid ? { default: defaultUid } : {}), ...(Object.keys(map).length ? { byDiscipline: map } : {}) },
      shiftAction,
      dryRun,
    };
  };

  async function runPreview() {
    setPreview(null);
    await act.run(async () => setPreview(await call<OffboardMemberRequest, OffboardMemberResponse>('offboardMember', request(true))));
  }

  async function runOffboard() {
    await act.run(async () => setDone(await call<OffboardMemberRequest, OffboardMemberResponse>('offboardMember', request(false))));
  }

  const edit = () => setPreview(null);
  const name = member.displayName || member.email;

  return (
    <Modal title={`Offboard ${name}`} onClose={onClose} wide>
      <ErrorBanner error={act.error} />
      {done ? (
        <div className="form">
          <div className="banner banner-ok">{name} was offboarded and deactivated. Their sign-in is revoked.</div>
          <CountsTable res={done} />
          {done.escalationPolicies.length > 0 && (
            <div className="banner banner-warn">
              Edit these escalation policies by hand; they still page {name} directly:{' '}
              {done.escalationPolicies.map((p) => p.name).join(', ')}. <Link to="/policies">Open escalation policies</Link>
            </div>
          )}
          <div className="row end"><Button variant="primary" onClick={onClose}>Done</Button></div>
        </div>
      ) : !preview ? (
        <div className="form">
          <p className="muted">
            Choose who takes over {name}'s work ({member.discipline}). Work of a discipline you map goes to that person; everything else
            goes to the default. With no replacement, items are left unassigned (and shifts are deleted).
          </p>
          <Field label="Default replacement">
            <MemberSelect members={others} value={defaultUid} onChange={setDefaultUid} placeholder="None (leave unassigned)" />
          </Field>
          <details open={Object.keys(byDiscipline).length > 0}>
            <summary>By discipline (optional)</summary>
            <div className="form-grid" style={{ marginTop: 8 }}>
              {DISCIPLINES.filter((d) => d !== 'Admin' && d !== 'Volunteer').map((d) => (
                <Field key={d} label={`${d} work`}>
                  <MemberSelect
                    members={others.filter((m) => m.discipline === d)}
                    value={byDiscipline[d] ?? ''}
                    onChange={(v) => setByDiscipline({ ...byDiscipline, [d]: v || undefined })}
                    placeholder="Use default"
                  />
                </Field>
              ))}
            </div>
          </details>
          <Field label="Future on-call shifts">
            <div className="row gap">
              <label className="row gap-sm"><input type="radio" checked={shiftAction === 'reassign'} onChange={() => setShiftAction('reassign')} /> Give to the replacement</label>
              <label className="row gap-sm"><input type="radio" checked={shiftAction === 'delete'} onChange={() => setShiftAction('delete')} /> Delete</label>
            </div>
          </Field>
          <div className="row gap end">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" busy={act.busy} onClick={() => void runPreview()}>Preview…</Button>
          </div>
        </div>
      ) : (
        <div className="form">
          <p>This is what will happen. Nothing has changed yet.</p>
          <CountsTable res={preview} />
          {preview.escalationPolicies.length > 0 && (
            <div className="banner banner-warn">
              {preview.escalationPolicies.length} escalation polic{preview.escalationPolicies.length === 1 ? 'y pages' : 'ies page'} {name} directly (
              {preview.escalationPolicies.map((p) => p.name).join(', ')}). They are not changed automatically.
            </div>
          )}
          <p className="muted small">Finally, {name} is deactivated: their sign-in is revoked and they leave all teams. Every change is audited.</p>
          <Field label={`Type ${name.split(' ')[0]} to confirm`}>
            <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />
          </Field>
          <div className="row gap end">
            <Button onClick={edit}>Back</Button>
            <Button
              variant="danger"
              busy={act.busy}
              disabled={confirmText.trim().toLowerCase() !== name.split(' ')[0]!.toLowerCase()}
              onClick={() => void runOffboard()}
            >
              Offboard and deactivate
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
