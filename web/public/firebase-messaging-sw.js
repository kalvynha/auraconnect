/* AuraConnect web push service worker (v4).
 *
 * Uses the Firebase compat SDK from gstatic, pinned to the `firebase` version in web/package.json
 * (keep FIREBASE_VERSION in sync when upgrading). The web app registers this worker as
 * `/firebase-messaging-sw.js?apiKey=…&projectId=…&messagingSenderId=…&appId=…` (see src/lib/push.ts),
 * so no project config is hard-coded here.
 *
 * Pushes are generic by design ("New message" / "Urgent message" / …): no message text or patient
 * data is ever in the payload or shown on the lock screen.
 */
/* eslint-disable no-undef */
const FIREBASE_VERSION = '11.10.0';
importScripts(`https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-app-compat.js`);
importScripts(`https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-messaging-compat.js`);

const params = new URL(self.location.href).searchParams;
const config = {};
['apiKey', 'authDomain', 'projectId', 'storageBucket', 'messagingSenderId', 'appId'].forEach((k) => {
  const v = params.get(k);
  if (v) config[k] = v;
});

const GENERIC_TITLES = { normal: 'New message', urgent: 'Urgent message', critical: 'Critical message' };

function targetUrl(data) {
  if (!data) return '/';
  if (data.type === 'alert') return '/alerts';
  if (data.channelId) return `/messages/${encodeURIComponent(data.channelId)}`;
  return '/messages';
}

if (config.apiKey && config.messagingSenderId && config.appId) {
  firebase.initializeApp(config);
  const messaging = firebase.messaging();

  // Payloads with a `notification` block are shown by the SDK itself; data-only payloads get the
  // same generic notification here.
  messaging.onBackgroundMessage((payload) => {
    if (payload.notification) return;
    const data = payload.data || {};
    const title = data.type === 'alert' ? 'New alert' : GENERIC_TITLES[data.priority] || 'New message';
    return self.registration.showNotification(title, {
      body: 'Open AuraConnect to view.',
      tag: data.channelId || data.alertId || 'aura',
      data: { url: targetUrl(data) },
      requireInteraction: data.priority === 'critical',
    });
  });
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const d = event.notification.data || {};
  // The SDK-shown notifications carry the FCM payload under FCM_MSG.
  const fcmData = (d.FCM_MSG && d.FCM_MSG.data) || null;
  const url = d.url || targetUrl(fcmData);
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (new URL(w.url).origin === self.location.origin && 'focus' in w) {
          if ('navigate' in w) w.navigate(url).catch(() => undefined);
          return w.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
