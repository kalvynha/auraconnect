import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { CreateChannelRequest, CreateChannelResponse, Discipline } from '@shared/types';
import { useOrgSession } from '../lib/session';
import { useAction } from '../lib/hooks';
import { call } from '../lib/firebase';
import { DISCIPLINES } from '../lib/constants';
import { presenceOf, uidOf, useOnCallNow, useOnCallRoles } from '../lib/messaging';
import { Badge, Button, ErrorBanner, Page } from '../components/ui';
import { PresenceDot } from '../components/messaging';

function telHref(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, '')}`;
}

/** v4 staff directory: presence, status, out of office and who is on call now. */
export default function DirectoryPage() {
  const s = useOrgSession();
  const navigate = useNavigate();
  const act = useAction();
  const roles = useOnCallRoles(s.orgId);
  const onCall = useOnCallNow(s.orgId);
  const [q, setQ] = useState('');
  const [discipline, setDiscipline] = useState<Discipline | ''>('');
  const [onCallOnly, setOnCallOnly] = useState(false);
  const roleLabel = useMemo(() => new Map(roles.data.map((r) => [r.id, r.label])), [roles.data]);

  const staff = useMemo(() => {
    const text = q.trim().toLowerCase();
    return s.members
      .filter((m) => m.active !== false)
      .filter((m) => s.isAdmin || m.discipline !== 'Volunteer')
      .filter((m) => !discipline || m.discipline === discipline)
      .filter((m) => !onCallOnly || onCall.byUid.has(uidOf(m)))
      .filter((m) => {
        if (!text) return true;
        const roleText = (onCall.byUid.get(uidOf(m)) ?? []).map((k) => `${k} ${roleLabel.get(k) ?? ''}`).join(' ');
        return [m.displayName, m.email, m.title ?? '', m.discipline, m.status?.text ?? '', roleText].join(' ').toLowerCase().includes(text);
      });
  }, [s.members, s.isAdmin, q, discipline, onCallOnly, onCall.byUid, roleLabel]);

  async function message(uid: string) {
    let res: CreateChannelResponse | null = null;
    const ok = await act.run(async () => {
      res = await call<CreateChannelRequest, CreateChannelResponse>('createChannel', {
        orgId: s.orgId,
        type: 'direct',
        memberUids: [...new Set([s.user.uid, uid])],
      });
    });
    const r = res as CreateChannelResponse | null;
    if (ok && r) navigate(`/messages/${r.channelId}`);
  }

  const disciplines = DISCIPLINES.filter((d) => s.isAdmin || d !== 'Volunteer');

  return (
    <Page title="Directory">
      <div className="toolbar">
        <input type="search" className="search" placeholder="Search name, role, status…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={discipline} onChange={(e) => setDiscipline(e.target.value as Discipline | '')} aria-label="Discipline">
          <option value="">All disciplines</option>
          {disciplines.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <label className="row gap-sm">
          <input type="checkbox" checked={onCallOnly} onChange={(e) => setOnCallOnly(e.target.checked)} /> On call now
        </label>
        <span className="muted small">{staff.length} {staff.length === 1 ? 'person' : 'people'}</span>
      </div>
      <ErrorBanner error={act.error ?? onCall.error ?? roles.error} />
      <div className="directory">
        {staff.length === 0 && <p className="muted">Nobody matches.</p>}
        {staff.map((m) => {
          const uid = uidOf(m);
          const p = presenceOf(m);
          const ooo = p.tone === 'ooo' ? m.outOfOffice : null;
          const myRoles = onCall.byUid.get(uid) ?? [];
          return (
            <div key={uid} className="dir-card">
              <div className="row space-between gap-sm">
                <div className="row gap-sm" style={{ minWidth: 0 }}>
                  <PresenceDot member={m} />
                  <strong className="dir-name">{m.displayName || m.email}</strong>
                  {uid === s.user.uid && <span className="muted small">(you)</span>}
                </div>
                <Badge tone="info">{m.discipline}</Badge>
              </div>
              {m.title && <div className="muted small">{m.title}</div>}
              <div className="small">
                {p.label}
                {p.text && <span className="muted"> · {p.text}</span>}
              </div>
              {ooo && (
                <div className="small dir-ooo">
                  Out of office until {p.oooUntil?.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                  {ooo.delegateUid && <> · contact {s.memberName(ooo.delegateUid)}</>}
                  {ooo.note && <div className="muted">{ooo.note}</div>}
                </div>
              )}
              {myRoles.length > 0 && (
                <div className="row gap-sm wrap">
                  {myRoles.map((k) => <Badge key={k} tone="accent">on call · {roleLabel.get(k) ?? k}</Badge>)}
                </div>
              )}
              <div className="row gap-sm dir-actions">
                {uid !== s.user.uid && s.role !== 'viewer' && (
                  <Button small variant="primary" busy={act.busy} onClick={() => void message(uid)}>Message</Button>
                )}
                {m.phone && (
                  <a className="btn btn-sm btn-secondary" href={telHref(m.phone)}>Call {m.phone}</a>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Page>
  );
}
