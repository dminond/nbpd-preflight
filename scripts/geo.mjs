// Small geodesy helpers shared by the TFR and airspace code. Distances in NM.

const R_NM = 3440.065;
export const rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;

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

// Local flat projection (NM) around the reference point; fine within ~100 NM.
export function projector(ref) {
  const k = Math.cos(rad(ref.lat)) * 60;
  return {
    fwd: p => ({ x: (p.lon - ref.lon) * k, y: (p.lat - ref.lat) * 60 }),
    inv: q => ({ lat: ref.lat + q.y / 60, lon: ref.lon + q.x / k }),
  };
}
export function segDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  let t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
export function pointInPoly(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}


// Bounding box nm around a point as 'minLat,minLon,maxLat,maxLon'.
export function bbox({ lat, lon }, nm) {
  const dLat = nm / 60, dLon = nm / (60 * Math.cos(rad(lat)));
  return [lat - dLat, lon - dLon, lat + dLat, lon + dLon].map(v => v.toFixed(3)).join(',');
}
