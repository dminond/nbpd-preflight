#!/usr/bin/env node
// Fetches all pre-flight sources, applies thresholds from config.json and
// writes data.json. Every source is isolated: one failure never fails the run.
//
// Usage:
//   node scripts/fetch.mjs                       # live fetch -> ./data.json
//   node scripts/fetch.mjs --out path.json
//   node scripts/fetch.mjs --fixtures dirA,dirB  # read raw responses from files (first match wins)
//   node scripts/fetch.mjs --now 2026-10-15T17:50:00Z --sample-age 3 --fail kp,nws_hourly
//
// Env: NWS_CONTACT (email or URL, sent in the NWS User-Agent).

import { readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEVELS = ['GO', 'CAUTION', 'NO-GO REVIEW'];
const TIMEOUT_MS = 15000;

// ---------------------------------------------------------------- args/config

function parseArgs(argv) {
  const a = { out: path.join(ROOT, 'data.json'), config: path.join(ROOT, 'config.json'), fixtures: null, now: null, sampleAge: null, fail: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === '--out') { a.out = path.resolve(v); i++; }
    else if (k === '--config') { a.config = path.resolve(v); i++; }
    else if (k === '--fixtures') { a.fixtures = v.split(',').map(d => path.resolve(d)); i++; }
    else if (k === '--now') { a.now = new Date(v); i++; }
    else if (k === '--sample-age') { a.sampleAge = Number(v); i++; }
    else if (k === '--fail') { a.fail = v.split(','); i++; }
    else throw new Error(`Unknown argument ${k}`);
  }
  return a;
}

// ---------------------------------------------------------------- transport

function makeTransport({ fixtures, fail }) {
  const contact = process.env.NWS_CONTACT || 'contact-not-set';
  const nwsUA = `(nbpd-uas-preflight, ${contact})`;

  async function get(key, url, { accept, nws } = {}) {
    if (fail.some(f => key === f || key.startsWith(f + '_'))) throw new Error('simulated failure (--fail)');
    if (fixtures) {
      const file = key.replace(/[^\w.-]/g, '_');
      for (const dir of fixtures) {
        for (const ext of ['.json', '.xml']) {
          const p = path.join(dir, file + ext);
          if (existsSync(p)) return readFile(p, 'utf8');
        }
      }
      throw new Error(`no fixture for ${key}`);
    }
    const headers = { 'Accept': accept || 'application/json' };
    // NWS requires an identifying User-Agent; send the same one everywhere.
    headers['User-Agent'] = nwsUA;
    if (nws) headers['Accept'] = 'application/geo+json';
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers, signal: ctl.signal });
      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160);
        throw new Error(`HTTP ${res.status} from ${new URL(url).host}${detail ? ': ' + detail : ''}`);
      }
      return await res.text();
    } catch (e) {
      if (e.name === 'AbortError') throw new Error(`timeout after ${TIMEOUT_MS / 1000}s (${new URL(url).host})`);
      throw new Error(e.cause?.code ? `${e.message} (${e.cause.code})` : e.message);
    } finally {
      clearTimeout(t);
    }
  }
  const getJSON = async (key, url, opts) => {
    const txt = await get(key, url, opts);
    if (!txt.trim()) return []; // aviationweather.gov answers 204 (empty body) when there is no data
    try { return JSON.parse(txt); } catch { throw new Error(`invalid JSON from ${key}`); }
  };
  return { get, getJSON };
}

// ---------------------------------------------------------------- tiny XML parser

