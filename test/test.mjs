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
// Airspace from the fixture layers (see make-fixtures.mjs).
assert.equal(full.sources.airspace.ok, true);
assert.equal(full.airspace.point.cls, 'G', 'Class G at the point');
assert.deepEqual(full.airspace.nearestControlled, { cls: 'D', name: 'SOMERSET CLASS D', distanceNm: 0.8, compass: 'N' });
assert.deepEqual(full.airspace.overhead.map(o => [o.cls, o.floorAgl]), [['B', 2921]], 'Class B shelf 3,000 MSL over 79 ft ground');
assert.equal(full.airspace.stadiums[0].name, 'SHI Stadium');
assert.ok(!full.overall.reasons.some(r => r.source === 'airspace'), 'stadium and nearby areas are information by default');
const raritan = full.airspace.restrictions.find(r => r.kind === 'NSUFR');
assert.ok(!raritan.inside && raritan.distanceNm > 0.5 && raritan.distanceNm < 1.2, `99.7 area outside nearNm (${raritan.distanceNm})`);
assert.equal(full.airspace.map.cells.length, 3);
assert.deepEqual(full.airspace.map.cells[0].slice(0, 2), [40.5, -74.46]);
assert.equal(nogo.airspace.point.ceilingFt, 0);
assert.ok(nogo.overall.reasons.some(r => r.source === 'airspace' && r.level === 2 && /0 ft facility map ceiling/.test(r.text)));
assert.ok(dead.sources.airspace.error, 'airspace failure is reported');
assert.ok(dead.overall.reasons.some(r => r.source === 'airspace' && /unavailable/.test(r.text)), 'missing airspace is a caution');
assert.ok(full.tfrs.local.every(t => t.distanceUnknown || t.shapes.length), 'parsed TFRs carry map shapes');
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
assert.equal(zcfg.name, 'DFR Preflight');

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

// Device location: rounded point, nearest ZIP for state/label, distances from the point itself.
const { parsePoint, nearestZip, configForPoint } = await import('../scripts/location.mjs');
assert.deepEqual(parsePoint('40.48912', '-74.44821'), { lat: 40.489, lon: -74.448 });
for (const [a, b] of [['91', '0'], ['1e2', '0'], ['40.4', null], ['', '-74'], ['40.4,1', '-74']]) assert.equal(parsePoint(a, b), null, `${a},${b}`);
const nz = nearestZip(40.5, -74.45);
assert.equal(nz.state, 'NJ');
assert.ok(nz.distanceNm < 3);
assert.ok(nearestZip(30, -40).distanceNm > 1000, 'mid-Atlantic is far from every ZIP');
const pcfg = configForPoint(JSON.parse(readFileSync('config.json', 'utf8')), { lat: 40.5, lon: -74.45 }, nz);
assert.deepEqual(pcfg.center, { lat: 40.5, lon: -74.45, label: `Near ${nz.city}, NJ`, source: 'device' });
assert.equal(pcfg.zip, null);
assert.deepEqual(pcfg.tfrStates, ['NJ', 'DE', 'NY', 'PA']);
console.log('zip tests passed');

