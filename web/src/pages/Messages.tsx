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
import { getDownloadURL, ref as storageRef } from 'firebase/storage';
import type {
  Attachment,
  Channel,
  CreateChannelRequest,
  CreateChannelResponse,
  Message,
  OnCallRole,
  Priority,
  ReadReceipt,
  SendRoleMessageRequest,
  SendRoleMessageResponse,
} from '@shared/types';
import { useOrgSession, type OrgSession } from '../lib/session';
import { orgCol, orgDoc, type WithId } from '../lib/firestore';
import { useLiveDoc, useLiveQuery } from '../lib/hooks';
import { call, storage } from '../lib/firebase';
import { PRIORITIES } from '../lib/constants';
import { errorMessage, formatInstant, formatTime, tsMillis, tsToDate } from '../lib/format';
import { Badge, Button, ErrorBanner, Field, MemberPicker, MemberSelect, Modal } from '../components/ui';

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

function AttachmentLink({ a }: { a: Attachment }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="attachment"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          window.open(await getDownloadURL(storageRef(storage, a.storagePath)), '_blank', 'noopener');
        } finally {
          setBusy(false);
        }
      }}
    >
      📎 {a.name}
    </button>
  );
}

function ChatView({ channel }: { channel: WithId<Channel> }) {
  const s = useOrgSession();
  const messages = useLiveQuery<Message>(
    query(orgCol(s.orgId, 'channels', channel.id, 'messages'), orderBy('createdAt'), limitToLast(200)),
    [s.orgId, channel.id],
  );
  const [body, setBody] = useState('');
  const [priority, setPriority] = useState<Priority>('normal');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const canSend = s.role !== 'viewer' && !channel.archived;

  // Mark read whenever this channel is open and new messages arrive.
  const lastId = messages.data[messages.data.length - 1]?.id;
  useEffect(() => {
    if (messages.loading) return;
    setDoc(orgDoc(s.orgId, 'channels', channel.id, 'reads', s.user.uid), { lastReadAt: serverTimestamp() }).catch(() => {
      /* non-fatal */
    });
  }, [s.orgId, channel.id, s.user.uid, lastId, messages.loading]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [lastId]);

  async function send(e?: FormEvent) {
    e?.preventDefault();
    const text = body.trim();
    if (!text || sending) return;
    if (text.length > MAX_BODY) return setError(`Messages are limited to ${MAX_BODY} characters.`);
    setSending(true);
    setError(null);
    try {
      await addDoc(orgCol(s.orgId, 'channels', channel.id, 'messages'), {
        senderUid: s.user.uid,
        senderName: (s.member?.displayName || s.user.displayName || s.user.email || 'Unknown').slice(0, 200),
        body: text,
        priority,
        attachments: [],
        roleTarget: null,
        createdAt: serverTimestamp(),
        alertId: null,
      });
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

  let lastDay = '';
  return (
    <div className="chat">
      <header className="chat-header">
        <div>
          <h2>{channelTitle(channel, s)}</h2>
          <div className="muted small">
            {channel.type} · {channel.memberUids.map((u) => s.memberName(u)).join(', ')}
          </div>
        </div>
        {channel.patientId && (
          <Link to={`/patients/${channel.patientId}`}>Patient chart →</Link>
        )}
      </header>
      <div className="chat-messages">
        <ErrorBanner error={messages.error} />
        {messages.loading && <p className="muted">Loading…</p>}
        {!messages.loading && messages.data.length === 0 && <p className="muted center-text">No messages yet.</p>}
        {messages.data.map((m) => {
          const d = tsToDate(m.createdAt);
          const day = d ? d.toDateString() : '';
          const showDay = day !== lastDay;
          lastDay = day;
          const mine = m.senderUid === s.user.uid;
          return (
            <div key={m.id}>
              {showDay && d && <div className="day-sep">{d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}</div>}
              <div className={`msg ${mine ? 'mine' : ''} prio-${m.priority}`}>
                <div className="msg-meta">
                  <strong>{mine ? 'You' : m.senderName}</strong>
                  <span className="muted small" title={formatInstant(m.createdAt)}>{formatTime(m.createdAt)}</span>
                  {m.priority !== 'normal' && <Badge value={m.priority} />}
                  {m.roleTarget && <span className="tag">to {m.roleTarget}</span>}
                  {m.alertId && <span className="tag">alert raised</span>}
                </div>
                <div className="msg-body">{m.body}</div>
                {m.attachments?.length > 0 && (
                  <div className="row gap-sm wrap">
                    {m.attachments.map((a, i) => <AttachmentLink key={i} a={a} />)}
                  </div>
                )}
              </div>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>
      {canSend ? (
        <form className="composer" onSubmit={send}>
          <ErrorBanner error={error} />
          <textarea
            rows={2}
            placeholder="Message… (Enter to send, Shift+Enter for newline)"
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
              Send{priority !== 'normal' ? ` ${priority}` : ''}
            </Button>
          </div>
        </form>
      ) : (
        <div className="composer muted small">{channel.archived ? 'This conversation is archived.' : 'Viewers cannot send messages.'}</div>
      )}
    </div>
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

export default function MessagesPage() {
  const { channelId } = useParams();
  const s = useOrgSession();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
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
    return channels.data.filter((c) => !c.archived && (!q || channelTitle(c, s).toLowerCase().includes(q)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channels.data, filter, s.members]);
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
          <div className="empty-chat muted">Conversation not found or you are not a member.</div>
        ) : (
          <div className="empty-chat muted">Select a conversation.</div>
        )}
      </section>
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
