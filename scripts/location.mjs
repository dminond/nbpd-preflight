// ZIP code -> per-location config for fetch.mjs. ZIP centres come from data/zips.json
// (GeoNames, CC BY 4.0; rebuild with scripts/build-zips.mjs).

import { readFileSync } from 'node:fs';
import path from 'node:path';

// States sharing a land or short water border. A TFR within tfrRadiusNm of a ZIP centre
// is filed under that ZIP's state or a neighbour, so only those FAA list entries need
// their detail XML fetched.
export const NEIGHBORS = {
  AK: [], AL: ['FL', 'GA', 'MS', 'TN'], AR: ['LA', 'MO', 'MS', 'OK', 'TN', 'TX'], AZ: ['CA', 'CO', 'NM', 'NV', 'UT'],
  CA: ['AZ', 'NV', 'OR'], CO: ['AZ', 'KS', 'NE', 'NM', 'OK', 'UT', 'WY'], CT: ['MA', 'NY', 'RI'], DC: ['MD', 'VA'],
  DE: ['MD', 'NJ', 'PA'], FL: ['AL', 'GA'], GA: ['AL', 'FL', 'NC', 'SC', 'TN'], HI: [],
  IA: ['IL', 'MN', 'MO', 'NE', 'SD', 'WI'], ID: ['MT', 'NV', 'OR', 'UT', 'WA', 'WY'], IL: ['IA', 'IN', 'KY', 'MI', 'MO', 'WI'],
  IN: ['IL', 'KY', 'MI', 'OH'], KS: ['CO', 'MO', 'NE', 'OK'], KY: ['IL', 'IN', 'MO', 'OH', 'TN', 'VA', 'WV'],
  LA: ['AR', 'MS', 'TX'], MA: ['CT', 'NH', 'NY', 'RI', 'VT'], MD: ['DC', 'DE', 'PA', 'VA', 'WV'], ME: ['NH'],
  MI: ['IL', 'IN', 'OH', 'WI'], MN: ['IA', 'ND', 'SD', 'WI'], MO: ['AR', 'IA', 'IL', 'KS', 'KY', 'NE', 'OK', 'TN'],
  MS: ['AL', 'AR', 'LA', 'TN'], MT: ['ID', 'ND', 'SD', 'WY'], NC: ['GA', 'SC', 'TN', 'VA'], ND: ['MN', 'MT', 'SD'],
  NE: ['CO', 'IA', 'KS', 'MO', 'SD', 'WY'], NH: ['MA', 'ME', 'VT'], NJ: ['DE', 'NY', 'PA'], NM: ['AZ', 'CO', 'OK', 'TX', 'UT'],
  NV: ['AZ', 'CA', 'ID', 'OR', 'UT'], NY: ['CT', 'MA', 'NJ', 'PA', 'RI', 'VT'], OH: ['IN', 'KY', 'MI', 'PA', 'WV'],
  OK: ['AR', 'CO', 'KS', 'MO', 'NM', 'TX'], OR: ['CA', 'ID', 'NV', 'WA'], PA: ['DE', 'MD', 'NJ', 'NY', 'OH', 'WV'],
  RI: ['CT', 'MA', 'NY'], SC: ['GA', 'NC'], SD: ['IA', 'MN', 'MT', 'ND', 'NE', 'WY'], TN: ['AL', 'AR', 'GA', 'KY', 'MO', 'MS', 'NC', 'VA'],
  TX: ['AR', 'LA', 'NM', 'OK'], UT: ['AZ', 'CO', 'ID', 'NM', 'NV', 'WY'], VA: ['DC', 'KY', 'MD', 'NC', 'TN', 'WV'],
  VT: ['MA', 'NH', 'NY'], WA: ['ID', 'OR'], WI: ['IA', 'IL', 'MI', 'MN'], WV: ['KY', 'MD', 'OH', 'PA', 'VA'],
  WY: ['CO', 'ID', 'MT', 'NE', 'SD', 'UT'],
};

let zips = null;
export function lookupZip(zip, root = process.cwd()) {
  if (!/^\d{5}$/.test(String(zip))) return null;
  zips ||= JSON.parse(readFileSync(path.join(root, 'data', 'zips.json'), 'utf8'));
  const z = zips[zip];
  return z ? { zip, lat: z[0], lon: z[1], state: z[2], city: z[3] } : null;
}

// The shared settings (thresholds, radius, URLs) stay as in config.json; only what
// depends on where you are changes. stations: null makes fetch.mjs pick the nearest ones.
export function configForZip(base, loc) {
  return {
    ...base,
    name: base.siteName || base.name,
    zip: loc.zip,
    center: { lat: loc.lat, lon: loc.lon, label: `${loc.city}, ${loc.state} ${loc.zip}` },
    timeZone: null, // taken from the NWS point lookup
    tfrStates: [loc.state, ...(NEIGHBORS[loc.state] || [])],
    stations: null,
    tafStations: null,
  };
}
