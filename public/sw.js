/* Pomong Agent service worker — keeps the app installable, always fresh, and receives web push. */
const VERSION = 'pomong-agent-v0.7.3';

self.addEventListener('install', (event) => {
  event.skipWaiting();
});

/** v0.7.3: 열린 페이지가 새 워커를 바로 쓰게 요청하면 기다리지 않고 활성화한다. */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // 옛 버전 캐시를 하나도 남기지 않는다(업데이트 직후 옛 번들·그림이 섞이지 않게).
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

  // v0.7.3: 화면 이동·index.html 은 **항상 네트워크 우선**(캐시에 저장도 하지 않는다).
  //   새로 배포된 index.html 이 늦게 도착해 옛 번들을 가리키는 일을 막는다.
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          return await fetch(req, { cache: 'no-store' });
        } catch (err) {
          const cached = await caches.match('/index.html');
          if (cached) return cached;
          throw err;
        }
      })()
    );
    return;
  }

  // network first, fall back to cache when offline
  event.respondWith(
    (async () => {
      try {
        const fresh = await fetch(req);
        if (
          fresh.ok &&
          (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/mascots/')) &&
          !url.pathname.endsWith('index.html')
        ) {
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
      const sameOrigin = list.filter((client) => {
        try {
          return new URL(client.url).origin === self.location.origin;
        } catch {
          return false;
        }
      });
      const existing = sameOrigin.find((client) => client.focused) || sameOrigin[0];
      if (existing) {
        await existing.focus();
        /**
         * v0.7.1: 이미 열린 앱은 새로고침하지 않고, 딥링크만 화면에 넘긴다.
         * 앱(App.tsx)이 이 메시지를 받아 해당 대화방·메시지·승인 카드로 이동한다.
         * 메시지를 받을 리스너가 없을 때를 대비해 navigate 는 보조로만 쓴다.
         */
        existing.postMessage({ type: 'pomong-deeplink', url: target });
        return;
      }
      await self.clients.openWindow(target);
    })()
  );
});
