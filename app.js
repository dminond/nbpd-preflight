// UAS pre-flight page. /NNNNN reads /api/data?zip=NNNNN and /?lat=..&lon=.. reads
// /api/data?lat=..&lon=.. (scripts/fetch.mjs behind a Vercel function); / shows a ZIP form. Re-polls every 5 minutes. All external text is inserted
// as text, never HTML.
(function () {
  'use strict';
  var POLL_MS = 5 * 60 * 1000, TICK_MS = 30 * 1000;
  var LEVELS = ['GO', 'CAUTION', 'NO-GO REVIEW'];
  var state = { data: null, config: null, loadedAt: 0, lastError: null, loading: false, loadStart: 0 };

  // ?data=samples/data-stale.json (or data.json from a local fetch) previews a file;
  // otherwise /08901 loads that ZIP, /?lat=..&lon=.. a device location, and / shows the ZIP form.
  var params = new URLSearchParams(location.search);
  var zipMatch = location.pathname.match(/\/(\d{5})\/?$/);
  var zip = zipMatch ? zipMatch[1] : null;
  var COORD = /^-?\d{1,3}(\.\d+)?$/;
  var point = COORD.test(params.get('lat') || '') && COORD.test(params.get('lon') || '') ? { lat: params.get('lat'), lon: params.get('lon') } : null;
  var dataUrl = null;
  var p = params.get('data');
  if (p && /^[\w-]+(\/[\w-]+)*\.json$/.test(p)) dataUrl = p;
  else if (zip) dataUrl = '/api/data?zip=' + zip;
  else if (point) dataUrl = '/api/data?lat=' + point.lat + '&lon=' + point.lon;

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
  // No configured zone (NWS lookup failed): fall back to the device's own zone.
  function tz() { return (state.data && state.data.config && state.data.config.timeZone) || undefined; }
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
  // "Now" on the data's own clock: real time, except sample files are replayed as if
  // they were generated age_minutes ago, so their fixed timestamps keep making sense.
  function dataNow() {
    var d = state.data;
    if (d && d.sample && d.sample.age_minutes != null) return Date.parse(d.generated_at) + d.sample.age_minutes * 60000 + (Date.now() - state.loadedAt);
    return Date.now();
  }
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
    if (!d && state.loading) {
      // A location's first check runs every source live (CDN cache miss) and can take a while.
      var secs = Math.round((Date.now() - state.loadStart) / 1000);
      b.className = 'lv-x loading';
      append(b, [h('div', { class: 'lvl', text: 'LOADING…' }),
        h('div', { class: 'asof', text: 'Checking FAA TFRs, METAR/TAF, NWS and Kp' }),
        secs >= 5 ? h('div', { class: 'small', text: secs + ' s · the first check for a location can take up to 30 s' }) : null,
        h('div', { class: 'bar' })]);
      return;
    }
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
    if (state.loading) append(b, h('div', { class: 'bar', title: 'Refreshing' }));
    document.getElementById('sample').hidden = !d.sample;
  }

  // ------------------------------------------------------------ TFRs
  var SOON_MS = 3 * 3600 * 1000; // highlight TFRs starting within 3 hours
  function dur(ms) {
    var m = Math.max(1, Math.round(ms / 60000));
    if (m < 60) return m + ' min';
    if (m < 48 * 60) return Math.floor(m / 60) + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '');
    return Math.round(m / 1440) + ' days';
  }
  // Computed in the browser so it stays correct between data refreshes.
  function tfrStatus(t, now) {
    var s = t.effective ? Date.parse(t.effective) : NaN, e = t.expires ? Date.parse(t.expires) : NaN;
    if (!isNaN(e) && now >= e) return { key: 'ended', text: 'ENDED ' + dur(now - e) + ' ago — confirm on FAA' };
    if (!isNaN(s) && now < s) return { key: s - now <= SOON_MS ? 'soon' : 'upcoming', text: 'STARTS IN ' + dur(s - now) };
    if (!isNaN(s) || !isNaN(e)) return { key: 'active', text: 'ACTIVE NOW' + (!isNaN(e) ? ' · ends in ' + dur(e - now) : ' · no end time') };
    return { key: 'unknown', text: 'TIMES UNKNOWN — check FAA' };
  }
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
        (function () { var st = tfrStatus(t, dataNow()); return h('div', { class: 'st st-' + st.key, text: st.text }); })(),
        h('dl', { class: 'kv' },
          h('dt', { text: 'Altitudes' }), h('dd', { text: (t.altitudes && t.altitudes.length) ? t.altitudes.join('; ') : 'see FAA detail' }),
          h('dt', { text: 'Window' }), h('dd', { text: win })),
        h('div', { class: 'small clamp', title: 'Show all', text: t.title && t.title !== t.description ? t.title + ' — ' + (t.description || '') : (t.description || '') }),
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
    var states = (d.config && d.config.tfrStates) || (state.config && state.config.tfrStates) || [];
    append(b, h('div', { class: 'small muted', text: 'Checked ' + (d.tfrs.checked || 0) + ' TFR(s) listed for ' + states.join('/') + '. Always confirm on the FAA TFR map.' }));
  }

  // ------------------------------------------------------------ METAR
  function renderMetar() {
    var d = state.data, b = body('s-metar');
    if (!srcOk('metar') || !d.metars) { append(b, srcErr('metar', 'METAR', 'https://aviationweather.gov/data/metar/')); return; }
    if (!d.metars.length) append(b, h('div', { class: 'err', text: 'No METAR station within ' + (d.config.stationSearchNm || '?') + ' NM. Check aviationweather.gov.' }));
    d.metars.forEach(function (m) {
      if (m.missing) { append(b, h('div', { class: 'item' }, h('div', { class: 'row' }, h('span', { class: 'big', text: m.station }), tag(1)), h('div', { text: 'No current METAR' }))); return; }
      if (m.decodeError) {
        append(b, h('div', { class: 'item' }, h('div', { class: 'row' }, h('span', { class: 'big', text: m.station }), tag(1)),
          h('div', { text: 'Could not decode this report — read the raw METAR.' }), h('div', { class: 'mono', text: m.raw || '' })));
        return;
      }
      var wind = m.windKt === 0 ? 'Calm' : (m.windDir === 'VRB' ? 'VRB' : (m.windDir != null ? String(m.windDir).padStart(3, '0') + '°' : '—')) + ' ' + (m.windKt != null ? m.windKt + ' kt' : '—') + (m.gustKt ? ' gust ' + m.gustKt + ' kt' : '');
      var vis = m.visibilitySm == null ? '—' : m.visibilitySm + (m.visibilityPlus ? '+' : '') + ' SM';
      var ceil = m.ceilingFt == null ? 'None' : m.ceilingFt.toLocaleString('en-US') + ' ft AGL';
      append(b, h('div', { class: 'item' },
        h('div', { class: 'row' },
          h('span', { class: 'big', text: m.station }),
          m.flightCategory ? h('span', { class: 'cat cat-' + m.flightCategory, text: m.flightCategory }) : null,
          tag(m.level || 0),
          h('span', { class: 'small muted', text: m.obsTime ? fmtTime(m.obsTime) + ' · ' + ago(Date.now() - new Date(m.obsTime)) : 'time unknown' })),
        m.distanceNm != null ? h('div', { class: 'small muted', text: m.distanceNm + ' NM ' + m.compass + (m.name ? ' · ' + m.name : '') }) : null,
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
    else if (!d.tafs.length) append(tafBox, h('div', { class: 'muted', text: d.config.stationSearchNm ? 'No TAF-issuing airport within ' + d.config.stationSearchNm + ' NM.' : 'No TAFs issued for these stations.' }));
    else d.tafs.forEach(function (t) {
      if (t.distanceNm != null) append(tafBox, h('div', { class: 'small muted', text: t.station + ' · ' + t.distanceNm + ' NM ' + t.compass }));
      append(tafBox, h('div', { class: 'mono', text: t.raw }));
    });
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

  // ------------------------------------------------------------ airspace
  function nm(d, dir) { return d === 0 ? 'here' : d + ' NM ' + (dir || ''); }
  function renderAirspace() {
    var d = state.data, b = body('s-air'), a = d.airspace;
    if (!srcOk('airspace') || !a) { append(b, srcErr('airspace', 'FAA airspace data', 'https://www.faa.gov/uas/getting_started/b4ufly')); return; }
    var pt = a.point || {};
    if (pt.controlled) {
      append(b, h('div', { class: 'item' },
        h('div', { class: 'row' }, h('span', { class: 'big', text: 'Class ' + pt.cls + (pt.airport ? ' · ' + pt.airport : '') }), tag(pt.ceilingFt === 0 ? 2 : 1, 'CONTROLLED')),
        h('div', { text: 'Controlled airspace: Part 107 flight needs FAA authorization (LAANC, FAADroneZone, or your agency’s COA/waiver).' }),
        h('dl', { class: 'kv' },
          h('dt', { text: 'LAANC ceiling' }), h('dd', { text: pt.ceilingFt == null ? 'No facility map grid here — request via FAADroneZone' : pt.ceilingFt === 0 ? '0 ft — no automatic approval' : pt.ceilingFt + ' ft AGL' }),
          h('dt', { text: 'LAANC' }), h('dd', { text: pt.laanc == null ? '—' : pt.laanc ? 'Available' : 'Not available at this airport — use FAADroneZone' }),
          pt.airportName ? h('dt', { text: 'Airport' }) : null, pt.airportName ? h('dd', { text: pt.airportName }) : null,
          pt.name ? h('dt', { text: 'Airspace' }) : null, pt.name ? h('dd', { text: pt.name + (pt.partTime ? ' (part-time — check hours)' : '') }) : null)));
    } else if (pt.controlled === false) {
      append(b, h('div', { class: 'item' },
        h('div', { class: 'row' }, h('span', { class: 'big', text: 'Class G' }), tag(0, 'UNCONTROLLED')),
        h('div', { text: 'No airspace authorization needed at this point up to 400 ft AGL.' }),
        a.nearestControlled ? h('div', { class: 'small', text: 'Nearest controlled airspace: Class ' + a.nearestControlled.cls + ' (' + a.nearestControlled.name + ') ' + nm(a.nearestControlled.distanceNm, a.nearestControlled.compass) }) : null));
    } else {
      append(b, h('div', { class: 'item err', text: 'Airspace class could not be determined here (' + (pt.name || 'MSL floor') + ', ground elevation unknown). Check the sectional or B4UFLY.' }));
    }
    a.overhead.forEach(function (o) { append(b, h('div', { class: 'small muted', text: 'Overhead: Class ' + o.cls + ' from ' + o.floor + ' (about ' + o.floorAgl.toLocaleString('en-US') + ' ft AGL)' })); });

    var rs = a.restrictions || [];
    if (rs.length) {
      var box = h('div', { class: 'item' }, h('h2', { text: 'Restricted areas within ' + a.radiusNm + ' NM' }));
      rs.forEach(function (r) {
        append(box, h('div', { class: 'item' },
          h('div', { class: 'row' }, h('strong', { text: r.name }), r.inside ? tag(2, 'INSIDE') : h('span', { class: 'small', text: nm(r.distanceNm, r.compass) })),
          h('div', { class: 'small', text: r.label + (r.floor || r.ceiling ? ' · ' + (r.floor || '?') + ' – ' + (r.ceiling || '?') : '') + (r.times ? ' · ' + r.times : '') + (r.note ? ' · ' + r.note : '') })));
      });
      append(b, box);
    }
    (a.other || []).forEach(function (o) { append(b, h('div', { class: 'small', text: 'ℹ Inside ' + o.name + ' (' + ({ MOA: 'military operations area', W: 'warning area', A: 'alert area', D: 'danger area' }[o.kind] || o.kind) + ')' + (o.times ? ' · ' + o.times : '') + ' — no sUAS restriction; watch for low-flying aircraft.' })); });
    (a.stadiums || []).forEach(function (s) { append(b, h('div', { class: 'small', text: '🏟 ' + s.name + ' ' + nm(s.distanceNm, s.compass) + ' — sporting-event TFR (FDC 4/3621) within 3 NM, 1 h before to 1 h after events. Check the schedule.' })); });
    append(b, h('div', { class: 'small muted', text: 'FAA UAS Data Delivery System' + (a.mapEffective ? ' · facility map effective ' + a.mapEffective : '') +
      (a.groundElevFt != null ? ' · ground ' + a.groundElevFt + ' ft MSL (NWS)' : '') + '. Confirm with B4UFLY or your LAANC provider before flight.' }));
  }

  // ------------------------------------------------------------ map
  // Leaflet is vendored and only loaded when the map card is first opened.
  var map = null, mapLayers = null, leafletLoading = null;
  var CEIL_COLORS = [[0, '#d10000'], [100, '#ff7a00'], [200, '#ffc400'], [300, '#7bc043'], [400, '#0b8a3a']];
  function ceilColor(c) { for (var i = 0; i < CEIL_COLORS.length; i++) if (c <= CEIL_COLORS[i][0]) return CEIL_COLORS[i][1]; return '#0b8a3a'; }
  var CLASS_STYLE = { B: { color: '#1f5fd1' }, C: { color: '#b000b0' }, D: { color: '#1f5fd1', dashArray: '6 5' }, E: { color: '#b000b0', dashArray: '6 5' } };
  function loadLeaflet() {
    if (window.L) return Promise.resolve();
    return leafletLoading || (leafletLoading = new Promise(function (resolve, reject) {
      var css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'vendor/leaflet/leaflet.css'; document.head.appendChild(css);
      var js = document.createElement('script'); js.src = 'vendor/leaflet/leaflet.js'; js.onload = resolve;
      js.onerror = function () { leafletLoading = null; reject(new Error('map library failed to load')); };
      document.head.appendChild(js);
    }));
  }
  function initMap() {
    var el = document.getElementById('map');
    map = L.map(el, { zoomSnap: 0.5 });
    var osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' });
    var sectional = L.tileLayer('https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/VFR_Sectional/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 16, maxNativeZoom: 12, attribution: 'FAA Aeronautical Information Services' });
    osm.addTo(map);
    mapLayers = { grid: L.layerGroup(), airspace: L.layerGroup(), restricted: L.layerGroup(), tfr: L.layerGroup(), stations: L.layerGroup(), stadiums: L.layerGroup(), center: L.layerGroup() };
    ['grid', 'airspace', 'restricted', 'tfr', 'stations', 'stadiums', 'center'].forEach(function (k) { mapLayers[k].addTo(map); });
    L.control.layers({ 'Street map': osm, 'FAA VFR sectional': sectional }, {
      'LAANC grid': mapLayers.grid, 'Controlled airspace': mapLayers.airspace, 'Restricted areas': mapLayers.restricted,
      'TFRs': mapLayers.tfr, 'METAR stations': mapLayers.stations, 'Stadiums': mapLayers.stadiums,
    }, { collapsed: true }).addTo(map);
    L.control.scale({ imperial: true, metric: false }).addTo(map);
    // Ceiling numbers once a facility map cell (1/120 degree) is tall enough on screen to hold one.
    function labels() {
      var c = map.getCenter(), a = map.latLngToContainerPoint(c), b = map.latLngToContainerPoint([c.lat + 1 / 120, c.lng]);
      el.classList.toggle('labels', Math.abs(a.y - b.y) >= 30);
    }
    map.on('zoomend', labels);
    drawMap(true);
    labels();
  }
  function tip(layer, text) { layer.bindTooltip(text, { sticky: true }); return layer; }
  function drawMap(fit) {
    var d = state.data;
    if (!map || !d || !d.config || !d.config.center) return;
    Object.keys(mapLayers).forEach(function (k) { mapLayers[k].clearLayers(); });
    var c = d.config.center, here = [c.lat, c.lon], NM = 1852;
    var a = d.airspace, m = a && a.map;
    if (m) {
      m.cells.forEach(function (x) {
        var col = ceilColor(x[4]), r = L.rectangle([[x[0], x[1]], [x[2], x[3]]], { color: col, weight: 0.5, fillColor: col, fillOpacity: 0.28, interactive: false });
        r.bindTooltip(String(x[4]), { permanent: true, direction: 'center', className: 'ceil' });
        mapLayers.grid.addLayer(r);
      });
      m.classes.forEach(function (x) {
        var st = CLASS_STYLE[x.cls] || CLASS_STYLE.E;
        mapLayers.airspace.addLayer(tip(L.polygon(x.rings, { color: st.color, dashArray: st.dashArray, weight: x.surface ? 2.5 : 1.2, fill: false }),
          x.name + ' · floor ' + (x.floor || '?')));
      });
      m.areas.forEach(function (x) {
        var hard = ['P', 'R', 'NSUFR', 'NDA', 'DC'].indexOf(x.kind) >= 0;
        var st = hard ? { color: '#d10000', weight: 2, fillColor: '#d10000', fillOpacity: x.kind === 'DC' ? 0.04 : 0.25 } : { color: '#777', weight: 1, dashArray: '4 4', fillOpacity: 0.05 };
        var shape = x.circle ? L.circle(x.circle.center, Object.assign({ radius: x.circle.rNm * NM }, st)) : L.polygon(x.rings, st);
        mapLayers.restricted.addLayer(tip(shape, x.name));
      });
      m.stadiums.forEach(function (s) {
        mapLayers.stadiums.addLayer(tip(L.circle([s.lat, s.lon], { radius: 3 * NM, color: '#7a00b5', weight: 1, dashArray: '3 5', fill: false }), s.name + ' · 3 NM event TFR'));
        mapLayers.stadiums.addLayer(tip(L.circleMarker([s.lat, s.lon], { radius: 5, color: '#7a00b5', fillColor: '#7a00b5', fillOpacity: 1 }), s.name));
      });
    }
    ((d.tfrs && d.tfrs.local) || []).forEach(function (t) {
      (t.shapes || []).forEach(function (s) {
        var st = { color: '#ff0000', weight: 2, fillColor: '#ff0000', fillOpacity: 0.18 };
        var shape = s.type === 'circle' ? L.circle(s.center, Object.assign({ radius: s.rNm * NM }, st)) : L.polygon(s.ring, st);
        mapLayers.tfr.addLayer(tip(shape, 'TFR ' + t.id + ' ' + (t.type || '')));
      });
    });
    (d.metars || []).forEach(function (s) {
      if (s.lat == null || s.lon == null) return;
      mapLayers.stations.addLayer(L.circleMarker([s.lat, s.lon], { radius: 6, color: '#000', weight: 1, fillColor: '#fff', fillOpacity: 1 })
        .bindTooltip(s.station, { permanent: true, direction: 'right', offset: [6, 0] }));
    });
    var radius = d.config.tfrRadiusNm;
    if (radius) mapLayers.center.addLayer(tip(L.circle(here, { radius: radius * NM, color: '#555', weight: 1.5, dashArray: '8 6', fill: false, interactive: true }), 'TFR search radius ' + radius + ' NM'));
    mapLayers.center.addLayer(tip(L.circleMarker(here, { radius: 8, color: '#fff', weight: 3, fillColor: '#0057ff', fillOpacity: 1 }), c.label || 'Location'));
    if (fit) {
      // The airspace radius, widened to the nearest edge of each local TFR.
      var bounds = L.latLng(here).toBounds(((a && a.radiusNm) || 3) * 2 * NM);
      ((d.tfrs && d.tfrs.local) || []).forEach(function (t) {
        if (t.distanceNm == null || t.bearingDeg == null) return;
        var r = (t.distanceNm + 0.5) / 60, b = t.bearingDeg * Math.PI / 180;
        bounds.extend([c.lat + r * Math.cos(b), c.lon + r * Math.sin(b) / Math.cos(c.lat * Math.PI / 180)]);
      });
      map.fitBounds(bounds);
    }
  }
  function openMap() {
    loadLeaflet().then(function () { if (!map) initMap(); else { map.invalidateSize(); drawMap(false); } })
      .catch(function (e) { document.getElementById('map').textContent = 'Map unavailable: ' + e.message; });
  }
  var mapDetails = document.querySelector('#s-map details');
  // Desktop dashboard (see the CSS): every card open and the map always shown. The phone's
  // remembered map open/closed choice is left alone.
  var desktop = window.matchMedia ? window.matchMedia('(min-width: 1000px)') : { matches: false };
  function applyLayout() {
    if (desktop.matches) document.querySelectorAll('section.card > details').forEach(function (d) { d.open = true; });
    if (map) map.invalidateSize();
  }
  try { if (localStorage.getItem('mapOpen') === '1') mapDetails.open = true; } catch (e) { /* storage blocked */ }
  applyLayout();
  if (desktop.addEventListener) desktop.addEventListener('change', applyLayout);
  mapDetails.addEventListener('toggle', function () {
    if (!desktop.matches) try { localStorage.setItem('mapOpen', mapDetails.open ? '1' : '0'); } catch (e) { /* storage blocked */ }
    if (mapDetails.open && state.data) openMap();
  });

  function renderSources() {
    var d = state.data, b = body('s-sources');
    var names = { airspace: 'FAA airspace', tfr: 'FAA TFR list', metar: 'METAR', taf: 'TAF', nws_points: 'NWS point', nws_hourly: 'NWS hourly', nws_grid: 'NWS gusts', nws_alerts: 'NWS alerts', kp: 'SWPC Kp' };
    Object.keys(d.sources || {}).forEach(function (k) {
      var s = d.sources[k];
      append(b, h('div', null, s.ok ? '✅ ' : '❌ ', h('strong', { text: names[k] || k }), s.ok ? '' : ' — ' + s.error));
    });
    append(b, h('div', { class: 'muted', text: 'Generated ' + d.generated_at + ' · page refreshes data every 5 min' }));
  }

  // Which overall-banner reasons and data sources belong to each collapsible card.
  var CARDS = {
    's-tfr': ['tfr'],
    's-air': ['airspace'],
    's-metar': ['metar'],
    's-fcst': ['forecast', 'nws_points', 'nws_hourly', 'taf'],
    's-alerts': ['nws_alerts'],
    's-sky': ['kp'],
  };
  function renderContributions() {
    var d = state.data;
    Object.keys(CARDS).forEach(function (id) {
      var chip = document.querySelector('#' + id + ' .contrib');
      if (!d) { chip.className = 'contrib tag lv-x'; chip.textContent = 'NO DATA'; return; }
      var keys = CARDS[id];
      var lvl = ((d.overall && d.overall.reasons) || []).reduce(function (m, r) {
        return keys.indexOf(r.source) >= 0 ? Math.max(m, r.level) : m;
      }, 0);
      var failed = keys.some(function (k) { return d.sources && d.sources[k] && !d.sources[k].ok; });
      chip.className = 'contrib tag lv-' + lvl;
      chip.textContent = failed && lvl < 2 ? 'UNAVAILABLE' : LEVELS[lvl];
    });
  }

  function renderPlace() {
    var c = state.data && state.data.config, el = document.getElementById('place');
    if (!c || !c.center || !c.center.label) { el.hidden = true; return; }
    el.hidden = false; el.textContent = '';
    var device = c.center.source === 'device';
    var geo = navigator.geolocation ? h('button', { type: 'button', text: device ? 'Update my location' : 'Use my location' }) : null;
    if (geo) geo.addEventListener('click', function () { locate(geo); });
    append(el, ['📍 ', h('strong', { text: device ? 'Your location' : c.center.label }),
      h('span', { class: 'muted', text: (device ? ' · ' + c.center.label : '') + ' · distances from ' + (device ? 'this point ' : c.zip ? 'the ZIP centre ' : '') +
        '(' + c.center.lat.toFixed(device ? 3 : 4) + ', ' + c.center.lon.toFixed(device ? 3 : 4) + ') · ' }),
      h('a', { href: '/', text: device ? 'Enter a ZIP' : 'Change ZIP' }), geo ? ' · ' : null, geo]);
    if (c.name) document.getElementById('title').textContent = c.name;
    document.title = (c.name || 'Pre-Flight') + ' — ' + c.center.label;
  }

  function render() {
    renderBanner();
    renderContributions();
    renderPlace();
    if (!state.data) return;
    if (state.data.nws && state.data.nws.forecastUrl) document.getElementById('nws-link').href = state.data.nws.forecastUrl;
    [renderTfr, renderAirspace, renderMetar, renderForecast, renderAlerts, renderSky, renderSources].forEach(function (fn) {
      try { fn(); } catch (e) { console.error(e); }
    });
    if (mapDetails.open) { if (map) drawMap(false); else openMap(); }
  }

  // ------------------------------------------------------------ loading
  function getJSON(url) {
    // No cache-busting query string: it would make every poll a CDN cache miss on Vercel.
    return fetch(url, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw Object.assign(new Error('HTTP ' + r.status), { status: r.status });
      return r.json();
    });
  }
  function load() {
    if (!dataUrl || state.loading) return;
    state.loading = true; state.loadStart = Date.now();
    renderBanner();
    var tick = state.data ? null : setInterval(renderBanner, 1000);
    return getJSON(dataUrl).then(function (d) {
      if (!d || !d.generated_at) throw new Error('invalid data file');
      state.data = d; state.loadedAt = Date.now(); state.lastError = null;
      if (zip) try { localStorage.setItem('zip', zip); } catch (e) { /* storage blocked */ }
    }).catch(function (e) {
      if (e.status === 404 && (zip || point) && !p) {
        dataUrl = null;
        showZipEntry(zip ? 'ZIP ' + zip + ' was not found. Check the number, or try a nearby ZIP.' : 'That location is outside US coverage. Enter a ZIP instead.');
        return;
      }
      state.lastError = e.message || String(e); // keep showing the previous data; it will go stale
    }).then(function () {
      state.loading = false; clearInterval(tick);
      if (dataUrl) render();
    });
  }

  // ------------------------------------------------------------ ZIP form
  function showZipEntry(msg) {
    document.body.classList.add('landing');
    document.getElementById('zip-entry').hidden = false;
    var m = document.getElementById('zip-msg');
    m.hidden = !msg; m.textContent = msg || '';
    var input = document.getElementById('zip-input');
    if (!input.value) try { input.value = localStorage.getItem('zip') || ''; } catch (e) { /* storage blocked */ }
  }
  // Device location -> /?lat=..&lon=.. (3 decimals, ~100 m). Needs HTTPS and the user's permission.
  function locate(btn) {
    var label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Locating…';
    navigator.geolocation.getCurrentPosition(function (pos) {
      location.href = '/?lat=' + pos.coords.latitude.toFixed(3) + '&lon=' + pos.coords.longitude.toFixed(3);
    }, function (err) {
      btn.disabled = false; btn.textContent = label;
      var msg = err.code === 1 ? 'Location permission was denied. Allow it in your browser settings, or enter a ZIP.'
        : err.code === 3 ? 'Finding your location timed out. Try again, or enter a ZIP.' : 'Your location is unavailable. Enter a ZIP instead.';
      if (document.body.classList.contains('landing')) showZipEntry(msg);
      else alert(msg);
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  }
  var geoBtn = document.getElementById('geo-btn');
  if (navigator.geolocation) { geoBtn.hidden = false; geoBtn.addEventListener('click', function () { locate(geoBtn); }); }

  // Long TFR text is clamped on desktop (CSS); a click shows all of it.
  document.addEventListener('click', function (e) { if (e.target.classList && e.target.classList.contains('clamp')) e.target.classList.toggle('open'); });

  document.getElementById('zip-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var v = document.getElementById('zip-input').value.trim();
    if (/^\d{5}$/.test(v)) location.href = '/' + v;
    else showZipEntry('Enter a 5-digit ZIP code.');
  });
  if (!dataUrl) showZipEntry();

  // Theme toggle (remembered per device).
  var root = document.documentElement;
  try { var saved = localStorage.getItem('theme'); if (saved) root.dataset.theme = saved; } catch (e) { /* storage blocked */ }
  if (!root.dataset.theme) root.dataset.theme = window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.getElementById('theme').addEventListener('click', function () {
    root.dataset.theme = root.dataset.theme === 'light' ? 'dark' : 'light';
    try { localStorage.setItem('theme', root.dataset.theme); } catch (e) { /* ignore */ }
  });

  getJSON('config.json').then(function (c) { state.config = c; }).catch(function () {}).then(function () {
    var c = state.config;
    if (c && !(state.data && state.data.config && state.data.config.name)) document.getElementById('title').textContent = (zip || point || !dataUrl ? c.siteName : c.name) || c.name;
  });
  load();
  setInterval(load, POLL_MS);
  setInterval(function () { // keep the age / stale indicator and TFR status labels honest between polls
    renderBanner();
    if (state.data) try { renderTfr(); } catch (e) { console.error(e); }
  }, TICK_MS);
  document.addEventListener('visibilitychange', function () { if (dataUrl && !document.hidden && Date.now() - state.loadedAt > 60000) load(); });
})();
