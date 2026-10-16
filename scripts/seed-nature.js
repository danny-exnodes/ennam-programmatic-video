// Nature physics demo: wind, falling leaves, flowing water, dew sliding on a
// leaf and dripping into the stream. Shot code lives in examples/nature/
// (common.js is inlined where a shot has `//@include common.js`).
// Also synthesizes an ambience track (wind gusts, stream, drop "plip").
// usage: npm run seed:nature   (server must be running)
import fs from 'node:fs';
import path from 'node:path';
import { run, FFMPEG } from '../server/media.js';
import { makeWind } from '../engine/fx/wind.js';
import { simulateDew } from '../engine/fx/dew.js';

const BASE = `http://127.0.0.1:${process.env.PORT || 5173}`;
const DIR = path.resolve('examples/nature');
const common = fs.readFileSync(path.join(DIR, 'common.js'), 'utf8');
const load = (f) => fs.readFileSync(path.join(DIR, f), 'utf8').replace('//@include common.js', common);

const shots = [
  { name: 'Suối trong gió', duration: 6, code: load('shot1.js'), transition: { type: 'cut' } },
  { name: 'Giọt sương trên lá', duration: 5.5, code: load('shot2.js'), transition: { type: 'dissolve', duration: 0.6 } },
  { name: 'Chạm mặt nước (slow-mo)', duration: 5, code: load('shot3.js'), transition: { type: 'dissolve', duration: 0.6 } },
];

// when does the drop hit the water inside shot 3? (same sim the shot uses)
const { WIND, LEAF } = new Function(common + ';return { WIND, LEAF };')();
const D = simulateDew(LEAF, makeWind({ until: 8, ...WIND }), 8);
const T0 = D.splashes[0]?.t ?? 4.5;
const shot3Start = shots[0].duration + shots[1].duration;
// shot 3 maps simT = T0 - 0.12 + 0.2 t  ->  impact at t = 0.6 s, jet drop ~ +0.16 s sim
const plip1 = shot3Start + 0.12 / 0.2;
const plip2 = shot3Start + (0.12 + (D.splashes[0]?.sec.t - T0 || 0.15)) / 0.2;
const total = shots.reduce((s, x) => s + x.duration, 0);

const OUT = path.resolve('data/demo-materials');
fs.mkdirSync(OUT, { recursive: true });
const audio = path.join(OUT, 'nature-ambience.mp3');
// wind: pink noise, low-passed, swelling with the scripted gusts of each shot
const gust = (t0) => `(0.35+0.65*exp(-pow((t-${t0})/1.1,2)))`;
const windVol = `0.55*max(${gust(1.0)},max(${gust(4.3)},max(${gust(6 + 1.1)},${gust(6 + 3.4)})))`;
await run(FFMPEG, [
  '-y',
  '-f', 'lavfi', '-i', `anoisesrc=color=pink:duration=${total}:seed=3:amplitude=0.6`,
  '-f', 'lavfi', '-i', `anoisesrc=color=brown:duration=${total}:seed=9:amplitude=0.5`,
  '-f', 'lavfi', '-i', `sine=f=1250:d=0.35`,
  '-f', 'lavfi', '-i', `sine=f=1700:d=0.25`,
  '-filter_complex', [
    `[0]lowpass=f=900,highpass=f=120,volume='${windVol}':eval=frame[w]`,
    `[1]bandpass=f=700:w=900,tremolo=f=7:d=0.25,volume=0.5[s]`,
    // slow-motion plips: pitch-dropped, decaying
    `[2]asetrate=44100*0.55,aresample=44100,afade=t=out:st=0:d=0.33,volume=0.9,adelay=${Math.round(plip1 * 1000)}|${Math.round(plip1 * 1000)}[p1]`,
    `[3]asetrate=44100*0.6,aresample=44100,afade=t=out:st=0:d=0.24,volume=0.5,adelay=${Math.round(plip2 * 1000)}|${Math.round(plip2 * 1000)}[p2]`,
    `[w][s][p1][p2]amix=inputs=4:normalize=0,aecho=0.6:0.5:60:0.2,alimiter=limit=0.9[a]`,
  ].join(';'),
  '-map', '[a]', '-t', String(total), '-b:a', '160k', audio,
]);

const j = async (r) => { const x = await r.json(); if (!r.ok) throw new Error(x.error); return x; };
const p = await j(await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Thiên nhiên: gió, lá, sương (demo vật lý)' }) }));
const fd = new FormData();
fd.append('files', new Blob([fs.readFileSync(audio)]), path.basename(audio));
let proj = (await j(await fetch(`${BASE}/api/projects/${p.id}/assets`, { method: 'POST', body: fd }))).project;
const music = proj.assets.find((a) => a.type === 'audio');
proj.shots = shots.map((s, i) => ({ id: 'n' + i, ...s }));
proj.style = { ...proj.style, grade: 'warm', bloom: 0.35, vignette: 0.28, grain: 0.03 };
if (music) proj.music = { assetId: music.id, volume: 0.9, fadeIn: 0.8, fadeOut: 1.2 };
await j(await fetch(`${BASE}/api/projects/${p.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(proj) }));
console.log('Nature demo:', p.id, `${BASE}/#p=${p.id}`, `(drop impact ${plip1.toFixed(2)}s)`);
