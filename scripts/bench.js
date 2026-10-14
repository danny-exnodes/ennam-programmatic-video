// Per-shot render timing. usage: node scripts/bench.js <projectId> [motionBlur=3] [scale=1]
import { loadProject } from '../server/store.js';
import { openRenderPage, getBrowser } from '../server/render.js';
const [id, mb = '3', scale = '1'] = process.argv.slice(2);
const p = await loadProject(id);
const { page, close } = await openRenderPage(p.id, { override: p, scale: Number(scale) });
let t0 = 0;
for (const [i, sh] of p.shots.entries()) {
  const times = [];
  for (const k of [0.3, 0.5, 0.8]) {
    const t = t0 + sh.duration * k;
    const s = Date.now();
    await page.evaluate(([tt, m]) => window.__frame(tt, m), [t, Number(mb)]);
    times.push(Date.now() - s);
  }
  console.log(`shot ${i + 1} ${sh.name}: ${times.join(' / ')} ms`);
  t0 += sh.duration;
}
await close();
(await getBrowser()).close();