// Enough for the FAA XNOTAM detail files: elements, text, CDATA. Attributes ignored.
export function parseXml(src) {
  const root = { name: '#root', children: [], text: '' };
  const stack = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/\s*([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[^>]*?)?)(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(src))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2]) { if (stack.length > 1) stack.pop(); }
    else if (m[3]) {
      const el = { name: m[3].replace(/^.*:/, ''), children: [], text: '' };
      top.children.push(el);
      if (!m[5]) stack.push(el);
    } else if (m[6]) top.text += decodeEntities(m[6]);
  }
  return root;
}
function decodeEntities(s) {
  return s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, e) => {
    const map = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
    if (map[e.toLowerCase()]) return map[e.toLowerCase()];
    return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  });
}
const kids = (el, name) => (el?.children || []).filter(c => c.name === name);
const kid = (el, name) => kids(el, name)[0];
const txt = (el, name) => { const k = kid(el, name); return k ? k.text.trim() : null; };
function findAll(el, name, out = []) {
  for (const c of el?.children || []) { if (c.name === name) out.push(c); findAll(c, name, out); }
  return out;
}

// ---------------------------------------------------------------- geo

const R_NM = 3440.065;
const rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;

export function distanceNm(a, b) {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}
export function bearingDeg(a, b) {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const compass = b => COMPASS[Math.round(b / 22.5) % 16];

// Parse "40.48620000N", "074.45180000W", "404910N", "0742706.5W", "-74.45".
export function parseCoord(s, isLon) {
  if (s == null) return null;
  s = String(s).trim().toUpperCase();
  let m = s.match(/^([+-]?\d+(?:\.\d+)?)([NSEW])?$/);
  if (!m) return null;
  let [, num, hemi] = m;
  let val;
  const intPart = num.replace(/^[+-]/, '').split('.')[0];
  const degDigits = isLon ? 3 : 2;
  if (hemi && intPart.length >= degDigits + 4) {
    // DDMMSS(.s) / DDDMMSS(.s)
    const n = num.replace(/^[+-]/, '');
    const d = Number(n.slice(0, degDigits)), mi = Number(n.slice(degDigits, degDigits + 2)), se = Number(n.slice(degDigits + 2));
    val = d + mi / 60 + se / 3600;
  } else {
    val = Number(num);
  }
  if (!Number.isFinite(val)) return null;
  if (hemi === 'S' || hemi === 'W') val = -Math.abs(val);
  if (isLon ? Math.abs(val) > 180 : Math.abs(val) > 90) return null;
  return val;
}

// Local flat projection (NM) around the reference point; fine within ~100 NM.
function projector(ref) {
  const k = Math.cos(rad(ref.lat)) * 60;
  return {
    fwd: p => ({ x: (p.lon - ref.lon) * k, y: (p.lat - ref.lat) * 60 }),
    inv: q => ({ lat: ref.lat + q.y / 60, lon: ref.lon + q.x / k }),
  };
}
function segDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  let t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
function pointInPoly(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

// ---------------------------------------------------------------- TFR

function tfrAreaGeometry(areaGroup, proj) {
  // Returns { kind:'circle', c, r } or { kind:'poly', pts } in projected NM, or null.
  const merged = findAll(areaGroup, 'abdMergedArea')[0] || findAll(areaGroup, 'Abd')[0] || areaGroup;
  const avx = findAll(merged, 'Avx');
  const pt = el => {
    const lat = parseCoord(txt(el, 'geoLat'), false), lon = parseCoord(txt(el, 'geoLong'), true);
    return lat == null || lon == null ? null : { lat, lon };
  };
  const arcCenter = el => {
    const lat = parseCoord(txt(el, 'geoLatArc'), false), lon = parseCoord(txt(el, 'geoLongArc'), true);
    return lat == null || lon == null ? null : { lat, lon };
  };
  const radiusNm = el => {
    const v = Number(txt(el, 'valRadiusArc'));
    if (!Number.isFinite(v) || v <= 0) return null;
    const u = (txt(el, 'uomRadiusArc') || 'NM').toUpperCase();
    return u === 'KM' ? v / 1.852 : u === 'M' ? v / 1852 : u === 'FT' ? v / 6076.12 : u === 'MI' ? v * 0.868976 : v;
  };
  // Circle: a single vertex (or explicit CIR) with arc centre + radius.
  const circ = avx.find(a => (txt(a, 'codeType') || '').toUpperCase() === 'CIR') || (avx.length === 1 ? avx[0] : null);
  if (circ) {
    const c = arcCenter(circ) || pt(circ), r = radiusNm(circ);
    if (c && r) return { kind: 'circle', c: proj.fwd(c), r };
  }
  if (avx.length < 3) return null;
  const pts = [];
  for (let i = 0; i < avx.length; i++) {
    const a = avx[i], p = pt(a);
    if (!p) return null;
    const P = proj.fwd(p);
    pts.push(P);
    const type = (txt(a, 'codeType') || 'GRC').toUpperCase();
    if (type === 'CWA' || type === 'CCA') {
      const nxt = pt(avx[(i + 1) % avx.length]), cc = arcCenter(a);
      if (!nxt || !cc) continue;
      const C = proj.fwd(cc), Q = proj.fwd(nxt);
      const r = radiusNm(a) || Math.hypot(P.x - C.x, P.y - C.y);
      let a0 = Math.atan2(P.y - C.y, P.x - C.x), a1 = Math.atan2(Q.y - C.y, Q.x - C.x);
      if (type === 'CWA') { while (a1 >= a0) a1 -= 2 * Math.PI; } else { while (a1 <= a0) a1 += 2 * Math.PI; }
      const steps = 24;
      for (let s = 1; s < steps; s++) {
        const t = a0 + (a1 - a0) * s / steps;
        pts.push({ x: C.x + r * Math.cos(t), y: C.y + r * Math.sin(t) });
      }
    }
  }
  return { kind: 'poly', pts };
}

function fmtAlt(val, uom, code) {
  if (val == null) return null;
  const v = Number(val);
  code = (code || '').toUpperCase(); uom = (uom || 'FT').toUpperCase();
  if (code === 'STD' || uom === 'FL') return `FL${String(Math.round(v)).padStart(3, '0')}`;
  if (v === 0) return 'SFC';
  const ref = code === 'HEI' ? 'AGL' : 'MSL';
  return `${v.toLocaleString('en-US')} ${uom === 'M' ? 'M' : 'FT'} ${ref}`;
}

function toIsoUtc(s) {
  if (!s) return null;
  s = s.trim();
  if (!/Z|[+-]\d\d:?\d\d$/.test(s)) s += 'Z';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function parseTfrDetail(xml, center) {
  const doc = parseXml(xml);
  const proj = projector(center);
  const origin = { x: 0, y: 0 };
  const not = findAll(doc, 'Not')[0] || doc;
  const areas = findAll(doc, 'TFRAreaGroup');
  const out = { altitudes: [], effective: toIsoUtc(txt(not, 'dateEffective')), expires: toIsoUtc(txt(not, 'dateExpire')),
    title: txt(not, 'txtDescrUSNS') || txt(not, 'txtDescrPurpose') || null, distanceNm: null, bearingDeg: null, inside: false };
  let best = null;
  for (const g of areas.length ? areas : [doc]) {
    const area = findAll(g, 'aseTFRArea')[0] || g;
    const lo = fmtAlt(txt(area, 'valDistVerLower'), txt(area, 'uomDistVerLower'), txt(area, 'codeDistVerLower'));
    const hi = fmtAlt(txt(area, 'valDistVerUpper'), txt(area, 'uomDistVerUpper'), txt(area, 'codeDistVerUpper'));
    if (lo || hi) out.altitudes.push(`${lo || '?'} – ${hi || '?'}`);
    const geom = tfrAreaGeometry(g, proj);
    if (!geom) continue;
    let d, ctr;
    if (geom.kind === 'circle') {
      const dc = Math.hypot(geom.c.x, geom.c.y);
      d = Math.max(0, dc - geom.r); ctr = geom.c;
    } else {
      const inside = pointInPoly(origin, geom.pts);
      d = inside ? 0 : Math.min(...geom.pts.map((p, i) => segDist(origin, p, geom.pts[(i + 1) % geom.pts.length])));
      ctr = { x: geom.pts.reduce((s, p) => s + p.x, 0) / geom.pts.length, y: geom.pts.reduce((s, p) => s + p.y, 0) / geom.pts.length };
    }
    if (!best || d < best.d) best = { d, ctr };
  }
  out.altitudes = [...new Set(out.altitudes)];
  if (best) {
    const c = proj.inv(best.ctr);
    out.distanceNm = Math.round(best.d * 10) / 10;
    out.inside = best.d === 0;
    out.bearingDeg = Math.round(bearingDeg(center, c));
    out.compass = compass(out.bearingDeg);
    out.centerDistanceNm = Math.round(distanceNm(center, c) * 10) / 10;
  }
  return out;
}

async function fetchTfrs(cfg, T, now, reasons) {
  const raw = await T.getJSON('tfr_list', 'https://tfr.faa.gov/tfrapi/exportTfrList');
  const list = Array.isArray(raw) ? raw : (raw.data || raw.items || []);
  if (!Array.isArray(list)) throw new Error('unexpected TFR list format');
  const states = new Set(cfg.tfrStates.map(s => s.toUpperCase()));
  const local = [], national = [];
  for (const t of list) {
    const state = String(t.state || '').toUpperCase(), facility = String(t.facility || '').toUpperCase();
    const base = { id: t.notam_id, type: t.type, facility: t.facility, state: t.state, description: t.description, created: t.creation_date,
      detailUrl: cfg.tfrDetailPageUrl.replace('{id}', String(t.notam_id).replace('/', '_')) };
    if (states.has(state)) local.push(base);
    else if (facility === 'FDC' || state === 'USA') national.push(base);
  }
  const kept = [];
  await mapLimit(local, 4, async t => {
    const id = String(t.id).replace('/', '_');
    let detail = null, lastErr = null;
    for (const tmpl of cfg.tfrDetailXmlUrls) {
      try {
        const xml = await T.get(`tfr_detail_${id}`, tmpl.replace('{id}', id), { accept: 'application/xml,text/xml' });
        if (!/<\w/.test(xml)) throw new Error('empty detail');
        detail = parseTfrDetail(xml, cfg.center);
        break;
      } catch (e) { lastErr = e; }
    }
    if (!detail) { kept.push({ ...t, distanceNm: null, distanceUnknown: true, note: `distance unknown — check FAA (${lastErr?.message || 'no detail'})` }); return; }
    Object.assign(t, detail);
    if (t.distanceNm == null) { t.distanceUnknown = true; t.note = 'distance unknown — check FAA (geometry not parsed)'; kept.push(t); return; }
    if (t.distanceNm <= cfg.tfrRadiusNm) kept.push(t);
  });
  kept.sort((a, b) => (a.distanceNm ?? 1e9) - (b.distanceNm ?? 1e9));
  for (const t of kept) {
    let lvl = 1, why;
    if (t.distanceUnknown) why = `TFR ${t.id}: distance unknown — check FAA`;
    else if (t.distanceNm <= cfg.thresholds.tfrNm.nogo) { lvl = 2; why = `TFR ${t.id} ${t.inside ? 'covers this location' : `${t.distanceNm} NM ${t.compass}`}`; }
    else why = `TFR ${t.id} ${t.distanceNm} NM ${t.compass}`;
    t.level = lvl;
    reasons.push({ level: lvl, source: 'tfr', text: why });
  }
  return { local: kept, national, checked: local.length };
}

async function mapLimit(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}

// ---------------------------------------------------------------- METAR / TAF

const num = v => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
function parseVis(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  const s = String(v).replace('+', '').replace(/SM$/i, '').trim();
  const m = s.match(/^(?:(\d+)\s+)?(\d+)\/(\d+)$/);
  if (m) return Number(m[1] || 0) + Number(m[2]) / Number(m[3]);
  return num(s);
}
function flightCategory(visSm, ceilFt) {
  const c = ceilFt ?? Infinity, v = visSm ?? Infinity;
  if (c < 500 || v < 1) return 'LIFR';
  if (c < 1000 || v < 3) return 'IFR';
  if (c <= 3000 || v <= 5) return 'MVFR';
  return 'VFR';
}
const PRECIP_RE = /(^|\s)[-+]?(?!VC)(?:MI|PR|BC|DR|BL|SH|TS|FZ)?(?:DZ|RA|SN|SG|IC|PL|GR|GS|UP)+|(^|\s)[-+]?TS/;

// obsTime/reportTime may be epoch seconds, epoch ms or an ISO string; never throw on any of them.
export function metarTime(m) {
  for (const v of [m.obsTime, m.reportTime, m.receiptTime]) {
    if (v == null || v === '') continue;
    let d;
    if (typeof v === 'number' || /^\d+(\.\d+)?$/.test(String(v))) { const n = Number(v); d = new Date(n > 1e12 ? n : n * 1000); }
    else d = new Date(/Z|[+-]\d\d:?\d\d$/.test(v) ? v : String(v).replace(' ', 'T') + 'Z');
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

export function decodeMetar(m, now, th, reasons) {
  const clouds = (Array.isArray(m.clouds) ? m.clouds : []).map(c => ({ cover: String(c?.cover || '').toUpperCase(), base: num(c?.base) }));
  const ceil = clouds.filter(c => ['BKN', 'OVC', 'OVX', 'VV'].includes(c.cover) && c.base != null).map(c => c.base);
  const ceilingFt = ceil.length ? Math.min(...ceil) : null;
  const visibilitySm = parseVis(m.visib);
  const obsTime = metarTime(m);
  const wx = typeof m.wxString === 'string' ? m.wxString : '';
  const d = {
    station: m.icaoId, name: m.name || null, raw: m.rawOb, obsTime,
    windDir: String(m.wdir).toUpperCase() === 'VRB' ? 'VRB' : num(m.wdir), windKt: num(m.wspd), gustKt: num(m.wgst),
    visibilitySm, visibilityPlus: typeof m.visib === 'string' && m.visib.includes('+'),
    ceilingFt, clouds, tempC: num(m.temp), dewC: num(m.dewp), altimHpa: num(m.altim), wx,
    flightCategory: m.fltCat || flightCategory(visibilitySm, ceilingFt), level: 0, flags: [],
  };
  const flag = (lvl, text) => { d.level = Math.max(d.level, lvl); d.flags.push(text); reasons.push({ level: lvl, source: 'metar', text: `${d.station}: ${text}` }); };
  const hi = (v, t, label, unit) => { if (v == null) return; if (v >= t.nogo) flag(2, `${label} ${v} ${unit}`); else if (v >= t.caution) flag(1, `${label} ${v} ${unit}`); };
  const lo = (v, t, label, unit) => { if (v == null) return; if (v < t.nogo) flag(2, `${label} ${v} ${unit}`); else if (v < t.caution) flag(1, `${label} ${v} ${unit}`); };
  hi(d.windKt, th.windKt, 'wind', 'kt');
  hi(d.gustKt, th.gustKt, 'gust', 'kt');
  lo(d.visibilitySm, th.visibilitySm, 'visibility', 'SM');
  lo(d.ceilingFt, th.ceilingFtAgl, 'ceiling', 'ft AGL');
  if (PRECIP_RE.test(wx)) flag(2, `precipitation/thunderstorm now (${wx})`);
  if (obsTime && (now - new Date(obsTime)) / 60000 > th.metarMaxAgeMin) flag(1, `observation is ${Math.round((now - new Date(obsTime)) / 60000)} min old`);
  return d;
}

// ---------------------------------------------------------------- NWS

const MPH_TO_KT = 0.868976, KMH_TO_KT = 1 / 1.852;
function parseMph(s) {
  if (s == null) return null;
  if (typeof s === 'object') return num(s.value) == null ? null : (String(s.unitCode).includes('km_h') ? s.value * KMH_TO_KT : s.value * MPH_TO_KT);
  const nums = String(s).match(/\d+(\.\d+)?/g);
  if (!nums) return null;
  const v = Math.max(...nums.map(Number));
  return /km/i.test(s) ? v * KMH_TO_KT : v * MPH_TO_KT;
}
function parseIsoDuration(s) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(s || '');
  return m ? ((+m[1] || 0) * 24 + (+m[2] || 0) + (+m[3] || 0) / 60) * 3600e3 : 0;
}
function gustAt(grid, t) {
  const g = grid?.properties?.windGust;
  if (!g?.values) return null;
  const toKt = String(g.uom || '').includes('km_h') ? KMH_TO_KT : String(g.uom || '').includes('m_s') ? 1.943844 : String(g.uom || '').includes('mi_h') ? MPH_TO_KT : KMH_TO_KT;
  for (const v of g.values) {
    const [start, dur] = String(v.validTime).split('/');
    const s = new Date(start).getTime(), e = s + parseIsoDuration(dur);
    if (t >= s && t < e) return v.value == null ? null : v.value * toKt;
  }
  return null;
}

function buildHourly(hourly, grid, now, cfg) {
  const th = cfg.thresholds;
  const periods = (hourly?.properties?.periods || []).filter(p => new Date(p.endTime) > now).slice(0, cfg.forecastHours);
  return periods.map(p => {
    const t = new Date(p.startTime).getTime();
    const wind = parseMph(p.windSpeed);
    const gust = p.windGust ? parseMph(p.windGust) : gustAt(grid, t);
    const tempF = p.temperatureUnit === 'C' ? p.temperature * 9 / 5 + 32 : p.temperature;
    const h = {
      start: new Date(t).toISOString(), windDir: p.windDirection || null,
      windKt: wind == null ? null : Math.round(wind), gustKt: gust == null ? null : Math.round(gust),
      precipPct: num(p.probabilityOfPrecipitation?.value) ?? 0, tempF: num(tempF), short: p.shortForecast || '', level: 0, flags: [],
    };
    // Forecast conditions cap at CAUTION: they inform planning, not an immediate no-go.
    const flag = text => { h.level = 1; h.flags.push(text); };
    if (h.windKt != null && h.windKt >= th.windKt.caution) flag(`wind ${h.windKt} kt`);
    if (h.gustKt != null && h.gustKt >= th.gustKt.caution) flag(`gust ${h.gustKt} kt`);
    if (h.precipPct > th.precipPct.caution) flag(`precip ${h.precipPct}%`);
    return h;
  });
}

function summarizeForecast(hourly, reasons) {
  const hits = hourly.map((h, i) => h.level ? `${h.flags.join(', ')} (${i === 0 ? 'this hour' : '+' + i + 'h'})` : null).filter(Boolean);
  if (hits.length) reasons.push({ level: 1, source: 'forecast', text: `Forecast: ${hits.slice(0, 3).join('; ')}${hits.length > 3 ? ` +${hits.length - 3} more` : ''}` });
}

function alertLevel(event) {
  if (/warning|watch/i.test(event)) return 2;
  if (/advisory/i.test(event)) return 1;
  return 0;
}

// ---------------------------------------------------------------- Kp

function latestKp(raw) {
  if (!Array.isArray(raw) || !raw.length) throw new Error('unexpected Kp format');
  let rows;
  if (Array.isArray(raw[0])) {
    const hdr = raw[0].map(String);
    const ti = hdr.indexOf('time_tag'), ki = hdr.findIndex(h => /^kp$/i.test(h));
    rows = raw.slice(1).map(r => ({ time: r[ti], kp: num(r[ki]) }));
  } else {
    rows = raw.map(r => ({ time: r.time_tag, kp: num(r.Kp ?? r.kp ?? r.kp_index) }));
  }
  rows = rows.filter(r => r.kp != null);
  if (!rows.length) throw new Error('no Kp values');
  const last = rows[rows.length - 1];
  const recent = rows.slice(-8).map(r => r.kp);
  return { kp: last.kp, time: toIsoUtc(String(last.time).replace(' ', 'T')), max24h: Math.max(...recent) };
}

// ---------------------------------------------------------------- main

export async function run(args) {
  const cfg = JSON.parse(await readFile(args.config, 'utf8'));
  const now = args.now || new Date();
  const T = makeTransport(args);
  const { lat, lon } = cfg.center;
  const th = cfg.thresholds;
  const sources = {};
  const reasons = [];

  async function step(name, fn) {
    const t0 = Date.now();
    try {
      const v = await fn();
      sources[name] = { ok: true, ms: Date.now() - t0 };
      return v;
    } catch (e) {
      sources[name] = { ok: false, error: String(e.message || e), ms: Date.now() - t0 };
      return null;
    }
  }

  const ids = cfg.stations.join(',');
  const awc = 'https://aviationweather.gov/api/data';
  const nwsPoint = `${lat.toFixed(4)},${lon.toFixed(4)}`;

  const [tfrs, metarRaw, tafRaw, points, alertsRaw, kpRaw] = await Promise.all([
    step('tfr', () => fetchTfrs(cfg, T, now, reasons)),
    step('metar', () => T.getJSON('metar', `${awc}/metar?ids=${ids}&format=json`)),
    step('taf', () => T.getJSON('taf', `${awc}/taf?ids=${ids}&format=json`)),
    step('nws_points', () => T.getJSON('nws_points', `https://api.weather.gov/points/${nwsPoint}`, { nws: true })),
    step('nws_alerts', () => T.getJSON('nws_alerts', `https://api.weather.gov/alerts/active?point=${nwsPoint}`, { nws: true })),
    step('kp', () => T.getJSON('kp', 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json')),
  ]);

  // Hourly forecast + gust grid depend on /points.
  let hourlyRaw = null, gridRaw = null;
  if (points) {
    const p = points.properties || {};
    [hourlyRaw, gridRaw] = await Promise.all([
      step('nws_hourly', () => { if (!p.forecastHourly) throw new Error('no forecastHourly URL'); return T.getJSON('nws_hourly', p.forecastHourly, { nws: true }); }),
      step('nws_grid', () => { if (!p.forecastGridData) throw new Error('no forecastGridData URL'); return T.getJSON('nws_grid', p.forecastGridData, { nws: true }); }),
    ]);
  } else {
    sources.nws_hourly = { ok: false, error: 'skipped: NWS points lookup failed' };
    sources.nws_grid = { ok: false, error: 'skipped: NWS points lookup failed' };
  }

  const metars = metarRaw ? await step('metar_decode', async () => {
    const arr = Array.isArray(metarRaw) ? metarRaw : Array.isArray(metarRaw?.features) ? metarRaw.features.map(f => f.properties || {}) : [];
    return cfg.stations.map(id => {
      const ts = x => Date.parse(metarTime(x) || 0) || 0;
      const m = arr.filter(x => String(x.icaoId || x.stationId || '').toUpperCase() === id).sort((a, b) => ts(b) - ts(a))[0];
      if (!m) { reasons.push({ level: 1, source: 'metar', text: `${id}: no current METAR` }); return { station: id, missing: true, level: 1, flags: ['no current METAR'] }; }
      // One malformed report must not take the other stations down with it.
      try { return decodeMetar(m, now, th, reasons); } catch (e) {
        reasons.push({ level: 1, source: 'metar', text: `${id}: METAR could not be decoded` });
        return { station: id, raw: m.rawOb || null, level: 1, flags: [`could not decode (${e.message})`], decodeError: true };
      }
    });
  }) : null;
  if (sources.metar_decode?.ok) delete sources.metar_decode;
  else if (sources.metar_decode) { sources.metar = sources.metar_decode; delete sources.metar_decode; }

  const tafs = tafRaw ? (Array.isArray(tafRaw) ? tafRaw : []).map(t => ({ station: t.icaoId, raw: t.rawTAF, issued: toIsoUtc(t.issueTime) }))
    .sort((a, b) => cfg.stations.indexOf(a.station) - cfg.stations.indexOf(b.station)) : null;

  const hourly = hourlyRaw ? await step('nws_hourly_decode', async () => { const h = buildHourly(hourlyRaw, gridRaw, now, cfg); summarizeForecast(h, reasons); return h; }) : null;
  if (sources.nws_hourly_decode) { if (!sources.nws_hourly_decode.ok) sources.nws_hourly = sources.nws_hourly_decode; delete sources.nws_hourly_decode; }

  const alerts = alertsRaw ? (alertsRaw.features || [])
    .map(f => f.properties || {})
    .filter(p => (p.status || 'Actual') === 'Actual' && p.messageType !== 'Cancel')
    .map(p => {
      const level = alertLevel(p.event || '');
      if (level) reasons.push({ level, source: 'nws_alerts', text: `NWS: ${p.event}` });
      return { event: p.event, severity: p.severity, urgency: p.urgency, headline: p.headline, description: p.description, instruction: p.instruction,
        onset: p.onset || p.effective, ends: p.ends || p.expires, sender: p.senderName, url: p['@id'] || p.id || null, level };
    })
    .sort((a, b) => b.level - a.level) : null;

  let kp = null;
  if (kpRaw) kp = await step('kp_decode', async () => latestKp(kpRaw));
  if (sources.kp_decode) { if (!sources.kp_decode.ok) sources.kp = sources.kp_decode; delete sources.kp_decode; }
  if (kp) {
    kp.level = kp.kp >= th.kp.nogo ? 2 : kp.kp >= th.kp.caution ? 1 : 0;
    if (kp.level) reasons.push({ level: kp.level, source: 'kp', text: `Kp ${kp.kp}` });
  }

  // A missing source is itself a caution: the pilot must check it manually.
  const LABEL = { tfr: 'TFR list', metar: 'METAR', taf: 'TAF', nws_points: 'NWS point lookup', nws_hourly: 'NWS hourly forecast', nws_alerts: 'NWS alerts', kp: 'Kp index' };
  for (const [k, s] of Object.entries(sources)) {
    if (!s.ok && LABEL[k]) reasons.push({ level: 1, source: k, text: `${LABEL[k]} unavailable — check official source` });
  }

  reasons.sort((a, b) => b.level - a.level);
  const lvl = reasons.reduce((m, r) => Math.max(m, r.level), 0);
  const p = points?.properties || {};
  const data = {
    schema: 1,
    generated_at: now.toISOString(),
    ...(args.sampleAge != null ? { sample: { age_minutes: args.sampleAge } } : {}),
    config: { name: cfg.name, center: cfg.center, timeZone: cfg.timeZone, tfrRadiusNm: cfg.tfrRadiusNm, stations: cfg.stations, staleMinutes: cfg.staleMinutes, thresholds: th },
    overall: { level: LEVELS[lvl], levelNum: lvl, reasons },
    sources,
    tfrs,
    metars,
    tafs,
    hourly,
    alerts,
    kp,
    nws: points ? { office: p.gridId || p.cwa || null, forecastUrl: `https://forecast.weather.gov/MapClick.php?lat=${lat}&lon=${lon}` } : null,
  };
  const tmp = args.out + '.tmp';
  await writeFile(tmp, JSON.stringify(data, null, 1) + '\n');
  await rename(tmp, args.out);
  return data;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('fetch.mjs')) {
  const args = parseArgs(process.argv.slice(2));
  run(args).then(d => {
    const bad = Object.entries(d.sources).filter(([, s]) => !s.ok);
    console.log(`wrote ${path.relative(process.cwd(), args.out) || args.out}: ${d.overall.level} (${d.overall.reasons.length} reasons)`);
    for (const [k, s] of Object.entries(d.sources)) console.log(`  ${s.ok ? 'ok ' : 'ERR'} ${k}${s.ok ? '' : ': ' + s.error}`);
    if (bad.length === Object.keys(d.sources).length) console.warn('warning: every source failed');
  }).catch(e => {
    // Only config/IO errors reach here; source errors are captured per source.
    console.error(e);
    process.exit(1);
  });
}
