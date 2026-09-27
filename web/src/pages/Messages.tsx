import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  limit,
  limitToLast,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  where,
} from 'firebase/firestore';
import type {
  AiTextResult,
  Alert,
  AlertActionRequest,
  Attachment,
  BroadcastAck,
  CancelReminderRequest,
  EditMessageRequest,
  JoinPatientChannelForCoverageRequest,
  JoinPatientChannelForCoverageResponse,
  LeaveChannelRequest,
  Member,
  MessageTemplate,
  NoReplyReminder,
  Patient,
  BroadcastTarget,
  Channel,
  CreateChannelRequest,
  CreateChannelResponse,
  Message,
  OnCallRole,
  PinMessageRequest,
  Priority,
  ReadReceipt,
  RecallMessageRequest,
  RemindIfNoReplyRequest,
  RenameChannelRequest,
  SearchMessagesRequest,
  SearchMessagesResponse,
  SendBroadcastRequest,
  SendBroadcastResponse,
  SendRoleMessageRequest,
  SendRoleMessageResponse,
  SummarizeChannelRequest,
  Discipline,
  Team,
  UpdateChannelMembersRequest,
} from '@shared/types';
import { useOrgSession, type OrgSession } from '../lib/session';
import { orgCol, orgDoc, type WithId } from '../lib/firestore';
import { useAction, useLiveDoc, useLiveQuery } from '../lib/hooks';
import { call } from '../lib/firebase';
import { DISCIPLINES, PRIORITIES } from '../lib/constants';
import { errorMessage, formatInstant, formatTime, tsMillis, tsToDate } from '../lib/format';
import { useHasCapability } from '../lib/capabilities';
import {
  ChatContext,
  EDIT_WINDOW_MS,
  MAX_BODY,
  REMINDER_MINUTES,
  TEMPLATE_CATEGORIES,
  TEMPLATE_CATEGORY_LABELS,
  builtinValues,
  canPostIn,
  fillPlaceholders,
  myName,
  postMessage,
  templateMarker,
  uidOf,
  useChat,
  useOnCallRoles,
  useOrgTemplates,
  usePersonalTemplates,
  type ChatContextValue,
  type MentionCandidate,
} from '../lib/messaging';
import { AiResultView, Badge, Button, ErrorBanner, Field, MemberPicker, MemberSelect, Modal } from '../components/ui';
import {
  AckReportModal,
  ChannelPrefsMenu,
  MentionText,
  Menu,
  MenuItem,
  PresenceDot,
  QuickReplies,
  Reactions,
  ReadStatusModal,
  TemplateEditorModal,
  TemplateFieldsModal,
} from '../components/messaging';
import { FileViewer } from '../components/FileViewer';
import { patientName } from '../lib/patient';

function channelTitle(c: Channel, s: OrgSession): string {
  if (c.type === 'direct') {
    const other = c.memberUids.find((u) => u !== s.user.uid) ?? s.user.uid;
    return s.memberName(other);
  }
  return c.name ?? c.memberUids.filter((u) => u !== s.user.uid).map((u) => s.memberName(u)).join(', ');
}

function ChannelRow({ c, active, mentioned, onClick }: { c: WithId<Channel>; active: boolean; mentioned?: boolean; onClick: () => void }) {
  const s = useOrgSession();
  const read = useLiveDoc<ReadReceipt>(orgDoc(s.orgId, 'channels', c.id, 'reads', s.user.uid), [s.orgId, c.id, s.user.uid]);
  const unread =
    !!c.lastMessage &&
    c.lastMessage.senderUid !== s.user.uid &&
    tsMillis(c.lastMessageAt) > tsMillis(read.data?.lastReadAt);
  return (
    <button type="button" className={`channel-row ${active ? 'active' : ''} ${unread ? 'unread' : ''}`} onClick={onClick}>
      <div className="row space-between">
        <span className="channel-name">
          {mentioned && <span className="tag tag-mention">@</span>}
          {c.type === 'patient' && <span className="tag">PT</span>}
          {c.type === 'team' && <span className="tag">TEAM</span>}
          {c.type === 'broadcast' && <span className="tag">BCAST</span>}
          {c.archived && <span className="tag">ARCHIVED</span>}
          {channelTitle(c, s)}
        </span>
        <span className="muted small">{c.lastMessage ? formatTime(c.lastMessageAt) : ''}</span>
      </div>
      <div className="channel-preview">
        {c.lastMessage && c.lastMessage.priority !== 'normal' && <Badge value={c.lastMessage.priority} />}
        <span>{c.lastMessage ? `${c.lastMessage.senderName}: ${c.lastMessage.text}` : 'No messages yet'}</span>
      </div>
    </button>
  );
}

/** Mentions filter: reports whether any of a channel's latest messages mention me (backend-set `mentions`). */
const MENTION_SCAN = 25;
function MentionProbe({ channelId, onResult }: { channelId: string; onResult: (channelId: string, hit: boolean) => void }) {
  const s = useOrgSession();
  const msgs = useLiveQuery<Message>(
    query(orgCol(s.orgId, 'channels', channelId, 'messages'), orderBy('createdAt', 'desc'), limit(MENTION_SCAN)),
    [s.orgId, channelId],
  );
  const hit = msgs.data.some((m) => !m.recalledAt && !!m.mentions?.includes(s.user.uid));
  useEffect(() => {
    if (!msgs.loading) onResult(channelId, hit);
  }, [channelId, hit, msgs.loading, onResult]);
  return null;
}

/** M2: attachments are fetched with auth (`getBlob`) and shown from an object URL; no download URLs. */
function AttachmentLink({ a }: { a: Attachment }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="attachment" onClick={() => setOpen(true)}>
        📎 {a.name}
      </button>
      {open && (
        <Modal title={a.name} onClose={() => setOpen(false)} wide>
          <FileViewer storagePath={a.storagePath} contentType={a.contentType} title={a.name} />
        </Modal>
      )}
    </>
  );
}

/**
 * O2: inline Acknowledge for an urgent/critical message whose alert targets me and is still open.
 * The alert is readable only by its recipients (and admins), so for anyone else the listener fails
 * quietly and nothing is shown. Replying in the channel also acknowledges (server side).
 */
function MessageAck({ alertId }: { alertId: string }) {
  const s = useOrgSession();
  const act = useAction();
  const alert = useLiveDoc<Alert>(orgDoc(s.orgId, 'alerts', alertId), [s.orgId, alertId]);
  const a = alert.data;
  if (!a || !a.targetUids.includes(s.user.uid)) return null;
  if (a.status !== 'open') {
    return <span className="muted small">{a.ackedBy ? `Acknowledged by ${a.ackedBy === s.user.uid ? 'you' : s.memberName(a.ackedBy)}` : a.status}</span>;
  }
  return (
    <>
      <Button
        small
        variant="primary"
        busy={act.busy}
        onClick={() => void act.run(() => call<AlertActionRequest, unknown>('ackAlert', { orgId: s.orgId, alertId }))}
      >
        Acknowledge
      </Button>
      <ErrorBanner error={act.error} />
    </>
  );
}

/** Whether the current user may post in this channel (rules: not viewer, not archived, broadcast = creator only). */
const canPost = canPostIn;

function readOnlyReason(channel: Channel, s: OrgSession): string {
  if (channel.archived) return 'This conversation is archived and read-only.';
  if (s.role === 'viewer') return 'Viewers cannot send messages.';
  return 'This is a broadcast. Only the sender can post.';
}

type TemplateOption = { t: WithId<MessageTemplate>; personal: boolean };

