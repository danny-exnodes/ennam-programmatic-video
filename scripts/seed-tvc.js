// Én Nam 30 s TVC demo project (6 shots, 1920×1080, 30 fps) built from
// examples/tvc-en-nam. Optional: pass a soundtrack .wav/.mp3 as music
// (see scripts/audio/build_tvc_audio.sh). usage: node scripts/seed-tvc.js [soundtrack]
import fs from 'node:fs';
import path from 'node:path';
const BASE = `http://127.0.0.1:${process.env.PORT || 5173}`;
const DIR = path.resolve('examples/tvc-en-nam');
const common = fs.readFileSync(path.join(DIR, 'common.js'), 'utf8');
const load = (f) => fs.readFileSync(path.join(DIR, f), 'utf8').replace('//@include common.js', common);
const plan = [
  ['s1-binh-minh.js', 'Bình minh đại ngàn', 5, 'cut'],
  ['s2-dong-suoi.js', 'Dòng suối', 5, 'dissolve'],
  ['s3-giot-suong.js', 'Giọt sương', 4.5, 'dissolve'],
  ['s4-cham-mat-nuoc.js', 'Chạm mặt nước', 4, 'dissolve'],
  ['s5-san-pham.js', 'Én Nam bên suối', 7, 'dissolve'],
  ['s6-packshot.js', 'Packshot', 4.5, 'dissolve'],
];
const j = async (r) => { const x = await r.json(); if (!r.ok) throw new Error(x.error); return x; };
const p = await j(await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'TVC Én Nam 30s' }) }));
let proj = await j(await fetch(`${BASE}/api/projects/${p.id}`));
const audio = process.argv[2];
if (audio) {
  const fd = new FormData();
  fd.append('files', new Blob([fs.readFileSync(audio)]), path.basename(audio));
  proj = (await j(await fetch(`${BASE}/api/projects/${p.id}/assets`, { method: 'POST', body: fd }))).project;
  const m = proj.assets.find((a) => a.type === 'audio');
  if (m) proj.music = { assetId: m.id, volume: 1, fadeIn: 0, fadeOut: 0.3 };
}
proj.shots = plan.map(([f, name, duration, tr], i) => ({ id: 's' + (i + 1), name, duration, code: load(f), transition: i ? { type: tr, duration: 0.6 } : { type: 'cut' } }));
proj.style = { ...proj.style, grade: 'clean', bloom: 0.3, vignette: 0.22, grain: 0.02 };
proj.voice = [
  ['Giữa đại ngàn xanh thẳm,', 0.8], ['dòng nước trong lành được rừng núi chắt lọc qua bao tầng đá.', 5.6],
  ['Từng giọt tinh khiết,', 10.6], ['giữ trọn sức sống của thiên nhiên.', 15.6],
  ['Én Nam, nước khoáng thiên nhiên, tinh khiết từ đại ngàn.', 19.5], ['Én Nam. Trong lành mỗi ngày.', 26.1],
].map(([text, start], i) => ({ id: 'v' + i, text, start, duration: 3, assetId: null }));
await j(await fetch(`${BASE}/api/projects/${p.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(proj) }));
console.log('TVC project:', p.id, `${BASE}/#p=${p.id}`);
