// Create a demo project with procedurally drawn materials (serum bottle PNG,
// orange slice PNG, studio backdrop) + a synthesized ambient music bed,
// then build the "product-ad" recipe. usage: npm run seed (server must be running)
import fs from 'node:fs';
import path from 'node:path';
import { getBrowser } from '../server/render.js';
import { run, FFMPEG } from '../server/media.js';

const BASE = `http://127.0.0.1:${process.env.PORT || 5173}`;
const OUT = path.resolve('data/demo-materials');
fs.mkdirSync(OUT, { recursive: true });

const b = await getBrowser();
const pg = await b.newPage();
await pg.goto(`${BASE}/render.html?override=1`);
async function draw(name, w, hgt, fnSrc, type = 'image/png') {
  const b64 = await pg.evaluate(async ([w, h, src, type]) => {
    await document.fonts.load('800 40px "Be Vietnam Pro"');
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    new Function('ctx', 'W', 'H', src)(ctx, w, h);
    return c.toDataURL(type, 0.92).split(',')[1];
  }, [w, hgt, fnSrc, type]);
  const f = path.join(OUT, name);
  fs.writeFileSync(f, Buffer.from(b64, 'base64'));
  return f;
}

const bottle = await draw('hero.png', 700, 1400, `
  const cx = W / 2;
  // glass body
  const bw = 420, top = 520, bot = 1360, r = 70;
  const glass = ctx.createLinearGradient(cx - bw/2, 0, cx + bw/2, 0);
  glass.addColorStop(0, '#3a1a04'); glass.addColorStop(0.18, '#a3570f'); glass.addColorStop(0.35, '#e08a22');
  glass.addColorStop(0.5, '#c8701a'); glass.addColorStop(0.8, '#7a3a08'); glass.addColorStop(1, '#2a1002');
  ctx.fillStyle = glass;
  ctx.beginPath();
  ctx.moveTo(cx - 90, top - 60); ctx.lineTo(cx + 90, top - 60);
  ctx.quadraticCurveTo(cx + bw/2, top - 40, cx + bw/2, top + 60);
  ctx.lineTo(cx + bw/2, bot - r); ctx.quadraticCurveTo(cx + bw/2, bot, cx + bw/2 - r, bot);
  ctx.lineTo(cx - bw/2 + r, bot); ctx.quadraticCurveTo(cx - bw/2, bot, cx - bw/2, bot - r);
  ctx.lineTo(cx - bw/2, top + 60); ctx.quadraticCurveTo(cx - bw/2, top - 40, cx - 90, top - 60);
  ctx.closePath(); ctx.fill();
  // liquid level line + inner glow
  const g2 = ctx.createRadialGradient(cx - 40, 900, 20, cx, 950, 300);
  g2.addColorStop(0, 'rgba(255,214,130,0.55)'); g2.addColorStop(1, 'rgba(255,214,130,0)');
  ctx.fillStyle = g2; ctx.fillRect(cx - bw/2, top, bw, bot - top);
  // highlights
  ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.fillRect(cx - bw/2 + 34, top + 40, 16, bot - top - 140);
  ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.fillRect(cx - bw/2 + 64, top + 60, 8, bot - top - 200);
  ctx.fillStyle = 'rgba(255,255,255,0.22)'; ctx.fillRect(cx + bw/2 - 50, top + 80, 10, bot - top - 220);
  // label
  ctx.fillStyle = 'rgba(250,244,234,0.94)'; ctx.fillRect(cx - bw/2 + 20, 820, bw - 40, 330);
  ctx.fillStyle = '#2a1404'; ctx.textAlign = 'center';
  ctx.font = '800 76px "Be Vietnam Pro"'; ctx.fillText('LUMI C+', cx, 925);
  ctx.font = '600 30px "Be Vietnam Pro"'; ctx.fillStyle = '#c0650f'; ctx.fillText('15% VITAMIN C SERUM', cx, 985);
  ctx.fillStyle = '#6b5a4a'; ctx.font = '400 24px "Be Vietnam Pro"'; ctx.fillText('Sáng da · Mờ thâm · Dịu nhẹ', cx, 1040);
  ctx.fillText('30 ml', cx, 1110);
  // neck + collar
  const col = ctx.createLinearGradient(cx - 110, 0, cx + 110, 0);
  col.addColorStop(0, '#6b5a2a'); col.addColorStop(0.35, '#f6e2a0'); col.addColorStop(0.55, '#c8a650'); col.addColorStop(1, '#4a3a14');
  ctx.fillStyle = col; ctx.fillRect(cx - 110, 360, 220, 120);
  ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(cx - 110, 470, 220, 10);
  // rubber bulb
  const bulb = ctx.createLinearGradient(cx - 90, 0, cx + 90, 0);
  bulb.addColorStop(0, '#120a06'); bulb.addColorStop(0.35, '#4a3a30'); bulb.addColorStop(0.6, '#1e140e'); bulb.addColorStop(1, '#050302');
  ctx.fillStyle = bulb; ctx.beginPath();
  ctx.moveTo(cx - 85, 365); ctx.bezierCurveTo(cx - 95, 160, cx - 70, 40, cx, 40); ctx.bezierCurveTo(cx + 70, 40, cx + 95, 160, cx + 85, 365); ctx.closePath(); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.beginPath(); ctx.ellipse(cx - 35, 170, 12, 90, -0.05, 0, Math.PI*2); ctx.fill();
`);

