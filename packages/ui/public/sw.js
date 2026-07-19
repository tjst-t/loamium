/**
 * Loamium App Shell Service Worker (Sa6c3b0-4)
 *
 * キャッシュ戦略:
 * - App Shell (index.html / main JS / CSS / アイコン): Cache First + Network Fallback
 * - /api/** エンドポイント: Network Only (vault データはキャッシュしない — AC-4-6)
 * - activate 時に古いキャッシュを削除する
 *
 * HTTPS or localhost での HTTPS は PWA 基準として Chrome/Edge が検証する (AC-4-3)。
 * アプリ側は manifest.json と SW を提供するのみ。TLS 終端は Caddy/Cloudflare 側。
 */

const CACHE_NAME = 'loamium-app-shell-v1';

/** App Shell に含めるアセット。Vite ビルドで / に配信されるエントリを列挙する。 */
const APP_SHELL_URLS = [
  '/',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

// ---- install: App Shell をキャッシュに保存 ----
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // navigateを除くアセットを事前キャッシュ（/ は install 後の初回アクセスでキャッシュ）
      await cache.addAll(APP_SHELL_URLS.filter((u) => u !== '/'));
    }),
  );
  // 旧 SW を待たずに即 activate (skipWaiting はユーザー体験を壊す可能性があるため
  // 次のナビゲーションで新 SW が有効になる標準挙動を採用)
});

// ---- activate: 古いキャッシュを削除 ----
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(async (keys) => {
      await Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME)
          .map((k) => caches.delete(k)),
      );
      // 新 SW をすべてのクライアントで即時有効化
      await self.clients.claim();
    }),
  );
});

// ---- fetch: キャッシュ戦略の振り分け ----
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // /api/** は Network Only (vault データはキャッシュしない — AC-4-6)
  if (url.pathname.startsWith('/api/')) {
    return; // ブラウザの通常 fetch に委ねる
  }

  // App Shell: Cache First + Network Fallback + キャッシュ更新
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(event.request);
      if (cached !== undefined) {
        // バックグラウンドで最新版をキャッシュ更新 (Stale While Revalidate)
        void fetch(event.request).then((res) => {
          if (res.ok) {
            void cache.put(event.request, res.clone());
          }
        });
        return cached;
      }
      // キャッシュミス: ネットワークから取得してキャッシュに保存
      try {
        const res = await fetch(event.request);
        if (res.ok) {
          void cache.put(event.request, res.clone());
        }
        return res;
      } catch {
        // オフライン + キャッシュなし → index.html でフォールバック (SPA ナビゲーション)
        const fallback = await cache.match('/');
        if (fallback !== undefined) return fallback;
        return new Response('Loamium — オフライン', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }
    }),
  );
});
