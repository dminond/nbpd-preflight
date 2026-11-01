// Service worker: makes the page installable and lets it open without a signal.
// Everything is network-first, so a connected phone always gets the latest page and
// data. The cache is only a fallback. Data served from the cache (/api/data?zip=…,
// /api/data?lat=…&lon=…, data.json) is marked with an X-From-Cache header so the page
// can say it is offline; its age still comes from generated_at, so DATA STALE appears
// exactly as it would online. Each ZIP or location is saved under its own URL.
'use strict';
var CACHE = 'dfr-preflight-v3';
var SHELL = ['./', 'index.html', 'app.js', 'suncalc.js', 'config.json', 'manifest.webmanifest',
  'favicon.ico', 'assets/favicon-32.png', 'assets/header-mark.png', 'assets/apple-touch-icon.png',
  'assets/icon-192.png', 'assets/icon-512.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  url.searchParams.delete('t'); url.searchParams.delete('app');
  var key = url.pathname + (url.searchParams.toString() ? '?' + url.searchParams.toString() : '');
  e.respondWith(fetch(req, { cache: 'no-store' }).then(function (res) {
    if (res.ok) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { return c.put(key, copy); });
    }
    return res;
  }).catch(function () {
    return caches.match(key).then(function (hit) {
      // /NNNNN and /?lat=… are all the same page.
      return hit || (req.mode === 'navigate' ? caches.match('index.html') : null);
    }).then(function (r) {
      if (!r) return Response.error();
      if (!/json/.test(r.headers.get('Content-Type') || '')) return r;
      var headers = new Headers(r.headers);
      headers.set('X-From-Cache', '1');
      return r.blob().then(function (body) { return new Response(body, { status: 200, headers: headers }); });
    });
  }));
});
