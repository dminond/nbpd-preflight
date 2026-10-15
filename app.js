// NBPD UAS pre-flight page. Reads data.json (written by scripts/fetch.mjs),
// re-polls every 5 minutes. All external text is inserted as text, never HTML.
(function () {
  'use strict';
  var POLL_MS = 5 * 60 * 1000, TICK_MS = 30 * 1000;
  var LEVELS = ['GO', 'CAUTION', 'NO-GO REVIEW'];
  var state = { data: null, config: null, loadedAt: 0, lastError: null };

  // ?data=samples/data-stale.json lets you preview the bundled samples.
  var params = new URLSearchParams(location.search);
  var dataUrl = 'data.json';
  var p = params.get('data');
  if (p && /^[\w-]+(\/[\w-]+)*\.json$/.test(p)) dataUrl = p;

  // ------------------------------------------------------------ helpers
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (attrs[k] == null || attrs[k] === false) continue;
      if (k === 'class') el.className = attrs[k];
      else if (k === 'text') el.textContent = attrs[k];
      else el.setAttribute(k, attrs[k]);
    }
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) c.forEach(function (x) { append(el, x); });
    else el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
  function body(id) { var b = document.querySelector('#' + id + ' .body'); b.textContent = ''; b.className = 'body'; return b; }
  function tz() { return (state.data && state.data.config && state.data.config.timeZone) || (state.config && state.config.timeZone) || 'America/New_York'; }
  function fmtTime(d, opts) {
    if (!d) return '—';
    d = d instanceof Date ? d : new Date(d);
    if (isNaN(d)) return '—';
    return new Intl.DateTimeFormat('en-US', Object.assign({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz() }, opts || {})).format(d);
  }
  function fmtDateTime(d) { return fmtTime(d, { month: 'numeric', day: 'numeric', timeZoneName: 'short' }); }
  function ago(ms) {
    var m = Math.round(ms / 60000);
    if (m < 1) return 'just now';
    if (m < 90) return m + ' min ago';
    var hh = Math.floor(m / 60);
    return hh + ' h ' + (m % 60) + ' min ago';
  }
  function tag(level, text) { return h('span', { class: 'tag lv-' + level, text: text || LEVELS[level] }); }
  function srcOk(name) { var s = state.data && state.data.sources && state.data.sources[name]; return !!(s && s.ok); }
  function srcErr(name, label, href) {
    var s = (state.data && state.data.sources && state.data.sources[name]) || {};
    return h('div', { class: 'err' },
      h('strong', { text: label + ' unavailable' }), ' — ', s.error || 'no data', '. ',
      href ? h('a', { href: href, target: '_blank', rel: 'noopener', text: 'Check official source' }) : null);
  }
  function cToF(c) { return c == null ? null : Math.round(c * 9 / 5 + 32); }
  function generatedAt(d) {
    // Sample files carry a fixed age so the preview always looks "N minutes old".
    if (d.sample && d.sample.age_minutes != null) return new Date(state.loadedAt - d.sample.age_minutes * 60000);
    return new Date(d.generated_at);
  }

  // ------------------------------------------------------------ banner
  function renderBanner() {
    var b = document.getElementById('banner');
    b.textContent = '';
    var d = state.data;
    if (!d) {
      b.className = 'lv-x';
      append(b, [h('div', { class: 'lvl', text: 'NO DATA' }),
        h('div', { class: 'asof', text: 'Could not load data' + (state.lastError ? ' (' + state.lastError + ')' : '') }),
        h('div', { class: 'stale', text: 'Verify with official sources.' })]);
      return;
    }
    var gen = generatedAt(d), age = Date.now() - gen.getTime();
    var staleMin = (d.config && d.config.staleMinutes) || 30;
    var stale = age > staleMin * 60000;
    var reasons = (d.overall && d.overall.reasons) || [];
    var lvl = (d.overall && d.overall.levelNum) || 0;
    if (stale) lvl = Math.max(lvl, 1);
    b.className = 'lv-' + lvl;
    append(b, h('div', { class: 'lvl', text: LEVELS[lvl] }));
    append(b, h('div', { class: 'asof', text: 'Data as of ' + fmtTime(gen, { timeZoneName: 'short' }) + ' · ' + ago(age) }));
    if (stale) append(b, h('div', { class: 'stale', text: 'DATA STALE — verify with official sources.' }));
    if (state.lastError) append(b, h('div', { class: 'small', text: 'Last refresh failed: ' + state.lastError }));
    if (reasons.length) {
      var ul = h('ul');
      reasons.slice(0, 8).forEach(function (r) { append(ul, h('li', { text: (r.level === 2 ? '⛔ ' : '⚠ ') + r.text })); });
      if (reasons.length > 8) append(ul, h('li', { text: '+' + (reasons.length - 8) + ' more below' }));
      append(b, ul);
    }
    document.getElementById('sample').hidden = !d.sample;
  }

  // ------------------------------------------------------------ TFRs
  function renderTfr() {
    var d = state.data, b = body('s-tfr');
    var radius = (d.config && d.config.tfrRadiusNm) || 30;
    if (!srcOk('tfr') || !d.tfrs) { append(b, srcErr('tfr', 'TFR list', 'https://tfr.faa.gov/tfr3/?page=list')); return; }
    var local = d.tfrs.local || [];
    if (!local.length) append(b, h('div', { class: 'big', text: 'No TFRs within ' + radius + ' NM' }));
    local.forEach(function (t) {
      var where = t.distanceUnknown ? 'distance unknown — check FAA'
        : t.inside ? 'INSIDE TFR (' + t.compass + ' ' + t.bearingDeg + '° to centre)'
        : t.distanceNm + ' NM ' + t.compass + ' (' + t.bearingDeg + '°)';
      var win = t.effective || t.expires
        ? fmtDateTime(t.effective) + ' → ' + (t.expires ? fmtDateTime(t.expires) : 'until further notice')
        : 'see FAA detail';
      append(b, h('div', { class: 'item' },
        h('div', { class: 'row' },
          h('a', { class: 'big', href: t.detailUrl, target: '_blank', rel: 'noopener', text: t.id }),
          h('strong', { text: t.type || '' }),
          tag(t.level || 1)),
        h('div', { class: 'big', text: where }),
        h('dl', { class: 'kv' },
          h('dt', { text: 'Altitudes' }), h('dd', { text: (t.altitudes && t.altitudes.length) ? t.altitudes.join('; ') : 'see FAA detail' }),
          h('dt', { text: 'Window' }), h('dd', { text: win })),
        h('div', { class: 'small', text: t.title && t.title !== t.description ? t.title + ' — ' + (t.description || '') : (t.description || '') }),
        t.note ? h('div', { class: 'small muted', text: t.note }) : null));
    });
    var nat = d.tfrs.national || [];
    if (nat.length) {
      var det = h('details', null, h('summary', { text: 'Standing national restrictions (' + nat.length + ')' }));
      nat.forEach(function (t) {
        append(det, h('div', { class: 'item small' },
          h('a', { href: t.detailUrl, target: '_blank', rel: 'noopener', text: t.id }), ' ', h('strong', { text: t.type || '' }), ' — ', t.description || ''));
      });
      append(b, det);
    }
    append(b, h('div', { class: 'small muted', text: 'Checked ' + (d.tfrs.checked || 0) + ' TFR(s) listed for ' + ((state.config && state.config.tfrStates) || ['NJ', 'NY', 'PA']).join('/') + '. Always confirm on the FAA TFR map.' }));
  }

  // ------------------------------------------------------------ METAR
  function renderMetar() {
    var d = state.data, b = body('s-metar');
    if (!srcOk('metar') || !d.metars) { append(b, srcErr('metar', 'METAR', 'https://aviationweather.gov/data/metar/')); return; }
    d.metars.forEach(function (m) {
      if (m.missing) { append(b, h('div', { class: 'item' }, h('div', { class: 'row' }, h('span', { class: 'big', text: m.station }), tag(1)), h('div', { text: 'No current METAR' }))); return; }
      var wind = m.windKt === 0 ? 'Calm' : (m.windDir === 'VRB' ? 'VRB' : (m.windDir != null ? String(m.windDir).padStart(3, '0') + '°' : '—')) + ' ' + (m.windKt != null ? m.windKt + ' kt' : '—') + (m.gustKt ? ' gust ' + m.gustKt + ' kt' : '');
      var vis = m.visibilitySm == null ? '—' : m.visibilitySm + (m.visibilityPlus ? '+' : '') + ' SM';
      var ceil = m.ceilingFt == null ? 'None' : m.ceilingFt.toLocaleString('en-US') + ' ft AGL';
      append(b, h('div', { class: 'item' },
        h('div', { class: 'row' },
          h('span', { class: 'big', text: m.station }),
          m.flightCategory ? h('span', { class: 'cat cat-' + m.flightCategory, text: m.flightCategory }) : null,
          tag(m.level || 0),
          h('span', { class: 'small muted', text: fmtTime(m.obsTime) + ' · ' + ago(Date.now() - new Date(m.obsTime)) })),
        h('dl', { class: 'kv' },
          h('dt', { text: 'Wind' }), h('dd', { text: wind }),
          h('dt', { text: 'Visibility' }), h('dd', { text: vis }),
          h('dt', { text: 'Ceiling' }), h('dd', { text: ceil }),
          h('dt', { text: 'Temp / dew' }), h('dd', { text: (m.tempC != null ? Math.round(m.tempC) + '°C / ' + Math.round(m.dewC) + '°C (' + cToF(m.tempC) + '°F / ' + cToF(m.dewC) + '°F)' : '—') }),
          m.wx ? h('dt', { text: 'Weather' }) : null, m.wx ? h('dd', { text: m.wx }) : null),
        m.flags && m.flags.length ? h('div', { class: 'small', text: '⚠ ' + m.flags.join(', ') }) : null,
        h('div', { class: 'mono muted', text: m.raw || '' })));
    });
  }

  // ------------------------------------------------------------ forecast + TAF
  function renderForecast() {
    var d = state.data, b = body('s-fcst'), th = (d.config && d.config.thresholds) || {};
    if (!srcOk('nws_hourly') || !d.hourly) append(b, srcErr('nws_hourly', 'NWS hourly forecast', d.nws ? d.nws.forecastUrl : 'https://forecast.weather.gov/'));
    else {
      var cell = function (v, over, suffix) { return h('td', { class: over ? 'c1' : null, text: v == null ? '—' : v + suffix }); };
      var tb = h('tbody');
      d.hourly.forEach(function (r) {
        append(tb, h('tr', null,
          h('td', { text: fmtTime(r.start) }),
          cell((r.windDir ? r.windDir + ' ' : '') + (r.windKt == null ? '—' : r.windKt), r.windKt != null && th.windKt && r.windKt >= th.windKt.caution, ''),
          cell(r.gustKt, r.gustKt != null && th.gustKt && r.gustKt >= th.gustKt.caution, ''),
          cell(r.precipPct, th.precipPct && r.precipPct > th.precipPct.caution, '%'),
          cell(r.tempF, false, '°')));
      });
      append(b, h('table', null, h('thead', null, h('tr', null,
        h('th', { text: 'Time' }), h('th', { text: 'Wind kt' }), h('th', { text: 'Gust kt' }), h('th', { text: 'Precip' }), h('th', { text: 'Temp °F' }))), tb));
      if (!srcOk('nws_grid')) append(b, h('div', { class: 'small muted', text: 'Gust forecast unavailable (' + ((d.sources.nws_grid || {}).error || 'no data') + ').' }));
    }
    var tafBox = h('div', { class: 'item' }, h('h2', { text: 'TAF' }));
    if (!srcOk('taf') || !d.tafs) append(tafBox, srcErr('taf', 'TAF', 'https://aviationweather.gov/data/taf/'));
    else if (!d.tafs.length) append(tafBox, h('div', { class: 'muted', text: 'No TAFs issued for these stations (KSMQ does not issue a TAF).' }));
    else d.tafs.forEach(function (t) { append(tafBox, h('div', { class: 'mono', text: t.raw })); });
    append(b, tafBox);
  }

  // ------------------------------------------------------------ alerts
  function renderAlerts() {
    var d = state.data, b = body('s-alerts');
    if (!srcOk('nws_alerts') || !d.alerts) { append(b, srcErr('nws_alerts', 'NWS alerts', 'https://alerts.weather.gov/')); return; }
    if (!d.alerts.length) { append(b, h('div', { class: 'big', text: 'No active NWS alerts for this point' })); return; }
    d.alerts.forEach(function (a) {
      var box = h('div', { class: 'item' },
        h('div', { class: 'row' }, h('span', { class: 'tag ' + (a.level ? 'lv-' + a.level : 'lv-i'), text: a.event }), h('span', { class: 'small', text: (a.severity || '') + (a.urgency ? ' · ' + a.urgency : '') })),
        h('div', { class: 'small', text: 'Until ' + fmtDateTime(a.ends) }),
        h('div', { text: a.headline || '' }));
      var det = h('details', null, h('summary', { class: 'small', text: 'Details' }),
        h('div', { class: 'small mono', text: (a.description || '') + (a.instruction ? '\n\n' + a.instruction : '') }));
      append(box, det);
      append(b, box);
    });
  }

  // ------------------------------------------------------------ Kp + sun
  function localNoon(now) {
    // Noon "today" in the configured time zone, as an absolute instant.
    var parts = new Intl.DateTimeFormat('en-US', { timeZone: tz(), hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(now);
    var hr = +parts.find(function (x) { return x.type === 'hour'; }).value, mi = +parts.find(function (x) { return x.type === 'minute'; }).value;
    return new Date(now.getTime() + ((12 - hr) * 60 - mi) * 60000);
  }
  function renderSky() {
    var d = state.data, b = body('s-sky');
    if (!srcOk('kp') || !d.kp) append(b, srcErr('kp', 'Kp index', 'https://www.swpc.noaa.gov/products/planetary-k-index'));
    else append(b, h('div', { class: 'row' },
      h('span', { class: 'big', text: 'Kp ' + d.kp.kp }), tag(d.kp.level || 0),
      h('span', { class: 'small muted', text: 'as of ' + fmtDateTime(d.kp.time) + ' · 24 h max ' + d.kp.max24h })));
    var c = (d && d.config && d.config.center) || (state.config && state.config.center);
    if (!c || !window.SunTimes) return;
    var now = new Date(), t = window.SunTimes.getTimes(localNoon(now), c.lat, c.lon);
    append(b, h('dl', { class: 'kv' },
      h('dt', { text: 'Civil dawn' }), h('dd', { text: fmtTime(t.civilDawn) }),
      h('dt', { text: 'Sunrise' }), h('dd', { text: fmtTime(t.sunrise) }),
      h('dt', { text: 'Sunset' }), h('dd', { text: fmtTime(t.sunset) }),
      h('dt', { text: 'Civil dusk' }), h('dd', { text: fmtTime(t.civilDusk) })));
    if (t.civilDawn && (now < t.civilDawn || now > t.civilDusk)) {
      append(b, h('div', { class: 'err', text: 'Outside civil twilight: night operation — anti-collision lighting visible for 3 SM required (14 CFR 107.29).' }));
    } else if (t.sunrise && (now < t.sunrise || now > t.sunset)) {
      append(b, h('div', { class: 'err', text: 'Civil twilight: anti-collision lighting visible for 3 SM required (14 CFR 107.29).' }));
    }
  }

  function renderSources() {
    var d = state.data, b = body('s-sources');
    var names = { tfr: 'FAA TFR list', metar: 'METAR', taf: 'TAF', nws_points: 'NWS point', nws_hourly: 'NWS hourly', nws_grid: 'NWS gusts', nws_alerts: 'NWS alerts', kp: 'SWPC Kp' };
    Object.keys(d.sources || {}).forEach(function (k) {
      var s = d.sources[k];
      append(b, h('div', null, s.ok ? '✅ ' : '❌ ', h('strong', { text: names[k] || k }), s.ok ? '' : ' — ' + s.error));
    });
    append(b, h('div', { class: 'muted', text: 'Generated ' + d.generated_at + ' · page refreshes data every 5 min' }));
  }

  function render() {
    renderBanner();
    if (!state.data) return;
    if (state.data.nws && state.data.nws.forecastUrl) document.getElementById('nws-link').href = state.data.nws.forecastUrl;
    [renderTfr, renderMetar, renderForecast, renderAlerts, renderSky, renderSources].forEach(function (fn) {
      try { fn(); } catch (e) { console.error(e); }
    });
  }

  // ------------------------------------------------------------ loading
  function getJSON(url) {
    return fetch(url + (url.indexOf('?') < 0 ? '?' : '&') + 't=' + Date.now(), { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }
  function load() {
    return getJSON(dataUrl).then(function (d) {
      if (!d || !d.generated_at) throw new Error('invalid data file');
      state.data = d; state.loadedAt = Date.now(); state.lastError = null;
    }).catch(function (e) {
      state.lastError = e.message || String(e); // keep showing the previous data; it will go stale
    }).then(render);
  }

  // Theme toggle (remembered per device).
  var root = document.documentElement;
  try { var saved = localStorage.getItem('theme'); if (saved) root.dataset.theme = saved; } catch (e) { /* storage blocked */ }
  if (!root.dataset.theme) root.dataset.theme = window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.getElementById('theme').addEventListener('click', function () {
    root.dataset.theme = root.dataset.theme === 'light' ? 'dark' : 'light';
    try { localStorage.setItem('theme', root.dataset.theme); } catch (e) { /* ignore */ }
  });

  getJSON('config.json').then(function (c) { state.config = c; }).catch(function () {}).then(function () {
    if (state.config && state.config.name) document.getElementById('title').textContent = state.config.name;
  });
  load();
  setInterval(load, POLL_MS);
  setInterval(renderBanner, TICK_MS); // keep the age / stale indicator honest between polls
  document.addEventListener('visibilitychange', function () { if (!document.hidden && Date.now() - state.loadedAt > 60000) load(); });
})();
