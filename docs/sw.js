'use strict';

// sw.js — Service Worker。アプリ殻（UI コード）のみキャッシュする。
// データ（Dropbox API 応答）は一切キャッシュしない＝常に最新をネットワークから取得。
// オフライン時の閲覧は app 側が localStorage に保持した最終取得データで行う。

const CACHE = 'pbm-shell-v37';

const SHELL = [
  './',
  './index.html',
  './style.css',
  './manifest.json',
  './config.js',
  './registry.js',
  './parser.js',
  './dropbox.js',
  './program.js',
  './app.js',
  './views/shared.js',
  './views/typeTab.js',
  './views/board.js',
  './views/reference.js',
  './views/knowledge.js',
  './views/consult.js',
  './views/report.js',
  './views/tray.js',
  './views/completed.js',
  './views/memo.js',
  './views/decision.js',
  './views/sheets.js',
  './views/views.js',
  './views/sessions.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // 同一オリジンの GET のみ扱う（＝アプリ殻）。Dropbox API 等クロスオリジンは素通し。
  if (req.method !== 'GET' || url.origin !== self.location.origin) {
    return; // ブラウザ既定のネットワーク処理に委ねる
  }

  // OAuth リダイレクト（?code=...）はキャッシュ汚染を避けネットワーク優先。
  if (url.search.includes('code=')) {
    event.respondWith(fetch(req).catch(() => caches.match('./index.html')));
    return;
  }

  // アプリ殻: キャッシュ優先・裏で更新（stale-while-revalidate）。
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
