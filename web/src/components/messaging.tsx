// v4 messaging UI pieces shared by Messages, Alerts, Templates, Directory and My notifications.
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { deleteDoc, serverTimestamp, setDoc, Timestamp } from 'firebase/firestore';
import type {
  BroadcastAckReportRequest,
  BroadcastAckReportResponse,
  ChannelPrefs,
  ChannelNotifyMode,
  DeleteTemplateRequest,
  IdResponse,
  Member,
  MessageReadStatusRequest,
  MessageReadStatusResponse,
  MessageTemplate,
  NudgeUnreadRequest,
  NudgeUnreadResponse,
  Patient,
  Priority,
  Reaction,
  SaveTemplateRequest,
  TemplateCategory,
  TemplateField,
} from '@shared/types';
import { useOrgSession } from '../lib/session';
import { orgDoc, type WithId } from '../lib/firestore';
import { useAction, useLiveDoc } from '../lib/hooks';
import { call } from '../lib/firebase';
import { PRIORITIES } from '../lib/constants';
import { errorMessage, formatInstant, formatTime, tsMillis } from '../lib/format';
import { csvFileName, downloadCsv, toCsv } from '../lib/csv';
import {
  ALLOWED_REACTIONS,
  BUILTIN_PLACEHOLDERS,
  DEFAULT_QUICK_REPLIES,
  NOTIFY_MODE_LABELS,
  TEMPLATE_CATEGORIES,
  TEMPLATE_CATEGORY_LABELS,
  TEMPLATE_FIELD_KINDS,
  builtinValues,
  fillPlaceholders,
  myName,
  postMessage,
  presenceOf,
  splitMentions,
  templateMarker,
  tomorrowMorning,
  type BodySegment,
} from '../lib/messaging';
import { Button, ErrorBanner, Field, Modal } from './ui';

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------

/** A button that toggles an absolutely positioned menu; closes on outside click or Escape. */
export function Menu({
  label,
  title,
  children,
  align = 'right',
  className,
}: {
  label: ReactNode;
  title?: string;
  children: (close: () => void) => ReactNode;
  align?: 'left' | 'right';
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className={`menu ${className ?? ''}`} ref={ref}>
      <button type="button" className="menu-trigger" title={title} aria-label={title} aria-expanded={open} onClick={() => setOpen(!open)}>
        {label}
      </button>
      {open && <div className={`menu-list menu-${align}`} role="menu">{children(() => setOpen(false))}</div>}
    </div>
  );
}

