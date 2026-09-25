import { useState, type FormEvent } from 'react';
import { addDoc, arrayRemove, deleteDoc, orderBy, query, serverTimestamp, updateDoc, writeBatch } from 'firebase/firestore';
import type { Team } from '@shared/types';
import { useOrgSession } from '../lib/session';
import { orgCol, orgDoc, type WithId } from '../lib/firestore';
import { useLiveQuery } from '../lib/hooks';
import { db } from '../lib/firebase';
import { errorMessage } from '../lib/format';
import { setTeamMembers } from '../lib/teams';
import { Button, Card, ErrorBanner, Field, MemberPicker, Modal, Page, Table } from '../components/ui';

function TeamEditor({ team, onClose }: { team: WithId<Team> | null; onClose: () => void }) {
  const s = useOrgSession();
  const [name, setName] = useState(team?.name ?? '');
  const [description, setDescription] = useState(team?.description ?? '');
  const [memberUids, setMemberUids] = useState<string[]>(team?.memberUids ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const fields = { name: name.trim(), description: description.trim() || null };
      if (team) {
        await updateDoc(orgDoc(s.orgId, 'teams', team.id), fields);
        await setTeamMembers(s.orgId, team.id, team.memberUids ?? [], memberUids);
      } else {
        const ref = await addDoc(orgCol(s.orgId, 'teams'), { ...fields, memberUids: [], createdAt: serverTimestamp() });
        await setTeamMembers(s.orgId, ref.id, [], memberUids);
      }
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal title={team ? 'Edit team' : 'New team'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <ErrorBanner error={error} />
        <Field label="Name">
          <input required value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Description">
          <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label="Members">
          <MemberPicker members={s.members} value={memberUids} onChange={setMemberUids} />
        </Field>
        <div className="row gap end">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" busy={busy}>Save</Button>
        </div>
      </form>
    </Modal>
  );
}

export default function TeamsPage() {
  const s = useOrgSession();
  const teams = useLiveQuery<Team>(query(orgCol(s.orgId, 'teams'), orderBy('name')), [s.orgId]);
  const [editing, setEditing] = useState<WithId<Team> | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function remove(t: WithId<Team>) {
    if (!window.confirm(`Delete team "${t.name}"?`)) return;
    setError(null);
    try {
      const batch = writeBatch(db);
      for (const uid of t.memberUids ?? []) {
        batch.update(orgDoc(s.orgId, 'members', uid), { teamIds: arrayRemove(t.id) });
      }
      await batch.commit();
      await deleteDoc(orgDoc(s.orgId, 'teams', t.id));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <Page title="Teams" actions={<Button variant="primary" onClick={() => setEditing('new')}>New team</Button>}>
      <ErrorBanner error={error ?? teams.error} />
      <Card>
        <Table
          rows={teams.data}
          rowKey={(t) => t.id}
          empty={teams.loading ? 'Loading…' : 'No teams yet.'}
          columns={[
            { header: 'Name', cell: (t) => <strong>{t.name}</strong> },
            { header: 'Description', cell: (t) => t.description ?? <span className="muted">—</span> },
            {
              header: 'Members',
              cell: (t) => (t.memberUids ?? []).map((u) => s.memberName(u)).join(', ') || <span className="muted">None</span>,
            },
            {
              header: '',
              className: 'actions',
              cell: (t) => (
                <div className="row gap-sm end">
                  <Button small onClick={() => setEditing(t)}>Edit</Button>
                  <Button small variant="danger" onClick={() => void remove(t)}>Delete</Button>
                </div>
              ),
            },
          ]}
        />
      </Card>
      {editing && <TeamEditor team={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </Page>
  );
}
