import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  addDoc,
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
  JoinPatientChannelForCoverageRequest,
  JoinPatientChannelForCoverageResponse,
  Patient,
  BroadcastTarget,
  Channel,
  CreateChannelRequest,
  CreateChannelResponse,
  Message,
  OnCallRole,
  Priority,
  ReadReceipt,
  RecallMessageRequest,
  SearchMessagesRequest,
  SearchMessagesResponse,
  SendBroadcastRequest,
  SendBroadcastResponse,
  SendRoleMessageRequest,
  SendRoleMessageResponse,
  SummarizeChannelRequest,
  Discipline,
  Team,
} from '@shared/types';
import { useOrgSession, type OrgSession } from '../lib/session';
import { orgCol, orgDoc, type WithId } from '../lib/firestore';
import { useAction, useLiveDoc, useLiveQuery } from '../lib/hooks';
import { call } from '../lib/firebase';
import { DISCIPLINES, PRIORITIES } from '../lib/constants';
import { errorMessage, formatInstant, formatTime, tsMillis, tsToDate } from '../lib/format';
import { AiResultView, Badge, Button, ErrorBanner, Field, MemberPicker, MemberSelect, Modal } from '../components/ui';
import { FileViewer } from '../components/FileViewer';
import { patientName } from '../lib/patient';

const MAX_BODY = 8000;

function channelTitle(c: Channel, s: OrgSession): string {
  if (c.type === 'direct') {
    const other = c.memberUids.find((u) => u !== s.user.uid) ?? s.user.uid;
    return s.memberName(other);
  }
  return c.name ?? c.memberUids.filter((u) => u !== s.user.uid).map((u) => s.memberName(u)).join(', ');
}