export function MenuItem({ onClick, children, danger, active, disabled }: { onClick: () => void; children: ReactNode; danger?: boolean; active?: boolean; disabled?: boolean }) {
  return (
    <button type="button" role="menuitem" className={`menu-item ${danger ? 'danger-link' : ''} ${active ? 'active' : ''}`} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

export function PresenceDot({ member, withLabel }: { member: Member | null | undefined; withLabel?: boolean }) {
  const p = presenceOf(member);
  const title = [p.label, p.text, p.oooUntil ? `until ${p.oooUntil.toLocaleString()}` : null].filter(Boolean).join(' · ');
  return (
    <span className="presence" title={title}>
      <span className={`presence-dot presence-${p.tone}`} aria-hidden="true" />
      {withLabel && <span className="small muted">{p.label}{p.text ? ` · ${p.text}` : ''}</span>}
    </span>
  );
}

/** Message body with @mentions highlighted (stronger when it's me). */
export function MentionText({
  body,
  names,
  roleKeys,
  meUid,
  mentionsMe,
}: {
  body: string;
  names: { uid: string; name: string }[];
  roleKeys: string[];
  meUid: string;
  /** m.mentions includes me (covers role mentions resolved to me). */
  mentionsMe: boolean;
}) {
  const segs: BodySegment[] = useMemo(() => splitMentions(body, names, roleKeys), [body, names, roleKeys]);
  return (
    <>
      {segs.map((sg, i) =>
        sg.mention ? (
          <span
            key={i}
            className={`mention ${
              (sg.mention.kind === 'member' && sg.mention.uid === meUid) || (sg.mention.kind === 'role' && mentionsMe) ? 'mention-me' : ''
            }`}
          >
            {sg.text}
          </span>
        ) : (
          <span key={i}>{sg.text}</span>
        ),
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

/** Form for a template's `fields` (e.g. SBAR). Returns the entered values keyed by field key. */
export function TemplateFieldsModal({
  template,
  onClose,
  onInsert,
}: {
  template: WithId<MessageTemplate>;
  onClose: () => void;
  onInsert: (values: Record<string, string>) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(template.fields.map((f) => [f.key, f.kind === 'choice' ? f.options?.[0] ?? '' : ''])),
  );
  const [error, setError] = useState<string | null>(null);
  function submit(e: FormEvent) {
    e.preventDefault();
    const missing = template.fields.filter((f) => f.required && !(values[f.key] ?? '').trim());
    if (missing.length) return setError(`Fill in: ${missing.map((f) => f.label).join(', ')}.`);
    onInsert(Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim()])));
  }
  return (
    <Modal title={template.title} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <ErrorBanner error={error} />
        {template.fields.map((f, i) => {
          const v = values[f.key] ?? '';
          const set = (x: string) => setValues({ ...values, [f.key]: x });
          const label = `${f.label}${f.required ? ' *' : ''}`;
          return (
            <Field key={f.key} label={label}>
              {f.kind === 'multiline' ? (
                <textarea rows={3} value={v} autoFocus={i === 0} onChange={(e) => set(e.target.value)} />
              ) : f.kind === 'choice' ? (
                <select value={v} onChange={(e) => set(e.target.value)}>
                  {!f.required && <option value="">—</option>}
                  {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : (
                <input type={f.kind === 'number' ? 'number' : 'text'} value={v} autoFocus={i === 0} onChange={(e) => set(e.target.value)} />
              )}
            </Field>
          );
        })}
        <div className="row gap end">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary">Insert</Button>
        </div>
      </form>
    </Modal>
  );
}

const FIELD_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

function blankField(): TemplateField {
  return { key: '', label: '', kind: 'text', required: false };
}

/** Create or edit an org (admin) or personal template through `saveTemplate`. */
export function TemplateEditorModal({
  scope,
  initial,
  initialBody,
  initialPriority,
  onClose,
}: {
  scope: 'org' | 'personal';
  initial?: WithId<MessageTemplate> | null;
  initialBody?: string;
  initialPriority?: Priority;
  onClose: () => void;
}) {
  const s = useOrgSession();
  const act = useAction();
  const [title, setTitle] = useState(initial?.title ?? '');
  const [category, setCategory] = useState<TemplateCategory>(initial?.category ?? 'clinical');
  const [body, setBody] = useState(initial?.body ?? initialBody ?? '');
  const [fields, setFields] = useState<TemplateField[]>(initial?.fields ?? []);
  const [optionText, setOptionText] = useState<string[]>(() => (initial?.fields ?? []).map((f) => (f.options ?? []).join(', ')));
  const [defaultPriority, setDefaultPriority] = useState<Priority>(initial?.defaultPriority ?? initialPriority ?? 'normal');
  const [patientContext, setPatientContext] = useState(initial?.patientContext ?? false);
  const [order, setOrder] = useState(initial?.order ?? 0);
  const [active, setActive] = useState(initial?.active ?? true);

  function updateField(i: number, patch: Partial<TemplateField>) {
    setFields(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  }
  function moveField(i: number, d: -1 | 1) {
    const j = i + d;
    if (j < 0 || j >= fields.length) return;
    const f = [...fields];
    const o = [...optionText];
    [f[i], f[j]] = [f[j]!, f[i]!];
    [o[i], o[j]] = [o[j] ?? '', o[i] ?? ''];
    setFields(f);
    setOptionText(o);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return act.setError('Enter a title.');
    if (!body.trim()) return act.setError('Enter the template text.');
    const keys = new Set<string>();
    const cleanFields: TemplateField[] = [];
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i]!;
      const key = f.key.trim();
      if (!FIELD_KEY_RE.test(key)) return act.setError(`Field ${i + 1}: the key must start with a letter and use only letters, digits and _.`);
      if (keys.has(key)) return act.setError(`Field key "${key}" is used twice.`);
      keys.add(key);
      if (!f.label.trim()) return act.setError(`Field "${key}" needs a label.`);
      const out: TemplateField = { key, label: f.label.trim(), kind: f.kind, required: f.required };
      if (f.kind === 'choice') {
        const opts = (optionText[i] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
        if (opts.length === 0) return act.setError(`Field "${key}" needs at least one option.`);
        out.options = opts;
      }
      cleanFields.push(out);
    }
    const req: SaveTemplateRequest = {
      orgId: s.orgId,
      scope,
      template: {
        title: title.trim(),
        category,
        body: body.trim(),
        fields: cleanFields,
        defaultPriority,
        patientContext,
        order: Number.isFinite(order) ? order : 0,
        active,
      },
    };
    if (initial?.id) req.templateId = initial.id;
    const ok = await act.run(() => call<SaveTemplateRequest, IdResponse>('saveTemplate', req));
    if (ok) onClose();
  }

  return (
    <Modal title={`${initial ? 'Edit' : 'New'} ${scope === 'org' ? 'organization' : 'personal'} template`} onClose={onClose} wide>
      <form className="form" onSubmit={submit}>
        <ErrorBanner error={act.error} />
        <div className="form-grid">
          <Field label="Title">
            <input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} required autoFocus />
          </Field>
          <Field label="Category">
            <select value={category} onChange={(e) => setCategory(e.target.value as TemplateCategory)}>
              {TEMPLATE_CATEGORIES.map((c) => <option key={c} value={c}>{TEMPLATE_CATEGORY_LABELS[c]}</option>)}
            </select>
          </Field>
          <Field label="Default priority">
            <select value={defaultPriority} onChange={(e) => setDefaultPriority(e.target.value as Priority)}>
              {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </Field>
          <Field label="Sort order" hint="Within the category.">
            <input type="number" value={order} onChange={(e) => setOrder(Number(e.target.value))} />
          </Field>
        </div>
        <Field
          label="Text"
          hint={
            <>
              Placeholders: {BUILTIN_PLACEHOLDERS.map((p) => `{{${p.key}}}`).join(' ')}
              {fields.some((f) => f.key) && <> · fields: {fields.filter((f) => f.key).map((f) => `{{${f.key}}}`).join(' ')}</>}
            </>
          }
        >
          <textarea rows={6} maxLength={4000} value={body} onChange={(e) => setBody(e.target.value)} required />
        </Field>
        <div className="row gap wrap">
          <label className="row gap-sm">
            <input type="checkbox" checked={patientContext} onChange={(e) => setPatientContext(e.target.checked)} /> Only in patient conversations
          </label>
          <label className="row gap-sm">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Active
          </label>
        </div>
        <fieldset className="fieldset">
          <legend>Form fields</legend>
          <p className="muted small">Optional inputs shown before inserting (e.g. SBAR: S, B, A, R). Use them in the text as {'{{key}}'}.</p>
          <div className="list-editor">
            {fields.map((f, i) => (
              <div key={i} className="list-editor-row wrap template-field-row">
                <input className="input-sm" placeholder="key" value={f.key} onChange={(e) => updateField(i, { key: e.target.value })} aria-label="Field key" />
                <input placeholder="Label" value={f.label} onChange={(e) => updateField(i, { label: e.target.value })} aria-label="Field label" />
                <select value={f.kind} onChange={(e) => updateField(i, { kind: e.target.value as TemplateField['kind'] })} aria-label="Field type">
                  {TEMPLATE_FIELD_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                </select>
                {f.kind === 'choice' && (
                  <input
                    placeholder="Options, comma-separated"
                    value={optionText[i] ?? ''}
                    onChange={(e) => {
                      const o = [...optionText];
                      o[i] = e.target.value;
                      setOptionText(o);
                    }}
                    aria-label="Options"
                  />
                )}
                <label className="row gap-sm small">
                  <input type="checkbox" checked={f.required} onChange={(e) => updateField(i, { required: e.target.checked })} /> Required
                </label>
                <button type="button" className="link small" onClick={() => moveField(i, -1)} disabled={i === 0} aria-label="Move up">↑</button>
                <button type="button" className="link small" onClick={() => moveField(i, 1)} disabled={i === fields.length - 1} aria-label="Move down">↓</button>
                <button
                  type="button"
                  className="link small danger-link"
                  onClick={() => {
                    setFields(fields.filter((_, j) => j !== i));
                    setOptionText(optionText.filter((_, j) => j !== i));
                  }}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
          <div className="row gap-sm" style={{ marginTop: 8 }}>
            <Button
              small
              onClick={() => {
                setFields([...fields, blankField()]);
                setOptionText([...optionText, '']);
              }}
            >
              Add field
            </Button>
          </div>
        </fieldset>
        <div className="row gap end">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" busy={act.busy}>Save template</Button>
        </div>
      </form>
    </Modal>
  );
}

export async function deleteTemplate(orgId: string, templateId: string, scope: 'org' | 'personal'): Promise<void> {
  await call<DeleteTemplateRequest, unknown>('deleteTemplate', { orgId, templateId, scope });
}

// ---------------------------------------------------------------------------
// Quick replies
// ---------------------------------------------------------------------------

/**
 * One-tap replies for urgent/critical messages and alerts: DEFAULT_QUICK_REPLIES plus active org
 * templates with category `quick_reply`. Each posts a normal message in the channel.
 */
export function QuickReplies({
  channelId,
  threadParentId,
  templates,
  patient,
}: {
  channelId: string;
  threadParentId?: string | null;
  templates: WithId<MessageTemplate>[];
  patient?: Patient | null;
}) {
  const s = useOrgSession();
  const [busy, setBusy] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tplReplies = templates.filter((t) => t.category === 'quick_reply' && t.active !== false);
  const values = builtinValues({ patient: patient ?? null, me: s.member, meName: myName(s) });
  const fromTemplates = tplReplies.map((t) => {
    const text = fillPlaceholders(t.body, values);
    return { key: `t:${t.id}`, label: t.title, body: `${templateMarker(t.id)}${text}`, text };
  });
  // Seeded org quick replies repeat the defaults; keep one chip per reply text (the template's).
  const seen = new Set(fromTemplates.map((c) => c.text.trim().toLowerCase()));
  const chips: { key: string; label: string; body: string }[] = [
    ...DEFAULT_QUICK_REPLIES.filter((r) => !seen.has(r.toLowerCase())).map((r) => ({ key: `d:${r}`, label: r, body: r })),
    ...fromTemplates,
  ];
  async function send(key: string, body: string) {
    setBusy(key);
    setError(null);
    try {
      await postMessage(s, channelId, body, 'normal', threadParentId);
      setSent(key);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="quick-replies">
      {chips.map((c) => (
        <button
          key={c.key}
          type="button"
          className={`chip ${sent === c.key ? 'chip-active' : ''}`}
          disabled={busy !== null}
          onClick={() => void send(c.key, c.body)}
          title={c.body.replace(/^\[\[tpl:[^\]]+\]\]/, '')}
        >
          {busy === c.key ? 'Sending…' : sent === c.key ? `✓ ${c.label}` : c.label}
        </button>
      ))}
      <ErrorBanner error={error} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------

/**
 * Reaction chips + hover picker. `reactions/{uid}` is written directly with exactly
 * `{emoji, at: serverTimestamp()}`; choosing my current emoji again deletes it.
 * My reaction doc is only listened to once the message has reactions or was hovered.
 */
export function Reactions({
  channelId,
  messageId,
  counts,
  canReact,
  showPicker,
  warm,
}: {
  channelId: string;
  messageId: string;
  counts: Record<string, number> | undefined;
  canReact: boolean;
  showPicker: boolean;
  /** Start listening to my reaction (e.g. once the message was hovered). */
  warm: boolean;
}) {
  const s = useOrgSession();
  const [error, setError] = useState<string | null>(null);
  const entries = Object.entries(counts ?? {}).filter(([, n]) => n > 0);
  const listen = entries.length > 0 || showPicker || warm;
  const ref = orgDoc(s.orgId, 'channels', channelId, 'messages', messageId, 'reactions', s.user.uid);
  const mine = useLiveDoc<Reaction>(listen ? ref : null, [s.orgId, channelId, messageId, s.user.uid, listen]);
  const myEmoji = mine.data?.emoji ?? null;

  async function toggle(emoji: string) {
    if (!canReact) return;
    setError(null);
    try {
      if (myEmoji === emoji) await deleteDoc(ref);
      else await setDoc(ref, { emoji, at: serverTimestamp() });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <>
      {entries.length > 0 && (
        <div className="reactions">
          {entries.map(([emoji, n]) => (
            <button
              key={emoji}
              type="button"
              className={`reaction-chip ${myEmoji === emoji ? 'mine' : ''}`}
              disabled={!canReact}
              onClick={() => void toggle(emoji)}
              title={myEmoji === emoji ? 'Remove your reaction' : 'React'}
            >
              {emoji} {n}
            </button>
          ))}
        </div>
      )}
      {canReact && showPicker && (
        <div className="reaction-picker" role="group" aria-label="Add reaction">
          {ALLOWED_REACTIONS.map((e) => (
            <button key={e} type="button" className={myEmoji === e ? 'mine' : ''} onClick={() => void toggle(e)} aria-label={`React ${e}`}>
              {e}
            </button>
          ))}
        </div>
      )}
      <ErrorBanner error={error} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Delivery tracking
// ---------------------------------------------------------------------------

export function ReadStatusModal({
  channelId,
  messageId,
  canNudge,
  onClose,
}: {
  channelId: string;
  messageId: string;
  canNudge: boolean;
  onClose: () => void;
}) {
  const s = useOrgSession();
  const load = useAction();
  const nudge = useAction();
  const [res, setRes] = useState<MessageReadStatusResponse | null>(null);
  const [nudged, setNudged] = useState<number | null>(null);

  useEffect(() => {
    let out: MessageReadStatusResponse | null = null;
    void load
      .run(async () => {
        out = await call<MessageReadStatusRequest, MessageReadStatusResponse>('messageReadStatus', { orgId: s.orgId, channelId, messageId });
      })
      .then((ok) => ok && setRes(out));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.orgId, channelId, messageId]);

  async function doNudge() {
    let out: NudgeUnreadResponse | null = null;
    const ok = await nudge.run(async () => {
      out = await call<NudgeUnreadRequest, NudgeUnreadResponse>('nudgeUnread', { orgId: s.orgId, channelId, messageId });
    });
    if (ok && out) setNudged((out as NudgeUnreadResponse).nudged);
  }

  return (
    <Modal title="Read status" onClose={onClose}>
      <ErrorBanner error={load.error ?? nudge.error} />
      {load.busy && <p className="muted">Loading…</p>}
      {res && (
        <div className="grid-read">
          <div>
            <h3>Read ({res.read.length})</h3>
            {res.read.length === 0 ? <p className="muted small">Nobody yet.</p> : (
              <ul className="list">
                {res.read.map((r) => (
                  <li key={r.uid} className="list-row"><span>{r.name}</span><span className="muted small">{formatInstant(r.at)}</span></li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h3>Unread ({res.unread.length})</h3>
            {res.unread.length === 0 ? <p className="muted small">Everyone has read it.</p> : (
              <ul className="list">
                {res.unread.map((r) => <li key={r.uid} className="list-row"><span>{r.name}</span></li>)}
              </ul>
            )}
          </div>
        </div>
      )}
      {nudged !== null && <div className="banner banner-ok">Reminder sent to {nudged} {nudged === 1 ? 'person' : 'people'}.</div>}
      {canNudge && res && res.unread.length > 0 && (
        <div className="row gap end">
          <span className="muted small">Sends a generic “unread message” reminder. Once per 10 minutes.</span>
          <Button variant="primary" busy={nudge.busy} onClick={() => void doNudge()}>Nudge unread</Button>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Ack-required broadcasts
// ---------------------------------------------------------------------------

export function AckReportModal({ channelId, messageId, title, onClose }: { channelId: string; messageId: string; title: string; onClose: () => void }) {
  const s = useOrgSession();
  const act = useAction();
  const [res, setRes] = useState<BroadcastAckReportResponse | null>(null);
  async function load() {
    let out: BroadcastAckReportResponse | null = null;
    const ok = await act.run(async () => {
      out = await call<BroadcastAckReportRequest, BroadcastAckReportResponse>('broadcastAckReport', { orgId: s.orgId, channelId, messageId });
    });
    if (ok) setRes(out);
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.orgId, channelId, messageId]);

  function exportCsv() {
    if (!res) return;
    type Row = { name: string; status: string; ackedAt: string };
    const rows: Row[] = [
      ...res.acked.map((a) => ({ name: a.name, status: 'Acknowledged', ackedAt: formatInstant(a.ackedAt) })),
      ...res.pending.map((p) => ({ name: p.name, status: 'Pending', ackedAt: '' })),
    ];
    downloadCsv(
      csvFileName(`broadcast-acks-${title}`),
      toCsv(rows, [
        { header: 'Name', value: (r) => r.name },
        { header: 'Status', value: (r) => r.status },
        { header: 'Acknowledged at', value: (r) => r.ackedAt },
      ]),
    );
  }

  return (
    <Modal
      title="Acknowledgement report"
      onClose={onClose}
      wide
      footer={
        <>
          <Button onClick={() => void load()} busy={act.busy}>Refresh</Button>
          <Button variant="primary" disabled={!res} onClick={exportCsv}>Export CSV</Button>
        </>
      }
    >
      <ErrorBanner error={act.error} />
      {!res && act.busy && <p className="muted">Loading…</p>}
      {res && (
        <>
          <p>
            <strong>{res.acked.length}</strong> of {res.total} acknowledged · <strong>{res.pending.length}</strong> pending
          </p>
          <div className="grid-read">
            <div>
              <h3>Acknowledged</h3>
              <ul className="list">
                {res.acked.map((a) => (
                  <li key={a.uid} className="list-row"><span>{a.name}</span><span className="muted small">{formatInstant(a.ackedAt)}</span></li>
                ))}
              </ul>
            </div>
            <div>
              <h3>Pending</h3>
              <ul className="list">
                {res.pending.map((p) => <li key={p.uid} className="list-row"><span>{p.name}</span></li>)}
              </ul>
            </div>
          </div>
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Channel notification preferences
// ---------------------------------------------------------------------------

/**
 * `channels/{cid}/prefs/{uid}` is written directly with exactly
 * `{mode, mutedUntil, updatedAt: serverTimestamp()}`.
 */
export function ChannelPrefsMenu({ channelId }: { channelId: string }) {
  const s = useOrgSession();
  const ref = orgDoc(s.orgId, 'channels', channelId, 'prefs', s.user.uid);
  const prefs = useLiveDoc<ChannelPrefs>(ref, [s.orgId, channelId, s.user.uid]);
  const [error, setError] = useState<string | null>(null);
  const mode: ChannelNotifyMode = prefs.data?.mode ?? 'all';
  const mutedMs = tsMillis(prefs.data?.mutedUntil);
  const muted = mutedMs > Date.now();

  async function write(nextMode: ChannelNotifyMode, mutedUntil: Date | null) {
    setError(null);
    try {
      await setDoc(ref, {
        mode: nextMode,
        mutedUntil: mutedUntil ? Timestamp.fromDate(mutedUntil) : null,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  const keepMute = () => (muted ? new Date(mutedMs) : null);
  const inHours = (h: number) => new Date(Date.now() + h * 3600_000);

  const label = muted ? '🔕' : mode === 'all' ? '🔔' : mode === 'mentions' ? '@' : '❗';
  return (
    <div className="row gap-sm">
      <Menu label={<>{label} <span className="small">{muted ? `Muted until ${formatTime({ seconds: Math.floor(mutedMs / 1000), nanoseconds: 0 })}` : NOTIFY_MODE_LABELS[mode]}</span></>} title="Notification settings">
        {(close) => (
          <>
            <div className="menu-heading">Notify me about</div>
            {(Object.keys(NOTIFY_MODE_LABELS) as ChannelNotifyMode[]).map((m) => (
              <MenuItem key={m} active={mode === m} onClick={() => { close(); void write(m, keepMute()); }}>
                {mode === m ? '● ' : '○ '}{NOTIFY_MODE_LABELS[m]}
              </MenuItem>
            ))}
            <div className="menu-heading">Mute normal messages</div>
            <MenuItem onClick={() => { close(); void write(mode, inHours(1)); }}>For 1 hour</MenuItem>
            <MenuItem onClick={() => { close(); void write(mode, inHours(8)); }}>For 8 hours</MenuItem>
            <MenuItem onClick={() => { close(); void write(mode, tomorrowMorning()); }}>Until tomorrow (8 AM)</MenuItem>
            <MenuItem disabled={!muted} onClick={() => { close(); void write(mode, null); }}>Unmute</MenuItem>
            <div className="menu-note small muted">Urgent and critical messages always notify.</div>
          </>
        )}
      </Menu>
      {error && <span className="error-text small">{error}</span>}
    </div>
  );
}
