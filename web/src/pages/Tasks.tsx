import { useEffect, useMemo, useState } from 'react';
import { limit, orderBy, query, where } from 'firebase/firestore';
import type {
  Discipline,
  Priority,
  SaveTaskTemplateRequest,
  Task,
  TaskStatus,
  TaskTemplate,
  TaskTemplateEvent,
  TaskTemplateItem,
} from '@shared/types';
import { useOrgSession } from '../lib/session';
import { orgCol, type WithId } from '../lib/firestore';
import { useAction, useLiveQuery } from '../lib/hooks';
import { usePatients } from '../lib/queries';
import { call } from '../lib/firebase';
import { DEFAULT_TASK_TEMPLATES, DISCIPLINES, PRIORITIES, TASK_STATUSES, TASK_TEMPLATE_EVENTS } from '../lib/constants';
import { addDaysISO, daysBetween, todayISO } from '../lib/format';
import { Badge, Button, Card, ErrorBanner, Field, MemberSelect, Page, PatientSelect, Tabs, type TabDef } from '../components/ui';
import { TaskEditorModal, TaskTable } from '../components/tasks';

type View = 'mine' | 'unassigned' | 'all' | 'templates';
type DueFilter = 'any' | 'overdue' | 'today' | 'week' | 'none';

interface ItemDraft {
  title: string;
  description: string;
  discipline: Discipline | '';
  offsetDays: string;
  priority: Priority;
}

function toDraft(i: TaskTemplateItem): ItemDraft {
  return {
    title: i.title,
    description: i.description ?? '',
    discipline: i.discipline ?? '',
    offsetDays: String(i.offsetDays),
    priority: i.priority,
  };
}