function ChannelRow({ c, active, onClick }: { c: WithId<Channel>; active: boolean; onClick: () => void }) {
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
function canPost(channel: Channel, s: OrgSession): boolean {
  if (s.role === 'viewer' || channel.archived) return false;
  if (channel.type === 'broadcast' && channel.createdBy !== s.user.uid) return false;
  return true;
}

function readOnlyReason(channel: Channel, s: OrgSession): string {
  if (channel.archived) return 'This conversation is archived and read-only.';
  if (s.role === 'viewer') return 'Viewers cannot send messages.';
  return 'This is a broadcast. Only the sender can post.';
}

function Composer({ channel, threadParentId, placeholder }: { channel: WithId<Channel>; threadParentId?: string; placeholder?: string }) {
  const s = useOrgSession();
  const [body, setBody] = useState('');
  const [priority, setPriority] = useState<Priority>('normal');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(e?: FormEvent) {
    e?.preventDefault();
    const text = body.trim();
    if (!text || sending) return;
    if (text.length > MAX_BODY) return setError(`Messages are limited to ${MAX_BODY} characters.`);
    setSending(true);
    setError(null);
    try {
      // Exact client create shape; `threadParentId` only on thread replies (non-empty string).
      const data: Record<string, unknown> = {
        senderUid: s.user.uid,
        senderName: (s.member?.displayName || s.user.displayName || s.user.email || 'Unknown').slice(0, 200),
        body: text,
        priority,
        attachments: [],
        roleTarget: null,
        createdAt: serverTimestamp(),
        alertId: null,
      };
      if (threadParentId) data.threadParentId = threadParentId;
      await addDoc(orgCol(s.orgId, 'channels', channel.id, 'messages'), data);
      setBody('');
      setPriority('normal');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSending(false);
    }
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  if (!canPost(channel, s)) return <div className="composer muted small">{readOnlyReason(channel, s)}</div>;
  return (
    <form className="composer" onSubmit={send}>
      <ErrorBanner error={error} />
      <textarea
        rows={2}
        placeholder={placeholder ?? 'Message… (Enter to send, Shift+Enter for newline)'}
        value={body}
        maxLength={MAX_BODY}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={onKey}
      />
      <div className="row gap-sm">
        <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)} aria-label="Priority">
          {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <Button type="submit" variant={priority === 'normal' ? 'primary' : 'danger'} busy={sending} disabled={!body.trim()}>
          {threadParentId ? 'Reply' : 'Send'}{priority !== 'normal' ? ` ${priority}` : ''}
        </Button>
      </div>
    </form>
  );
}

function MessageBubble({
  m,
  channel,
  onThread,
  inThread,
}: {
  m: WithId<Message>;
  channel: WithId<Channel>;
  onThread?: () => void;
  inThread?: boolean;
}) {
  const s = useOrgSession();
  const recall = useAction();
  const mine = m.senderUid === s.user.uid;
  const recalled = !!m.recalledAt;
  const canRecall = !recalled && s.role !== 'viewer' && (mine || s.isAdmin);
  const replies = m.replyCount ?? 0;
  const needsAck = !recalled && !mine && !!m.alertId && m.priority !== 'normal';

  async function doRecall() {
    if (!window.confirm('Recall this message? Its text and attachments are removed for everyone.')) return;
    await recall.run(() =>
      call<RecallMessageRequest, unknown>('recallMessage', { orgId: s.orgId, channelId: channel.id, messageId: m.id }),
    );
  }

  return (
    <div className={`msg ${mine ? 'mine' : ''} prio-${m.priority} ${recalled ? 'recalled' : ''}`} id={`msg-${m.id}`}>
      <div className="msg-meta">
        <strong>{mine ? 'You' : m.senderName}</strong>
        <span className="muted small" title={formatInstant(m.createdAt)}>{inThread ? formatInstant(m.createdAt) : formatTime(m.createdAt)}</span>
        {m.priority !== 'normal' && <Badge value={m.priority} />}
        {m.roleTarget && <span className="tag">to {m.roleTarget}</span>}
        {m.alertId && <span className="tag">alert raised</span>}
      </div>
      {recalled ? (
        <div className="msg-body muted"><em>Message recalled</em></div>
      ) : (
        <>
          <div className="msg-body">{m.body}</div>
          {m.attachments?.length > 0 && (
            <div className="row gap-sm wrap">
              {m.attachments.map((a, i) => <AttachmentLink key={i} a={a} />)}
            </div>
          )}
        </>
      )}
      <ErrorBanner error={recall.error} />
      {(onThread || canRecall || needsAck) && (
        <div className="msg-actions">
          {needsAck && m.alertId && <MessageAck alertId={m.alertId} />}
          {onThread && replies > 0 && (
            <button type="button" className="link small" onClick={onThread}>
              {replies} {replies === 1 ? 'reply' : 'replies'}{m.lastReplyAt ? ` · last ${formatTime(m.lastReplyAt)}` : ''}
            </button>
          )}
          {onThread && !recalled && (replies === 0) && (
            <button type="button" className="link small" onClick={onThread}>Reply in thread</button>
          )}
          {canRecall && (
            <button type="button" className="link small danger-link" disabled={recall.busy} onClick={() => void doRecall()}>
              Recall
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ThreadPanel({ channel, parent, onClose }: { channel: WithId<Channel>; parent: WithId<Message>; onClose: () => void }) {
  const s = useOrgSession();
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
        <MessageBubble m={parent} channel={channel} inThread />
        <div className="day-sep">{sorted.length} {sorted.length === 1 ? 'reply' : 'replies'}</div>
        <ErrorBanner error={replies.error} />
        {sorted.map((m) => <MessageBubble key={m.id} m={m} channel={channel} inThread />)}
        <div ref={endRef} />
      </div>
      <Composer channel={channel} threadParentId={parent.id} placeholder="Reply in thread…" />
    </aside>
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

function ChatView({ channel }: { channel: WithId<Channel> }) {
  const s = useOrgSession();
  const messages = useLiveQuery<Message>(
    query(orgCol(s.orgId, 'channels', channel.id, 'messages'), orderBy('createdAt'), limitToLast(200)),
    [s.orgId, channel.id],
  );
  const [threadId, setThreadId] = useState<string | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  // Channel timeline hides thread replies (old messages lack threadParentId).
  const timeline = useMemo(() => messages.data.filter((m) => !m.threadParentId), [messages.data]);
  const threadParent = threadId ? messages.data.find((m) => m.id === threadId) ?? null : null;

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

  let lastDay = '';
  return (
    <div className="chat-with-thread">
      <div className="chat">
        <header className="chat-header">
          <div>
            <h2>
              {channelTitle(channel, s)} {channel.archived && <Badge tone="neutral">archived</Badge>}
              {channel.type === 'broadcast' && <> <Badge tone="info">broadcast</Badge></>}
            </h2>
            <div className="muted small">
              {channel.type} · {channel.memberUids.map((u) => s.memberName(u)).join(', ')}
            </div>
          </div>
          <div className="row gap">
            <Button small onClick={() => setSummarizing(true)}>Summarize</Button>
            {channel.patientId && <Link to={`/patients/${channel.patientId}`}>Patient chart →</Link>}
          </div>
        </header>
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
                <MessageBubble m={m} channel={channel} onThread={() => setThreadId(m.id)} />
              </div>
            );
          })}
          <div ref={endRef} />
        </div>
        <Composer channel={channel} />
      </div>
      {threadParent && <ThreadPanel key={threadParent.id} channel={channel} parent={threadParent} onClose={() => setThreadId(null)} />}
      {summarizing && <SummarizeModal channel={channel} onClose={() => setSummarizing(false)} />}
    </div>
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
        <p className="muted small">Recipients can read the broadcast but cannot reply in it.</p>
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
  const channels = useLiveQuery<Channel>(
    query(
      orgCol(s.orgId, 'channels'),
      where('memberUids', 'array-contains', s.user.uid),
      orderBy('lastMessageAt', 'desc'),
      limit(100),
    ),
    [s.orgId, s.user.uid],
  );
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return channels.data.filter((c) => (showArchived || !c.archived) && (!q || channelTitle(c, s).toLowerCase().includes(q)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channels.data, filter, s.members, showArchived]);
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
        </div>
        <ErrorBanner error={channels.error} />
        {channels.loading && <p className="muted pad">Loading…</p>}
        {!channels.loading && visible.length === 0 && <p className="muted pad">No conversations.</p>}
        {visible.map((c) => (
          <ChannelRow key={c.id} c={c} active={c.id === channelId} onClick={() => navigate(`/messages/${c.id}`)} />
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
