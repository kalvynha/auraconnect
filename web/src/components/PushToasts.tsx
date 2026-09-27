import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useSession } from '../lib/session';
import { PUSH_ENABLED_EVENT, startForegroundPush } from '../lib/push';

interface Toast {
  id: number;
  title: string;
  body: string;
  priority: string;
  url: string | null;
}

const TOAST_MS = 8000;

/**
 * v4: foreground FCM messages as in-app toasts. Only active once the user has granted
 * notification permission (from My notifications); nothing is requested on load.
 * Payloads are generic (no message text or PHI).
 */
export function PushToasts() {
  const s = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const pathRef = useRef(location.pathname);
  pathRef.current = location.pathname;
  const tokensRef = useRef<readonly string[]>([]);
  tokensRef.current = s.member?.fcmTokens ?? [];
  const nextId = useRef(1);
  const ready = s.status === 'ready' && !!s.orgId && !!s.user && !!s.member;
  const orgId = s.orgId;
  const uid = s.user?.uid ?? null;
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    const bump = () => setEpoch((e) => e + 1);
    window.addEventListener(PUSH_ENABLED_EVENT, bump);
    return () => window.removeEventListener(PUSH_ENABLED_EVENT, bump);
  }, []);

  useEffect(() => {
    if (!ready || !orgId || !uid) return;
    return startForegroundPush(orgId, uid, tokensRef.current, (payload) => {
      const data = (payload.data ?? {}) as Record<string, string>;
      const url = data.type === 'alert' ? '/alerts' : data.channelId ? `/messages/${data.channelId}` : null;
      // Already looking at that conversation: the message is on screen.
      if (url && url.startsWith('/messages/') && pathRef.current === url) return;
      const id = nextId.current++;
      const t: Toast = {
        id,
        title: payload.notification?.title ?? (data.type === 'alert' ? 'New alert' : 'New message'),
        body: payload.notification?.body ?? '',
        priority: data.priority ?? 'normal',
        url,
      };
      setToasts((list) => [...list.slice(-3), t]);
      window.setTimeout(() => setToasts((list) => list.filter((x) => x.id !== id)), data.priority === 'critical' ? TOAST_MS * 3 : TOAST_MS);
    });
  }, [ready, orgId, uid, epoch]);

  if (toasts.length === 0) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast prio-${t.priority}`}>
          <div className="toast-main">
            <strong>{t.title}</strong>
            {t.body && <div className="small muted">{t.body}</div>}
          </div>
          {t.url && (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => {
                navigate(t.url!);
                setToasts((list) => list.filter((x) => x.id !== t.id));
              }}
            >
              Open
            </button>
          )}
          <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => setToasts((list) => list.filter((x) => x.id !== t.id))}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
