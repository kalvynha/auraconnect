import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type {
  CreateTaskRequest,
  Discipline,
  IdResponse,
  Patient,
  Priority,
  Task,
  TaskStatus,
  UpdateTaskRequest,
} from '@shared/types';
import { useOrgSession } from '../lib/session';
import type { WithId } from '../lib/firestore';
import { useAction } from '../lib/hooks';
import { call } from '../lib/firebase';
import { DISCIPLINES, PRIORITIES, TASK_STATUSES } from '../lib/constants';
import { dueState, formatDate, formatInstant } from '../lib/format';
import { Badge, Button, ErrorBanner, Field, MemberSelect, Modal, PatientSelect, Table } from './ui';

export function TaskEditorModal({
  task,
  patientId: fixedPatientId,
  patients,
  onClose,
}: {
  task?: WithId<Task> | null;
  patientId?: string;
  patients?: WithId<Patient>[];
  onClose: () => void;
}) {
  const s = useOrgSession();
  const act = useAction();
  const [title, setTitle] = useState(task?.title ?? '');
  const [description, setDescription] = useState(task?.description ?? '');
  const [patientId, setPatientId] = useState(fixedPatientId ?? task?.patientId ?? '');
  const [assigneeUid, setAssigneeUid] = useState(task?.assigneeUid ?? '');
  const [discipline, setDiscipline] = useState<Discipline | ''>(task?.discipline ?? '');
  const [dueDate, setDueDate] = useState(task?.dueDate ?? '');
  const [priority, setPriority] = useState<Priority>(task?.priority ?? 'normal');
  const [status, setStatus] = useState<TaskStatus>(task?.status ?? 'open');

  async function submit(e: FormEvent) {
    e.preventDefault();
    const t = title.trim();
    if (!t) return act.setError('Title is required.');
    let ok: boolean;
    if (task) {
      const req: UpdateTaskRequest = { orgId: s.orgId, taskId: task.id };
      if (t !== task.title) req.title = t;
      const d = description.trim() || null;
      if (d !== (task.description ?? null)) req.description = d;
      if ((assigneeUid || null) !== task.assigneeUid) req.assigneeUid = assigneeUid || null;
      if ((dueDate || null) !== task.dueDate) req.dueDate = dueDate || null;
      if (priority !== task.priority) req.priority = priority;
      if (status !== task.status) req.status = status;
      ok = await act.run(() => call<UpdateTaskRequest, unknown>('updateTask', req));
    } else {
      const req: CreateTaskRequest = { orgId: s.orgId, title: t, priority };
      if (description.trim()) req.description = description.trim();
      if (patientId) req.patientId = patientId;
      if (assigneeUid) req.assigneeUid = assigneeUid;
      if (discipline) req.discipline = discipline;
      if (dueDate) req.dueDate = dueDate;
      ok = await act.run(() => call<CreateTaskRequest, IdResponse>('createTask', req));
    }
    if (ok) onClose();
  }

  return (
    <Modal title={task ? 'Edit task' : 'New task'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <ErrorBanner error={act.error} />
        <Field label="Title">
          <input required value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Description">
          <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div className="form-grid">
          {!fixedPatientId && (
            <Field label="Patient" hint={task ? 'The patient cannot be changed.' : undefined}>
              <PatientSelect patients={patients ?? []} value={patientId} onChange={setPatientId} />
            </Field>
          )}
          <Field label="Assignee">
            <MemberSelect members={s.members} value={assigneeUid} onChange={setAssigneeUid} placeholder="Unassigned" />
          </Field>
          {!task && (
            <Field label="Discipline" hint="Unassigned tasks can be picked up by this discipline.">
              <select value={discipline} onChange={(e) => setDiscipline(e.target.value as Discipline | '')}>
                <option value="">Any</option>
                {DISCIPLINES.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </Field>
          )}
          <Field label="Due date">
            <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </Field>
          <Field label="Priority">
            <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
              {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </Field>
          {task && (
            <Field label="Status">
              <select value={status} onChange={(e) => setStatus(e.target.value as TaskStatus)}>
                {TASK_STATUSES.map((st) => <option key={st} value={st}>{st}</option>)}
              </select>
            </Field>
          )}
        </div>
        <div className="row gap end">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" busy={act.busy}>{task ? 'Save' : 'Create task'}</Button>
        </div>
      </form>
    </Modal>
  );
}

function CompleteTaskButton({ task }: { task: WithId<Task> }) {
  const s = useOrgSession();
  const act = useAction();
  return (
    <>
      <Button
        small
        variant="primary"
        busy={act.busy}
        onClick={() =>
          void act.run(() => call<UpdateTaskRequest, unknown>('updateTask', { orgId: s.orgId, taskId: task.id, status: 'done' }))
        }
      >
        Complete
      </Button>
      {act.error && <span className="error-text small" title={act.error}>Failed</span>}
    </>
  );
}

function TakeTaskButton({ task }: { task: WithId<Task> }) {
  const s = useOrgSession();
  const act = useAction();
  return (
    <Button
      small
      busy={act.busy}
      title={act.error ?? undefined}
      onClick={() =>
        void act.run(() => call<UpdateTaskRequest, unknown>('updateTask', { orgId: s.orgId, taskId: task.id, assigneeUid: s.user.uid }))
      }
    >
      {act.error ? 'Retry take' : 'Take'}
    </Button>
  );
}

function sourceLabel(t: Task): string {
  switch (t.source?.type) {
    case 'template':
      return `${t.source.event} template`;
    case 'idg':
      return 'IDG';
    case 'triage':
      return 'Triage';
    default:
      return 'Manual';
  }
}

export function TaskDue({ task }: { task: Task }) {
  if (!task.dueDate) return <span className="muted">—</span>;
  const st = task.status === 'open' ? dueState(task.dueDate, 2) : 'ok';
  return (
    <span className="row gap-sm">
      {formatDate(task.dueDate)}
      {st === 'overdue' && <Badge tone="danger">overdue</Badge>}
      {st === 'soon' && <Badge tone="warn">soon</Badge>}
    </span>
  );
}

export function TaskTable({
  rows,
  showPatient = true,
  onEdit,
  empty = 'No tasks.',
  exportName,
}: {
  rows: WithId<Task>[];
  showPatient?: boolean;
  onEdit: (t: WithId<Task>) => void;
  empty?: string;
  exportName?: string;
}) {
  const s = useOrgSession();
  const canEdit = s.role !== 'viewer';
  return (
    <Table
      rows={rows}
      rowKey={(t) => t.id}
      empty={empty}
      rowClassName={(t) => (t.status !== 'open' ? 'row-muted' : undefined)}
      exportName={exportName}
      columns={[
        {
          header: 'Task',
          csv: (t) => (t.description ? `${t.title} — ${t.description}` : t.title),
          cell: (t) => (
            <>
              <strong>{t.title}</strong>
              {t.description && <div className="muted small clamp">{t.description}</div>}
            </>
          ),
        },
        ...(showPatient
          ? [{ header: 'Patient', csv: (t: WithId<Task>) => t.patientName ?? '', cell: (t: WithId<Task>) => (t.patientId ? <Link to={`/patients/${t.patientId}`}>{t.patientName ?? 'Patient'}</Link> : <span className="muted">—</span>) }]
          : []),
        { header: 'Assignee', csv: (t) => (t.assigneeUid ? s.memberName(t.assigneeUid) : `Unassigned${t.discipline ? ` (${t.discipline})` : ''}`), cell: (t) => (t.assigneeUid ? s.memberName(t.assigneeUid) : <span className="muted">Unassigned{t.discipline ? ` · ${t.discipline}` : ''}</span>) },
        { header: 'Due', csv: (t) => t.dueDate ?? '', cell: (t) => <TaskDue task={t} /> },
        { header: 'Priority', csv: (t) => t.priority, cell: (t) => (t.priority !== 'normal' ? <Badge value={t.priority} /> : <span className="muted">normal</span>) },
        { header: 'Status', csv: (t) => t.status, cell: (t) => <Badge value={t.status} tone={t.status === 'open' ? 'info' : undefined} /> },
        { header: 'Source', csv: (t) => sourceLabel(t), cell: (t) => <span className="muted small">{sourceLabel(t)}</span> },
        {
          header: '',
          className: 'actions',
          cell: (t) =>
            canEdit ? (
              <div className="row gap-sm end">
                {t.status === 'open' && !t.assigneeUid && <TakeTaskButton task={t} />}
                {t.status === 'open' && <CompleteTaskButton task={t} />}
                <Button small variant="ghost" onClick={() => onEdit(t)}>Edit</Button>
              </div>
            ) : t.completedAt ? (
              <span className="muted small">Done {formatInstant(t.completedAt)}</span>
            ) : null,
        },
      ]}
    />
  );
}
