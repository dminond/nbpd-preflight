// Airspace at the reference point, from the FAA's public ArcGIS layers (UAS Data Delivery
// System, services6.arcgis.com/ssFJjBXIUyZDrSYZ): controlled airspace and UAS Facility Map
// (LAANC) ceilings, special use airspace, national security UAS flight restrictions
// (14 CFR 99.7), national defense airspace and stadiums. One envelope query per layer;
// containment and distances are computed here so the same data also feeds the map.

import { rad, bearingDeg, compass, distanceNm, projector, pointInPoly } from './geo.mjs';

const FAA = 'https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services';
const PART_107_MAX_FT = 400;
const STADIUM_NM = 3; // FDC 0/0367 stadium restriction radius (up to 3,000 ft AGL)
// The Washington DC FRZ and SFRA (14 CFR 93 subpart V) are not in these layers. Both are
// treated as circles around the DCA VOR/DME (the FRZ is roughly 15 NM, the SFRA 30 NM).
const DCA = { lat: 38.8592, lon: -77.0364 }, DC_FRZ_NM = 15, DC_SFRA_NM = 30;

// simplify: ArcGIS maxAllowableOffset in degrees (~20 m), keeps big polygons small.
const LAYERS = {
  uasfm: { service: 'FAA_UAS_FacilityMap_Data', fields: 'CEILING,MAP_EFF,APT1_ICAO,APT1_NAME,APT1_LAANC,AIRSPACE_1' },
  classes: {
    service: 'Class_Airspace', simplify: 0.0002,
    fields: 'NAME,IDENT,ICAO_ID,CLASS,LOCAL_TYPE,LOWER_VAL,LOWER_UOM,LOWER_CODE,UPPER_VAL,UPPER_UOM,UPPER_CODE,WKHR_CODE',
    // Mode C veils and Class A never apply to sUAS; E5/E6 only when their floor could reach 400 ft AGL.
    where: "LOCAL_TYPE IN ('CLASS_B','CLASS_C','CLASS_D','CLASS_E','CLASS_E2','CLASS_E3','CLASS_E4') OR (LOCAL_TYPE IN ('CLASS_E5','CLASS_E6') AND (LOWER_CODE='MSL' OR LOWER_VAL<400))",
  },
  sua: { service: 'Special_Use_Airspace', simplify: 0.0002, fields: 'NAME,TYPE_CODE,LOWER_VAL,LOWER_UOM,LOWER_CODE,UPPER_VAL,UPPER_UOM,UPPER_CODE,TIMESOFUSE' },
  nsufr: { service: 'DoD_Mar_13', simplify: 0.0001, fields: 'Facility,Base,Floor,Ceiling' },
  nsufrPartTime: { service: 'Part_Time_National_Security_UAS_Flight_Restrictions', simplify: 0.0001, fields: 'Facility,Base,Floor,Ceiling,ACTIVETIME,ENDTIME' },
  nda: { service: 'National_Defense_Airspace_TFR_Areas', simplify: 0.0002, fields: 'NAME,WKHR_CODE' },
  stadiums: { service: 'Stadiums', fields: 'NAME,CITY,STATE,STATUS_CODE', minRadiusNm: STADIUM_NM },
};