function TemplateEditor({ event, saved }: { event: TaskTemplateEvent; saved: TaskTemplate | undefined }) {
  const s = useOrgSession();
  const act = useAction();
  const source = saved?.items ?? DEFAULT_TASK_TEMPLATES[event];
  const [items, setItems] = useState<ItemDraft[]>(() => source.map(toDraft));
  const [dirty, setDirty] = useState(false);
  const [ok, setOk] = useState(false);

  // Follow live changes until the user starts editing.
  useEffect(() => {
    if (!dirty) setItems(source.map(toDraft));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);

  const update = (i: number, patch: Partial<ItemDraft>) => {
    setDirty(true);
    setOk(false);
    setItems(items.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  };

  async function save() {
    const out: TaskTemplateItem[] = [];
    for (const d of items) {
      const title = d.title.trim();
      if (!title) return act.setError('Every item needs a title.');
      const off = Number(d.offsetDays);
      if (!Number.isInteger(off) || off < 0 || off > 365) return act.setError(`"${title}": days after event must be a whole number 0–365.`);
      out.push({ title, description: d.description.trim() || null, discipline: d.discipline || null, offsetDays: off, priority: d.priority });
    }
    const done = await act.run(() =>
      call<SaveTaskTemplateRequest, unknown>('saveTaskTemplate', { orgId: s.orgId, event, items: out }),
    );
    if (done) {
      setDirty(false);
      setOk(true);
    }
  }

  return (
    <Card
      title={`${event[0].toUpperCase()}${event.slice(1)} template`}
      actions={!saved && <Badge tone="neutral">using defaults</Badge>}
    >
      <ErrorBanner error={act.error} />
      {ok && <div className="banner banner-ok">Template saved.</div>}
      <div className="form">
        {items.length === 0 && <p className="muted">No tasks are created for this event.</p>}
        {items.map((d, i) => (
          <div key={i} className="list-editor-row wrap">
            <input placeholder="Title" value={d.title} onChange={(e) => update(i, { title: e.target.value })} />
            <select value={d.discipline} onChange={(e) => update(i, { discipline: e.target.value as Discipline | '' })} aria-label="Discipline">
              <option value="">Any discipline</option>
              {DISCIPLINES.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
            <input
              className="input-sm"
              type="number"
              min={0}
              max={365}
              value={d.offsetDays}
              aria-label="Days after event"
              title="Days after event"
              onChange={(e) => update(i, { offsetDays: e.target.value })}
            />
            <span className="muted small">days</span>
            <select value={d.priority} onChange={(e) => update(i, { priority: e.target.value as Priority })} aria-label="Priority">
              {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            <Button small variant="ghost" onClick={() => { setDirty(true); setItems(items.filter((_, j) => j !== i)); }}>Remove</Button>
          </div>
        ))}
        <div className="row gap space-between">
          <Button
            small
            onClick={() => {
              setDirty(true);
              setItems([...items, { title: '', description: '', discipline: '', offsetDays: '0', priority: 'normal' }]);
            }}
          >
            + Add item
          </Button>
          <Button variant="primary" busy={act.busy} disabled={!dirty && !!saved} onClick={() => void save()}>Save template</Button>
        </div>
      </div>
    </Card>
  );
}

function TemplatesView() {
  const s = useOrgSession();
  const templates = useLiveQuery<TaskTemplate>(query(orgCol(s.orgId, 'taskTemplates')), [s.orgId]);
  if (templates.loading) return <p className="muted">Loading…</p>;
  return (
    <>
      <ErrorBanner error={templates.error} />
      <p className="muted">
        Tasks created automatically when a patient is admitted, recertified, discharged or dies. Each task goes to the care-team
        member with the matching discipline (otherwise it stays unassigned); its due date is the event date plus the offset.
      </p>
      {TASK_TEMPLATE_EVENTS.map((ev) => (
        <TemplateEditor key={ev} event={ev} saved={templates.data.find((t) => t.id === ev)} />
      ))}
    </>
  );
}

export default function TasksPage() {
  const s = useOrgSession();
  const [view, setView] = useState<View>('mine');
  const [status, setStatus] = useState<TaskStatus | 'all'>('open');
  const [patientId, setPatientId] = useState('');
  const [due, setDue] = useState<DueFilter>('any');
  const [assignee, setAssignee] = useState('');
  const [editing, setEditing] = useState<WithId<Task> | 'new' | null>(null);
  const patients = usePatients(s.orgId);
  const myDiscipline = s.member?.discipline ?? null;

  const today = todayISO();
  const assigneeFilter = view === 'all' ? assignee : '';
  // Open tasks are filtered on the server (status == open, ordered by due date) so the
  // backlog of done/cancelled tasks never pushes open ones past a limit. Overdue adds
  // dueDate < today. Indexes: tasks(status, dueDate), tasks(assigneeUid, status, dueDate).
  const q = useMemo(() => {
    if (view === 'templates') return null;
    const col = orgCol(s.orgId, 'tasks');
    const who =
      view === 'mine'
        ? [where('assigneeUid', '==', s.user.uid)]
        : view === 'unassigned'
          ? [where('assigneeUid', '==', null)]
          : assigneeFilter
            ? [where('assigneeUid', '==', assigneeFilter)]
            : [];
    if (status === 'open') {
      return query(
        col,
        ...who,
        where('status', '==', 'open'),
        ...(due === 'overdue' ? [where('dueDate', '<', today)] : []),
        orderBy('dueDate'),
        limit(1000),
      );
    }
    // History views (done / cancelled / all): per-person queries are naturally bounded;
    // the org-wide one shows the newest 500.
    if (who.length) return query(col, ...who);
    return query(col, orderBy('createdAt', 'desc'), limit(500));
  }, [s.orgId, s.user.uid, view, status, due, today, assigneeFilter]);
  const tasks = useLiveQuery<Task>(q, [s.orgId, s.user.uid, view, status, due, today, assigneeFilter]);

  const rows = useMemo(() => {
    const weekEnd = addDaysISO(today, 7);
    return tasks.data
      .filter((t) => {
        if (view === 'unassigned' && !s.isAdmin && t.discipline && t.discipline !== myDiscipline) return false;
        if (status !== 'all' && t.status !== status) return false;
        if (patientId && t.patientId !== patientId) return false;
        switch (due) {
          case 'overdue':
            return !!t.dueDate && daysBetween(today, t.dueDate) < 0;
          case 'today':
            return t.dueDate === today;
          case 'week':
            return !!t.dueDate && t.dueDate >= today && t.dueDate <= weekEnd;
          case 'none':
            return !t.dueDate;
          default:
            return true;
        }
      })
      .sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999'));
  }, [tasks.data, view, status, patientId, due, myDiscipline, s.isAdmin, today]);

  const tabs: TabDef<View>[] = [
    { key: 'mine', label: 'My tasks' },
    { key: 'unassigned', label: s.isAdmin ? 'Unassigned' : `Unassigned${myDiscipline ? ` (${myDiscipline})` : ''}` },
    { key: 'all', label: 'All', hidden: !s.isAdmin },
    { key: 'templates', label: 'Task templates', hidden: !s.isAdmin },
  ];

  return (
    <Page title="Tasks" actions={s.role !== 'viewer' && <Button variant="primary" onClick={() => setEditing('new')}>New task</Button>}>
      <Tabs tabs={tabs} value={view} onChange={setView} />
      {view === 'templates' ? (
        <TemplatesView />
      ) : (
        <>
          <div className="toolbar">
            <div className="segmented">
              {(['open', ...TASK_STATUSES.filter((x) => x !== 'open'), 'all'] as const).map((st) => (
                <button key={st} className={status === st ? 'active' : ''} onClick={() => setStatus(st)}>{st}</button>
              ))}
            </div>
            <Field label="Patient" className="field-inline">
              <PatientSelect patients={patients.data} value={patientId} onChange={setPatientId} placeholder="All patients" />
            </Field>
            {view === 'all' && (
              <Field label="Assignee" className="field-inline">
                <MemberSelect members={s.members} value={assignee} onChange={setAssignee} placeholder="Anyone" />
              </Field>
            )}
            <Field label="Due" className="field-inline">
              <select value={due} onChange={(e) => setDue(e.target.value as DueFilter)}>
                <option value="any">Any time</option>
                <option value="overdue">All overdue</option>
                <option value="today">Due today</option>
                <option value="week">Next 7 days</option>
                <option value="none">No due date</option>
              </select>
            </Field>
          </div>
          <Card>
            <ErrorBanner error={tasks.error} />
            <TaskTable rows={rows} onEdit={setEditing} exportName={`tasks-${view}-${status}`} empty={tasks.loading ? 'Loading…' : 'No tasks match.'} />
            {view === 'unassigned' && (
              <p className="muted small">Use “Take” to assign a task to yourself.</p>
            )}
          </Card>
        </>
      )}
      {editing && (
        <TaskEditorModal task={editing === 'new' ? null : editing} patients={patients.data} onClose={() => setEditing(null)} />
      )}
    </Page>
  );
}
