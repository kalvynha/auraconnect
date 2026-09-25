import { useState, type FormEvent } from 'react';
import { addDoc, deleteDoc, doc, orderBy, query, setDoc, updateDoc } from 'firebase/firestore';
import type { EscalationPolicy, EscalationStep, EscalationTarget, OnCallRole } from '@shared/types';
import { useOrgSession } from '../lib/session';
import { orgCol, orgDoc, type WithId } from '../lib/firestore';
import { useLiveQuery } from '../lib/hooks';
import { db } from '../lib/firebase';
import { errorMessage } from '../lib/format';
import { Badge, Button, Card, ErrorBanner, Field, MemberSelect, Modal, Page, Table } from '../components/ui';

type Kind = EscalationTarget['kind'];

function describeTarget(t: EscalationTarget, roleLabel: (k: string) => string, memberName: (u: string) => string): string {
  switch (t.kind) {
    case 'role':
      return `On-call: ${roleLabel(t.roleKey)}`;
    case 'uid':
      return memberName(t.uid);
    case 'original':
      return 'Original recipients';
  }
}

function PolicyEditor({
  policy,
  roles,
  onClose,
}: {
  policy: WithId<EscalationPolicy> | null;
  roles: WithId<OnCallRole>[];
  onClose: () => void;
}) {
  const s = useOrgSession();
  const [name, setName] = useState(policy?.name ?? '');
  const [steps, setSteps] = useState<EscalationStep[]>(
    policy?.steps ?? [{ target: { kind: 'original' }, waitMinutes: 5 }],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function setStep(i: number, step: EscalationStep) {
    setSteps(steps.map((s0, j) => (j === i ? step : s0)));
  }
  function setKind(i: number, kind: Kind) {
    const target: EscalationTarget =
      kind === 'role' ? { kind, roleKey: roles[0]?.id ?? '' } : kind === 'uid' ? { kind, uid: '' } : { kind };
    setStep(i, { ...steps[i], target });
  }
  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= steps.length) return;
    const next = [...steps];
    [next[i], next[j]] = [next[j], next[i]];
    setSteps(next);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (steps.length === 0) return setError('Add at least one step.');
    for (const st of steps) {
      if (st.target.kind === 'role' && !st.target.roleKey) return setError('Choose a role for every role step.');
      if (st.target.kind === 'uid' && !st.target.uid) return setError('Choose a member for every member step.');
      if (!(st.waitMinutes >= 1)) return setError('Wait minutes must be at least 1.');
    }
    setBusy(true);
    try {
      const data: EscalationPolicy = { name: name.trim(), steps };
      if (policy) await setDoc(orgDoc(s.orgId, 'escalationPolicies', policy.id), data);
      else await addDoc(orgCol(s.orgId, 'escalationPolicies'), data);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal title={policy ? 'Edit policy' : 'New escalation policy'} onClose={onClose} wide>
      <form className="form" onSubmit={submit}>
        <ErrorBanner error={error} />
        <Field label="Name">
          <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Urgent clinical" />
        </Field>
        <p className="muted small">
          Step N is escalation level N (level 0 = when the alert is raised, so step 1 is usually "Original
          recipients"). After notifying a step's target, the alert waits that step's minutes for an acknowledgement
          before moving to the next step.
        </p>
        <ol className="steps">
          {steps.map((st, i) => (
            <li key={i} className="step-row">
              <span className="step-num" title={`Level ${i}`}>{i + 1}</span>
              <select value={st.target.kind} onChange={(e) => setKind(i, e.target.value as Kind)}>
                <option value="original">Original recipients</option>
                <option value="role">On-call role</option>
                <option value="uid">Specific member</option>
              </select>
              {st.target.kind === 'role' && (
                <select
                  value={st.target.roleKey}
                  onChange={(e) => setStep(i, { ...st, target: { kind: 'role', roleKey: e.target.value } })}
                >
                  <option value="">Select role…</option>
                  {roles.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                </select>
              )}
              {st.target.kind === 'uid' && (
                <MemberSelect
                  members={s.members}
                  value={st.target.uid}
                  onChange={(uid) => setStep(i, { ...st, target: { kind: 'uid', uid } })}
                />
              )}
              <label className="row gap-sm">
                wait
                <input
                  type="number"
                  min={1}
                  className="input-sm"
                  value={st.waitMinutes}
                  onChange={(e) => setStep(i, { ...st, waitMinutes: Number(e.target.value) })}
                />
                min
              </label>
              <div className="row gap-sm">
                <Button small variant="ghost" onClick={() => move(i, -1)} disabled={i === 0}>↑</Button>
                <Button small variant="ghost" onClick={() => move(i, 1)} disabled={i === steps.length - 1}>↓</Button>
                <Button small variant="ghost" onClick={() => setSteps(steps.filter((_, j) => j !== i))}>Remove</Button>
              </div>
            </li>
          ))}
        </ol>
        <div>
          <Button small onClick={() => setSteps([...steps, { target: { kind: 'role', roleKey: roles[0]?.id ?? '' }, waitMinutes: 10 }])}>
            Add step
          </Button>
        </div>
        <div className="row gap end">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" busy={busy}>Save</Button>
        </div>
      </form>
    </Modal>
  );
}

export default function PoliciesPage() {
  const s = useOrgSession();
  const policies = useLiveQuery<EscalationPolicy>(query(orgCol(s.orgId, 'escalationPolicies'), orderBy('name')), [s.orgId]);
  const roles = useLiveQuery<OnCallRole>(query(orgCol(s.orgId, 'onCallRoles'), orderBy('label')), [s.orgId]);
  const [editing, setEditing] = useState<WithId<EscalationPolicy> | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const defaultId = s.org?.defaultEscalationPolicyId ?? null;

  const roleLabel = (k: string) => roles.data.find((r) => r.id === k)?.label ?? k;

  async function setDefault(id: string | null) {
    setError(null);
    try {
      await updateDoc(doc(db, 'orgs', s.orgId), { defaultEscalationPolicyId: id });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function remove(p: WithId<EscalationPolicy>) {
    if (!window.confirm(`Delete policy "${p.name}"?`)) return;
    try {
      if (defaultId === p.id) await setDefault(null);
      await deleteDoc(orgDoc(s.orgId, 'escalationPolicies', p.id));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <Page title="Escalation policies" actions={<Button variant="primary" onClick={() => setEditing('new')}>New policy</Button>}>
      <ErrorBanner error={error ?? policies.error ?? roles.error} />
      <Card title="Organization default">
        <div className="row gap">
          <select value={defaultId ?? ''} onChange={(e) => void setDefault(e.target.value || null)}>
            <option value="">None (no automatic escalation)</option>
            {policies.data.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <span className="muted small">Applied to urgent/critical messages and deadline alerts.</span>
        </div>
      </Card>
      <Card>
        <Table
          rows={policies.data}
          rowKey={(p) => p.id}
          empty={policies.loading ? 'Loading…' : 'No escalation policies yet.'}
          columns={[
            {
              header: 'Name',
              cell: (p) => (
                <>
                  <strong>{p.name}</strong> {p.id === defaultId && <Badge tone="accent">default</Badge>}
                </>
              ),
            },
            {
              header: 'Steps',
              cell: (p) => (
                <ol className="inline-steps">
                  {p.steps.map((st, i) => (
                    <li key={i}>
                      {describeTarget(st.target, roleLabel, s.memberName)} · wait {st.waitMinutes} min
                    </li>
                  ))}
                </ol>
              ),
            },
            {
              header: '',
              className: 'actions',
              cell: (p) => (
                <div className="row gap-sm end">
                  <Button small onClick={() => setEditing(p)}>Edit</Button>
                  <Button small variant="danger" onClick={() => void remove(p)}>Delete</Button>
                </div>
              ),
            },
          ]}
        />
      </Card>
      {editing && (
        <PolicyEditor policy={editing === 'new' ? null : editing} roles={roles.data} onClose={() => setEditing(null)} />
      )}
    </Page>
  );
}
