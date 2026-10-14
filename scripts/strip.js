// Filmstrip of ONE shot at many times — for tuning physics/fx.
// usage: node scripts/strip.js <projectId> <shotIndex> [frames=8] [out.jpg]
import fs from 'node:fs';
import { loadProject } from '../server/store.js';
import { inspectProject, getBrowser } from '../server/render.js';
const [id, idx = '0', n = '8', out = 'strip.jpg'] = process.argv.slice(2);
const p = await loadProject(id);
const shot = p.shots[Number(idx)];
const frames = Number(n);
const q = { ...p, shots: [shot] };
const r = await inspectProject(q, { framesPerShot: frames, thumbWidth: 480 });
if (r.sheet) fs.writeFileSync(out, Buffer.from(r.sheet, 'base64'));
console.log(JSON.stringify(r.errors));
(await getBrowser()).close();