export async function fetchAirspace(cfg, T) {
  const radius = cfg.airspaceRadiusNm || 3;
  const entries = await Promise.all(Object.entries(LAYERS).map(async ([key, L]) => {
    const r = Math.max(radius, L.minRadiusNm || 0);
    const dLat = r / 60, dLon = r / (60 * Math.cos(rad(cfg.center.lat)));
    const { lat, lon } = cfg.center;
    const q = new URLSearchParams({
      where: L.where || '1=1', outFields: L.fields, returnGeometry: 'true', f: 'geojson',
      geometry: [lon - dLon, lat - dLat, lon + dLon, lat + dLat].map(v => v.toFixed(4)).join(','),
      geometryType: 'esriGeometryEnvelope', inSR: '4326', outSR: '4326', spatialRel: 'esriSpatialRelIntersects', geometryPrecision: '5',
    });
    if (L.simplify) q.set('maxAllowableOffset', String(L.simplify));
    const d = await T.getJSON(`airspace_${key}`, `${FAA}/${L.service}/FeatureServer/0/query?${q}`, { retries: 1, timeoutMs: 20000 });
    // ArcGIS reports query errors with HTTP 200.
    if (d?.error) throw new Error(`FAA ${L.service}: ${d.error.message || 'query error'}`);
    if (!Array.isArray(d?.features)) throw new Error(`FAA ${L.service}: unexpected response`);
    return [key, d.features];
  }));
  return Object.fromEntries(entries);
}

// ---------------------------------------------------------------- geometry

const r5 = v => Math.round(v * 1e5) / 1e5;
// GeoJSON Polygon/MultiPolygon -> polygons -> rings -> [lat, lon]
function polygons(g) {
  const conv = rings => rings.map(r => r.map(([x, y]) => [r5(y), r5(x)]));
  if (g?.type === 'Polygon') return [conv(g.coordinates)];
  if (g?.type === 'MultiPolygon') return g.coordinates.map(conv);
  return [];
}
// Is the reference point inside (even-odd, so holes work), and how far to the nearest edge.
function relate(polys, proj) {
  const O = { x: 0, y: 0 };
  let inside = false, best = { d: Infinity, x: 0, y: 0 };
  for (const rings of polys) {
    const pr = rings.map(r => r.map(([lat, lon]) => proj.fwd({ lat, lon })));
    let inPoly = false;
    for (const r of pr) if (pointInPoly(O, r)) inPoly = !inPoly;
    inside ||= inPoly;
    for (const r of pr) for (let i = 0; i + 1 < r.length; i++) {
      const c = closest(r[i], r[i + 1]);
      if (c.d < best.d) best = c;
    }
  }
  const edgeNm = best.d === Infinity ? null : Math.round(best.d * 10) / 10;
  return { inside, edgeNm, compass: edgeNm == null ? null : compass((Math.atan2(best.x, best.y) * 180 / Math.PI + 360) % 360) };
}
function closest(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / l2)) : 0;
  const x = a.x + t * dx, y = a.y + t * dy;
  return { d: Math.hypot(x, y), x, y };
}
const rings = polys => polys.flat();

// ---------------------------------------------------------------- altitudes

// Floor in feet AGL, or null when it is MSL and the ground elevation is unknown.
function floorAgl(val, uom, code, groundFt) {
  let v = Number(val);
  if (val == null || val === '' || !Number.isFinite(v)) return null;
  if (String(uom || 'FT').toUpperCase() === 'FL') v *= 100;
  code = String(code || '').toUpperCase();
  if (code === 'SFC' || code === 'AGL' || code === 'HEI') return v;
  return groundFt == null ? null : v - groundFt;
}
function altText(val, uom, code) {
  const v = Number(val);
  if (val == null || val === '' || !Number.isFinite(v) || v < 0) return null;
  code = String(code || '').toUpperCase();
  if (String(uom || '').toUpperCase() === 'FL' || code === 'STD') return `FL${String(Math.round(v)).padStart(3, '0')}`;
  if (v === 0 && code === 'SFC') return 'SFC';
  return `${v.toLocaleString('en-US')} ft ${code === 'SFC' ? 'AGL' : 'MSL'}`;
}

// ---------------------------------------------------------------- evaluation

const CLASS_ORDER = ['B', 'C', 'D', 'E'];
const classOf = localType => (String(localType || '').match(/^CLASS_([A-E])/) || [])[1] || null;

