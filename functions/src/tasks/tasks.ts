/** Task callables: `createTask`, `updateTask`, `saveTaskTemplate` (admin). */
import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { writeAudit } from '../lib/audit';
import { assertCanActOnPatientWork, carePaths, newTaskDoc, patientDisplayName } from '../lib/care';
import { CLINICAL_ROLES, parse, requireOrg } from '../lib/context';
import { colRef, db, docRef, getDocData, paths } from '../lib/db';
import { assertActiveMembers } from '../lib/members';
import { discipline, id, isoDate, priority } from '../lib/schemas';
import type { CreateTaskRequest, IdResponse, Patient, SaveTaskTemplateRequest, Task, UpdateTaskRequest } from '../shared/types';

const title = z.string().trim().min(1).max(200);
const description = z.string().trim().max(4000);

const createSchema = z.object({
  orgId: id,
  title,
  description: description.optional(),
  patientId: id.optional(),
  assigneeUid: id.optional(),
  discipline: discipline.optional(),
  dueDate: isoDate.optional(),
  priority: priority.default('normal'),
});
const updateSchema = z.object({
  orgId: id,
  taskId: id,
  title: title.optional(),
  description: description.nullable().optional(),
  assigneeUid: id.nullable().optional(),
  dueDate: isoDate.nullable().optional(),
  priority: priority.optional(),
  status: z.enum(['open', 'done', 'cancelled']).optional(),
});
export const templateItemSchema = z.object({
  title,
  description: description.nullable().default(null),
  discipline: discipline.nullable().default(null),
  offsetDays: z.number().int().min(-30).max(365),
  priority: priority.default('normal'),
});
const templateSchema = z.object({
  orgId: id,
  event: z.enum(['admission', 'recertification', 'discharge', 'death']),
  items: z.array(templateItemSchema).max(50),
});

export async function createTaskHandler(request: CallableRequest<CreateTaskRequest>): Promise<IdResponse> {
  const input = parse(createSchema, request.data);
  const ctx = await requireOrg(request, input.orgId, CLINICAL_ROLES);
  if (input.assigneeUid) await assertActiveMembers(ctx.orgId, [input.assigneeUid]);
  let patientName: string | null = null;
  if (input.patientId) {
    const p = await getDocData<Patient>(paths.patient(ctx.orgId, input.patientId));
    if (!p) throw new HttpsError('not-found', 'Patient not found.');
    patientName = patientDisplayName(p);
  }
  const ref = colRef(carePaths.tasks(ctx.orgId)).doc();
  const batch = db().batch();
  batch.set(
    ref,
    newTaskDoc({
      title: input.title,
      description: input.description ?? null,
      patientId: input.patientId ?? null,
      patientName,
      assigneeUid: input.assigneeUid ?? null,
      discipline: input.discipline ?? null,
      dueDate: input.dueDate ?? null,
      priority: input.priority,
      source: { type: 'manual' },
      createdBy: ctx.uid,
    }),
  );
  await writeAudit(
    ctx.orgId,
    { actorUid: ctx.uid, action: 'task.create', resourceType: 'task', resourceId: ref.id, patientId: input.patientId ?? null, metadata: { source: 'manual' } },
    batch,
  );
  await batch.commit();
  return { id: ref.id };
}

/** The creator, the assignee, the patient's care team or an admin may update a task. */
export async function updateTaskHandler(request: CallableRequest<UpdateTaskRequest>): Promise<Record<string, never>> {
  const input = parse(updateSchema, request.data);
  const ctx = await requireOrg(request, input.orgId, CLINICAL_ROLES);
  if (input.assigneeUid) await assertActiveMembers(ctx.orgId, [input.assigneeUid]);
  const ref = docRef(carePaths.task(ctx.orgId, input.taskId));
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Task not found.');
    const task = snap.data() as Task;
    let careTeam: string[] = [];
    if (task.patientId) {
      const p = await tx.get(docRef(paths.patient(ctx.orgId, task.patientId)));
      careTeam = p.exists ? ((p.data() as Patient).careTeamUids ?? []) : [];
    }
    assertCanActOnPatientWork(ctx, careTeam, [task.createdBy, task.assigneeUid]);

    const update: Record<string, unknown> = {};
    for (const k of ['title', 'description', 'assigneeUid', 'dueDate', 'priority'] as const) {
      if (input[k] !== undefined && input[k] !== task[k]) update[k] = input[k];
    }
    const completing = input.status === 'done' && task.status !== 'done';
    if (input.status !== undefined && input.status !== task.status) {
      update.status = input.status;
      if (completing) {
        update.completedAt = FieldValue.serverTimestamp();
        update.completedBy = ctx.uid;
      } else {
        update.completedAt = null;
        update.completedBy = null;
      }
    }
    const changed = Object.keys(update);
    if (changed.length === 0) return;
    tx.update(ref, { ...update, updatedAt: FieldValue.serverTimestamp() });
    await writeAudit(
      ctx.orgId,
      {
        actorUid: ctx.uid,
        action: completing ? 'task.complete' : 'task.update',
        resourceType: 'task',
        resourceId: input.taskId,
        patientId: task.patientId,
        metadata: { fields: changed, ...(update.status ? { status: update.status } : {}) },
      },
      tx,
    );
  });
  return {};
}

export async function saveTaskTemplateHandler(request: CallableRequest<SaveTaskTemplateRequest>): Promise<Record<string, never>> {
  const input = parse(templateSchema, request.data);
  const ctx = await requireOrg(request, input.orgId, ['admin']);
  const batch = db().batch();
  batch.set(docRef(carePaths.taskTemplate(ctx.orgId, input.event)), { event: input.event, items: input.items });
  // No dedicated AuditAction exists for templates; recorded as a task update on the template resource.
  await writeAudit(
    ctx.orgId,
    { actorUid: ctx.uid, action: 'task.update', resourceType: 'taskTemplate', resourceId: input.event, metadata: { items: input.items.length } },
    batch,
  );
  await batch.commit();
  return {};
}

export const createTask = onCall(createTaskHandler);
export const updateTask = onCall(updateTaskHandler);
export const saveTaskTemplate = onCall(saveTaskTemplateHandler);