/**
 * Composer with v4 templates ("/" or the Templates button), @mention autocomplete and
 * "Save as template". A message sent from a template begins with `[[tpl:{id}]]`; the create shape
 * itself is unchanged (see `postMessage`).
 */
function Composer({ threadParentId, placeholder }: { threadParentId?: string; placeholder?: string }) {
  const s = useOrgSession();
  const chat = useChat();
  const channel = chat.channel;
  const [body, setBody] = useState('');
  const [priority, setPriority] = useState<Priority>('normal');
  const [tpl, setTpl] = useState<{ id: string; title: string } | null>(null);
  const [picker, setPicker] = useState<null | 'slash' | 'button'>(null);
  const [pickerQuery, setPickerQuery] = useState('');
  const [mention, setMention] = useState<{ start: number; end: number; query: string } | null>(null);
  const [hi, setHi] = useState(0);
  const [fieldsFor, setFieldsFor] = useState<WithId<MessageTemplate> | null>(null);
  const [savingTpl, setSavingTpl] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fromSlash = useRef(false);

  const isPatient = channel.type === 'patient';
  const templates: TemplateOption[] = useMemo(() => {
    const all: TemplateOption[] = [
      ...chat.orgTemplates.map((t) => ({ t, personal: false })),
      ...chat.personalTemplates.map((t) => ({ t, personal: true })),
    ].filter(({ t }) => isPatient || !t.patientContext);
    const q = pickerQuery.trim().toLowerCase();
    const filtered = q
      ? all.filter(({ t }) => t.title.toLowerCase().includes(q) || (TEMPLATE_CATEGORY_LABELS[t.category] ?? '').toLowerCase().includes(q))
      : all;
    return filtered.sort(
      (a, b) =>
        TEMPLATE_CATEGORIES.indexOf(a.t.category) - TEMPLATE_CATEGORIES.indexOf(b.t.category) ||
        Number(a.personal) - Number(b.personal) ||
        (a.t.order ?? 0) - (b.t.order ?? 0) ||
        a.t.title.localeCompare(b.t.title),
    );
  }, [chat.orgTemplates, chat.personalTemplates, isPatient, pickerQuery]);

  const mentionCands: MentionCandidate[] = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    const byUid = new Map(s.members.map((m) => [uidOf(m), m]));
    const members: MentionCandidate[] = channel.memberUids
      .filter((u) => u !== s.user.uid)
      .map((u) => byUid.get(u))
      .filter((m): m is WithId<Member> => !!m && m.active !== false && !!m.displayName)
      .map((m) => ({ insert: m.displayName, label: m.displayName, sub: m.discipline, kind: 'member', uid: uidOf(m) }));
    const roles: MentionCandidate[] = chat.roles.map((r) => ({ insert: r.id, label: r.label, sub: `@${r.id} · whoever is on call`, kind: 'role' }));
    return [...members, ...roles]
      .filter((c) => !q || c.label.toLowerCase().includes(q) || c.insert.toLowerCase().includes(q))
      .slice(0, 8);
  }, [mention, channel.memberUids, s.members, s.user.uid, chat.roles]);

  const open: 'templates' | 'mentions' | null = picker ? 'templates' : mention && mentionCands.length > 0 ? 'mentions' : null;
  const count = open === 'templates' ? templates.length : open === 'mentions' ? mentionCands.length : 0;

  function focusAt(pos: number) {
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(pos, pos);
    });
  }

  function onChange(value: string, caret: number) {
    setBody(value);
    if (!value.trim()) setTpl(null);
    const slash = /^\/\S*$/.test(value);
    if (slash) {
      setPicker('slash');
      setPickerQuery(value.slice(1));
      setHi(0);
    } else if (picker === 'slash') {
      setPicker(null);
    }
    const mm = slash ? null : /(^|\s)@([^@\n]{0,40})$/.exec(value.slice(0, caret));
    if (mm) {
      setMention({ start: caret - mm[2]!.length - 1, end: caret, query: mm[2]! });
      setHi(0);
    } else {
      setMention(null);
    }
  }

  function chooseMention(c: MentionCandidate) {
    if (!mention) return;
    const next = `${body.slice(0, mention.start)}@${c.insert} ${body.slice(mention.end)}`;
    setBody(next);
    setMention(null);
    focusAt(mention.start + c.insert.length + 2);
  }

  function applyTemplate(t: WithId<MessageTemplate>, values: Record<string, string>) {
    const text = fillPlaceholders(t.body, { ...builtinValues({ patient: chat.patient, me: s.member, meName: myName(s) }), ...values });
    const replace = fromSlash.current || !body.trim();
    const next = (replace ? text : `${body.replace(/\s+$/, '')}\n${text}`).slice(0, MAX_BODY);
    setBody(next);
    setTpl({ id: t.id, title: t.title });
    setPriority(t.defaultPriority ?? 'normal');
    setFieldsFor(null);
    focusAt(next.length);
  }

  function chooseTemplate(t: WithId<MessageTemplate>) {
    fromSlash.current = picker === 'slash';
    setPicker(null);
    setPickerQuery('');
    if (t.fields?.length) setFieldsFor(t);
    else applyTemplate(t, {});
  }

  /** Arrow/Enter/Tab/Escape handling for the open suggestion list; returns true when handled. */
  function listKey(e: KeyboardEvent<HTMLElement>): boolean {
    if (!open) return false;
    if (e.key === 'Escape') {
      e.preventDefault();
      setPicker(null);
      setMention(null);
      return true;
    }
    if (count === 0) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setHi((h) => (h + (e.key === 'ArrowDown' ? 1 : count - 1)) % count);
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      const i = Math.min(hi, count - 1);
      if (open === 'templates') chooseTemplate(templates[i]!.t);
      else chooseMention(mentionCands[i]!);
      return true;
    }
    return false;
  }

  async function send(e?: FormEvent) {
    e?.preventDefault();
    const text = body.trim();
    if (!text || sending) return;
    const full = tpl ? `${templateMarker(tpl.id)}${text}` : text;
    if (full.length > MAX_BODY) return setError(`Messages are limited to ${MAX_BODY} characters.`);
    setSending(true);
    setError(null);
    try {
      await postMessage(s, channel.id, full, priority, threadParentId);
      setBody('');
      setPriority('normal');
      setTpl(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSending(false);
    }
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    // The button-opened picker is driven from its own search box; Escape still closes it.
    if (picker === 'button') {
      if (e.key === 'Escape') {
        e.preventDefault();
        setPicker(null);
        return;
      }
    } else if (listKey(e)) {
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  if (!canPost(channel, s)) return <div className="composer muted small">{readOnlyReason(channel, s)}</div>;
  return (
    <>
      <form className="composer" onSubmit={send}>
        <ErrorBanner error={error} />
        {open && (
          <div className="suggest" role="listbox" aria-label={open === 'templates' ? 'Templates' : 'Mention'}>
            {open === 'templates' && (
              <>
                {picker === 'button' && (
                  <input
                    className="suggest-search"
                    type="search"
                    autoFocus
                    placeholder="Search templates…"
                    value={pickerQuery}
                    onChange={(e) => {
                      setPickerQuery(e.target.value);
                      setHi(0);
                    }}
                    onKeyDown={(e) => void listKey(e)}
                  />
                )}
                {templates.length === 0 && (
                  <div className="muted small pad">
                    No templates{pickerQuery ? ' match' : ''}. {s.isAdmin && <Link to="/templates">Manage templates</Link>}
                  </div>
                )}
                {templates.map((x, i) => {
                  const header = i === 0 || templates[i - 1]!.t.category !== x.t.category;
                  return (
                    <Fragment key={`${x.personal ? 'p' : 'o'}:${x.t.id}`}>
                      {header && <div className="suggest-group">{TEMPLATE_CATEGORY_LABELS[x.t.category] ?? x.t.category}</div>}
                      <button
                        type="button"
                        role="option"
                        aria-selected={i === hi}
                        className={`suggest-item ${i === hi ? 'active' : ''}`}
                        onMouseDown={(e) => e.preventDefault()}
                        onMouseEnter={() => setHi(i)}
                        onClick={() => chooseTemplate(x.t)}
                      >
                        <span>
                          {x.t.title}
                          {x.personal && <span className="tag" style={{ marginLeft: 6 }}>MINE</span>}
                          {x.t.fields?.length > 0 && <span className="muted small"> · form</span>}
                        </span>
                        {x.t.defaultPriority !== 'normal' && <Badge value={x.t.defaultPriority} />}
                      </button>
                    </Fragment>
                  );
                })}
              </>
            )}
            {open === 'mentions' &&
              mentionCands.map((c, i) => (
                <button
                  key={`${c.kind}:${c.insert}`}
                  type="button"
                  role="option"
                  aria-selected={i === hi}
                  className={`suggest-item ${i === hi ? 'active' : ''}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setHi(i)}
                  onClick={() => chooseMention(c)}
                >
                  <span>
                    {c.kind === 'member' && <PresenceDot member={s.members.find((m) => uidOf(m) === c.uid)} />} {c.label}
                  </span>
                  <span className="muted small">{c.sub}</span>
                </button>
              ))}
          </div>
        )}
        {tpl && (
          <div className="composer-tpl small">
            <span className="tag">TEMPLATE</span> {tpl.title}
            <button type="button" className="link small" onClick={() => setTpl(null)} aria-label="Don't mark as template">×</button>
          </div>
        )}
        <textarea
          ref={taRef}
          rows={2}
          placeholder={placeholder ?? 'Message… (Enter to send, / for templates, @ to mention)'}
          value={body}
          maxLength={MAX_BODY}
          onChange={(e) => onChange(e.target.value, e.target.selectionStart ?? e.target.value.length)}
          onKeyDown={onKey}
          onBlur={() => setMention(null)}
        />
        <div className="row gap-sm wrap">
          <Button
            small
            variant="ghost"
            onClick={() => {
              setPicker(picker === 'button' ? null : 'button');
              setPickerQuery('');
              setHi(0);
            }}
          >
            Templates
          </Button>
          <Button small variant="ghost" disabled={!body.trim()} onClick={() => setSavingTpl(true)} title="Save this text as a personal template">
            Save as template
          </Button>
          <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)} aria-label="Priority">
            {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <Button type="submit" variant={priority === 'normal' ? 'primary' : 'danger'} busy={sending} disabled={!body.trim()}>
            {threadParentId ? 'Reply' : 'Send'}{priority !== 'normal' ? ` ${priority}` : ''}
          </Button>
        </div>
      </form>
      {fieldsFor && <TemplateFieldsModal template={fieldsFor} onClose={() => setFieldsFor(null)} onInsert={(v) => applyTemplate(fieldsFor, v)} />}
      {savingTpl && <TemplateEditorModal scope="personal" initialBody={body.trim()} initialPriority={priority} onClose={() => setSavingTpl(false)} />}
    </>
  );
}

/** Ack-required broadcast: direct create of `acks/{uid}` with exactly `{messageId, ackedAt}`. */
function AckControl({ messageId }: { messageId: string }) {
  const s = useOrgSession();
  const chat = useChat();
  const act = useAction();
  if (chat.myAck) {
    return <Badge tone="ok">Acknowledged {formatInstant(chat.myAck.ackedAt)}</Badge>;
  }
  if (chat.myAckLoading) return null;
  return (
    <>
      <Button
        small
        variant="primary"
        busy={act.busy}
        onClick={() =>
          void act.run(() =>
            setDoc(orgDoc(s.orgId, 'channels', chat.channel.id, 'acks', s.user.uid), { messageId, ackedAt: serverTimestamp() }),
          )
        }
      >
        Acknowledge
      </Button>
      <ErrorBanner error={act.error} />
    </>
  );
}

const QUICK_REPLY_OPEN_MS = 6 * 3600_000;

function MessageBubble({ m, onThread, inThread }: { m: WithId<Message>; onThread?: () => void; inThread?: boolean }) {
  const s = useOrgSession();
  const chat = useChat();
  const channel = chat.channel;
  const hasReports = useHasCapability('reports');
  const recall = useAction();
  const acts = useAction();
  const [hovered, setHovered] = useState(false);
  const [warm, setWarm] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [readStatus, setReadStatus] = useState(false);
  const [ackReport, setAckReport] = useState(false);
  const [quickOpen, setQuickOpen] = useState(() => Date.now() - tsMillis(m.createdAt) < QUICK_REPLY_OPEN_MS);
  const mine = m.senderUid === s.user.uid;
  const recalled = !!m.recalledAt;
  const canRecall = !recalled && s.role !== 'viewer' && (mine || s.isAdmin);
  const replies = m.replyCount ?? 0;
  const needsAck = !recalled && !mine && !!m.alertId && m.priority !== 'normal';
  const mentionsMe = !!m.mentions?.includes(s.user.uid);
  const pinned = !!channel.pinned?.some((p) => p.messageId === m.id);
  const created = tsMillis(m.createdAt);
  const canEdit = mine && !recalled && chat.canPost && Date.now() - created < EDIT_WINDOW_MS;
  const showQuick = !mine && !recalled && m.priority !== 'normal' && chat.canPost;
  const isAckMsg = !!channel.requireAck && chat.ackMessageId === m.id;
  const canSeeAckReport = isAckMsg && (mine || s.isAdmin || hasReports);
  const myReminders = chat.reminders.filter((r) => r.messageId === m.id);
  const others = channel.memberUids.filter((u) => u !== s.user.uid);
  const readN = mine ? others.filter((u) => (chat.readAt.get(u) ?? 0) >= created).length : 0;
  const hasMenu = !recalled && (chat.canPost || canRecall);

  async function doRecall() {
    if (!window.confirm('Recall this message? Its text and attachments are removed for everyone.')) return;
    await recall.run(() =>
      call<RecallMessageRequest, unknown>('recallMessage', { orgId: s.orgId, channelId: channel.id, messageId: m.id }),
    );
  }
  async function togglePin() {
    await acts.run(() =>
      call<PinMessageRequest, unknown>('pinMessage', { orgId: s.orgId, channelId: channel.id, messageId: m.id, pinned: !pinned }),
    );
  }
  async function saveEdit() {
    const text = draft.trim();
    if (!text) return acts.setError('A message cannot be empty. Use Recall to remove it.');
    if (text === m.body) return setEditing(false);
    const ok = await acts.run(() =>
      call<EditMessageRequest, unknown>('editMessage', { orgId: s.orgId, channelId: channel.id, messageId: m.id, body: text }),
    );
    if (ok) setEditing(false);
  }
  async function remind(minutes: RemindIfNoReplyRequest['minutes']) {
    await acts.run(() =>
      call<RemindIfNoReplyRequest, unknown>('remindIfNoReply', { orgId: s.orgId, channelId: channel.id, messageId: m.id, minutes }),
    );
  }
  async function cancelReminder(reminderId: string) {
    await acts.run(() => call<CancelReminderRequest, unknown>('cancelReminder', { orgId: s.orgId, reminderId }));
  }

  return (
    <div
      className={`msg ${mine ? 'mine' : ''} prio-${m.priority} ${recalled ? 'recalled' : ''} ${mentionsMe ? 'mentioned' : ''}`}
      id={`msg-${m.id}`}
      onMouseEnter={() => {
        setHovered(true);
        setWarm(true);
      }}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="msg-meta">
        <strong>{mine ? 'You' : m.senderName}</strong>
        <span className="muted small" title={formatInstant(m.createdAt)}>{inThread ? formatInstant(m.createdAt) : formatTime(m.createdAt)}</span>
        {m.priority !== 'normal' && <Badge value={m.priority} />}
        {m.roleTarget && <span className="tag">to {m.roleTarget}</span>}
        {m.alertId && <span className="tag">alert raised</span>}
        {pinned && <span className="tag">PINNED</span>}
        {mentionsMe && !mine && <span className="tag tag-mention">@you</span>}
        {m.editedAt && !recalled && <span className="muted small" title={`Edited ${formatInstant(m.editedAt)}`}>(edited)</span>}
        {hasMenu && (
          <Menu className="msg-menu" label="⋯" title="Message actions">
            {(close) => (
              <>
                {chat.canPost && (
                  <MenuItem onClick={() => { close(); void togglePin(); }}>{pinned ? 'Unpin' : 'Pin to channel'}</MenuItem>
                )}
                {canEdit && (
                  <MenuItem onClick={() => { close(); setDraft(m.body); setEditing(true); }}>Edit</MenuItem>
                )}
                {mine && chat.canPost && (
                  <>
                    <div className="menu-heading">Remind me if no reply in</div>
                    {REMINDER_MINUTES.map((n) => (
                      <MenuItem key={n} onClick={() => { close(); void remind(n); }}>
                        {n < 60 ? `${n} minutes` : `${n / 60} hour${n > 60 ? 's' : ''}`}
                      </MenuItem>
                    ))}
                  </>
                )}
                {canRecall && (
                  <MenuItem danger onClick={() => { close(); void doRecall(); }}>Recall</MenuItem>
                )}
              </>
            )}
          </Menu>
        )}
      </div>
      {recalled ? (
        <div className="msg-body muted"><em>Message recalled</em></div>
      ) : editing ? (
        <div className="msg-edit">
          <textarea
            rows={3}
            autoFocus
            maxLength={MAX_BODY}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setEditing(false);
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void saveEdit();
              }
            }}
          />
          <div className="row gap-sm">
            <Button small variant="primary" busy={acts.busy} onClick={() => void saveEdit()}>Save</Button>
            <Button small onClick={() => setEditing(false)}>Cancel</Button>
            <span className="muted small">Edits don't notify again.</span>
          </div>
        </div>
      ) : (
        <>
          <div className="msg-body">
            <MentionText body={m.body} names={chat.mentionNames} roleKeys={chat.roleKeys} meUid={s.user.uid} mentionsMe={mentionsMe} />
          </div>
          {m.attachments?.length > 0 && (
            <div className="row gap-sm wrap">
              {m.attachments.map((a, i) => <AttachmentLink key={i} a={a} />)}
            </div>
          )}
        </>
      )}
      {!recalled && (
        <Reactions
          channelId={channel.id}
          messageId={m.id}
          counts={m.reactionCounts}
          canReact={chat.canPost}
          showPicker={hovered && !editing}
          warm={warm}
        />
      )}
      <ErrorBanner error={recall.error ?? acts.error} />
      <div className="msg-actions">
        {needsAck && m.alertId && <MessageAck alertId={m.alertId} />}
        {isAckMsg && channel.createdBy !== s.user.uid && <AckControl messageId={m.id} />}
        {onThread && replies > 0 && (
          <button type="button" className="link small" onClick={onThread}>
            {replies} {replies === 1 ? 'reply' : 'replies'}{m.lastReplyAt ? ` · last ${formatTime(m.lastReplyAt)}` : ''}
          </button>
        )}
        {onThread && !recalled && replies === 0 && (
          <button type="button" className="link small" onClick={onThread}>Reply in thread</button>
        )}
        {mine && !recalled && others.length > 0 && (
          <button type="button" className="link small muted-link" onClick={() => setReadStatus(true)} title="See who has read this">
            Read by {readN} of {others.length}
          </button>
        )}
        {canSeeAckReport && (
          <button type="button" className="link small" onClick={() => setAckReport(true)}>Acknowledgement report</button>
        )}
        {showQuick && !quickOpen && (
          <button type="button" className="link small" onClick={() => setQuickOpen(true)}>Quick reply…</button>
        )}
      </div>
      {myReminders.map((r) => (
        <div key={r.id} className="reminder-chip small">
          ⏰ Reminding you at {formatTime(r.dueAt)} if nobody replies ·{' '}
          <button type="button" className="link small" disabled={acts.busy} onClick={() => void cancelReminder(r.id)}>Cancel</button>
        </div>
      ))}
      {showQuick && quickOpen && (
        <QuickReplies channelId={channel.id} threadParentId={m.threadParentId ?? null} templates={chat.orgTemplates} patient={chat.patient} />
      )}
      {readStatus && (
        <ReadStatusModal channelId={channel.id} messageId={m.id} canNudge={mine || s.isAdmin} onClose={() => setReadStatus(false)} />
      )}
      {ackReport && (
        <AckReportModal channelId={channel.id} messageId={m.id} title={channel.name ?? 'broadcast'} onClose={() => setAckReport(false)} />
      )}
    </div>
  );
}

function ThreadPanel({ parent, onClose }: { parent: WithId<Message>; onClose: () => void }) {
  const s = useOrgSession();
  const { channel } = useChat();
  const replies = useLiveQuery<Message>(
    query(orgCol(s.orgId, 'channels', channel.id, 'messages'), where('threadParentId', '==', parent.id)),
    [s.orgId, channel.id, parent.id],
  );
  const sorted = useMemo(() => [...replies.data].sort((a, b) => tsMillis(a.createdAt) - tsMillis(b.createdAt)), [replies.data]);
  const endRef = useRef<HTMLDivElement>(null);
  const lastId = sorted[sorted.length - 1]?.id;
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [lastId]);

  return (
    <aside className="thread-panel">
      <header className="chat-header">
        <h2>Thread</h2>
        <button className="icon-btn" onClick={onClose} aria-label="Close thread">×</button>
      </header>
      <div className="chat-messages">
        <MessageBubble m={parent} inThread />
        <div className="day-sep">{sorted.length} {sorted.length === 1 ? 'reply' : 'replies'}</div>
        <ErrorBanner error={replies.error} />
        {sorted.map((m) => <MessageBubble key={m.id} m={m} inThread />)}
        <div ref={endRef} />
      </div>
      <Composer threadParentId={parent.id} placeholder="Reply in thread…" />
    </aside>
  );
}

/** Pinned messages (channel.pinned, newest first, max 10) shown at the top of the channel. */
function PinnedBar() {
  const s = useOrgSession();
  const chat = useChat();
  const act = useAction();
  const [expanded, setExpanded] = useState(false);
  const pins = chat.channel.pinned ?? [];
  if (pins.length === 0) return null;
  const shown = expanded ? pins : pins.slice(0, 1);
  function jump(id: string) {
    const el = document.getElementById(`msg-${id}`);
    if (!el) return act.setError('That message is older than the loaded history.');
    act.setError(null);
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('flash');
    window.setTimeout(() => el.classList.remove('flash'), 1600);
  }
  return (
    <div className="pinned-bar">
      {shown.map((p) => (
        <div key={p.messageId} className="pinned-row">
          <span aria-hidden="true">📌</span>
          <button type="button" className="link pinned-snippet" onClick={() => jump(p.messageId)}>{p.snippet || '(no text)'}</button>
          <span className="muted small">{s.memberName(p.pinnedBy)} · {formatInstant(p.pinnedAt)}</span>
          {chat.canPost && (
            <button
              type="button"
              className="link small"
              disabled={act.busy}
              onClick={() =>
                void act.run(() =>
                  call<PinMessageRequest, unknown>('pinMessage', { orgId: s.orgId, channelId: chat.channel.id, messageId: p.messageId, pinned: false }),
                )
              }
            >
              Unpin
            </button>
          )}
        </div>
      ))}
      {pins.length > 1 && (
        <button type="button" className="link small" onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Show less' : `Show all ${pins.length} pinned`}
        </button>
      )}
      <ErrorBanner error={act.error} />
    </div>
  );
}

function telHref(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, '')}`;
}

/** Channel info side panel: patient header, description, members (presence), rename/add/remove/leave. */
function ChannelInfoPanel({ onClose }: { onClose: () => void }) {
  const s = useOrgSession();
  const chat = useChat();
  const channel = chat.channel;
  const navigate = useNavigate();
  const act = useAction();
  const [name, setName] = useState(channel.name ?? '');
  const [adding, setAdding] = useState<string[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const p = chat.patient;
  const groupish = channel.type === 'group' || channel.type === 'team';
  const canRename = groupish && !channel.archived && (channel.createdBy === s.user.uid || s.isAdmin);
  const canLeave = groupish && channel.memberUids.length > 1;
  const canManage =
    !channel.archived &&
    s.role !== 'viewer' &&
    (groupish || (channel.type === 'patient' && (s.isAdmin || !!p?.careTeamUids?.includes(s.user.uid))));
  const byUid = useMemo(() => new Map(s.members.map((m) => [uidOf(m), m])), [s.members]);
  const coverage = new Map((channel.coverageMembers ?? []).map((c) => [c.uid, c]));
  const members = [...channel.memberUids].sort((a, b) => s.memberName(a).localeCompare(s.memberName(b)));
  const nonMembers = s.members.filter((m) => !channel.memberUids.includes(uidOf(m)));

  async function update(req: Omit<UpdateChannelMembersRequest, 'orgId' | 'channelId'>) {
    return act.run(() => call<UpdateChannelMembersRequest, unknown>('updateChannelMembers', { orgId: s.orgId, channelId: channel.id, ...req }));
  }
  async function rename(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return act.setError('Enter a name.');
    await act.run(() => call<RenameChannelRequest, unknown>('renameChannel', { orgId: s.orgId, channelId: channel.id, name: name.trim() }));
  }
  async function leave() {
    if (!window.confirm('Leave this conversation? You will no longer see its messages.')) return;
    const ok = await act.run(() => call<LeaveChannelRequest, unknown>('leaveChannel', { orgId: s.orgId, channelId: channel.id }));
    if (ok) navigate('/messages');
  }

  return (
    <aside className="thread-panel info-panel">
      <header className="chat-header">
        <h2>Details</h2>
        <button className="icon-btn" onClick={onClose} aria-label="Close details">×</button>
      </header>
      <div className="info-body">
        <ErrorBanner error={act.error} />
        {channel.type === 'patient' && p && (
          <section className="info-section patient-head">
            <Link to={`/patients/${p.id}`}><strong>{patientName(p)}</strong></Link>
            <div className="row gap-sm wrap">
              <Badge tone={p.codeStatus === 'Full Code' || p.codeStatus === 'Unknown' ? 'neutral' : 'warn'}>{p.codeStatus}</Badge>
              <Badge value={p.status} />
            </div>
            <div className="small">
              <span className="muted">Allergies: </span>
              {p.allergies?.length ? <strong className="error-text">{p.allergies.join(', ')}</strong> : 'None recorded'}
            </div>
            {p.caregiver ? (
              <div className="small">
                <span className="muted">Caregiver: </span>
                {p.caregiver.name}{p.caregiver.relationship ? ` (${p.caregiver.relationship})` : ''}
                {p.caregiver.phone && <> · <a href={telHref(p.caregiver.phone)}>{p.caregiver.phone}</a></>}
              </div>
            ) : (
              <div className="small muted">No caregiver on file.</div>
            )}
          </section>
        )}
        {channel.description && (
          <section className="info-section">
            <div className="field-label">About</div>
            <p className="small" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{channel.description}</p>
          </section>
        )}
        {canRename && (
          <section className="info-section">
            <form className="row gap-sm" onSubmit={rename}>
              <input value={name} maxLength={200} onChange={(e) => setName(e.target.value)} aria-label="Conversation name" />
              <Button small type="submit" busy={act.busy} disabled={name.trim() === (channel.name ?? '')}>Rename</Button>
            </form>
          </section>
        )}
        <section className="info-section">
          <div className="row space-between">
            <div className="field-label">Members ({channel.memberUids.length})</div>
            {canManage && <button type="button" className="link small" onClick={() => setShowAdd(!showAdd)}>{showAdd ? 'Done' : 'Add'}</button>}
          </div>
          {showAdd && canManage && (
            <div className="form" style={{ margin: '8px 0' }}>
              <MemberPicker members={nonMembers} value={adding} onChange={setAdding} />
              <Button
                small
                variant="primary"
                busy={act.busy}
                disabled={adding.length === 0}
                onClick={async () => {
                  if (await update({ add: adding })) {
                    setAdding([]);
                    setShowAdd(false);
                  }
                }}
              >
                Add {adding.length || ''} member{adding.length === 1 ? '' : 's'}
              </Button>
            </div>
          )}
          <ul className="list">
            {members.map((uid) => {
              const m = byUid.get(uid);
              const cov = coverage.get(uid);
              return (
                <li key={uid} className="list-row">
                  <span className="row gap-sm">
                    <PresenceDot member={m} />
                    <span>
                      {s.memberName(uid)}{uid === s.user.uid ? ' (you)' : ''}
                      <span className="muted small"> {m?.discipline ?? ''}</span>
                      {cov && <span className="tag" style={{ marginLeft: 6 }}>COVERAGE until {formatTime(cov.until)}</span>}
                    </span>
                  </span>
                  {canManage && uid !== s.user.uid && channel.memberUids.length > 1 && (
                    <button
                      type="button"
                      className="link small danger-link"
                      disabled={act.busy}
                      onClick={() => {
                        if (window.confirm(`Remove ${s.memberName(uid)} from this conversation?`)) void update({ remove: [uid] });
                      }}
                    >
                      Remove
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
        {canLeave && (
          <section className="info-section">
            <Button small variant="danger" busy={act.busy} onClick={() => void leave()}>Leave conversation</Button>
          </section>
        )}
      </div>
    </aside>
  );
}

type SidePanel = { kind: 'thread'; id: string } | { kind: 'info' } | null;

function ChatView({ channel }: { channel: WithId<Channel> }) {
  const s = useOrgSession();
  const messages = useLiveQuery<Message>(
    query(orgCol(s.orgId, 'channels', channel.id, 'messages'), orderBy('createdAt'), limitToLast(200)),
    [s.orgId, channel.id],
  );
  const patient = useLiveDoc<Patient>(channel.patientId ? orgDoc(s.orgId, 'patients', channel.patientId) : null, [s.orgId, channel.patientId]);
  const orgTemplates = useOrgTemplates(s);
  const personalTemplates = usePersonalTemplates(s);
  const roles = useOnCallRoles(s.orgId);
  const reads = useLiveQuery<ReadReceipt>(orgCol(s.orgId, 'channels', channel.id, 'reads'), [s.orgId, channel.id]);
  const reminders = useLiveQuery<NoReplyReminder>(
    query(orgCol(s.orgId, 'reminders'), where('ownerUid', '==', s.user.uid), where('status', '==', 'pending')),
    [s.orgId, s.user.uid],
  );
  const requireAck = !!channel.requireAck;
  const myAck = useLiveDoc<BroadcastAck>(
    requireAck ? orgDoc(s.orgId, 'channels', channel.id, 'acks', s.user.uid) : null,
    [s.orgId, channel.id, s.user.uid, requireAck],
  );
  const [side, setSide] = useState<SidePanel>(null);
  const [summarizing, setSummarizing] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  // Channel timeline hides thread replies (old messages lack threadParentId).
  const timeline = useMemo(() => messages.data.filter((m) => !m.threadParentId), [messages.data]);
  const threadParent = side?.kind === 'thread' ? messages.data.find((m) => m.id === side.id) ?? null : null;

  const ackMessageId = useMemo(
    () => (requireAck ? timeline.find((m) => m.senderUid === channel.createdBy)?.id ?? null : null),
    [requireAck, timeline, channel.createdBy],
  );

  const ctx = useMemo<ChatContextValue>(
    () => ({
      channel,
      patient: patient.data,
      orgTemplates: orgTemplates.data,
      personalTemplates: personalTemplates.data,
      roles: roles.data,
      readAt: new Map(reads.data.map((r) => [r.id, tsMillis(r.lastReadAt)])),
      reminders: reminders.data.filter((r) => r.channelId === channel.id),
      myAck: myAck.data,
      myAckLoading: myAck.loading,
      ackMessageId,
      canPost: canPost(channel, s),
      mentionNames: s.members.filter((m) => m.active !== false && m.displayName).map((m) => ({ uid: uidOf(m), name: m.displayName })),
      roleKeys: roles.data.map((r) => r.id),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [channel, patient.data, orgTemplates.data, personalTemplates.data, roles.data, reads.data, reminders.data, myAck.data, myAck.loading, ackMessageId, s.members, s.role],
  );

  // Mark read whenever this channel is open and new messages arrive.
  const lastId = messages.data[messages.data.length - 1]?.id;
  const lastTimelineId = timeline[timeline.length - 1]?.id;
  useEffect(() => {
    if (messages.loading) return;
    setDoc(orgDoc(s.orgId, 'channels', channel.id, 'reads', s.user.uid), { lastReadAt: serverTimestamp() }).catch(() => {
      /* non-fatal */
    });
  }, [s.orgId, channel.id, s.user.uid, lastId, messages.loading]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [lastTimelineId]);

  const directOther = channel.type === 'direct' ? s.members.find((m) => uidOf(m) === channel.memberUids.find((u) => u !== s.user.uid)) : undefined;

  let lastDay = '';
  return (
    <ChatContext.Provider value={ctx}>
      <div className="chat-with-thread">
        <div className="chat">
          <header className="chat-header">
            <div style={{ minWidth: 0 }}>
              <h2>
                {directOther && <PresenceDot member={directOther} />} {channelTitle(channel, s)}{' '}
                {channel.archived && <Badge tone="neutral">archived</Badge>}
                {channel.type === 'broadcast' && <> <Badge tone="info">broadcast</Badge></>}
                {requireAck && <> <Badge tone="warn">ack required</Badge></>}
              </h2>
              <div className="muted small chat-subtitle">
                {channel.type === 'patient' && patient.data
                  ? `${patient.data.codeStatus} · ${patient.data.allergies?.length ? `Allergies: ${patient.data.allergies.join(', ')}` : 'No allergies recorded'}`
                  : `${channel.type} · ${channel.memberUids.map((u) => s.memberName(u)).join(', ')}`}
              </div>
            </div>
            <div className="row gap">
              <ChannelPrefsMenu channelId={channel.id} />
              <Button small onClick={() => setSummarizing(true)}>Summarize</Button>
              <Button small variant={side?.kind === 'info' ? 'primary' : 'secondary'} onClick={() => setSide(side?.kind === 'info' ? null : { kind: 'info' })}>
                Details
              </Button>
              {channel.patientId && <Link to={`/patients/${channel.patientId}`}>Patient chart →</Link>}
            </div>
          </header>
          <PinnedBar />
          {requireAck && channel.createdBy !== s.user.uid && !myAck.loading && !myAck.data && ackMessageId && (
            <div className="banner banner-warn ack-banner row gap space-between">
              <span>This broadcast requires your acknowledgement.</span>
              <AckControl messageId={ackMessageId} />
            </div>
          )}
          <div className="chat-messages">
            <ErrorBanner error={messages.error} />
            {messages.loading && <p className="muted">Loading…</p>}
            {!messages.loading && timeline.length === 0 && <p className="muted center-text">No messages yet.</p>}
            {timeline.map((m) => {
              const d = tsToDate(m.createdAt);
              const day = d ? d.toDateString() : '';
              const showDay = day !== lastDay;
              lastDay = day;
              return (
                <div key={m.id}>
                  {showDay && d && <div className="day-sep">{d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}</div>}
                  <MessageBubble m={m} onThread={() => setSide({ kind: 'thread', id: m.id })} />
                </div>
              );
            })}
            <div ref={endRef} />
          </div>
          <Composer />
        </div>
        {threadParent && <ThreadPanel key={threadParent.id} parent={threadParent} onClose={() => setSide(null)} />}
        {side?.kind === 'info' && <ChannelInfoPanel key={channel.id} onClose={() => setSide(null)} />}
        {summarizing && <SummarizeModal channel={channel} onClose={() => setSummarizing(false)} />}
      </div>
    </ChatContext.Provider>
  );
}

function SummarizeModal({ channel, onClose }: { channel: WithId<Channel>; onClose: () => void }) {
  const s = useOrgSession();
  const act = useAction();
  const [sinceHours, setSinceHours] = useState(24);
  const [result, setResult] = useState<AiTextResult | null>(null);
  async function run() {
    setResult(null);
    let res: AiTextResult | null = null;
    const ok = await act.run(async () => {
      res = await call<SummarizeChannelRequest, AiTextResult>('summarizeChannel', { orgId: s.orgId, channelId: channel.id, sinceHours });
    });
    if (ok) setResult(res);
  }
  return (
    <Modal title="Summarize conversation" onClose={onClose} wide>
      <ErrorBanner error={act.error} />
      <div className="row gap">
        <select value={sinceHours} onChange={(e) => setSinceHours(Number(e.target.value))} aria-label="Time range">
          {[12, 24, 72, 168].map((h) => <option key={h} value={h}>Last {h < 48 ? `${h} hours` : `${h / 24} days`}</option>)}
        </select>
        <Button variant="primary" busy={act.busy} onClick={() => void run()}>{result ? 'Regenerate' : 'Summarize'}</Button>
      </div>
      {act.busy && <p className="muted">Summarizing…</p>}
      {result && <AiResultView result={result} />}
    </Modal>
  );
}

function SearchModal({ onClose, onOpen }: { onClose: () => void; onOpen: (channelId: string) => void }) {
  const s = useOrgSession();
  const act = useAction();
  const [q, setQ] = useState('');
  const [res, setRes] = useState<SearchMessagesResponse | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const text = q.trim();
    if (text.length < 2) return act.setError('Enter at least 2 characters.');
    let out: SearchMessagesResponse | null = null;
    const ok = await act.run(async () => {
      out = await call<SearchMessagesRequest, SearchMessagesResponse>('searchMessages', { orgId: s.orgId, query: text });
    });
    if (ok) setRes(out);
  }
  return (
    <Modal title="Search messages" onClose={onClose} wide>
      <form className="row gap" onSubmit={submit}>
        <input type="search" className="search" autoFocus placeholder="Search your conversations…" value={q} onChange={(e) => setQ(e.target.value)} />
        <Button type="submit" variant="primary" busy={act.busy}>Search</Button>
      </form>
      <p className="muted small">
        Simple case-insensitive text match over your active conversations from the last 90 days (not full-text search).
      </p>
      <ErrorBanner error={act.error} />
      {res && (
        <>
          {res.hits.length === 0 && <p className="muted">No matches.</p>}
          <ul className="list">
            {res.hits.map((h) => (
              <li key={`${h.channelId}/${h.messageId}`} className="list-row search-hit">
                <button type="button" className="link" onClick={() => onOpen(h.channelId)}>
                  <strong>{h.channelName ?? 'Direct message'}</strong>
                </button>
                <div className="search-snippet">
                  <span className="muted small">{h.senderName} · {formatInstant(h.createdAt)}</span>
                  <div>{h.snippet}</div>
                </div>
              </li>
            ))}
          </ul>
          {res.truncated && <p className="muted small">Showing the first {res.hits.length} matches. Refine your search to see more.</p>}
        </>
      )}
    </Modal>
  );
}

function BroadcastModal({ onClose, onOpen }: { onClose: () => void; onOpen: (channelId: string) => void }) {
  const s = useOrgSession();
  const act = useAction();
  const teams = useLiveQuery<Team>(query(orgCol(s.orgId, 'teams'), orderBy('name')), [s.orgId]);
  const roles = useLiveQuery<OnCallRole>(query(orgCol(s.orgId, 'onCallRoles'), orderBy('label')), [s.orgId]);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<BroadcastTarget['kind']>('all');
  const [teamId, setTeamId] = useState('');
  const [roleKey, setRoleKey] = useState('');
  const [discipline, setDiscipline] = useState<Discipline>('RN');
  const [body, setBody] = useState('');
  const [priority, setPriority] = useState<Priority>('normal');
  const [requireAck, setRequireAck] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    let target: BroadcastTarget;
    if (kind === 'team') {
      if (!teamId) return act.setError('Choose a team.');
      target = { kind, teamId };
    } else if (kind === 'role') {
      if (!roleKey) return act.setError('Choose a role.');
      target = { kind, roleKey };
    } else if (kind === 'discipline') {
      target = { kind, discipline };
    } else {
      target = { kind: 'all' };
    }
    if (!body.trim()) return act.setError('Write a message.');
    let res: SendBroadcastResponse | null = null;
    const ok = await act.run(async () => {
      res = await call<SendBroadcastRequest, SendBroadcastResponse>('sendBroadcast', {
        orgId: s.orgId,
        name: name.trim() || 'Broadcast',
        target,
        body: body.trim(),
        priority,
        requireAck,
      });
    });
    const r = res as SendBroadcastResponse | null;
    if (ok && r) onOpen(r.channelId);
  }

  return (
    <Modal title="New broadcast" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <ErrorBanner error={act.error ?? teams.error ?? roles.error} />
        <Field label="Title">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Weather advisory" required />
        </Field>
        <Field label="Recipients">
          <select value={kind} onChange={(e) => setKind(e.target.value as BroadcastTarget['kind'])}>
            <option value="all">Everyone in the organization</option>
            <option value="team">A team</option>
            <option value="role">Whoever is on call for a role</option>
            <option value="discipline">A discipline</option>
          </select>
        </Field>
        {kind === 'team' && (
          <Field label="Team">
            <select value={teamId} onChange={(e) => setTeamId(e.target.value)} required>
              <option value="">Select team…</option>
              {teams.data.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </Field>
        )}
        {kind === 'role' && (
          <Field label="On-call role">
            <select value={roleKey} onChange={(e) => setRoleKey(e.target.value)} required>
              <option value="">Select role…</option>
              {roles.data.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
          </Field>
        )}
        {kind === 'discipline' && (
          <Field label="Discipline">
            <select value={discipline} onChange={(e) => setDiscipline(e.target.value as Discipline)}>
              {DISCIPLINES.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </Field>
        )}
        <Field label="Message">
          <textarea rows={4} maxLength={MAX_BODY} value={body} onChange={(e) => setBody(e.target.value)} required />
        </Field>
        <Field label="Priority" hint={s.isAdmin ? undefined : 'Critical broadcasts can be sent only by an administrator.'}>
          <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
            {PRIORITIES.filter((p) => s.isAdmin || p !== 'critical').map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </Field>
        <label className="row gap-sm">
          <input type="checkbox" checked={requireAck} onChange={(e) => setRequireAck(e.target.checked)} /> Require acknowledgement
        </label>
        <p className="muted small">
          Recipients can read the broadcast but cannot reply in it.
          {requireAck && ' Each recipient gets an Acknowledge button; you can see who has acknowledged and export the report.'}
        </p>
        <div className="row gap end">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" busy={act.busy}>Send broadcast</Button>
        </div>
      </form>
    </Modal>
  );
}

function NewConversationModal({ onClose, onOpen }: { onClose: () => void; onOpen: (channelId: string) => void }) {
  const s = useOrgSession();
  const roles = useLiveQuery<OnCallRole>(query(orgCol(s.orgId, 'onCallRoles'), orderBy('label')), [s.orgId]);
  const [mode, setMode] = useState<'direct' | 'group' | 'role'>('direct');
  const [uid, setUid] = useState('');
  const [uids, setUids] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [roleKey, setRoleKey] = useState('');
  const [body, setBody] = useState('');
  const [priority, setPriority] = useState<Priority>('normal');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const others = s.members.filter((m) => (m.uid ?? m.id) !== s.user.uid);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'role') {
        if (!roleKey || !body.trim()) throw new Error('Choose a role and write a message.');
        const res = await call<SendRoleMessageRequest, SendRoleMessageResponse>('sendRoleMessage', {
          orgId: s.orgId,
          roleKey,
          body: body.trim(),
          priority,
        });
        onOpen(res.channelId);
      } else {
        const memberUids = mode === 'direct' ? [uid] : uids;
        if (memberUids.filter(Boolean).length === 0) throw new Error('Choose at least one member.');
        const req: CreateChannelRequest = { orgId: s.orgId, type: mode, memberUids: [...new Set([s.user.uid, ...memberUids])] };
        if (mode === 'group' && name.trim()) req.name = name.trim();
        const res = await call<CreateChannelRequest, CreateChannelResponse>('createChannel', req);
        onOpen(res.channelId);
      }
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal title="New conversation" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="segmented">
          <button type="button" className={mode === 'direct' ? 'active' : ''} onClick={() => setMode('direct')}>Direct</button>
          <button type="button" className={mode === 'group' ? 'active' : ''} onClick={() => setMode('group')}>Group</button>
          <button type="button" className={mode === 'role' ? 'active' : ''} onClick={() => setMode('role')}>Message on-call role</button>
        </div>
        <ErrorBanner error={error} />
        {mode === 'direct' && (
          <Field label="Member">
            <MemberSelect members={others} value={uid} onChange={setUid} />
          </Field>
        )}
        {mode === 'group' && (
          <>
            <Field label="Group name (optional)">
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Members">
              <MemberPicker members={others} value={uids} onChange={setUids} />
            </Field>
          </>
        )}
        {mode === 'role' && (
          <>
            <Field label="On-call role" hint="Delivered to whoever is on shift now (or the role's fallback members).">
              <select value={roleKey} onChange={(e) => setRoleKey(e.target.value)} required>
                <option value="">Select role…</option>
                {roles.data.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
              </select>
            </Field>
            <Field label="Message">
              <textarea rows={3} maxLength={MAX_BODY} value={body} onChange={(e) => setBody(e.target.value)} required />
            </Field>
            <Field label="Priority">
              <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
                {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </Field>
          </>
        )}
        <div className="row gap end">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" busy={busy}>{mode === 'role' ? 'Send' : 'Start conversation'}</Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * O5: opening a patient's care-team channel you're not in. The channel itself is unreadable, so the
 * patient is found by `channelId` (staff can read patients). On-call staff on shift (and admins) can
 * join for the rest of their shift with a reason; the server checks the shift and audits the access.
 */
function NotMemberView({ channelId }: { channelId: string }) {
  const s = useOrgSession();
  const act = useAction();
  // Volunteers can only read their assigned patients, so the lookup is skipped for them.
  const isVolunteer = !s.isAdmin && s.member?.discipline === 'Volunteer';
  const patients = useLiveQuery<Patient>(
    isVolunteer ? null : query(orgCol(s.orgId, 'patients'), where('channelId', '==', channelId), limit(1)),
    [s.orgId, channelId, isVolunteer],
  );
  const patient = patients.data[0] ?? null;
  const [reason, setReason] = useState('');
  const [joined, setJoined] = useState<JoinPatientChannelForCoverageResponse | null>(null);

  async function join(e: FormEvent) {
    e.preventDefault();
    if (!patient) return;
    if (reason.trim().length < 3) return act.setError('Enter a reason for access.');
    let res: JoinPatientChannelForCoverageResponse | null = null;
    const ok = await act.run(async () => {
      res = await call<JoinPatientChannelForCoverageRequest, JoinPatientChannelForCoverageResponse>('joinPatientChannelForCoverage', {
        orgId: s.orgId,
        patientId: patient.id,
        reason: reason.trim(),
      });
    });
    if (ok) setJoined(res);
  }

  if (joined) {
    return (
      <div className="empty-chat">
        <p>
          You were added for on-call coverage{joined.until ? ` until ${new Date(joined.until).toLocaleString()}` : ''}. The conversation opens
          in a moment.
        </p>
      </div>
    );
  }
  if (!patient) {
    return <div className="empty-chat muted">{patients.loading ? 'Loading…' : 'Conversation not found or you are not a member.'}</div>;
  }
  return (
    <div className="empty-chat">
      <form className="form" style={{ maxWidth: 480 }} onSubmit={join}>
        <p>
          You are not on the care team for <strong>{patientName(patient)}</strong>.
        </p>
        <p className="muted small">
          If you are on call now, you can join this care-team channel for the rest of your shift. Access is recorded in the audit log
          with your reason, and you are removed when the shift ends.
        </p>
        <ErrorBanner error={act.error ?? patients.error} />
        <Field label="Reason for access">
          <input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="e.g. After-hours call from family" required />
        </Field>
        <div>
          <Button type="submit" variant="primary" busy={act.busy}>Join for on-call coverage</Button>
        </div>
      </form>
    </div>
  );
}

export default function MessagesPage() {
  const { channelId } = useParams();
  const s = useOrgSession();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [searching, setSearching] = useState(false);
  const [broadcasting, setBroadcasting] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [filter, setFilter] = useState('');
  const [mentionsOnly, setMentionsOnly] = useState(false);
  const [mentionHits, setMentionHits] = useState<Record<string, boolean>>({});
  const onMentionResult = useCallback((id: string, hit: boolean) => {
    setMentionHits((prev) => (prev[id] === hit ? prev : { ...prev, [id]: hit }));
  }, []);
  const channels = useLiveQuery<Channel>(
    query(
      orgCol(s.orgId, 'channels'),
      where('memberUids', 'array-contains', s.user.uid),
      orderBy('lastMessageAt', 'desc'),
      limit(100),
    ),
    [s.orgId, s.user.uid],
  );
  const candidates = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return channels.data.filter((c) => (showArchived || !c.archived) && (!q || channelTitle(c, s).toLowerCase().includes(q)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channels.data, filter, s.members, showArchived]);
  const visible = mentionsOnly ? candidates.filter((c) => mentionHits[c.id]) : candidates;
  const mentionPending = mentionsOnly && candidates.some((c) => mentionHits[c.id] === undefined);
  const active = channels.data.find((c) => c.id === channelId) ?? null;

  return (
    <div className="messages">
      <aside className="channel-list">
        <div className="channel-list-header">
          <input type="search" placeholder="Filter conversations" value={filter} onChange={(e) => setFilter(e.target.value)} />
          {s.role !== 'viewer' && (
            <Button small variant="primary" onClick={() => setCreating(true)}>New</Button>
          )}
        </div>
        <div className="channel-list-tools">
          <Button small variant="ghost" onClick={() => setSearching(true)}>Search messages</Button>
          {s.role !== 'viewer' && <Button small variant="ghost" onClick={() => setBroadcasting(true)}>New broadcast</Button>}
          <label className="row gap-sm small">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Archived
          </label>
          <label className="row gap-sm small" title="Conversations whose recent messages mention you">
            <input type="checkbox" checked={mentionsOnly} onChange={(e) => setMentionsOnly(e.target.checked)} /> Mentions
          </label>
          <Link className="small" to="/notifications">Notifications</Link>
        </div>
        <ErrorBanner error={channels.error} />
        {channels.loading && <p className="muted pad">Loading…</p>}
        {mentionsOnly && candidates.map((c) => <MentionProbe key={c.id} channelId={c.id} onResult={onMentionResult} />)}
        {mentionPending && <p className="muted pad small">Checking recent messages for mentions…</p>}
        {!channels.loading && !mentionPending && visible.length === 0 && (
          <p className="muted pad">{mentionsOnly ? 'No recent mentions.' : 'No conversations.'}</p>
        )}
        {visible.map((c) => (
          <ChannelRow
            key={c.id}
            c={c}
            active={c.id === channelId}
            mentioned={mentionsOnly && !!mentionHits[c.id]}
            onClick={() => navigate(`/messages/${c.id}`)}
          />
        ))}
      </aside>
      <section className="chat-pane">
        {active ? (
          <ChatView key={active.id} channel={active} />
        ) : channelId && !channels.loading ? (
          <NotMemberView channelId={channelId} />
        ) : (
          <div className="empty-chat muted">Select a conversation.</div>
        )}
      </section>
      {searching && (
        <SearchModal
          onClose={() => setSearching(false)}
          onOpen={(id) => {
            setSearching(false);
            navigate(`/messages/${id}`);
          }}
        />
      )}
      {broadcasting && (
        <BroadcastModal
          onClose={() => setBroadcasting(false)}
          onOpen={(id) => {
            setBroadcasting(false);
            navigate(`/messages/${id}`);
          }}
        />
      )}
      {creating && (
        <NewConversationModal
          onClose={() => setCreating(false)}
          onOpen={(id) => {
            setCreating(false);
            navigate(`/messages/${id}`);
          }}
        />
      )}
    </div>
  );
}
