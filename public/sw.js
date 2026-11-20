/* Pomong Agent service worker — keeps the app installable, always fresh, and receives web push. */
const VERSION = 'pomong-agent-v0.6.12';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // network first, fall back to cache when offline
  event.respondWith(
    (async () => {
      try {
        const fresh = await fetch(req);
        if (fresh.ok && (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/mascots/'))) {
          const cache = await caches.open(VERSION);
          cache.put(req, fresh.clone());
        }
        return fresh;
      } catch (err) {
        const cached = await caches.match(req);
        if (cached) return cached;
        throw err;
      }
    })()
  );
});

/* ------------------------------------------------------------------ */
/* 웹 푸시                                                              */
/* ------------------------------------------------------------------ */

/**
 * 앱을 보고 있으면 알림을 띄우지 않는다(이중 가드 ②).
 * 서버가 ①에서 이미 걸러 주지만, 창이 보이는 중에 도착한 알림까지 확실히 막는다.
 */
async function anyVisibleWindow() {
  const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return list.some((client) => client.focused || client.visibilityState === 'visible');
}

self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      let payload = {};
      try {
        payload = event.data ? event.data.json() : {};
      } catch {
        payload = { title: 'Pomong Agent', body: event.data ? event.data.text() : '' };
      }
      if (await anyVisibleWindow()) return;
      const title = payload.title || 'Pomong Agent';
      await self.registration.showNotification(title, {
        body: payload.body || '',
        icon: '/icons/icon-192.png',
        badge: '/icons/favicon-32.png',
        tag: payload.tag || 'pomong',
        renotify: false,
        data: { url: payload.url || '/' },
      });
    })()
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    (async () => {
      const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of list) {
        const url = new URL(client.url);
        if (url.origin === self.location.origin) {
          await client.focus();
          if ('navigate' in client) {
            try {
              await client.navigate(target);
            } catch {
              /* focus만 해도 된다 */
            }
          }
          return;
        }
      }
      await self.clients.openWindow(target);
    })()
  );
});
