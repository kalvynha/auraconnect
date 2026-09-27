/**
 * v4 message templates.
 *  - `saveTemplate` / `deleteTemplate`: `scope: 'org'` (`messageTemplates/{id}`) is admin-only;
 *    `scope: 'personal'` (`members/{uid}/templates/{id}`) is the caller's own.
 *  - `seedDefaultTemplates` (admin): adds any missing default org templates (`domain/templates.ts`);
 *    existing ones, including admin-edited defaults, are left alone. `createOrg` seeds them too.
 */
import { FieldValue, type Transaction, type WriteBatch } from 'firebase-admin/firestore';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { DEFAULT_TEMPLATES, TEMPLATE_FIELD_KEY_RE, TEMPLATE_ID_RE, unknownPlaceholders } from '../domain/templates';
import { writeAudit } from '../lib/audit';
import { parse, requireOrg, type OrgContext } from '../lib/context';
import { colRef, db, docRef, getMany, paths } from '../lib/db';
import { id, priority } from '../lib/schemas';
import type {
  DeleteTemplateRequest, IdResponse, SaveTemplateRequest, SeedDefaultTemplatesRequest, SeedDefaultTemplatesResponse,
} from '../shared/types';

/** Personal templates per member. */
export const MAX_PERSONAL_TEMPLATES = 50;
/** Org templates (defaults included). */
export const MAX_ORG_TEMPLATES = 200;

const templateId = z.string().regex(TEMPLATE_ID_RE, 'must be 1–128 letters, digits, "_" or "-"');

const field = z
  .object({
    key: z.string().regex(TEMPLATE_FIELD_KEY_RE, 'must start with a letter (letters, digits, "_"; ≤ 32)'),
    label: z.string().trim().min(1).max(100),
    kind: z.enum(['text', 'multiline', 'choice', 'number']),
    options: z.array(z.string().trim().min(1).max(60)).min(1).max(20).optional(),
    required: z.boolean(),
  })
  .strict()
  .refine((f) => f.kind !== 'choice' || (f.options?.length ?? 0) > 0, 'choice fields need options')
  .refine((f) => f.kind === 'choice' || f.options === undefined, 'only choice fields take options');

const template = z
  .object({
    title: z.string().trim().min(1).max(100),
    category: z.enum(['escalation', 'clinical', 'visit', 'end_of_life', 'orders', 'family', 'logistics', 'quick_reply']),
    body: z.string().min(1).max(4000),
    fields: z.array(field).max(12),
    defaultPriority: priority,
    patientContext: z.boolean(),
    order: z.number().int().min(0).max(10_000),
    active: z.boolean(),
  })
  .strict()
  .superRefine((t, ctx) => {
    const keys = t.fields.map((f) => f.key);
    if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', path: ['fields'], message: 'field keys must be unique' });
    const unknown = unknownPlaceholders(t);
    if (unknown.length) ctx.addIssue({ code: 'custom', path: ['body'], message: `unknown placeholder(s): ${unknown.join(', ')}` });
  });

const saveSchema = z.object({
  orgId: id,
  templateId: templateId.optional(),
  scope: z.enum(['org', 'personal']),
  template,
});
const deleteSchema = z.object({ orgId: id, templateId, scope: z.enum(['org', 'personal']) });
const seedSchema = z.object({ orgId: id });

function requireScope(ctx: OrgContext, scope: 'org' | 'personal'): void {
  if (scope === 'org' && ctx.role !== 'admin') {
    throw new HttpsError('permission-denied', 'Only an administrator can manage organization templates.');
  }
  if (scope === 'personal' && ctx.member.discipline === 'Volunteer' && ctx.role !== 'admin') {
    throw new HttpsError('permission-denied', 'Volunteers cannot save message templates.');
  }
}

function templatePath(ctx: OrgContext, scope: 'org' | 'personal', tid: string): string {
  return scope === 'org' ? paths.orgTemplate(ctx.orgId, tid) : paths.memberTemplate(ctx.orgId, ctx.uid, tid);
}

