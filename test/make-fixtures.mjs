// Regenerates the synthetic raw-response fixtures in test/fixtures/.
// They mimic each upstream API's response format; the values are invented.
import { writeFileSync } from 'node:fs';
const NOW = Date.UTC(2026, 9, 15, 17, 50);
const ep = m => Math.round((NOW - m * 60000) / 1000);
const iso = (h, off = 0) => new Date(NOW - 50 * 60000 + h * 3600e3 + off).toISOString().replace('.000Z', '+00:00');
const w = (dir, name, obj) => writeFileSync(`test/fixtures/${dir}/${name}`, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1) + '\n');

// ---- TFR list
const list = [
  { notam_id: '6/4321', type: 'HAZARDS', facility: 'ZNY', state: 'NJ', description: 'Hillsborough, NJ, Thursday, October 15, 2026 through Friday, October 16, 2026 UTC', creation_date: '10/14/2026' },
  { notam_id: '6/5555', type: 'SECURITY', facility: 'ZOB', state: 'NY', description: 'Buffalo, NY, Thursday, October 15, 2026 UTC', creation_date: '10/13/2026' },
  { notam_id: '6/7777', type: 'SPECIAL', facility: 'ZNY', state: 'PA', description: 'Morrisville, PA, Thursday, October 15, 2026 UTC', creation_date: '10/15/2026' },
  { notam_id: '6/2468', type: 'SECURITY', facility: 'ZNY', state: 'NJ', description: 'Perth Amboy, NJ, Thursday, October 15, 2026 UTC', creation_date: '10/15/2026' },
  { notam_id: '4/3621', type: 'SECURITY', facility: 'FDC', state: 'USA', description: 'Sporting events and stadiums nationwide', creation_date: '03/01/2024' },
  { notam_id: '1/1155', type: 'SECURITY', facility: 'FDC', state: 'DC', description: 'Washington, DC Special Flight Rules Area', creation_date: '01/01/2021' },
  { notam_id: '6/9001', type: 'HAZARDS', facility: 'ZLA', state: 'CA', description: 'Los Angeles, CA wildfire', creation_date: '10/12/2026' },
];
w('base', 'tfr_list.json', list);

const tfrXml = (id, type, descr, eff, exp, lo, hi, avxs) => `<?xml version="1.0" encoding="UTF-8"?>
<XNOTAM-Update version="2.0" origin="USNS">
 <Group><Add><Not>
  <NotUid><txtLocalName>${id}</txtLocalName><codeFacility>ZNY</codeFacility></NotUid>
  <dateEffective>${eff}</dateEffective>
  ${exp ? `<dateExpire>${exp}</dateExpire>` : ''}
  <codeTimeZone>EDT</codeTimeZone>
  <txtDescrUSNS>${descr}</txtDescrUSNS>
  <TFRNot><codeType>${type}</codeType>
   <TFRAreaGroup>
    <aseTFRArea><txtName>Area A</txtName>
     <valDistVerLower>${lo[0]}</valDistVerLower><uomDistVerLower>FT</uomDistVerLower><codeDistVerLower>${lo[1]}</codeDistVerLower>
     <valDistVerUpper>${hi[0]}</valDistVerUpper><uomDistVerUpper>FT</uomDistVerUpper><codeDistVerUpper>${hi[1]}</codeDistVerUpper>
    </aseTFRArea>
    <abdMergedArea>
${avxs.map(a => `     <Avx><codeDatum>WGE</codeDatum><codeType>${a.t || 'GRC'}</codeType><geoLat>${a.lat}</geoLat><geoLong>${a.lon}</geoLong>${a.clat ? `<geoLatArc>${a.clat}</geoLatArc><geoLongArc>${a.clon}</geoLongArc>` : ''}${a.r ? `<valRadiusArc>${a.r}</valRadiusArc><uomRadiusArc>NM</uomRadiusArc>` : ''}</Avx>`).join('\n')}
    </abdMergedArea>
   </TFRAreaGroup>
  </TFRNot>
 </Not></Add></Group>
</XNOTAM-Update>
`;
// Hillsborough polygon ~10-12 NM WNW, with one clockwise arc edge.
w('base', 'tfr_detail_6_4321.xml', tfrXml('6/4321', 'HAZARDS', 'Hillsborough, NJ wildfire suppression &amp; aerial operations', '2026-10-15T12:00:00', '2026-10-16T23:59:00', ['0', 'ALT'], ['2500', 'ALT'], [
  { lat: '40.55000000N', lon: '074.62000000W' },
  { lat: '40.55000000N', lon: '074.70000000W', t: 'CWA', clat: '40.50000000N', clon: '074.70000000W', r: '3' },
  { lat: '40.45000000N', lon: '074.70000000W' },
  { lat: '40.45000000N', lon: '074.65000000W' },
]));
// Buffalo: DMS coordinates, far away -> filtered out.
w('base', 'tfr_detail_6_5555.xml', tfrXml('6/5555', 'SECURITY', 'Buffalo, NY VIP', '2026-10-15T14:00:00', '2026-10-15T20:00:00', ['0', 'ALT'], ['18000', 'STD'], [
  { lat: '425300N', lon: '0784900W', clat: '425300N', clon: '0784900W', r: '10', t: 'CIR' },
]));
// 6/7777 detail intentionally absent -> "distance unknown".
// Perth Amboy: UAS restriction with no usable geometry -> "distance unknown".
w('base', 'tfr_detail_6_2468.xml', tfrXml('6/2468', 'SECURITY', 'Perth Amboy, NJ UAS operations prohibited', '2026-10-15T13:00:00', null, ['0', 'HEI'], ['400', 'HEI'], []));

