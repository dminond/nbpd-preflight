// Vercel function behind /data.json (see vercel.json). Runs the same pipeline as the
// GitHub Action, on demand; Vercel's CDN caches the result so upstream APIs are hit
// at most about once per CACHE_S per region rather than once per page poll.
import path from 'node:path';
import { run } from '../scripts/fetch.mjs';

const CACHE_S = 300;

export async function GET() {
  try {
    const data = await run({ config: path.join(process.cwd(), 'config.json'), out: null, fixtures: null, now: null, sampleAge: null, fail: [] });
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
