import { useState, type FormEvent } from 'react';
import { orderBy, query, updateDoc } from 'firebase/firestore';
import type { Discipline, Invite, InviteMemberRequest, InviteMemberResponse, Member, Role, Team } from '@shared/types';
import { useOrgSession } from '../lib/session';
import { orgCol, orgDoc, type WithId } from '../lib/firestore';
import { useLiveQuery } from '../lib/hooks';
import { call } from '../lib/firebase';
import { DISCIPLINES, ROLES } from '../lib/constants';
import { errorMessage, formatInstant } from '../lib/format';
import { setMemberTeams } from '../lib/teams';
import { sendInvitationEmail } from '../lib/invites';
import { Badge, Button, Card, ErrorBanner, Field, Modal, Page, Table } from '../components/ui';

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

function ResendButton({ email }: { email: string }) {
  const [state, setState] = useState<'idle' | 'busy' | 'sent' | 'error'>('idle');
  async function resend() {
    setState('busy');
    try {
      await sendInvitationEmail(email);
      setState('sent');
    } catch {
      setState('error');
    }
  }
  if (state === 'sent') return <span className="muted small">Sent</span>;
  return (
    <Button small variant="ghost" busy={state === 'busy'} onClick={() => void resend()}>
      {state === 'error' ? 'Retry email' : 'Resend email'}
    </Button>
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
  const [error, setError] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(true);
  const teamName = (id: string) => teams.data.find((t) => t.id === id)?.name ?? '(deleted team)';

  async function update(m: WithId<Member>, patch: Partial<Pick<Member, 'role' | 'discipline' | 'active'>>) {
    if (m.id === s.user.uid && (patch.role && patch.role !== 'admin' || patch.active === false)) {
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
          columns={[
            { header: 'Name', cell: (m) => <strong>{m.displayName}</strong> },
            { header: 'Email', cell: (m) => m.email },
            {
              header: 'Role',
              cell: (m) => (
                <select value={m.role} onChange={(e) => void update(m, { role: e.target.value as Role })}>
                  {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              ),
            },
            {
              header: 'Discipline',
              cell: (m) => (
                <select value={m.discipline} onChange={(e) => void update(m, { discipline: e.target.value as Discipline })}>
                  {DISCIPLINES.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              ),
            },
            {
              header: 'Teams',
              cell: (m) => (
                <div className="row gap-sm wrap">
                  {(m.teamIds ?? []).map((t) => <Badge key={t} tone="info">{teamName(t)}</Badge>)}
                  <Button small variant="ghost" onClick={() => setEditing(m)}>Edit</Button>
                </div>
              ),
            },
            {
              header: 'Active',
              cell: (m) => (
                <input type="checkbox" checked={m.active} onChange={(e) => void update(m, { active: e.target.checked })} />
              ),
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
            { header: '', cell: (i) => <ResendButton email={i.email} /> },
          ]}
        />
      </Card>

      {editing && <TeamsEditor member={editing} teams={teams.data} onClose={() => setEditing(null)} />}
    </Page>
  );
}
