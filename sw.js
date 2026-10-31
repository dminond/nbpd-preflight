// Service worker: makes the page installable and lets it open without a signal.
// Everything is network-first, so a connected phone always gets the latest page and
// data.json. The cache is only a fallback. A data.json served from the cache is
// marked with an X-From-Cache header so the page can say it is offline; its age
// still comes from generated_at, so DATA STALE appears exactly as it would online.
'use strict';
var CACHE = 'nbpd-preflight-v2';
var SHELL = ['./', 'index.html', 'app.js', 'suncalc.js', 'config.json', 'manifest.webmanifest',
  'favicon.ico', 'assets/favicon-32.png', 'assets/header-mark.png', 'assets/apple-touch-icon.png',
  'assets/icon-192.png', 'assets/icon-512.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    // data.json is best-effort: a failed fetch here must not block installing the page.
    return c.addAll(SHELL).then(function () { return c.add('data.json').catch(function () {}); });
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  // Cache by path only: app.js adds ?t=<now> to defeat HTTP caches. Keep ?data= for samples.
  var key = url.pathname + (url.searchParams.has('data') ? '?data=' + url.searchParams.get('data') : '');
  e.respondWith(fetch(req, { cache: 'no-store' }).then(function (res) {
    if (res.ok) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { return c.put(key, copy); });
    }
    return res;
  }).catch(function () {
    return caches.match(key).then(function (hit) {
      if (!hit && req.mode === 'navigate') hit = caches.match('index.html');
      return Promise.resolve(hit).then(function (r) {
        if (!r) return Response.error();
        if (!/\.json$/.test(url.pathname)) return r;
        var headers = new Headers(r.headers);
        headers.set('X-From-Cache', '1');
        return r.blob().then(function (body) { return new Response(body, { status: 200, headers: headers }); });
      });
    });
  }));
});