// ---- METAR (aviationweather.gov JSON)
const metar = (icaoId, name, mAgo, wdir, wspd, wgst, visib, clouds, temp, dewp, wx, fltCat, raw) =>
  ({ icaoId, receiptTime: '', obsTime: ep(mAgo), reportTime: new Date(ep(mAgo) * 1000).toISOString().replace('.000Z', 'Z'), temp, dewp, wdir, wspd, wgst, visib, altim: 1016.3, wxString: wx, metarType: 'METAR', rawOb: raw, lat: 0, lon: 0, elev: 0, name, clouds, fltCat });
w('base', 'metar.json', [
  metar('KSMQ', 'Somerville/Somerset Arpt, NJ, US', 4, 290, 9, null, '10+', [{ cover: 'SCT', base: 4500 }], 16.1, 4.4, null, 'VFR', 'METAR KSMQ 151746Z 29009KT 10SM SCT045 16/04 A3001'),
  metar('KEWR', 'Newark Liberty Intl, NJ, US', 0, 300, 14, 22, '10+', [{ cover: 'FEW', base: 5000 }, { cover: 'BKN', base: 8000 }], 17.2, 3.9, null, 'VFR', 'METAR KEWR 151751Z 30014G22KT 10SM FEW050 BKN080 17/04 A3000 RMK AO2 PK WND 30027/1712 SLP160'),
  metar('KTTN', 'Trenton-Mercer Arpt, NJ, US', 0, 'VRB', 4, null, 6, [{ cover: 'OVC', base: 3100 }], 15.6, 6.1, 'HZ', null, 'METAR KTTN 151753Z VRB04KT 6SM HZ OVC031 16/06 A3002 RMK AO2 SLP165'),
]);
w('nogo', 'metar.json', [
  metar('KSMQ', 'Somerville/Somerset Arpt, NJ, US', 6, 270, 18, 27, '2 1/2', [{ cover: 'BKN', base: 800 }, { cover: 'OVC', base: 1500 }], 12.0, 11.0, '-TSRA BR', 'IFR', 'METAR KSMQ 151744Z 27018G27KT 2 1/2SM -TSRA BR BKN008 OVC015CB 12/11 A2981'),
  metar('KEWR', 'Newark Liberty Intl, NJ, US', 0, 260, 21, 30, 4, [{ cover: 'OVC', base: 1200 }], 13.0, 11.0, 'RA', 'MVFR', 'METAR KEWR 151751Z 26021G30KT 4SM RA OVC012 13/11 A2980'),
]);

// ---- TAF
w('base', 'taf.json', [
  { icaoId: 'KEWR', issueTime: '2026-10-15T17:20:00Z', validTimeFrom: ep(30), validTimeTo: ep(-1800), rawTAF: 'TAF KEWR 151720Z 1518/1624 30014G22KT P6SM FEW050 BKN080\n  FM160000 31010KT P6SM SCT060\n  FM161400 33008KT P6SM FEW250' },
  { icaoId: 'KTTN', issueTime: '2026-10-15T17:20:00Z', validTimeFrom: ep(30), validTimeTo: ep(-1440), rawTAF: 'TAF KTTN 151720Z 1518/1618 VRB05KT 6SM HZ OVC030\n  FM152200 29008KT P6SM SCT040\n  FM160600 VRB03KT P6SM SKC' },
]);

// ---- NWS
w('base', 'nws_points.json', { properties: {
  gridId: 'PHI', gridX: 63, gridY: 104, cwa: 'PHI',
  forecastHourly: 'https://api.weather.gov/gridpoints/PHI/63,104/forecast/hourly',
  forecastGridData: 'https://api.weather.gov/gridpoints/PHI/63,104',
  relativeLocation: { properties: { city: 'New Brunswick', state: 'NJ' } } } });
