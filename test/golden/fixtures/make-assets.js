// Generates the tiny synthetic photo plate used by the s.photo golden fixture:
//   valley.png (colour), valley.depth.png, valley.mask.png (R water, G sway, B sky),
//   valley.flow.png (B/G = flow direction, R = speed; 0.5 = neutral).
// Procedural and deterministic — no licensed photos. Re-run only if you change it:
//   node test/golden/fixtures/make-assets.js
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets');
const W = 256, H = 144;
fs.mkdirSync(OUT, { recursive: true });

// smooth value noise with a fixed hash (no Math.random)
const hash = (x, y) => { let h = (x * 374761393 + y * 668265263) | 0; h = (h ^ (h >>> 13)) * 1274126177; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
const vnoise = (x, y) => {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
};
const fbm = (x, y) => vnoise(x, y) * 0.55 + vnoise(x * 2.1, y * 2.1) * 0.3 + vnoise(x * 4.3, y * 4.3) * 0.15;
const mix = (a, b, k) => a + (b - a) * k;
const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));

const rgb = Buffer.alloc(W * H * 3), depth = Buffer.alloc(W * H), mask = Buffer.alloc(W * H * 3), flow = Buffer.alloc(W * H * 3);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const u = x / W, v = y / H, i = y * W + x;
    const ridge = 0.38 + 0.08 * Math.sin(u * 7.0) + 0.05 * fbm(u * 6, 1.3);   // far mountains
    const hill = 0.55 + 0.05 * Math.sin(u * 11 + 1) + 0.04 * fbm(u * 9, 4.1);   // tree line
    const riverTop = 0.72 + 0.03 * Math.sin(u * 5), riverBot = 0.9 + 0.025 * Math.sin(u * 4 + 2);
    let c, d, m = [0, 0, 0], f = [128, 128, 128];
    if (v < ridge) { // sky
      c = [mix(110, 238, v / ridge), mix(150, 226, v / ridge), mix(200, 196, v / ridge)];
      d = 0; m = [0, 0, 255];
    } else if (v < hill) { // misty mountains
      const n = fbm(u * 8, v * 8);
      c = [80 + 30 * n, 105 + 30 * n, 120 + 20 * n];
      d = 0.15 + 0.15 * (v - ridge) / (hill - ridge);
    } else if (v < riverTop || v > riverBot) { // forest / near bank
      const n = fbm(u * 22, v * 22);
      const near = v > riverBot;
      c = near ? [70 + 50 * n, 60 + 40 * n, 40 + 25 * n] : [30 + 40 * n, 70 + 60 * n, 32 + 30 * n];
      d = near ? 0.85 + 0.15 * (v - riverBot) / (1 - riverBot) : 0.35 + 0.3 * (v - hill) / (riverTop - hill);
      m = [0, near ? 0 : Math.round(200 * n + 55), 0];
    } else { // river
      const n = fbm(u * 30, v * 10);
      const s = 0.5 + 0.5 * Math.sin(u * 60 + n * 6);
      c = [60 + 70 * s * n, 100 + 70 * s * n, 120 + 80 * s * n];
      d = 0.65 + 0.2 * (v - riverTop) / (riverBot - riverTop);
      m = [255, 0, 0];
      f = [160, 128, 255]; // speed 1.25, direction +x
    }
    rgb[i * 3] = clamp(c[0]); rgb[i * 3 + 1] = clamp(c[1]); rgb[i * 3 + 2] = clamp(c[2]);
    depth[i] = clamp(d * 255);
    mask.set(m, i * 3); flow.set(f, i * 3);
  }
}
const png = (buf, ch, name) => sharp(buf, { raw: { width: W, height: H, channels: ch } }).png({ compressionLevel: 9, palette: false }).toFile(path.join(OUT, name));
await png(rgb, 3, 'valley.png');
await png(depth, 1, 'valley.depth.png');
await png(mask, 3, 'valley.mask.png');
await png(flow, 3, 'valley.flow.png');
for (const f of fs.readdirSync(OUT)) console.log(f, fs.statSync(path.join(OUT, f)).size, 'B');
