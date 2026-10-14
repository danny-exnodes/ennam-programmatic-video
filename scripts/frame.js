// Render single shot frames at full res: node scripts/frame.js <projectId> <shotIndex> <t1,t2,...> <outPrefix>
import fs from 'node:fs';
import { loadProject } from '../server/store.js';
import { openRenderPage, getBrowser } from '../server/render.js';
const [id, idx = '0', ts = '1', out = 'frame'] = process.argv.slice(2);
const p = await loadProject(id);
const shot = p.shots[Number(idx)];
const { page, close, logs } = await openRenderPage(p.id, { override: { ...p, shots: [shot] }, scale: 1 });
for (const t of ts.split(',').map(Number)) {
  const b64 = await page.evaluate((tt) => window.__frame(tt, 1), t);
  fs.writeFileSync(`${out}-${t}.jpg`, Buffer.from(b64, 'base64'));
}
console.log(logs.filter((l) => /error/i.test(l)).join('\n'));
await close();
(await getBrowser()).close();