export function evaluateAirspace(raw, cfg, groundFt, now, reasons) {
  const center = cfg.center, proj = projector(center);
  const th = cfg.thresholds.airspace || {};
  const nearNm = th.nearNm ?? 0.5;
  const out = {
    radiusNm: cfg.airspaceRadiusNm || 3, groundElevFt: groundFt == null ? null : Math.round(groundFt),
    point: null, nearestControlled: null, overhead: [], restrictions: [], other: [], stadiums: [], mapEffective: null, level: 0,
    map: { cells: [], classes: [], areas: [], stadiums: [] },
  };
  const flag = (level, text) => { out.level = Math.max(out.level, level); reasons.push({ level, source: 'airspace', text }); };

  // UAS Facility Map grid: axis-aligned cells, sent to the page as [s, w, n, e, ceiling].
  const cells = raw.uasfm.map(f => {
    const pts = rings(polygons(f.geometry)), p = f.properties || {};
    const lats = pts.flat().map(q => q[0]), lons = pts.flat().map(q => q[1]);
    if (!lats.length) return null;
    return { s: Math.min(...lats), w: Math.min(...lons), n: Math.max(...lats), e: Math.max(...lons), ceiling: Number(p.CEILING),
      airport: p.APT1_ICAO || null, airportName: p.APT1_NAME || null, laanc: Number(p.APT1_LAANC) === 1, airspace: p.AIRSPACE_1 || null, eff: p.MAP_EFF || null };
  }).filter(c => c && Number.isFinite(c.ceiling));
  out.map.cells = cells.map(c => [c.s, c.w, c.n, c.e, c.ceiling]);
  // On a shared edge, take the lower ceiling.
  const cell = cells.filter(c => center.lat >= c.s && center.lat <= c.n && center.lon >= c.w && center.lon <= c.e).sort((a, b) => a.ceiling - b.ceiling)[0] || null;
  out.mapEffective = cells.find(c => c.eff)?.eff || null;

  // Class B/C/D/E: controlled at drone altitude when the floor is below 400 ft AGL.
  const classes = raw.classes.map(f => {
    const p = f.properties || {}, polys = polygons(f.geometry);
    return { cls: classOf(p.LOCAL_TYPE), localType: p.LOCAL_TYPE, name: p.NAME, ident: p.ICAO_ID || p.IDENT || null,
      agl: floorAgl(p.LOWER_VAL, p.LOWER_UOM, p.LOWER_CODE, groundFt), floor: altText(p.LOWER_VAL, p.LOWER_UOM, p.LOWER_CODE),
      partTime: !!p.WKHR_CODE && p.WKHR_CODE !== 'H24', polys, rel: relate(polys, proj) };
  }).filter(c => c.cls);
  const here = classes.filter(c => c.rel.inside);
  const surface = here.filter(c => c.agl != null && c.agl < PART_107_MAX_FT).sort((a, b) => CLASS_ORDER.indexOf(a.cls) - CLASS_ORDER.indexOf(b.cls));
  const unknown = here.filter(c => c.agl == null && ['B', 'C', 'D'].includes(c.cls));
  for (const c of here.filter(c => c.agl != null && c.agl >= PART_107_MAX_FT && c.cls !== 'E')) out.overhead.push({ cls: c.cls, name: c.name, floor: c.floor, floorAgl: Math.round(c.agl) });
  const eAbove = here.filter(c => c.cls === 'E' && c.agl != null && c.agl >= PART_107_MAX_FT).map(c => c.agl);

  const top = surface[0];
  if (top || cell) {
    const cls = top?.cls || cell.airspace || '?', apt = cell?.airport || top?.ident || '';
    const where = `Class ${cls}${apt ? ` (${apt})` : ''}`;
    out.point = { controlled: true, cls, name: top?.name || null, airport: apt || null, airportName: cell?.airportName || null,
      ceilingFt: cell ? cell.ceiling : null, laanc: cell ? cell.laanc : null, partTime: surface.some(c => c.partTime) };
    const pt = out.point.partTime ? ' · part-time airspace, check hours' : '';
    if (!cell) flag(th.controlledLevel ?? 1, `${where}: controlled airspace — authorization required (no facility map ceiling here)${pt}`);
    else if (cell.ceiling === 0) flag(th.zeroCeilingLevel ?? 2, `${where}: 0 ft facility map ceiling — no LAANC approval; needs FAA authorization or your COA${pt}`);
    else if (!cell.laanc) flag(th.controlledLevel ?? 1, `${where}: authorization required — facility map ceiling ${cell.ceiling} ft, LAANC not available here${pt}`);
    else flag(th.controlledLevel ?? 1, `${where}: authorization required — LAANC up to ${cell.ceiling} ft${pt}`);
  } else if (unknown.length) {
    const u = unknown[0];
    out.point = { controlled: null, cls: u.cls, name: u.name };
    flag(1, `${u.name}: floor ${u.floor}, ground elevation unknown — check the sectional`);
  } else {
    out.point = { controlled: false, cls: 'G', eFloorAgl: eAbove.length ? Math.round(Math.min(...eAbove)) : null };
  }
  // Nearest controlled airspace outside the point, for DFR flights that move.
  if (!out.point.controlled) {
    const near = classes.filter(c => !c.rel.inside && c.agl != null && c.agl < PART_107_MAX_FT && c.rel.edgeNm != null).sort((a, b) => a.rel.edgeNm - b.rel.edgeNm)[0];
    if (near) out.nearestControlled = { cls: near.cls, name: near.name, distanceNm: near.rel.edgeNm, compass: near.rel.compass };
  }
  out.map.classes = classes.filter(c => c.agl == null || c.agl < PART_107_MAX_FT || ['B', 'C'].includes(c.cls))
    .map(c => ({ cls: c.cls, name: c.name, floor: c.floor, surface: c.agl != null && c.agl < PART_107_MAX_FT, rings: rings(c.polys) }));

  // Areas where flight is prohibited or restricted (NO-GO REVIEW inside, CAUTION near).
  const restrict = (kind, label, name, polys, extra = {}) => {
    const rel = relate(polys, proj);
    const r = { kind, label, name, inside: rel.inside, distanceNm: rel.inside ? 0 : rel.edgeNm, compass: rel.compass, ...extra };
    if (extra.relevant !== false) {
      if (r.inside) flag(extra.insideLevel ?? 2, `Inside ${name} (${label})${extra.note ? ' — ' + extra.note : ''}`);
      else if (r.distanceNm != null && r.distanceNm <= nearNm) flag(1, `${name} (${label}) ${r.distanceNm} NM ${r.compass}`);
    }
    delete r.relevant; delete r.insideLevel;
    out.restrictions.push(r);
    out.map.areas.push({ kind, name, rings: rings(polys) });
  };
  for (const f of raw.sua) {
    const p = f.properties || {}, type = String(p.TYPE_CODE || '').toUpperCase(), polys = polygons(f.geometry);
    const floor = altText(p.LOWER_VAL, p.LOWER_UOM, p.LOWER_CODE), ceiling = altText(p.UPPER_VAL, p.UPPER_UOM, p.UPPER_CODE);
    if (type === 'P' || type === 'R') {
      const agl = floorAgl(p.LOWER_VAL, p.LOWER_UOM, p.LOWER_CODE, groundFt);
      restrict(type, type === 'P' ? 'prohibited area' : 'restricted area', p.NAME, polys,
        { floor, ceiling, times: p.TIMESOFUSE || null, relevant: agl == null || agl < PART_107_MAX_FT, note: type === 'R' && p.TIMESOFUSE ? `in use ${p.TIMESOFUSE}` : null });
    } else {
      // MOA, warning, alert areas: no sUAS restriction, shown for awareness.
      const rel = relate(polys, proj);
      if (rel.inside) out.other.push({ kind: type, name: p.NAME, floor, ceiling, times: p.TIMESOFUSE || null });
      out.map.areas.push({ kind: type, name: p.NAME, rings: rings(polys) });
    }
  }
  for (const f of raw.nsufr) {
    const p = f.properties || {};
    restrict('NSUFR', 'national security UAS flight restriction', (p.Facility || '').trim() || (p.Base || '').trim() || 'Federal facility', polygons(f.geometry),
      { floor: p.Floor || null, ceiling: p.Ceiling || null, note: '14 CFR 99.7' });
  }
  for (const f of raw.nsufrPartTime) {
    const p = f.properties || {}, start = Number(p.ACTIVETIME) || null, end = Number(p.ENDTIME) || null;
    const ended = end && end < now.getTime(), upcoming = start && start > now.getTime();
    restrict('NSUFR', 'part-time national security UAS flight restriction', (p.Facility || '').trim() || (p.Base || '').trim() || 'Federal facility', polygons(f.geometry),
      { floor: p.Floor || null, ceiling: p.Ceiling || null, relevant: !ended, insideLevel: upcoming ? 1 : 2,
        start: start && new Date(start).toISOString(), end: end && new Date(end).toISOString(),
        note: ended ? 'ended' : upcoming ? `activates ${new Date(start).toISOString().slice(0, 16)}Z` : '14 CFR 99.7' });
  }
  for (const f of raw.nda) {
    const p = f.properties || {};
    restrict('NDA', 'national defense airspace', p.NAME || 'National defense airspace', polygons(f.geometry));
  }
  const dDca = distanceNm(center, DCA);
  if (dDca <= DC_SFRA_NM + nearNm) {
    const frz = dDca <= DC_FRZ_NM, d = Math.round(dDca * 10) / 10;
    out.restrictions.push({ kind: 'DC', label: frz ? 'Flight Restricted Zone' : 'Special Flight Rules Area', name: frz ? 'Washington DC FRZ' : 'Washington DC SFRA',
      inside: dDca <= DC_SFRA_NM, distanceNm: dDca <= DC_SFRA_NM ? 0 : Math.round((dDca - DC_SFRA_NM) * 10) / 10, compass: compass(bearingDeg(center, DCA)), floor: 'SFC', ceiling: null });
    if (frz) flag(2, `Inside the Washington DC Flight Restricted Zone (${d} NM from DCA) — UAS flight needs FAA/TSA authorization`);
    else flag(1, `Washington DC SFRA (${d} NM from DCA) — special rules apply; FRZ starts ${Math.round((dDca - DC_FRZ_NM) * 10) / 10} NM ${compass(bearingDeg(center, DCA))}`);
    out.map.areas.push({ kind: 'DC', name: 'DC FRZ (approx.)', circle: { center: [DCA.lat, DCA.lon], rNm: DC_FRZ_NM } });
    out.map.areas.push({ kind: 'DC', name: 'DC SFRA (approx.)', circle: { center: [DCA.lat, DCA.lon], rNm: DC_SFRA_NM } });
  }
  out.restrictions.sort((a, b) => (a.distanceNm ?? 1e9) - (b.distanceNm ?? 1e9));

  for (const f of raw.stadiums) {
    const [lon, lat] = f.geometry?.coordinates || [];
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const p = f.properties || {}, d = Math.round(distanceNm(center, { lat, lon }) * 10) / 10;
    out.map.stadiums.push({ name: p.NAME, lat: r5(lat), lon: r5(lon) });
    if (d > STADIUM_NM) continue;
    out.stadiums.push({ name: p.NAME, city: p.CITY, distanceNm: d, compass: compass(bearingDeg(center, { lat, lon })), status: p.STATUS_CODE || null });
    // The event TFR is active only around games, so by default this is information, like
    // the other standing national restrictions; set thresholds.airspace.stadiumLevel to flag it.
    if (th.stadiumLevel) flag(th.stadiumLevel, `Stadium ${d} NM ${compass(bearingDeg(center, { lat, lon }))}: ${p.NAME} — stadium restriction (FDC 0/0367) during qualifying events`);
  }
  out.stadiums.sort((a, b) => a.distanceNm - b.distanceNm);
  return out;
}
