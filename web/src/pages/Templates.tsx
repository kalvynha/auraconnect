import { useState } from 'react';
import { query } from 'firebase/firestore';
import type { MessageTemplate } from '@shared/types';
import { useOrgSession } from '../lib/session';
import { orgCol, type WithId } from '../lib/firestore';
import { useAction, useLiveQuery } from '../lib/hooks';
import { call } from '../lib/firebase';
import { TEMPLATE_CATEGORY_LABELS, isVolunteerSession, sortTemplates } from '../lib/messaging';
import { formatInstant } from '../lib/format';
import { Badge, Button, Card, ErrorBanner, Page, Table, Tabs, type Column, type TabDef } from '../components/ui';
import { TemplateEditorModal, deleteTemplate } from '../components/messaging';

type Scope = 'org' | 'personal';

function TemplateTable({ scope, rows, canEdit }: { scope: Scope; rows: WithId<MessageTemplate>[]; canEdit: boolean }) {
  const s = useOrgSession();
  const act = useAction();
  const [editing, setEditing] = useState<WithId<MessageTemplate> | null>(null);

  async function remove(t: WithId<MessageTemplate>) {
    if (!window.confirm(`Delete the template "${t.title}"?`)) return;
    await act.run(() => deleteTemplate(s.orgId, t.id, scope));
  }

  const columns: Column<WithId<MessageTemplate>>[] = [
    {
      header: 'Title',
      cell: (t) => (
        <>
          <strong>{t.title}</strong>
          <div className="muted small clamp">{t.body}</div>
        </>
      ),
      csv: (t) => t.title,
    },
    { header: 'Category', cell: (t) => TEMPLATE_CATEGORY_LABELS[t.category] ?? t.category },
    { header: 'Priority', cell: (t) => <Badge value={t.defaultPriority} />, csv: (t) => t.defaultPriority },
    { header: 'Fields', cell: (t) => (t.fields?.length ? t.fields.map((f) => f.label).join(', ') : '—') },
    { header: 'Patient only', cell: (t) => (t.patientContext ? 'Yes' : '—') },
    { header: 'Order', cell: (t) => t.order ?? 0 },
    { header: 'Status', cell: (t) => (t.active ? <Badge tone="ok">active</Badge> : <Badge tone="neutral">inactive</Badge>), csv: (t) => (t.active ? 'active' : 'inactive') },
    { header: 'Updated', cell: (t) => formatInstant(t.updatedAt) },
  ];
  if (canEdit) {
    columns.push({
      header: '',
      className: 'actions',
      cell: (t) => (
        <div className="row gap-sm">
          <Button small onClick={() => setEditing(t)}>Edit</Button>
          <Button small variant="ghost" busy={act.busy} onClick={() => void remove(t)}>Delete</Button>
        </div>
      ),
    });
  }

  return (
    <>
      <ErrorBanner error={act.error} />
      <Table columns={columns} rows={rows} rowKey={(t) => t.id} empty="No templates yet." exportName={`${scope}-message-templates`} />
      {editing && <TemplateEditorModal scope={scope} initial={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

/**
 * v4 message templates. Admins manage organization templates (`saveTemplate` / `deleteTemplate`,
 * "Seed defaults" → `seedDefaultTemplates`); everyone manages their personal templates.
 */
export default function TemplatesPage() {
  const s = useOrgSession();
  const volunteer = isVolunteerSession(s);
  const [tab, setTab] = useState<Scope>(volunteer ? 'personal' : 'org');
  const [creating, setCreating] = useState<Scope | null>(null);
  const seed = useAction();
  const [seeded, setSeeded] = useState<string | null>(null);
  // Admins read all org templates (including inactive); other staff only see active ones in the composer.
  const org = useLiveQuery<MessageTemplate>(volunteer ? null : query(orgCol(s.orgId, 'messageTemplates')), [s.orgId, volunteer]);
  const personal = useLiveQuery<MessageTemplate>(query(orgCol(s.orgId, 'members', s.user.uid, 'templates')), [s.orgId, s.user.uid]);

  async function seedDefaults() {
    let res: unknown = null;
    const ok = await seed.run(async () => {
      res = await call<{ orgId: string }, unknown>('seedDefaultTemplates', { orgId: s.orgId });
    });
    if (ok) {
      const r = (res ?? {}) as Record<string, unknown>;
      const n = [r.added, r.created, r.count].find((x) => typeof x === 'number') as number | undefined;
      setSeeded(n === undefined ? 'Default templates added.' : `${n} default template${n === 1 ? '' : 's'} added.`);
    }
  }

  const tabs: TabDef<Scope>[] = [
    { key: 'org', label: <>Organization <span className="tab-count">{org.data.length}</span></>, hidden: volunteer },
    { key: 'personal', label: <>My templates <span className="tab-count">{personal.data.length}</span></> },
  ];

  return (
    <Page
      title="Message templates"
      actions={
        <>
          {tab === 'org' && s.isAdmin && (
            <Button busy={seed.busy} onClick={() => void seedDefaults()} title="Adds the built-in templates (SBAR, fall report, …) that this org doesn't have yet">
              Seed defaults
            </Button>
          )}
          {(tab === 'personal' || s.isAdmin) && (
            <Button variant="primary" onClick={() => setCreating(tab)}>New template</Button>
          )}
        </>
      }
    >
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      <ErrorBanner error={seed.error ?? (tab === 'org' ? org.error : personal.error)} />
      {seeded && <div className="banner banner-ok">{seeded}</div>}
      <Card>
        <p className="muted small" style={{ marginTop: 0 }}>
          {tab === 'org'
            ? 'Shared with all staff. Type “/” in a message or use the Templates button to insert one. Quick-reply templates appear as one-tap replies on urgent messages and alerts.'
            : 'Only you see these. You can also save a message as a template from the composer.'}{' '}
          Placeholders such as {'{{patient}}'}, {'{{codeStatus}}'}, {'{{caregiver}}'}, {'{{me}}'}, {'{{time}}'} are filled from the conversation.
        </p>
        {tab === 'org' ? (
          <TemplateTable scope="org" rows={sortTemplates(org.data)} canEdit={s.isAdmin} />
        ) : (
          <TemplateTable scope="personal" rows={sortTemplates(personal.data)} canEdit />
        )}
      </Card>
      {creating && <TemplateEditorModal scope={creating} onClose={() => setCreating(null)} />}
    </Page>
  );
}
