import { useState, type FormEvent } from 'react';
import { orderBy, query, updateDoc } from 'firebase/firestore';
import type { Capability, Discipline, Invite, InviteMemberRequest, InviteMemberResponse, Member, Role, Team } from '@shared/types';
import { useOrgSession } from '../lib/session';
import { orgCol, orgDoc, type WithId } from '../lib/firestore';
import { useLiveQuery } from '../lib/hooks';
import { call } from '../lib/firebase';
import { CAPABILITIES, CAPABILITY_LABELS, DISCIPLINES, ROLES } from '../lib/constants';
import { errorMessage, formatInstant } from '../lib/format';
import { setMemberTeams } from '../lib/teams';
import { sendInvitationEmail } from '../lib/invites';
import { InviteActions, InviteExpiry } from '../components/inviteActions';
import { Badge, Button, Card, ErrorBanner, Field, Modal, Page, Table } from '../components/ui';
import { OffboardWizard } from '../components/offboarding';

function TeamsEditor({
  member,
  teams,
  onClose,
}: {
  member: WithId<Member>;
  teams: WithId<Team>[];
  onClose: () => void;
}) {
  const s = useOrgSession();
  const [value, setValue] = useState<string[]>(member.teamIds ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await setMemberTeams(s.orgId, member.id, member.teamIds ?? [], value);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Teams — ${member.displayName}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} onClick={() => void save()}>Save</Button>
        </>
      }
    >
      <ErrorBanner error={error} />
      {teams.length === 0 ? (
        <p className="muted">No teams yet. Create teams on the Teams page.</p>
      ) : (
        <div className="picker">
          {teams.map((t) => (
            <label key={t.id} className="picker-item">
              <input
                type="checkbox"
                checked={value.includes(t.id)}
                onChange={(e) => setValue(e.target.checked ? [...value, t.id] : value.filter((x) => x !== t.id))}
              />
              {t.name}
            </label>
          ))}
        </div>
      )}
    </Modal>
  );
}

/**
 * Capabilities editor (admin direct write to members/{uid}.capabilities). The admin branch of the
 * members update rule accepts any well-formed doc, so this key is allowed as-is.
 */
function CapabilitiesEditor({ member, onClose }: { member: WithId<Member>; onClose: () => void }) {
  const s = useOrgSession();
  const [value, setValue] = useState<Capability[]>(member.capabilities ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      // Keep the canonical order so diffs in the audit trail stay readable.
      await updateDoc(orgDoc(s.orgId, 'members', member.id), { capabilities: CAPABILITIES.filter((c) => value.includes(c)) });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Capabilities — ${member.displayName}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} onClick={() => void save()}>Save</Button>
        </>
      }
    >
      <ErrorBanner error={error} />
      {member.role === 'admin' && (
        <div className="banner banner-info">Admins implicitly hold every capability; these only matter if the role changes.</div>
      )}
      <p className="muted small">Grant specific permissions without making this member an admin.</p>
      <div className="picker">
        {CAPABILITIES.map((c) => (
          <label key={c} className="picker-item">
            <input
              type="checkbox"
              checked={value.includes(c)}
              onChange={(e) => setValue(e.target.checked ? [...value, c] : value.filter((x) => x !== c))}
            />
            <span>{CAPABILITY_LABELS[c]}</span>
          </label>
        ))}
      </div>
    </Modal>
  );
}

function InviteForm({ teams }: { teams: WithId<Team>[] }) {
  const s = useOrgSession();
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<Role>('clinician');
  const [discipline, setDiscipline] = useState<Discipline>('RN');
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const inviteEmail = email.trim().toLowerCase();
      await call<InviteMemberRequest, InviteMemberResponse>('inviteMember', {
        orgId: s.orgId,
        email: inviteEmail,
        displayName: displayName.trim(),
        role,
        discipline,
        teamIds,
      });
      try {
        await sendInvitationEmail(inviteEmail);
        setOk(`Invitation emailed to ${inviteEmail}.`);
      } catch (mailErr) {
        setOk(
          `Invitation created for ${inviteEmail}, but the email could not be sent (${errorMessage(mailErr)}). ` +
            'Ask them to sign up with that email, or use "Resend email" below.',
        );
      }
      setEmail('');
      setDisplayName('');
      setTeamIds([]);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form" onSubmit={submit}>
      <ErrorBanner error={error} />
      {ok && <div className="banner banner-info">{ok}</div>}
      <div className="form-grid">
        <Field label="Email">
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Display name">
          <input required value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </Field>
        <Field label="Role">
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </Field>
        <Field label="Discipline">
          <select value={discipline} onChange={(e) => setDiscipline(e.target.value as Discipline)}>
            {DISCIPLINES.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </Field>
      </div>
      {teams.length > 0 && (
        <Field label="Teams">
          <div className="picker picker-inline">
            {teams.map((t) => (
              <label key={t.id} className="picker-item">
                <input
                  type="checkbox"
                  checked={teamIds.includes(t.id)}
                  onChange={(e) => setTeamIds(e.target.checked ? [...teamIds, t.id] : teamIds.filter((x) => x !== t.id))}
                />
                {t.name}
              </label>
            ))}
          </div>
        </Field>
      )}
      <div>
        <Button type="submit" variant="primary" busy={busy}>Send invite</Button>
      </div>
    </form>
  );
}

