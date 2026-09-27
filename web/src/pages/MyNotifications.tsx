import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { query, Timestamp, updateDoc, where } from 'firebase/firestore';
import type {
  CancelReminderRequest,
  MemberStatus,
  NoReplyReminder,
  NotificationSettings,
  OutOfOffice,
  PresenceState,
} from '@shared/types';
import { useOrgSession } from '../lib/session';
import { orgCol, orgDoc } from '../lib/firestore';
import { useAction, useLiveQuery } from '../lib/hooks';
import { call } from '../lib/firebase';
import { formatInstant, toDateTimeLocal, tsMillis, tsToDate } from '../lib/format';
import { PRESENCE_LABELS, PRESENCE_STATES, presenceOf, uidOf } from '../lib/messaging';
import { disableWebPush, enableWebPush, pushState, thisBrowserToken, type PushState } from '../lib/push';
import { Button, Card, ErrorBanner, Field, MemberSelect, Page } from '../components/ui';
import { PresenceDot } from '../components/messaging';

// Member self-updates may only touch `status`, `outOfOffice` and `notificationSettings` here
// (plus `fcmTokens` for push); each save writes exactly one of those keys with the full shape.

function WebPushCard() {
  const s = useOrgSession();
  const act = useAction();
  const [state, setState] = useState<PushState | null>(null);
  const [registered, setRegistered] = useState(() => {
    const t = thisBrowserToken();
    return !!t && !!s.member?.fcmTokens?.includes(t);
  });
  useEffect(() => {
    void pushState().then(setState);
  }, []);
  useEffect(() => {
    const t = thisBrowserToken();
    setRegistered(!!t && !!s.member?.fcmTokens?.includes(t));
  }, [s.member?.fcmTokens]);

  async function enable() {
    const ok = await act.run(() => enableWebPush(s.orgId, s.user.uid, s.member?.fcmTokens ?? []));
    void pushState().then(setState);
    if (ok) setRegistered(true);
  }
  async function disable() {
    const ok = await act.run(() => disableWebPush(s.orgId, s.user.uid));
    if (ok) setRegistered(false);
  }

  return (
    <Card title="Desktop notifications">
      <ErrorBanner error={act.error} />
      {state === null && <p className="muted">Checking…</p>}
      {state === 'unsupported' && <p className="muted">This browser doesn't support web push notifications.</p>}
      {state === 'unconfigured' && (
        <p className="muted">Web push isn't configured for this deployment (an administrator must set <code>VITE_FIREBASE_VAPID_KEY</code>).</p>
      )}
      {state === 'denied' && (
        <p className="muted">Notifications are blocked for this site. Allow them in your browser's site settings, then reload.</p>
      )}
      {(state === 'default' || state === 'granted') && (
        <div className="row gap wrap">
          {registered && state === 'granted' ? (
            <>
              <span>✓ This browser receives AuraConnect notifications.</span>
              <Button busy={act.busy} onClick={() => void disable()}>Turn off on this browser</Button>
            </>
          ) : (
            <>
              <span className="muted">Get a notification when a message or alert arrives while AuraConnect is in the background.</span>
              <Button variant="primary" busy={act.busy} onClick={() => void enable()}>Enable notifications</Button>
            </>
          )}
        </div>
      )}
      <p className="muted small" style={{ marginBottom: 0 }}>
        Notifications never contain message text or patient details. {s.member?.fcmTokens?.length ?? 0} of 20 device slots used.
      </p>
    </Card>
  );
}

const STATUS_DURATIONS = [
  { key: 'none', label: "Don't clear" },
  { key: '1h', label: '1 hour' },
  { key: '4h', label: '4 hours' },
  { key: 'today', label: 'End of today' },
] as const;
type StatusDuration = (typeof STATUS_DURATIONS)[number]['key'];

function statusUntil(d: StatusDuration): Date | null {
  const now = new Date();
  if (d === '1h') return new Date(now.getTime() + 3600_000);
  if (d === '4h') return new Date(now.getTime() + 4 * 3600_000);
  if (d === 'today') {
    const e = new Date(now);
    e.setHours(23, 59, 0, 0);
    return e;
  }
  return null;
}

function StatusCard() {
  const s = useOrgSession();
  const act = useAction();
  const cur = s.member?.status ?? null;
  const live = !!cur && (!cur.until || tsMillis(cur.until) > Date.now());
  const [state, setState] = useState<PresenceState>(live && cur ? cur.state : 'available');
  const [text, setText] = useState(live && cur ? cur.text ?? '' : '');
  const [duration, setDuration] = useState<StatusDuration>('none');
  const ref = orgDoc(s.orgId, 'members', s.user.uid);

  async function save(e: FormEvent) {
    e.preventDefault();
    const until = statusUntil(duration);
    const status: MemberStatus = {
      state,
      text: text.trim() ? text.trim().slice(0, 140) : null,
      until: until ? Timestamp.fromDate(until) : null,
    };
    await act.run(() => updateDoc(ref, { status }));
  }
  async function clear() {
    const ok = await act.run(() => updateDoc(ref, { status: null }));
    if (ok) {
      setState('available');
      setText('');
    }
  }

  return (
    <Card title="Status">
      <form className="form" onSubmit={save}>
        <ErrorBanner error={act.error} />
        <div className="row gap-sm">
          <PresenceDot member={s.member} withLabel />
          {live && cur?.until && <span className="muted small">clears {formatInstant(cur.until)}</span>}
        </div>
        <div className="form-grid">
          <Field label="Availability">
            <select value={state} onChange={(e) => setState(e.target.value as PresenceState)}>
              {PRESENCE_STATES.map((p) => <option key={p} value={p}>{PRESENCE_LABELS[p]}</option>)}
            </select>
          </Field>
          <Field label="Status text (optional)">
            <input value={text} maxLength={140} placeholder="e.g. At the Smith home until 3" onChange={(e) => setText(e.target.value)} />
          </Field>
          <Field label="Clear after">
            <select value={duration} onChange={(e) => setDuration(e.target.value as StatusDuration)}>
              {STATUS_DURATIONS.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
            </select>
          </Field>
        </div>
        <p className="muted small" style={{ margin: 0 }}>Don't put patient names or details in your status; everyone in the organization sees it.</p>
        <div className="row gap">
          <Button type="submit" variant="primary" busy={act.busy}>Save status</Button>
          {cur && <Button busy={act.busy} onClick={() => void clear()}>Clear</Button>}
        </div>
      </form>
    </Card>
  );
}

function OutOfOfficeCard() {
  const s = useOrgSession();
  const act = useAction();
  const cur = s.member?.outOfOffice ?? null;
  const active = !!cur && tsMillis(cur.until) > Date.now();
  const [until, setUntil] = useState(() => {
    const d = cur ? tsToDate(cur.until) : null;
    if (d && d.getTime() > Date.now()) return toDateTimeLocal(d);
    const t = new Date();
    t.setDate(t.getDate() + 1);
    t.setHours(8, 0, 0, 0);
    return toDateTimeLocal(t);
  });
  const [delegate, setDelegate] = useState(cur?.delegateUid ?? '');
  const [note, setNote] = useState(cur?.note ?? '');
  const ref = orgDoc(s.orgId, 'members', s.user.uid);
  const others = s.members.filter((m) => uidOf(m) !== s.user.uid && m.discipline !== 'Volunteer');

  async function save(e: FormEvent) {
    e.preventDefault();
    const d = new Date(until);
    if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) return act.setError('Choose a return time in the future.');
    const outOfOffice: OutOfOffice = {
      until: Timestamp.fromDate(d),
      delegateUid: delegate || null,
      note: note.trim() ? note.trim().slice(0, 500) : null,
    };
    await act.run(() => updateDoc(ref, { outOfOffice }));
  }

  return (
    <Card title="Out of office">
      <form className="form" onSubmit={save}>
        <ErrorBanner error={act.error} />
        {active && cur ? (
          <div className="banner banner-info">
            You're out of office until {formatInstant(cur.until)}
            {cur.delegateUid && <> · direct messages point people to {s.memberName(cur.delegateUid)}</>}.
          </div>
        ) : (
          <p className="muted small" style={{ margin: 0 }}>
            While you're out, people who message you directly are told when you're back and who to contact instead, and on-call routing skips
            you. Mentions still reach you.
          </p>
        )}
        <div className="form-grid">
          <Field label="Back at">
            <input type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} required />
          </Field>
          <Field label="Contact instead (optional)">
            <MemberSelect members={others} value={delegate} onChange={setDelegate} placeholder="Nobody" />
          </Field>
        </div>
        <Field label="Note (optional)">
          <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="e.g. At a conference" />
        </Field>
        <div className="row gap">
          <Button type="submit" variant="primary" busy={act.busy}>{active ? 'Update' : 'Turn on'}</Button>
          {cur && <Button busy={act.busy} onClick={() => void act.run(() => updateDoc(ref, { outOfOffice: null }))}>Turn off</Button>}
        </div>
      </form>
    </Card>
  );
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function QuietHoursCard() {
  const s = useOrgSession();
  const act = useAction();
  const cur = s.member?.notificationSettings ?? null;
  const [quietOn, setQuietOn] = useState(!!cur?.quietHours);
  const [start, setStart] = useState(cur?.quietHours?.start ?? '22:00');
  const [end, setEnd] = useState(cur?.quietHours?.end ?? '07:00');
  const [offShiftQuiet, setOffShiftQuiet] = useState(cur?.offShiftQuiet ?? false);
  const [saved, setSaved] = useState(false);
  const tz = s.org?.timezone;

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaved(false);
    if (quietOn && (!HHMM.test(start) || !HHMM.test(end))) return act.setError('Enter quiet hours as HH:MM.');
    if (quietOn && start === end) return act.setError('Quiet hours need different start and end times.');
    const notificationSettings: NotificationSettings = {
      quietHours: quietOn ? { start, end } : null,
      offShiftQuiet,
    };
    const ok = await act.run(() => updateDoc(orgDoc(s.orgId, 'members', s.user.uid), { notificationSettings }));
    if (ok) setSaved(true);
  }

  return (
    <Card title="Quiet hours">
      <form className="form" onSubmit={save}>
        <ErrorBanner error={act.error} />
        {saved && <div className="banner banner-ok">Saved.</div>}
        <label className="row gap-sm">
          <input type="checkbox" checked={quietOn} onChange={(e) => setQuietOn(e.target.checked)} /> Don't push normal messages during quiet hours
        </label>
        {quietOn && (
          <div className="row gap wrap">
            <Field label="From">
              <input type="time" value={start} onChange={(e) => setStart(e.target.value)} required />
            </Field>
            <Field label="To">
              <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} required />
            </Field>
            {tz && <span className="muted small">Times are in the organization's time zone ({tz}).</span>}
          </div>
        )}
        <label className="row gap-sm">
          <input type="checkbox" checked={offShiftQuiet} onChange={(e) => setOffShiftQuiet(e.target.checked)} /> Don't push normal messages when I'm
          not on an on-call shift (applies only if I have shifts)
        </label>
        <p className="muted small" style={{ margin: 0 }}>
          Urgent and critical messages, direct messages and @mentions still notify you. Per-conversation settings (mentions only, mute) are
          in each conversation's header.
        </p>
        <div>
          <Button type="submit" variant="primary" busy={act.busy}>Save</Button>
        </div>
      </form>
    </Card>
  );
}

