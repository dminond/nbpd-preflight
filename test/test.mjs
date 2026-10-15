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
assert.equal(full.tfrs.local.length, 4, 'Buffalo TFR filtered out by radius');
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
