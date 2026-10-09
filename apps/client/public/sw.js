/* AWB PWA service worker.
 *
 * 하는 일 세 가지 — 그 이상은 하지 않는다:
 *   1. 앱 셸(정적 자산)의 오프라인 캐시. /api·/mcp·/api-docs는 절대 캐시하지 않는다.
 *   2. OS 알림 클릭 → 앱 창 포커스 + 해당 화면으로 이동 (NotificationContext가 data.url을 싣는다).
 *   3. push 이벤트 스캐폴드 — 서버가 Web Push(VAPID)를 붙이면 그때부터 백그라운드 푸시가
 *      동작한다. 그 전까지 알림은 앱이 열려 있을 때(포그라운드·백그라운드) SSE 경유로만 온다.
 */

const SW_VERSION = 'awb-sw-v1';
const STATIC_CACHE = `${SW_VERSION}-static`;
const RUNTIME_CACHE = `${SW_VERSION}-runtime`;
const PRECACHE = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => !k.startsWith(SW_VERSION)).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

function isBypassed(pathname) {
  return (
    pathname === '/api' ||
    pathname.startsWith('/api/') ||
    pathname === '/mcp' ||
    pathname.startsWith('/mcp/') ||
    pathname.startsWith('/api-docs')
  );
}

async function networkFirst(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) {
      try {
        await cache.put(request, fresh.clone());
      } catch {
        /* opaque / uncacheable — serve anyway */
      }
    }
    return fresh;
  } catch {
    const cached =
      (await cache.match(request)) ||
      (await caches.open(STATIC_CACHE).then((c) => c.match('/index.html')));
    if (cached) return cached;
    throw new Error('offline');
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const fresh = await fetch(request);
  try {
    if (fresh && fresh.ok) {
      const cache = await caches.open(RUNTIME_CACHE);
      await cache.put(request, fresh.clone());
    }
  } catch {
    /* uncacheable — serve anyway */
  }
  return fresh;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (isBypassed(url.pathname)) return;
  // 네비게이션(index.html)은 항상 먼저 네트워크 — 배포 후 stale 탭이 옛 청크를 물고
  // 있는 문제를 SW가 키우지 않게. 해시 자산·vad·사운드·아이콘은 캐시 우선.
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }
  if (
    url.pathname.startsWith('/assets/') ||
    url.pathname.startsWith('/vad/') ||
    url.pathname.startsWith('/sounds/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/favicon.svg' ||
    url.pathname === '/manifest.webmanifest'
  ) {
    event.respondWith(cacheFirst(request));
  }
});

// 서버 Web Push용 스캐폴드 — payload { title, body, tag, url }.
// 서버에 구독 저장·발송이 붙기 전에는 호출되지 않는다.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    try {
      data = { body: event.data ? event.data.text() : '' };
    } catch {
      data = {};
    }
  }
  const title = data.title || 'AWB';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      tag: data.tag || 'awb-push',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: data.url || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const raw = event.notification.data && event.notification.data.url;
  const target = new URL(typeof raw === 'string' && raw ? raw : '/', self.location.origin);
  // 같은 오리진의 앱 화면으로만 이동 — 외부 URL은 열지 않는다.
  if (target.origin !== self.location.origin) return;
  const url = target.pathname + target.search + target.hash;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        try {
          await client.focus();
        } catch {
          continue;
        }
        try {
          if ('navigate' in client) await client.navigate(url);
        } catch {
          /* focus-only fallback */
        }
        return;
      }
      if (self.clients.openWindow) {
        try {
          await self.clients.openWindow(url);
        } catch {
          /* ignore */
        }
      }
    })(),
  );
});
