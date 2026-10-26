// Vercel function behind /api/data?zip=NNNNN (and /data.json, see vercel.json). Runs the
// same pipeline as the GitHub Action, on demand; Vercel's CDN caches the result per URL
// so upstream APIs are hit at most about once per CACHE_S per ZIP per region.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { run } from '../scripts/fetch.mjs';
import { lookupZip, configForZip } from '../scripts/location.mjs';

const CACHE_S = 300;
const ROOT = process.cwd();
const baseConfig = JSON.parse(readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

export async function GET(request) {
  const zip = new URL(request.url).searchParams.get('zip');
  let cfg = baseConfig;
  if (zip != null) {
    const loc = lookupZip(zip, ROOT);
    if (!loc) {
      return Response.json({ error: 'unknown ZIP', zip }, {
        status: 404,
        headers: { 'Cache-Control': 'no-cache', 'Vercel-CDN-Cache-Control': 'max-age=86400' },
      });
    }
    cfg = configForZip(baseConfig, loc);
  }
  try {
    const data = await run({ cfg, out: null, fixtures: null, now: null, sampleAge: null, fail: [], sharedCacheMs: CACHE_S * 1000 });
    return Response.json(data, {
      headers: {
        'Cache-Control': 'no-cache',
        // Serve a slightly old copy while refreshing; worst case ~15 min old, under the 30 min DATA STALE limit.
        'Vercel-CDN-Cache-Control': `max-age=${CACHE_S}, stale-while-revalidate=${2 * CACHE_S}`,
      },
    });
  } catch (e) {
    // Only config errors reach here; source failures are recorded inside data.
    console.error(e);
    return Response.json({ error: String(e.message || e) }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
}
