// Offline checks: parsers, fixture pipeline, and data.json shape. Run: node test/test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCoord, parseTfrDetail, distanceNm, run } from '../scripts/fetch.mjs';

const C = { lat: 40.4862, lon: -74.4518 };
assert.equal(parseCoord('40.48620000N', false), 40.4862);
assert.equal(parseCoord('074.45180000W', true), -74.4518);
assert.ok(Math.abs(parseCoord('403900N', false) - 40.65) < 1e-9);
assert.ok(Math.abs(parseCoord('0743800W', true) + 74.6333333) < 1e-6);
assert.equal(parseCoord('garbage', false), null);
assert.ok(Math.abs(distanceNm(C, { lat: 41.4862, lon: -74.4518 }) - 60) < 0.2);

const d = parseTfrDetail(readFileSync('test/fixtures/nogo/tfr_detail_6_1234.xml', 'utf8'), C);
assert.equal(d.compass, 'NW');
assert.ok(d.distanceNm > 2 && d.distanceNm < 4, `circle edge distance ${d.distanceNm}`);
assert.deepEqual(d.altitudes, ['SFC – 17,999 FT MSL']);
// A circle that contains the reference point -> inside, 0 NM.
const inside = parseTfrDetail('<Not><TFRAreaGroup><abdMergedArea><Avx><codeType>CIR</codeType><geoLatArc>40.49N</geoLatArc><geoLongArc>074.45W</geoLongArc><valRadiusArc>3</valRadiusArc><uomRadiusArc>NM</uomRadiusArc></Avx></abdMergedArea></TFRAreaGroup></Not>', C);
assert.equal(inside.inside, true);
assert.equal(inside.distanceNm, 0);

function checkShape(x) {
  assert.ok(!Number.isNaN(Date.parse(x.generated_at)));
  assert.ok(['GO', 'CAUTION', 'NO-GO REVIEW'].includes(x.overall.level));
  for (const k of ['tfr', 'metar', 'taf', 'nws_points', 'nws_hourly', 'nws_grid', 'nws_alerts', 'kp']) {
    assert.equal(typeof x.sources[k]?.ok, 'boolean', `source ${k}`);
    if (!x.sources[k].ok) assert.ok(x.sources[k].error, `error text for ${k}`);
  }
}
const out = new URL('../test/.out.json', import.meta.url).pathname;
const now = new Date('2026-10-15T17:50:00Z');
const full = await run({ config: 'config.json', out, fixtures: ['test/fixtures/base'], now, fail: [] });
checkShape(full);
assert.equal(full.overall.level, 'CAUTION');
assert.equal(full.tfrs.local.length, 3, 'Buffalo TFR and one beyond the 8 NM radius filtered out');
assert.equal(full.tfrs.national.length, 2);
assert.equal(full.hourly.length, 6);

const nogo = await run({ config: 'config.json', out, fixtures: ['test/fixtures/nogo', 'test/fixtures/base'], now, fail: [] });
assert.equal(nogo.overall.level, 'NO-GO REVIEW');
assert.equal(nogo.kp.kp, 5.33, 'legacy Kp array format');

const dead = await run({ config: 'config.json', out, fixtures: ['test/fixtures/does-not-exist'], now, fail: [] });
checkShape(dead);
assert.ok(Object.values(dead.sources).every(s => !s.ok));
assert.equal(dead.overall.level, 'CAUTION', 'all sources down is never GO');
console.log('all tests passed');

// METAR robustness: obsTime formats, 204 empty bodies, malformed fields.
const { metarTime, decodeMetar } = await import('../scripts/fetch.mjs');
const th = JSON.parse(readFileSync('config.json', 'utf8')).thresholds;
assert.equal(metarTime({ obsTime: 1760550600 }), '2025-10-15T17:50:00.000Z');
assert.equal(metarTime({ obsTime: 1760550600000 }), '2025-10-15T17:50:00.000Z');
assert.equal(metarTime({ obsTime: '2025-10-15T17:50:00Z' }), '2025-10-15T17:50:00.000Z');
assert.equal(metarTime({ obsTime: 'garbage', reportTime: '2025-10-15 17:50:00' }), '2025-10-15T17:50:00.000Z');
assert.equal(metarTime({}), null);
const odd = decodeMetar({ icaoId: 'KSMQ', obsTime: '2026-10-15T17:46:00Z', wdir: 'VRB', wspd: '4', visib: '10+', clouds: null, wxString: null, rawOb: 'METAR KSMQ' }, now, th, []);
assert.equal(odd.obsTime, '2026-10-15T17:46:00.000Z');
assert.equal(odd.windKt, 4);
assert.equal(odd.ceilingFt, null);
assert.equal(odd.flightCategory, 'VFR');
const empty = await run({ config: 'config.json', out, fixtures: ['test/fixtures/empty-metar', 'test/fixtures/base'], now, fail: [] });
assert.equal(empty.sources.metar.ok, true, '204 empty body is not a source failure');
assert.ok(empty.metars.every(m => m.missing), 'each station reported as no current METAR');
const bad = await run({ config: 'config.json', out, fixtures: ['test/fixtures/bad-metar', 'test/fixtures/base'], now, fail: [] });
assert.equal(bad.sources.metar.ok, true);
const kewr = bad.metars.find(m => m.station === 'KEWR');
assert.ok(!kewr.decodeError, 'malformed fields tolerated');
assert.equal(kewr.obsTime, '2026-10-15T17:51:00.000Z');
assert.equal(kewr.visibilitySm, null);
assert.equal(kewr.ceilingFt, null);
assert.equal(bad.metars.filter(m => m.raw).length, 3, 'all stations still shown');
console.log('metar robustness tests passed');

