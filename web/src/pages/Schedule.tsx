import { useMemo, useState, type FormEvent } from 'react';
import { Timestamp, addDoc, deleteDoc, getDoc, orderBy, query, setDoc, updateDoc, where } from 'firebase/firestore';
import type { Discipline, OnCallRole, Shift, Team } from '@shared/types';
import { useOrgSession } from '../lib/session';
import { orgCol, orgDoc, type WithId } from '../lib/firestore';
import { useLiveQuery } from '../lib/hooks';
import { DISCIPLINES } from '../lib/constants';
import { errorMessage, slugify, toDateTimeLocal, tsToDate } from '../lib/format';
import { Button, Card, ErrorBanner, Field, MemberPicker, MemberSelect, Modal, Page, Table } from '../components/ui';

const DAY_MS = 86400000;

function startOfWeek(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - x.getDay()); // Sunday
  return x;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function RoleEditor({
  role,
  teams,
  onClose,
}: {
  role: WithId<OnCallRole> | null;
  teams: WithId<Team>[];
  onClose: () => void;
}) {
  const s = useOrgSession();
  const [label, setLabel] = useState(role?.label ?? '');
  const [roleKey, setRoleKey] = useState(role?.id ?? '');
  const [keyTouched, setKeyTouched] = useState(false);
  const [discipline, setDiscipline] = useState<Discipline | ''>(role?.discipline ?? '');
  const [teamId, setTeamId] = useState(role?.teamId ?? '');
  const [fallbackUids, setFallbackUids] = useState<string[]>(role?.fallbackUids ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveKey = role ? role.id : keyTouched ? roleKey : slugify(`oncall-${label}`);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(effectiveKey)) {
      setError('Role key must be a lowercase slug, e.g. oncall-rn-north.');
      return;
    }
    setBusy(true);
    try {
      const ref = orgDoc(s.orgId, 'onCallRoles', effectiveKey);
      if (!role && (await getDoc(ref)).exists()) {
        setError('A role with that key already exists.');
        setBusy(false);
        return;
      }
      const data: OnCallRole = {
        label: label.trim(),
        discipline: discipline || null,
        teamId: teamId || null,
        fallbackUids,
      };
      await setDoc(ref, data);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal title={role ? 'Edit on-call role' : 'New on-call role'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <ErrorBanner error={error} />
        <Field label="Label">
          <input required value={label} onChange={(e) => setLabel(e.target.value)} placeholder="On-call RN North" />
        </Field>
        <Field label="Role key" hint={role ? 'Keys cannot be changed.' : 'Lowercase slug used to address this role.'}>
          <input
            value={effectiveKey}
            disabled={!!role}
            onChange={(e) => {
              setKeyTouched(true);
              setRoleKey(e.target.value);
            }}
          />
        </Field>
        <div className="form-grid">
          <Field label="Discipline">
            <select value={discipline} onChange={(e) => setDiscipline(e.target.value as Discipline | '')}>
              <option value="">Any</option>
              {DISCIPLINES.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </Field>
          <Field label="Team">
            <select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
              <option value="">None</option>
              {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Fallback members" hint="Notified when nobody is scheduled.">
          <MemberPicker members={s.members} value={fallbackUids} onChange={setFallbackUids} />
        </Field>
        <div className="row gap end">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" busy={busy}>Save</Button>
        </div>
      </form>
    </Modal>
  );
}

interface ShiftDraft {
  id: string | null;
  roleKey: string;
  uid: string;
  start: string;
  end: string;
  notes: string;
}

function ShiftEditor({
  draft,
  roles,
  onClose,
}: {
  draft: ShiftDraft;
  roles: WithId<OnCallRole>[];
  onClose: () => void;
}) {
  const s = useOrgSession();
  const [d, setD] = useState<ShiftDraft>(draft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const start = new Date(d.start);
    const end = new Date(d.end);
    if (!(end > start)) {
      setError('End must be after start.');
      return;
    }
    setBusy(true);
    try {
      const data = {
        roleKey: d.roleKey,
        uid: d.uid,
        start: Timestamp.fromDate(start),
        end: Timestamp.fromDate(end),
        notes: d.notes.trim() || null,
      };
      if (d.id) await updateDoc(orgDoc(s.orgId, 'shifts', d.id), data);
      else await addDoc(orgCol(s.orgId, 'shifts'), data);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  async function remove() {
    if (!d.id || !window.confirm('Delete this shift?')) return;
    setBusy(true);
    try {
      await deleteDoc(orgDoc(s.orgId, 'shifts', d.id));
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal title={d.id ? 'Edit shift' : 'New shift'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <ErrorBanner error={error} />
        <Field label="Role">
          <select required value={d.roleKey} onChange={(e) => setD({ ...d, roleKey: e.target.value })}>
            <option value="">Select role…</option>
            {roles.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select>
        </Field>
        <Field label="Member">
          <MemberSelect members={s.members} value={d.uid} onChange={(uid) => setD({ ...d, uid })} required />
        </Field>
        <div className="form-grid">
          <Field label="Start">
            <input type="datetime-local" required value={d.start} onChange={(e) => setD({ ...d, start: e.target.value })} />
          </Field>
          <Field label="End">
            <input type="datetime-local" required value={d.end} onChange={(e) => setD({ ...d, end: e.target.value })} />
          </Field>
        </div>
        <Field label="Notes">
          <input value={d.notes} onChange={(e) => setD({ ...d, notes: e.target.value })} />
        </Field>
        <div className="row gap space-between">
          <div>{d.id && <Button variant="danger" onClick={() => void remove()} disabled={busy}>Delete</Button>}</div>
          <div className="row gap">
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" busy={busy}>Save</Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

export default function SchedulePage() {
  const s = useOrgSession();
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const weekEnd = addDays(weekStart, 7);
  const [now] = useState(() => new Date());

  const roles = useLiveQuery<OnCallRole>(query(orgCol(s.orgId, 'onCallRoles'), orderBy('label')), [s.orgId]);
  const teams = useLiveQuery<Team>(query(orgCol(s.orgId, 'teams'), orderBy('name')), [s.orgId]);
  // Single-field range on `end`; filter start < weekEnd client-side (no composite index needed).
  const weekShifts = useLiveQuery<Shift>(
    query(orgCol(s.orgId, 'shifts'), where('end', '>', Timestamp.fromDate(weekStart)), orderBy('end')),
    [s.orgId, weekStart.getTime()],
  );
  const currentShifts = useLiveQuery<Shift>(
    query(orgCol(s.orgId, 'shifts'), where('end', '>', Timestamp.fromDate(now)), orderBy('end')),
    [s.orgId, now.getTime()],
  );

  const [roleEditing, setRoleEditing] = useState<WithId<OnCallRole> | 'new' | null>(null);
  const [shiftDraft, setShiftDraft] = useState<ShiftDraft | null>(null);
  const [error, setError] = useState<string | null>(null);

  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const shiftsInWeek = useMemo(
    () => weekShifts.data.filter((sh) => (tsToDate(sh.start)?.getTime() ?? 0) < weekEnd.getTime()),
    [weekShifts.data, weekEnd],
  );

  const onCallNow = (roleKey: string): string[] => {
    const t = Date.now();
    return currentShifts.data
      .filter((sh) => sh.roleKey === roleKey && (tsToDate(sh.start)?.getTime() ?? 0) <= t && (tsToDate(sh.end)?.getTime() ?? 0) > t)
      .map((sh) => sh.uid);
  };

  function newShift(roleKey: string, day: Date) {
    const start = new Date(day);
    start.setHours(7, 0, 0, 0);
    const end = new Date(day);
    end.setHours(19, 0, 0, 0);
    setShiftDraft({ id: null, roleKey, uid: '', start: toDateTimeLocal(start), end: toDateTimeLocal(end), notes: '' });
  }

  function editShift(sh: WithId<Shift>) {
    if (!s.isAdmin) return;
    setShiftDraft({
      id: sh.id,
      roleKey: sh.roleKey,
      uid: sh.uid,
      start: toDateTimeLocal(tsToDate(sh.start) ?? new Date()),
      end: toDateTimeLocal(tsToDate(sh.end) ?? new Date()),
      notes: sh.notes ?? '',
    });
  }

  async function deleteRole(r: WithId<OnCallRole>) {
    if (!window.confirm(`Delete role "${r.label}"? Existing shifts for it will no longer be shown.`)) return;
    try {
      await deleteDoc(orgDoc(s.orgId, 'onCallRoles', r.id));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const fmtTime = (d: Date | null) => (d ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '');
  const teamName = (id: string | null) => (id ? teams.data.find((t) => t.id === id)?.name ?? '—' : '—');

  return (
    <Page
      title="On-call schedule"
      actions={s.isAdmin && <Button variant="primary" onClick={() => setRoleEditing('new')}>New role</Button>}
    >
      <ErrorBanner error={error ?? roles.error ?? weekShifts.error ?? currentShifts.error} />

      <Card title="On-call roles">
        <Table
          rows={roles.data}
          rowKey={(r) => r.id}
          empty={roles.loading ? 'Loading…' : 'No on-call roles defined.'}
          columns={[
            { header: 'Role', cell: (r) => <><strong>{r.label}</strong><div className="muted small mono">{r.id}</div></> },
            { header: 'Discipline', cell: (r) => r.discipline ?? '—' },
            { header: 'Team', cell: (r) => teamName(r.teamId) },
            {
              header: 'On call now',
              cell: (r) => {
                const uids = onCallNow(r.id);
                if (uids.length) return <strong>{uids.map((u) => s.memberName(u)).join(', ')}</strong>;
                return (
                  <span className="muted">
                    Nobody scheduled{r.fallbackUids.length ? ` · fallback: ${r.fallbackUids.map((u) => s.memberName(u)).join(', ')}` : ''}
                  </span>
                );
              },
            },
            ...(s.isAdmin
              ? [
                  {
                    header: '',
                    className: 'actions',
                    cell: (r: WithId<OnCallRole>) => (
                      <div className="row gap-sm end">
                        <Button small onClick={() => setRoleEditing(r)}>Edit</Button>
                        <Button small variant="danger" onClick={() => void deleteRole(r)}>Delete</Button>
                      </div>
                    ),
                  },
                ]
              : []),
          ]}
        />
      </Card>

      <Card
        title={`Week of ${weekStart.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`}
        actions={
          <>
            <Button small onClick={() => setWeekStart(addDays(weekStart, -7))}>← Prev</Button>
            <Button small onClick={() => setWeekStart(startOfWeek(new Date()))}>This week</Button>
            <Button small onClick={() => setWeekStart(addDays(weekStart, 7))}>Next →</Button>
          </>
        }
      >
        <div className="table-wrap">
          <table className="table schedule-grid">
            <thead>
              <tr>
                <th>Role</th>
                {days.map((d) => (
                  <th key={d.getTime()} className={d.toDateString() === now.toDateString() ? 'today' : undefined}>
                    {d.toLocaleDateString(undefined, { weekday: 'short', month: 'numeric', day: 'numeric' })}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {roles.data.length === 0 && (
                <tr><td colSpan={8} className="empty">Create an on-call role to start scheduling.</td></tr>
              )}
              {roles.data.map((r) => (
                <tr key={r.id}>
                  <th className="row-head">{r.label}</th>
                  {days.map((d) => {
                    const dayStart = d.getTime();
                    const dayEnd = dayStart + DAY_MS;
                    const cell = shiftsInWeek.filter((sh) => {
                      const a = tsToDate(sh.start)?.getTime() ?? 0;
                      const b = tsToDate(sh.end)?.getTime() ?? 0;
                      return sh.roleKey === r.id && a < dayEnd && b > dayStart;
                    });
                    return (
                      <td key={dayStart} className="cell">
                        {cell.map((sh) => (
                          <button
                            key={sh.id}
                            type="button"
                            className={`shift ${s.isAdmin ? '' : 'readonly'}`}
                            onClick={() => editShift(sh)}
                            title={sh.notes ?? undefined}
                          >
                            <span className="shift-name">{s.memberName(sh.uid)}</span>
                            <span className="shift-time">
                              {fmtTime(tsToDate(sh.start))}–{fmtTime(tsToDate(sh.end))}
                            </span>
                          </button>
                        ))}
                        {s.isAdmin && (
                          <button type="button" className="add-shift" onClick={() => newShift(r.id, d)} aria-label="Add shift">
                            +
                          </button>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {roleEditing && (
        <RoleEditor role={roleEditing === 'new' ? null : roleEditing} teams={teams.data} onClose={() => setRoleEditing(null)} />
      )}
      {shiftDraft && <ShiftEditor draft={shiftDraft} roles={roles.data} onClose={() => setShiftDraft(null)} />}
    </Page>
  );
}