const orange = await draw('splash.png', 900, 900, `
  const cx = W/2, cy = H/2, R = 400;
  ctx.fillStyle = '#e8790c'; ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI*2); ctx.fill();
  ctx.fillStyle = '#fff3d6'; ctx.beginPath(); ctx.arc(cx, cy, R - 26, 0, Math.PI*2); ctx.fill();
  for (let i = 0; i < 11; i++) {
    const a0 = i / 11 * Math.PI * 2 + 0.05, a1 = (i + 1) / 11 * Math.PI * 2 - 0.05;
    const g = ctx.createRadialGradient(cx, cy, 20, cx, cy, R - 40);
    g.addColorStop(0, '#ffd48a'); g.addColorStop(0.6, '#ffa21f'); g.addColorStop(1, '#f07c0a');
    ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(cx + Math.cos((a0+a1)/2) * 30, cy + Math.sin((a0+a1)/2) * 30);
    ctx.arc(cx, cy, R - 44, a0, a1); ctx.closePath(); ctx.fill();
    for (let k = 0; k < 14; k++) {
      const rr = 80 + k * 20, aa = a0 + (a1 - a0) * ((k * 37) % 10) / 10;
      ctx.fillStyle = 'rgba(255,240,200,0.45)'; ctx.beginPath(); ctx.ellipse(cx + Math.cos(aa) * rr, cy + Math.sin(aa) * rr, 8, 3, aa, 0, Math.PI*2); ctx.fill();
    }
  }
  ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.beginPath(); ctx.ellipse(cx - 160, cy - 180, 70, 22, -0.7, 0, Math.PI*2); ctx.fill();
`);

const bg = await draw('bg.jpg', 1920, 1080, `
  const g = ctx.createRadialGradient(W*0.55, H*0.45, 50, W*0.5, H*0.5, W*0.75);
  g.addColorStop(0, '#6b3c12'); g.addColorStop(0.45, '#2e1806'); g.addColorStop(1, '#080402');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  // wooden-ish table plane
  const t = ctx.createLinearGradient(0, H*0.72, 0, H);
  t.addColorStop(0, '#3a2210'); t.addColorStop(1, '#120904');
  ctx.fillStyle = t; ctx.fillRect(0, H*0.72, W, H*0.28);
  for (let i = 0; i < 40; i++) {
    const x = (i * 397) % W, y = (i * 233) % (H * 0.6), r = 20 + (i * 13) % 70;
    const b = ctx.createRadialGradient(x, y, 0, x, y, r);
    b.addColorStop(0, 'rgba(255,190,110,0.12)'); b.addColorStop(1, 'rgba(255,190,110,0)');
    ctx.fillStyle = b; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI*2); ctx.fill();
  }
`, 'image/jpeg');
await b.close();

// ambient music bed (warm pad chord + soft pulse), 30s
const music = path.join(OUT, 'music.mp3');
await run(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'sine=f=220:d=30', '-f', 'lavfi', '-i', 'sine=f=277.18:d=30', '-f', 'lavfi', '-i', 'sine=f=329.63:d=30', '-f', 'lavfi', '-i', 'sine=f=110:d=30',
  '-filter_complex', '[0][1][2][3]amix=inputs=4,volume=1.6,tremolo=f=2:d=0.35,aecho=0.8:0.7:120:0.35,lowpass=f=2400[a]', '-map', '[a]', '-b:a', '160k', music]);

// create project + upload + recipe
const j = async (r) => { const x = await r.json(); if (!r.ok) throw new Error(x.error); return x; };
const p = await j(await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Lumi C+ (demo)' }) }));
const fd = new FormData();
for (const f of [bottle, orange, bg, music]) fd.append('files', new Blob([fs.readFileSync(f)]), path.basename(f));
let proj = (await j(await fetch(`${BASE}/api/projects/${p.id}/assets`, { method: 'POST', body: fd }))).project;
const desc = { hero: 'Chai serum Lumi C+ 30ml, nền trong suốt', splash: 'Lát cam tươi, nền trong suốt', bg: 'Phông studio ấm, mặt bàn gỗ' };
for (const a of proj.assets) if (desc[a.name]) proj = await j(await fetch(`${BASE}/api/projects/${p.id}/assets/${a.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ desc: desc[a.name] }) }));
proj = await j(await fetch(`${BASE}/api/projects/${p.id}/template`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ template: 'product-ad', material: 'serum' }) }));
proj.voice = [
  ['Làn da mệt mỏi, thiếu sức sống?', 0.6, 2.4],
  ['Lumi C cộng, với 15% Vitamin C nguyên chất.', 4.2, 3.0],
  ['Thẩm thấu nhanh, cho làn da sáng mịn.', 8.0, 2.8],
  ['Rạng rỡ mỗi sáng, tươi tắn mỗi ngày.', 11.6, 2.8],
  ['Lumi C cộng. Đặt ngay hôm nay.', 15.0, 2.5],
].map(([text, start, duration], i) => ({ id: 'v' + i, text, start, duration, assetId: null }));
await j(await fetch(`${BASE}/api/projects/${p.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(proj) }));
console.log('Demo project:', p.id, `${BASE}/#p=${p.id}`);
