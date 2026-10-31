#!/usr/bin/env node
// Builds data/zips.json from the GeoNames US postal-code dump (CC BY 4.0, https://www.geonames.org/).
//
// Usage:
//   curl -O https://download.geonames.org/export/zip/US.zip && unzip US.zip US.txt
//   node scripts/build-zips.mjs US.txt
//
// Output: { "08901": [lat, lon, "NJ", "New Brunswick"], ... }. Rows without a state or
// coordinates (military APO/FPO) are skipped.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = process.argv[2];
if (!src) { console.error('usage: node scripts/build-zips.mjs US.txt'); process.exit(1); }

const zips = {};
for (const line of (await readFile(src, 'utf8')).split('\n')) {
  // country, zip, place, state name, state code, county, county code, -, -, lat, lon, accuracy
  const f = line.split('\t');
  if (f[0] !== 'US' || !/^\d{5}$/.test(f[1]) || !/^[A-Z]{2}$/.test(f[4])) continue;
  const lat = Number(f[9]), lon = Number(f[10]);
  if (!f[9] || !f[10] || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
  zips[f[1]] = [Math.round(lat * 1e4) / 1e4, Math.round(lon * 1e4) / 1e4, f[4], f[2]];
}
const sorted = Object.fromEntries(Object.entries(zips).sort(([a], [b]) => a.localeCompare(b)));
// One ZIP per line keeps git diffs readable when the data is refreshed.
const out = '{\n' + Object.entries(sorted).map(([k, v]) => JSON.stringify(k) + ':' + JSON.stringify(v)).join(',\n') + '\n}\n';
await writeFile(path.join(ROOT, 'data', 'zips.json'), out);
console.log(`wrote data/zips.json: ${Object.keys(sorted).length} ZIPs`);
