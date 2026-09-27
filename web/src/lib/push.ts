// v4 web push (FCM). Permission is requested only from a user gesture (never on load).
// The token is stored in `members/{uid}.fcmTokens` via the member self-update path (≤ 20 tokens).
import { arrayRemove, arrayUnion, updateDoc } from 'firebase/firestore';
import type { Messaging, MessagePayload } from 'firebase/messaging';
import { app } from './firebase';
import { orgDoc } from './firestore';

export const MAX_FCM_TOKENS = 20;
const TOKEN_KEY = 'aura.webPushToken';

export const vapidKey = (import.meta.env.VITE_FIREBASE_VAPID_KEY ?? '').trim();

export type PushState = 'unsupported' | 'unconfigured' | 'default' | 'denied' | 'granted';

let messagingPromise: Promise<Messaging | null> | null = null;

/** Lazily loads firebase/messaging (only in browsers that support it). */
function getMessagingInstance(): Promise<Messaging | null> {
  if (!messagingPromise) {
    messagingPromise = (async () => {
      const m = await import('firebase/messaging');
      if (!(await m.isSupported())) return null;
      return m.getMessaging(app);
    })().catch(() => null);
  }
  return messagingPromise;
}

export async function pushState(): Promise<PushState> {
  if (typeof window === 'undefined' || !('Notification' in window) || !('serviceWorker' in navigator)) return 'unsupported';
  if (!(await getMessagingInstance())) return 'unsupported';
  if (!vapidKey) return 'unconfigured';
  return Notification.permission as PushState;
}

/** Registers the messaging service worker, passing the web app config in the query string. */
async function registerWorker(): Promise<ServiceWorkerRegistration> {
  const o = app.options;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries({
    apiKey: o.apiKey,
    authDomain: o.authDomain,
    projectId: o.projectId,
    storageBucket: o.storageBucket,
    messagingSenderId: o.messagingSenderId,
    appId: o.appId,
  })) {
    if (v) params.set(k, v);
  }
  return navigator.serviceWorker.register(`/firebase-messaging-sw.js?${params.toString()}`, {
    scope: '/firebase-cloud-messaging-push-scope',
  });
}

function readStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
function storeToken(t: string | null) {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

/** Save `token` into the member's fcmTokens (arrayUnion; oldest dropped when the list is full). */
async function saveToken(orgId: string, uid: string, current: readonly string[], token: string, previous: string | null) {
  const ref = orgDoc(orgId, 'members', uid);
  const stale = previous && previous !== token && current.includes(previous) ? previous : null;
  if (current.includes(token) && !stale) return;
  if (!stale && current.length < MAX_FCM_TOKENS) {
    await updateDoc(ref, { fcmTokens: arrayUnion(token) });
    return;
  }
  // Replace the list: drop this browser's rotated token and trim the oldest to stay within 20.
  const others = current.filter((t) => t !== token && t !== stale);
  await updateDoc(ref, { fcmTokens: [...others.slice(-(MAX_FCM_TOKENS - 1)), token] });
}

/** Ask for permission (call from a click handler), get a token and store it. */
export async function enableWebPush(orgId: string, uid: string, current: readonly string[]): Promise<void> {
  if (!vapidKey) throw new Error('Web push is not configured (VITE_FIREBASE_VAPID_KEY is missing).');
  const messaging = await getMessagingInstance();
  if (!messaging) throw new Error('This browser does not support web push notifications.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notifications are blocked. Allow them in your browser settings to enable push.');
  const { getToken } = await import('firebase/messaging');
  const serviceWorkerRegistration = await registerWorker();
  const token = await getToken(messaging, { vapidKey, serviceWorkerRegistration });
  if (!token) throw new Error('Could not get a push token.');
  await saveToken(orgId, uid, current, token, readStoredToken());
  storeToken(token);
  window.dispatchEvent(new Event(PUSH_ENABLED_EVENT));
}

/** Fired after push is enabled from a button, so the foreground listener can start without a reload. */
export const PUSH_ENABLED_EVENT = 'aura:push-enabled';

/** Remove this browser's token and stop pushes here. */
export async function disableWebPush(orgId: string, uid: string): Promise<void> {
  const messaging = await getMessagingInstance();
  const stored = readStoredToken();
  if (messaging) {
    const { deleteToken } = await import('firebase/messaging');
    await deleteToken(messaging).catch(() => false);
  }
  if (stored) await updateDoc(orgDoc(orgId, 'members', uid), { fcmTokens: arrayRemove(stored) });
  storeToken(null);
}

export function thisBrowserToken(): string | null {
  return readStoredToken();
}

/**
 * When permission was already granted: refresh the token silently (re-saving it if it rotated)
 * and deliver foreground messages to `onForeground`. Returns an unsubscribe function.
 */
export function startForegroundPush(
  orgId: string,
  uid: string,
  current: readonly string[],
  onForeground: (payload: MessagePayload) => void,
): () => void {
  let unsub: (() => void) | null = null;
  let cancelled = false;
  void (async () => {
    if (!vapidKey || !('Notification' in window) || Notification.permission !== 'granted') return;
    const messaging = await getMessagingInstance();
    if (!messaging || cancelled) return;
    const { getToken, onMessage } = await import('firebase/messaging');
    unsub = onMessage(messaging, onForeground);
    try {
      const serviceWorkerRegistration = await registerWorker();
      const token = await getToken(messaging, { vapidKey, serviceWorkerRegistration });
      if (token && !cancelled) {
        await saveToken(orgId, uid, current, token, readStoredToken());
        storeToken(token);
      }
    } catch {
      /* non-fatal: the user can re-enable from My notifications */
    }
  })();
  return () => {
    cancelled = true;
    unsub?.();
  };
}
