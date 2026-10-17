// Quick motion preview of one shot: node scripts/preview.js <projectId> <shotIndex> <out.mp4> [fps=15] [scale=0.5]
import { spawn } from 'node:child_process';
import { loadProject } from '../server/store.js';
import { openRenderPage, getBrowser } from '../server/render.js';
const [id, idx = '0', out = 'preview.mp4', fps = '15', scale = '0.5'] = process.argv.slice(2);
const p = await loadProject(id);
const shot = p.shots[Number(idx)];
const { page, close, logs } = await openRenderPage(p.id, { override: { ...p, shots: [shot] }, scale: Number(scale) });
const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', fps, '-i', '-', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', out], { stdio: ['pipe', 'inherit', 'inherit'] });
const n = Math.round(shot.duration * Number(fps));
for (let i = 0; i < n; i++) {
  const b64 = await page.evaluate((tt) => window.__frame(tt, 1), i / Number(fps));
  ff.stdin.write(Buffer.from(b64, 'base64'));
}
ff.stdin.end();
await new Promise((r) => ff.on('close', r));
console.log(logs.filter((l) => /error/i.test(l) && !/404/.test(l)).join('\n'));
await close();
(await getBrowser()).close();