// ZIP pages: location lookup, neighbouring-state TFR filter, nearest-station selection.
const { lookupZip, configForZip } = await import('../scripts/location.mjs');
const { mkdirSync, writeFileSync } = await import('node:fs');
assert.equal(lookupZip('00000'), null);
assert.equal(lookupZip('abcde'), null);
const nb = lookupZip('08901');
assert.equal(nb.state, 'NJ');
assert.ok(distanceNm(C, nb) < 1, 'ZIP centre near the old hard-coded centre');
const zcfg = configForZip(JSON.parse(readFileSync('config.json', 'utf8')), nb);
assert.deepEqual(zcfg.tfrStates, ['NJ', 'DE', 'NY', 'PA']);
assert.equal(zcfg.name, 'DFR Pre-Flight');

// Bounding-box responses: several reports per station, unsorted, one without coordinates.
const auto = new URL('../test/.auto/', import.meta.url).pathname;
mkdirSync(auto, { recursive: true });
const ob = (icaoId, lat, lon, mAgo, name) => ({ icaoId, lat, lon, name, obsTime: Math.floor(now / 1000) - mAgo * 60, wdir: 270, wspd: 5, visib: '10+', clouds: [], rawOb: `METAR ${icaoId} ${mAgo}` });
writeFileSync(auto + 'metar.json', JSON.stringify([
  ob('KTTN', 40.2767, -74.8135, 5, 'Trenton'), ob('KEWR', 40.6925, -74.1687, 50, 'Newark'), ob('KEWR', 40.6925, -74.1687, 2, 'Newark'),
  ob('KSMQ', 40.6238, -74.6694, 3, 'Somerville'), ob('KJFK', 40.6398, -73.7789, 1, 'JFK'), ob('KXXX', null, null, 1, 'no coords'),
]));
writeFileSync(auto + 'taf.json', JSON.stringify([
  { icaoId: 'KJFK', lat: 40.6398, lon: -73.7789, rawTAF: 'TAF KJFK', issueTime: '2026-10-15T17:20:00Z' },
  { icaoId: 'KEWR', lat: 40.6925, lon: -74.1687, rawTAF: 'TAF KEWR old', issueTime: '2026-10-15T11:20:00Z' },
  { icaoId: 'KEWR', lat: 40.6925, lon: -74.1687, rawTAF: 'TAF KEWR AMD', issueTime: '2026-10-15T17:20:00Z' },
  { icaoId: 'KTTN', lat: 40.2767, lon: -74.8135, rawTAF: 'TAF KTTN', issueTime: '2026-10-15T17:20:00Z' },
]));
const pts = JSON.parse(readFileSync('test/fixtures/base/nws_points.json', 'utf8'));
pts.properties.timeZone = 'America/New_York';
writeFileSync(auto + 'nws_points.json', JSON.stringify(pts));
const z = await run({ cfg: zcfg, out: null, fixtures: [auto, 'test/fixtures/base'], now, fail: [] });
checkShape(z);
assert.deepEqual(z.config.stations, ['KSMQ', 'KEWR', 'KTTN'], 'nearest three, closest first');
assert.deepEqual(z.metars.map(m => m.station), ['KSMQ', 'KEWR', 'KTTN']);
assert.equal(z.metars[1].raw, 'METAR KEWR 2', 'latest report per station');
assert.ok(z.metars.every(m => m.distanceNm > 0 && m.compass));
assert.deepEqual(z.tafs.map(t => t.raw), ['TAF KEWR AMD', 'TAF KTTN'], 'nearest two TAFs, latest issue');
assert.equal(z.config.timeZone, 'America/New_York', 'time zone from NWS points');
assert.equal(z.config.center.label, 'New Brunswick, NJ 08901');
writeFileSync(auto + 'metar.json', '[]');
const none = await run({ cfg: zcfg, out: null, fixtures: [auto, 'test/fixtures/base'], now, fail: [] });
assert.deepEqual(none.metars, []);
assert.ok(none.overall.reasons.some(r => /No METAR station within 60 NM/.test(r.text)), 'no nearby station is a caution');
console.log('zip tests passed');