const winds = ['10 mph', '12 mph', '14 mph', '18 mph', '15 mph', '10 mph', '8 mph', '6 mph', '5 mph', '5 mph'];
const pop = [5, 5, 10, 20, 35, 40, 20, 10, 5, 0];
w('base', 'nws_hourly.json', { properties: { periods: winds.map((ws, i) => ({
  number: i + 1, startTime: iso(i), endTime: iso(i + 1), isDaytime: i < 6, temperature: 62 - i, temperatureUnit: 'F',
  probabilityOfPrecipitation: { unitCode: 'wmoUnit:percent', value: pop[i] }, windSpeed: ws, windDirection: 'NW',
  shortForecast: pop[i] > 30 ? 'Chance Showers And Thunderstorms' : 'Partly Sunny' })) } });
const gustsKmh = [33, 37, 41, 44, 39, 30, 24, 20, 18, 15];
w('base', 'nws_grid.json', { properties: { windGust: { uom: 'wmoUnit:km_h-1', values: gustsKmh.map((v, i) => ({ validTime: `${iso(i)}/PT1H`, value: v })) } } });
w('base', 'nws_alerts.json', { type: 'FeatureCollection', features: [
  { properties: { '@id': 'https://api.weather.gov/alerts/urn:oid:2.49.0.1.840.0.sample1', status: 'Actual', messageType: 'Alert', event: 'Wind Advisory', severity: 'Moderate', urgency: 'Expected',
    headline: 'Wind Advisory issued October 15 at 11:02AM EDT until October 15 at 8:00PM EDT by NWS Mount Holly NJ',
    description: '* WHAT...Northwest winds 15 to 25 mph with gusts up to 45 mph expected.\n\n* WHERE...Middlesex and Somerset counties.',
    instruction: 'Use extra caution when driving, especially if operating a high profile vehicle.', onset: iso(-1), ends: iso(3), senderName: 'NWS Mount Holly NJ' } },
  { properties: { '@id': 'https://api.weather.gov/alerts/urn:oid:2.49.0.1.840.0.sample2', status: 'Actual', messageType: 'Alert', event: 'Special Weather Statement', severity: 'Minor', urgency: 'Expected',
    headline: 'Special Weather Statement issued October 15 by NWS Mount Holly NJ', description: 'Elevated fire danger this afternoon.', onset: iso(-2), ends: iso(4), senderName: 'NWS Mount Holly NJ' } },
] });
w('nogo', 'nws_alerts.json', { type: 'FeatureCollection', features: [
  { properties: { status: 'Actual', messageType: 'Alert', event: 'Severe Thunderstorm Warning', severity: 'Severe', urgency: 'Immediate',
    headline: 'Severe Thunderstorm Warning issued October 15 at 1:44PM EDT until October 15 at 2:30PM EDT by NWS Mount Holly NJ',
    description: 'At 144 PM EDT, a severe thunderstorm was located near Bound Brook, moving east at 35 mph.\n\nHAZARD...60 mph wind gusts and penny size hail.', instruction: 'For your protection move to an interior room on the lowest floor of a building.', onset: iso(0), ends: iso(1), senderName: 'NWS Mount Holly NJ' } },
] });

// ---- Kp (current SWPC object format; legacy array-of-arrays is also accepted)
const kps = [1.67, 2, 2.33, 2.67, 2, 1.33, 2.33, 2.67];
w('base', 'kp.json', kps.map((kp, i) => ({ time_tag: new Date(NOW - (7 - i) * 3 * 3600e3 - 110 * 60000).toISOString().slice(0, 19), Kp: kp, a_running: 7, station_count: 8 })));
w('nogo', 'kp.json', [['time_tag', 'Kp', 'a_running', 'station_count'], ['2026-10-15 12:00:00.000', '4.33', '32', '8'], ['2026-10-15 15:00:00.000', '5.33', '56', '8']]);

// No-go TFR: VIP circle 10 NM radius centred ~12 NM NW (Bedminster) -> edge ~2 NM away.
w('nogo', 'tfr_list.json', [{ notam_id: '6/1234', type: 'VIP', facility: 'ZNY', state: 'NJ', description: 'Bedminster, NJ, Thursday, October 15, 2026 through Sunday, October 18, 2026 UTC', creation_date: '10/10/2026' }, ...list]);
w('nogo', 'tfr_detail_6_1234.xml', tfrXml('6/1234', 'VIP', 'Bedminster, NJ VIP movement', '2026-10-15T16:00:00', '2026-10-18T22:00:00', ['0', 'HEI'], ['17999', 'ALT'], [
  { lat: '403900N', lon: '0743800W', clat: '403900N', clon: '0743800W', r: '10', t: 'CIR' },
]));
console.log('fixtures written');