// Airspace rules with hand-built layers.
const { evaluateAirspace } = await import('../scripts/airspace.mjs');
const P = { lat: 40.4862, lon: -74.4518 };
const sq = (d, props) => ({ type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: [[[P.lon - d, P.lat - d], [P.lon - d, P.lat + d], [P.lon + d, P.lat + d], [P.lon + d, P.lat - d], [P.lon - d, P.lat - d]]] } });
const noLayers = { uasfm: [], classes: [], sua: [], nsufr: [], nsufrPartTime: [], nda: [], stadiums: [] };
const acfg = { center: P, airspaceRadiusNm: 3, thresholds: { airspace: { controlledLevel: 1, zeroCeilingLevel: 2, nearNm: 0.5 } } };
const ev = (layers, ground, cfg = acfg) => { const rs = []; const a = evaluateAirspace({ ...noLayers, ...layers }, cfg, ground, now, rs); return { a, rs }; };
const shelf = sq(0.05, { NAME: 'SHELF B', CLASS: 'B', LOCAL_TYPE: 'CLASS_B', LOWER_VAL: 500, LOWER_UOM: 'FT', LOWER_CODE: 'MSL', WKHR_CODE: 'H24' });
let t = ev({ classes: [shelf] }, 200);
assert.equal(t.a.point.cls, 'B', '500 MSL over 200 ft ground is 300 ft AGL: controlled');
assert.ok(/no facility map ceiling/.test(t.rs[0].text) && t.rs[0].level === 1);
t = ev({ classes: [shelf] }, 50);
assert.equal(t.a.point.cls, 'G', '500 MSL over 50 ft ground is 450 ft AGL: above Part 107 altitude');
assert.equal(t.a.overhead[0].floorAgl, 450);
t = ev({ classes: [shelf] }, null);
assert.equal(t.a.point.controlled, null, 'MSL floor with unknown ground is not assumed clear');
assert.equal(t.rs[0].level, 1);
t = ev({ classes: [sq(0.05, { NAME: 'E5', CLASS: 'E', LOCAL_TYPE: 'CLASS_E5', LOWER_VAL: 700, LOWER_CODE: 'SFC' })] }, 0);
assert.equal(t.a.point.cls, 'G', 'Class E from 700 ft AGL leaves Class G at drone altitudes');
// Hole in a polygon (even-odd): point in the hole is outside.
const donut = sq(0.05, { NAME: 'R-1', TYPE_CODE: 'R', LOWER_VAL: '0', LOWER_CODE: 'SFC', UPPER_VAL: '5000', UPPER_CODE: 'MSL' });
donut.geometry.coordinates.push(sq(0.01, {}).geometry.coordinates[0]);
t = ev({ sua: [donut] }, 0);
assert.equal(t.a.restrictions[0].inside, false, 'point in the hole');
assert.equal(t.rs[0].level, 1, '0.6 NM from the hole edge is near: CAUTION');
t = ev({ sua: [sq(0.05, { NAME: 'P-99', TYPE_CODE: 'P', LOWER_VAL: '0', LOWER_CODE: 'SFC' })] }, 0);
assert.equal(t.rs[0].level, 2, 'inside a prohibited area');
t = ev({ sua: [sq(0.05, { NAME: 'HIGH R', TYPE_CODE: 'R', LOWER_VAL: '5000', LOWER_UOM: 'FT', LOWER_CODE: 'MSL' })] }, 0);
assert.equal(t.rs.length, 0, 'restricted area starting at 5,000 MSL does not affect a 400 ft flight');
t = ev({ sua: [sq(0.05, { NAME: 'MOA X', TYPE_CODE: 'MOA', LOWER_VAL: '500', LOWER_CODE: 'SFC' })] }, 0);
assert.equal(t.rs.length, 0); assert.equal(t.a.other[0].name, 'MOA X');
t = ev({ nsufrPartTime: [sq(0.05, { Facility: 'Base X', ACTIVETIME: now.getTime() - 3600e3, ENDTIME: now.getTime() - 60e3 })] }, 0);
assert.equal(t.rs.length, 0, 'ended part-time restriction does not flag');
t = ev({ uasfm: [sq(0.004, { CEILING: 200, APT1_ICAO: 'KTTN', APT1_LAANC: 0, AIRSPACE_1: 'D' })] }, 0);
assert.ok(/LAANC not available/.test(t.rs[0].text) && t.a.point.ceilingFt === 200, 'grid cell without a class polygon still means controlled');
t = ev({}, 0, { ...acfg, center: { lat: 38.8977, lon: -77.0365 } });
assert.ok(t.rs.some(r => r.level === 2 && /Flight Restricted Zone/.test(r.text)), 'DC FRZ');
t = ev({}, 0, { ...acfg, center: { lat: 38.978, lon: -76.492 } });
assert.ok(t.rs.some(r => r.level === 1 && /SFRA/.test(r.text)) && !t.rs.some(r => r.level === 2), 'DC SFRA outside the FRZ');
// ArcGIS reports query errors with HTTP 200; that must fail the source, not read as "no airspace".
const { fetchAirspace } = await import('../scripts/airspace.mjs');
await assert.rejects(fetchAirspace(acfg, { getJSON: async () => ({ error: { code: 400, message: 'Invalid query' } }) }), /Invalid query/);
console.log('airspace tests passed');