export default function MembersPage() {
  const s = useOrgSession();
  const teams = useLiveQuery<Team>(query(orgCol(s.orgId, 'teams'), orderBy('name')), [s.orgId]);
  const invites = useLiveQuery<Invite>(query(orgCol(s.orgId, 'invites'), orderBy('createdAt', 'desc')), [s.orgId]);
  const [editing, setEditing] = useState<WithId<Member> | null>(null);
  const [editingCaps, setEditingCaps] = useState<WithId<Member> | null>(null);
  const [offboarding, setOffboarding] = useState<WithId<Member> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(true);
  const teamName = (id: string) => teams.data.find((t) => t.id === id)?.name ?? '(deleted team)';

  const activeAdmins = s.members.filter((m) => m.active && m.role === 'admin');
  const isLastAdmin = (m: WithId<Member>) => m.active && m.role === 'admin' && activeAdmins.length <= 1;

  async function update(m: WithId<Member>, patch: Partial<Pick<Member, 'role' | 'discipline' | 'active'>>) {
    const losesAdmin = (patch.role !== undefined && patch.role !== 'admin') || patch.active === false;
    // UI guard; the server-side guard is enforced separately.
    if (losesAdmin && isLastAdmin(m)) {
      setError(`${m.displayName} is the only active admin. Make another member an admin before demoting or deactivating them.`);
      return;
    }
    if (m.id === s.user.uid && losesAdmin) {
      if (!window.confirm('You are changing your own admin access. You may lose access to this page. Continue?')) return;
    }
    setError(null);
    try {
      await updateDoc(orgDoc(s.orgId, 'members', m.id), patch);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const rows = s.members.filter((m) => showInactive || m.active);
  const pending = invites.data.filter((i) => i.status === 'pending');

  return (
    <Page title="Members">
      <ErrorBanner error={error ?? teams.error ?? invites.error} />
      <Card
        title={`Members (${s.members.length})`}
        actions={
          <label className="row gap-sm small">
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show inactive
          </label>
        }
      >
        <Table
          rows={rows}
          rowKey={(m) => m.id}
          rowClassName={(m) => (m.active ? undefined : 'row-muted')}
          exportName="members"
          columns={[
            { header: 'Name', cell: (m) => <strong>{m.displayName}</strong> },
            { header: 'Email', cell: (m) => m.email },
            {
              header: 'Role',
              csv: (m) => m.role,
              cell: (m) => (
                <select
                  value={m.role}
                  title={isLastAdmin(m) ? 'Only active admin: promote someone else first.' : undefined}
                  onChange={(e) => void update(m, { role: e.target.value as Role })}
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r} disabled={isLastAdmin(m) && r !== 'admin'}>{r}</option>
                  ))}
                </select>
              ),
            },
            {
              header: 'Discipline',
              csv: (m) => m.discipline,
              cell: (m) => (
                <select value={m.discipline} onChange={(e) => void update(m, { discipline: e.target.value as Discipline })}>
                  {DISCIPLINES.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              ),
            },
            {
              header: 'Teams',
              csv: (m) => (m.teamIds ?? []).map(teamName).join('; '),
              cell: (m) => (
                <div className="row gap-sm wrap">
                  {(m.teamIds ?? []).map((t) => <Badge key={t} tone="info">{teamName(t)}</Badge>)}
                  <Button small variant="ghost" onClick={() => setEditing(m)}>Edit</Button>
                </div>
              ),
            },
            {
              header: 'Capabilities',
              csv: (m) => (m.role === 'admin' ? 'all (admin)' : (m.capabilities ?? []).join('; ')),
              cell: (m) => (
                <div className="row gap-sm wrap">
                  {m.role === 'admin' ? (
                    <span className="muted small">all (admin)</span>
                  ) : (
                    (m.capabilities ?? []).map((c) => <Badge key={c} tone="accent">{c}</Badge>)
                  )}
                  <Button small variant="ghost" onClick={() => setEditingCaps(m)}>Edit</Button>
                </div>
              ),
            },
            {
              header: 'Active',
              csv: (m) => (m.active ? 'yes' : 'no'),
              cell: (m) => (
                <input
                  type="checkbox"
                  checked={m.active}
                  disabled={isLastAdmin(m)}
                  title={isLastAdmin(m) ? 'Only active admin: cannot be deactivated.' : undefined}
                  onChange={(e) => void update(m, { active: e.target.checked })}
                />
              ),
            },
            {
              header: '',
              className: 'actions',
              cell: (m) =>
                m.active && m.id !== s.user.uid && !isLastAdmin(m) ? (
                  <Button small variant="ghost" onClick={() => setOffboarding(m)}>Offboard…</Button>
                ) : null,
            },
          ]}
        />
      </Card>

      <Card title="Invite a member">
        <InviteForm teams={teams.data} />
      </Card>

      <Card title={`Pending invites (${pending.length})`}>
        <Table
          rows={pending}
          rowKey={(i) => i.id}
          empty="No pending invites."
          columns={[
            { header: 'Email', cell: (i) => i.email },
            { header: 'Name', cell: (i) => i.displayName },
            { header: 'Role', cell: (i) => <Badge value={i.role} /> },
            { header: 'Discipline', cell: (i) => i.discipline },
            { header: 'Invited by', cell: (i) => s.memberName(i.createdBy) },
            { header: 'Created', cell: (i) => formatInstant(i.createdAt) },
            { header: 'Expires', cell: (i) => <InviteExpiry invite={i} /> },
            { header: '', cell: (i) => <InviteActions orgId={s.orgId} invite={i} /> },
          ]}
        />
      </Card>

      {editing && <TeamsEditor member={editing} teams={teams.data} onClose={() => setEditing(null)} />}
      {editingCaps && <CapabilitiesEditor member={editingCaps} onClose={() => setEditingCaps(null)} />}
      {offboarding && <OffboardWizard member={offboarding} onClose={() => setOffboarding(null)} />}
    </Page>
  );
}
