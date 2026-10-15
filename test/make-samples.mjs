// Builds samples/*.json by running fetch.mjs against the synthetic fixtures.
import { run } from '../scripts/fetch.mjs';
const now = new Date('2026-10-15T17:50:00Z');
const base = ['test/fixtures/base'];
const samples = [
  { out: 'samples/data-caution.json', fixtures: base, sampleAge: 4 },
  { out: 'samples/data-nogo.json', fixtures: ['test/fixtures/nogo', ...base], sampleAge: 2 },
  { out: 'samples/data-stale.json', fixtures: base, sampleAge: 47 },
  { out: 'samples/data-partial.json', fixtures: base, sampleAge: 6, fail: ['nws_points', 'kp', 'tfr_detail'] },
];
for (const s of samples) {
  const d = await run({ config: 'config.json', now, fail: [], ...s });
  console.log(s.out, d.overall.level, Object.entries(d.sources).filter(([, v]) => !v.ok).map(([k]) => k).join(',') || 'all ok');
}
