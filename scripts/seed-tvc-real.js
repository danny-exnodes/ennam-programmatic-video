// Én Nam 30 s TVC — "filmed" version built from real photos (s.photo) + code FX.
// Photos are prepared with scripts/photo/prep.py into <dir>/<name>.{jpg,depth.png,mask.png,flow.png}.
// usage: node scripts/seed-tvc-real.js <assetDir> [soundtrack.wav]
import fs from 'node:fs';
import path from 'node:path';
const BASE = `http://127.0.0.1:${process.env.PORT || 5173}`;
const DIR = path.resolve('examples/tvc-en-nam-real');
const common = fs.existsSync(path.join(DIR, 'common.js')) ? fs.readFileSync(path.join(DIR, 'common.js'), 'utf8') : '';
const load = (f) => fs.readFileSync(path.join(DIR, f), 'utf8').replace('//@include common.js', common);
const plan = JSON.parse(fs.readFileSync(path.join(DIR, 'plan.json'), 'utf8'));
const [assetDir, audio] = process.argv.slice(2);
const j = async (r) => { const x = await r.json(); if (!r.ok) throw new Error(x.error); return x; };
const p = await j(await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: plan.name }) }));
let proj;
const upload = async (file, name) => {
  const fd = new FormData();
  fd.append('files', new Blob([fs.readFileSync(file)]), path.basename(file));
  if (name) fd.append('name', name);
  proj = (await j(await fetch(`${BASE}/api/projects/${p.id}/assets`, { method: 'POST', body: fd }))).project;
};
for (const f of fs.readdirSync(assetDir).sort()) {
  if (!/\.(jpg|png)$/.test(f)) continue;
  await upload(path.join(assetDir, f), f.replace(/\.(jpg|png)$/, ''));
}
if (audio) {
  await upload(audio);
  const m = proj.assets.find((a) => a.type === 'audio');
  if (m) proj.music = { assetId: m.id, volume: 1, fadeIn: 0, fadeOut: 0.3 };
}
proj.shots = plan.shots.map(([f, name, duration, tr], i) => ({ id: 's' + (i + 1), name, duration, code: load(f), transition: i ? { type: tr, duration: 0.6 } : { type: 'cut' } }));
proj.style = { ...proj.style, ...plan.style };
proj.voice = plan.voice.map(([text, start], i) => ({ id: 'v' + i, text, start, duration: 3, assetId: null }));
await j(await fetch(`${BASE}/api/projects/${p.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(proj) }));
console.log(p.id);