function RemindersCard() {
  const s = useOrgSession();
  const act = useAction();
  const reminders = useLiveQuery<NoReplyReminder>(
    query(orgCol(s.orgId, 'reminders'), where('ownerUid', '==', s.user.uid), where('status', '==', 'pending')),
    [s.orgId, s.user.uid],
  );
  const rows = [...reminders.data].sort((a, b) => tsMillis(a.dueAt) - tsMillis(b.dueAt));
  return (
    <Card title="My pending “no reply” reminders">
      <ErrorBanner error={act.error ?? reminders.error} />
      {rows.length === 0 ? (
        <p className="muted small" style={{ margin: 0 }}>None. Use “Remind me if no reply” in a message's ⋯ menu.</p>
      ) : (
        <ul className="list">
          {rows.map((r) => (
            <li key={r.id} className="list-row">
              <span>
                {formatInstant(r.dueAt)} · <Link to={`/messages/${r.channelId}`}>open conversation</Link>
              </span>
              <Button
                small
                busy={act.busy}
                onClick={() => void act.run(() => call<CancelReminderRequest, unknown>('cancelReminder', { orgId: s.orgId, reminderId: r.id }))}
              >
                Cancel
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export default function MyNotificationsPage() {
  const s = useOrgSession();
  const p = presenceOf(s.member);
  return (
    <Page title="My notifications">
      {p.tone === 'ooo' && <div className="banner banner-info">You're marked out of office.</div>}
      <div className="grid-2">
        <WebPushCard />
        <StatusCard />
        <QuietHoursCard />
        <OutOfOfficeCard />
      </div>
      <RemindersCard />
    </Page>
  );
}