export async function saveTemplateHandler(request: CallableRequest<SaveTemplateRequest>): Promise<IdResponse> {
  const input = parse(saveSchema, request.data);
  const ctx = await requireOrg(request, input.orgId);
  requireScope(ctx, input.scope);
  const col = input.scope === 'org' ? paths.orgTemplates(ctx.orgId) : paths.memberTemplates(ctx.orgId, ctx.uid);
  const ref = input.templateId ? docRef(templatePath(ctx, input.scope, input.templateId)) : colRef(col).doc();
  const max = input.scope === 'org' ? MAX_ORG_TEMPLATES : MAX_PERSONAL_TEMPLATES;

  await db().runTransaction(async (tx) => {
    const existing = await tx.get(ref);
    if (!existing.exists) {
      const count = (await colRef(col).count().get()).data().count;
      if (count >= max) throw new HttpsError('resource-exhausted', `At most ${max} templates are allowed; delete one first.`);
    }
    const t = input.template;
    tx.set(ref, {
      title: t.title,
      category: t.category,
      body: t.body,
      fields: t.fields.map((f) => ({ key: f.key, label: f.label, kind: f.kind, ...(f.kind === 'choice' ? { options: f.options } : {}), required: f.required })),
      defaultPriority: t.defaultPriority,
      patientContext: t.patientContext,
      order: t.order,
      active: t.active,
      createdBy: ctx.uid,
      updatedAt: FieldValue.serverTimestamp(),
    });
    if (input.scope === 'org') {
      await writeAudit(
        ctx.orgId,
        { actorUid: ctx.uid, action: 'template.save', resourceType: 'messageTemplate', resourceId: ref.id, metadata: { created: !existing.exists, category: t.category } },
        tx,
      );
    }
  });
  return { id: ref.id };
}

export async function deleteTemplateHandler(request: CallableRequest<DeleteTemplateRequest>): Promise<Record<string, never>> {
  const input = parse(deleteSchema, request.data);
  const ctx = await requireOrg(request, input.orgId);
  requireScope(ctx, input.scope);
  const ref = docRef(templatePath(ctx, input.scope, input.templateId));
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Template not found.');
    tx.delete(ref);
    if (input.scope === 'org') {
      await writeAudit(ctx.orgId, { actorUid: ctx.uid, action: 'template.delete', resourceType: 'messageTemplate', resourceId: input.templateId }, tx);
    }
  });
  return {};
}

/** Default org template docs, keyed by doc id (`createdBy` = the seeding actor). */
export function defaultTemplateDocs(createdBy: string): Array<{ id: string; data: Record<string, unknown> }> {
  return DEFAULT_TEMPLATES.map((d) => ({
    id: d.id,
    data: { ...d.template, fields: d.template.fields.map((f) => ({ ...f })), createdBy, updatedAt: FieldValue.serverTimestamp() },
  }));
}

/** Writes every default template into `messageTemplates` with `create` (fails if one exists). */
export function writeDefaultTemplates(writer: Transaction | WriteBatch, orgId: string, createdBy: string, onlyIds?: ReadonlySet<string>): number {
  let n = 0;
  for (const d of defaultTemplateDocs(createdBy)) {
    if (onlyIds && !onlyIds.has(d.id)) continue;
    (writer as WriteBatch).create(docRef(paths.orgTemplate(orgId, d.id)), d.data);
    n++;
  }
  return n;
}

export async function seedDefaultTemplatesHandler(request: CallableRequest<SeedDefaultTemplatesRequest>): Promise<SeedDefaultTemplatesResponse> {
  const input = parse(seedSchema, request.data);
  const ctx = await requireOrg(request, input.orgId, ['admin']);
  const existing = await getMany<unknown>(DEFAULT_TEMPLATES.map((d) => paths.orgTemplate(ctx.orgId, d.id)));
  const missing = new Set(DEFAULT_TEMPLATES.map((d) => d.id).filter((tid) => !existing.has(paths.orgTemplate(ctx.orgId, tid))));
  if (missing.size === 0) return { created: 0, existing: DEFAULT_TEMPLATES.length };
  const batch = db().batch();
  const created = writeDefaultTemplates(batch, ctx.orgId, ctx.uid, missing);
  await writeAudit(ctx.orgId, { actorUid: ctx.uid, action: 'template.seed', resourceType: 'org', resourceId: ctx.orgId, metadata: { created } }, batch);
  await batch.commit();
  return { created, existing: DEFAULT_TEMPLATES.length - created };
}

export const saveTemplate = onCall(saveTemplateHandler);
export const deleteTemplate = onCall(deleteTemplateHandler);
export const seedDefaultTemplates = onCall(seedDefaultTemplatesHandler);
