// Render a contact sheet of a project to a JPEG (for quick visual checks).
// usage: node scripts/sheet.js <projectId> [out.jpg] [framesPerShot]
import fs from 'node:fs';
import { loadProject } from '../server/store.js';
import { inspectProject, getBrowser } from '../server/render.js';

const [id, out = 'sheet.jpg', n = '3'] = process.argv.slice(2);
const p = await loadProject(id);
const r = await inspectProject(p, { framesPerShot: Number(n), thumbWidth: 640 });
if (r.sheet) fs.writeFileSync(out, Buffer.from(r.sheet, 'base64'));
console.log(JSON.stringify(r.errors, null, 1));
(await getBrowser()).close();
