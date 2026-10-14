// Atmosphere & light: bokeh, dust motes, volumetric mist/smoke, bubbles,
// underwater caustics, god rays, glass sheen, lens flare, light leaks,
// and a general physical particle burst (solids, petals, powder, sparks).
import { clamp, rng, TAU, rgba, noise2, fbm, smoothstep, lerp, ease } from '../math.js';
import { resolveMaterial, drawDroplet } from '../materials.js';
import { simulate, sample } from './sim.js';

const offscreens = new Map();
export function offscreen(key, w, h) {
  let c = offscreens.get(key);
  if (!c || c.width !== w || c.height !== h) {
    c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
    offscreens.set(key, c);
  }
  return c;
}

/** Out-of-focus light orbs, drifting with parallax. */
export function bokeh(ctx, t, o = {}) {
  const W = (ctx.__W ?? ctx.canvas.width), H = (ctx.__H ?? ctx.canvas.height);
  const r = rng(o.seed ?? 11);
  const n = o.count ?? 24;
  const color = o.color ?? '#ffcf8a';
  const [minS, maxS] = o.size ?? [20, 90];
  const area = o.rect ?? [0, 0, W, H];
  ctx.save();
  ctx.globalCompositeOperation = o.blend ?? 'screen';
  for (let i = 0; i < n; i++) {
    const s = r.range(minS, maxS);
    const depth = r.range(0.3, 1);
    const x = area[0] + ((r() * area[2] + (o.drift ?? 18) * t * depth * r.sign()) % area[2] + area[2]) % area[2];
    const y = area[1] + ((r() * area[3] - (o.rise ?? 10) * t * depth) % area[3] + area[3]) % area[3];
    const tw = 0.6 + 0.4 * Math.sin(t * r.range(0.6, 1.6) + r() * TAU);
    const a = (o.opacity ?? 0.35) * tw * depth;
    const g = ctx.createRadialGradient(x, y, 0, x, y, s);
    g.addColorStop(0, rgba(color, a * 0.5));
    g.addColorStop(0.75, rgba(color, a * 0.35));
    g.addColorStop(0.92, rgba(color, a * 0.7)); // bright rim like real lens bokeh
    g.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, s, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

/** Tiny dust motes catching light, Brownian drift. */
export function dust(ctx, t, o = {}) {
  const W = (ctx.__W ?? ctx.canvas.width), H = (ctx.__H ?? ctx.canvas.height);
  const r = rng(o.seed ?? 5);
  const n = o.count ?? 80;
  const color = o.color ?? '#fff3dc';
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  for (let i = 0; i < n; i++) {
    const bx = r() * W, by = r() * H, s = r.range(0.6, 2.6) * (o.size ?? 1);
    const x = bx + noise2(i * 7.1, t * 0.25, 3) * 60 + t * (o.wind ?? 6);
    const y = by + noise2(i * 3.7, t * 0.25, 9) * 60 - t * (o.rise ?? 4);
    const fl = 0.5 + 0.5 * Math.sin(t * r.range(1, 4) + i);
    ctx.fillStyle = rgba(color, (o.opacity ?? 0.6) * fl);
    ctx.beginPath();
    ctx.arc(((x % W) + W) % W, ((y % H) + H) % H, s, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

/** Volumetric mist / smoke / steam: advected soft puffs that grow and fade. */
export function mist(ctx, t, o = {}) {
  const W = (ctx.__W ?? ctx.canvas.width), H = (ctx.__H ?? ctx.canvas.height);
  const x = o.x ?? W / 2, y = o.y ?? H;
  const r = rng(o.seed ?? 21);
  const rate = o.rate ?? 8; // puffs per second
  const life = o.life ?? 3.5;
  const color = o.color ?? '#ffffff';
  const spread = o.spread ?? 120;
  const vy = -(o.rise ?? 90), vx = o.wind ?? 15;
  const size = o.size ?? 80;
  const start = o.start ?? -life;
  ctx.save();
  ctx.globalCompositeOperation = o.blend ?? 'screen';
  const first = Math.floor(Math.max(start, t - life) * rate);
  const last = Math.floor(t * rate);
  for (let i = first; i <= last; i++) {
    const birth = i / rate;
    if (birth < start) continue;
    const age = t - birth;
    if (age < 0 || age > life) continue;
    const pr = rng(i * 7919 + (o.seed ?? 21));
    const k = age / life;
    const curlX = fbm(i * 0.37, age * 0.5, 4) * 80 * k;
    const px = x + pr.range(-spread, spread) * 0.5 + vx * age + curlX;
    const py = y + vy * age * (1 - 0.3 * k) + pr.range(-10, 10);
    const s = size * (0.4 + 1.6 * ease.outQuad(k)) * pr.range(0.7, 1.3);
    const a = (o.opacity ?? 0.12) * Math.sin(Math.PI * k) * pr.range(0.6, 1);
    const g = ctx.createRadialGradient(px, py, 0, px, py, s);
    g.addColorStop(0, rgba(color, a));
    g.addColorStop(0.6, rgba(color, a * 0.45));
    g.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(px, py, s, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
  void r;
}

/** Rising bubbles with wobble (in liquid or glass). */
export function bubbles(ctx, t, o = {}) {
  const [rx, ry, rw, rh] = o.rect ?? [0, 0, (ctx.__W ?? ctx.canvas.width), (ctx.__H ?? ctx.canvas.height)];
  const r = rng(o.seed ?? 31);
  const n = o.count ?? 40;
  const color = o.color ?? '#ffffff';
  ctx.save();
  if (o.clip) {
    ctx.beginPath();
    ctx.rect(rx, ry, rw, rh);
    ctx.clip();
  }
  for (let i = 0; i < n; i++) {
    const s = r.range(...(o.size ?? [2, 9]));
    // Stokes: rise speed ~ r^2 (bigger bubbles rise faster)
    const sp = (o.speed ?? 60) * (0.4 + (s / 9) ** 2 * 1.4);
    const ph = r();
    const yy = ry + rh - (((ph * rh + sp * t) % (rh + 40)));
    const xx = rx + r() * rw + Math.sin(t * r.range(2, 5) + i) * s * 0.8;
    ctx.strokeStyle = rgba(color, 0.55 * (o.opacity ?? 1));
    ctx.lineWidth = Math.max(0.7, s * 0.18);
    ctx.beginPath();
    ctx.ellipse(xx, yy, s, s * 0.92, 0, 0, TAU);
    ctx.stroke();
    ctx.fillStyle = rgba(color, 0.12 * (o.opacity ?? 1));
    ctx.fill();
    ctx.fillStyle = rgba(color, 0.85 * (o.opacity ?? 1));
    ctx.beginPath();
    ctx.arc(xx - s * 0.35, yy - s * 0.35, Math.max(0.6, s * 0.22), 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

/** Caustic light network (light refracted by a wavy liquid surface). */
export function caustics(ctx, t, o = {}) {
  const W = (ctx.__W ?? ctx.canvas.width), H = (ctx.__H ?? ctx.canvas.height);
  const [rx, ry, rw, rh] = o.rect ?? [0, 0, W, H];
  const lw = 192, lh = Math.max(32, Math.round((192 * rh) / rw));
  const c = offscreen('caustics', lw, lh);
  const cx = c.getContext('2d');
  const img = cx.createImageData(lw, lh);
  const sc = o.scale ?? 6;
  const sp = o.speed ?? 0.6;
  const col = hex3(o.color ?? '#fff2c8');
  for (let j = 0; j < lh; j++) {
    for (let i = 0; i < lw; i++) {
      const u = (i / lw) * sc, v = (j / lh) * sc * (lh / lw);
      let w = 0;
      w += Math.sin(u * 2.1 + t * sp * 1.3 + Math.sin(v * 1.7 + t * sp));
      w += Math.sin(v * 2.4 - t * sp * 1.1 + Math.sin(u * 1.3 - t * sp * 0.7));
      w += Math.sin((u + v) * 1.6 + t * sp * 0.9);
      const k = Math.pow(1 - Math.abs(Math.sin(w * 1.2)), 6);
      const o4 = (j * lw + i) * 4;
      img.data[o4] = col[0]; img.data[o4 + 1] = col[1]; img.data[o4 + 2] = col[2];
      img.data[o4 + 3] = k * 255;
    }
  }
  cx.putImageData(img, 0, 0);
  ctx.save();
  ctx.globalCompositeOperation = o.blend ?? 'screen';
  ctx.globalAlpha *= o.intensity ?? 0.35;
  ctx.filter = `blur(${o.softness ?? 2}px)`;
  ctx.drawImage(c, rx, ry, rw, rh);
  ctx.restore();
}
function hex3(h) {
  h = h.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((x) => x + x).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Volumetric god rays from a light source. */
export function lightRays(ctx, t, o = {}) {
  const W = (ctx.__W ?? ctx.canvas.width), H = (ctx.__H ?? ctx.canvas.height);
  const x = o.x ?? W * 0.2, y = o.y ?? -50;
  const r = rng(o.seed ?? 41);
  const n = o.count ?? 9;
  const len = o.length ?? H * 1.6;
  const color = o.color ?? '#ffe2a8';
  const dir = o.angle ?? Math.PI / 2.6;
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  for (let i = 0; i < n; i++) {
    const a = dir + r.range(-0.45, 0.45) + Math.sin(t * 0.2 + i) * 0.015;
    const w = r.range(0.02, 0.07);
    const al = (o.opacity ?? 0.18) * (0.5 + 0.5 * Math.sin(t * r.range(0.3, 0.9) + i * 2));
    const g = ctx.createLinearGradient(x, y, x + Math.cos(a) * len, y + Math.sin(a) * len);
    g.addColorStop(0, rgba(color, al));
    g.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a - w) * len, y + Math.sin(a - w) * len);
    ctx.lineTo(x + Math.cos(a + w) * len, y + Math.sin(a + w) * len);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/**
 * Glossy sheen sweeping across a surface (glass bottle, foil, metal).
 * If `image` is given, the sheen is masked to that image's alpha.
 */
export function sheen(ctx, t, o = {}) {
  const [x, y, w, h] = o.rect ?? [0, 0, (ctx.__W ?? ctx.canvas.width), (ctx.__H ?? ctx.canvas.height)];
  const p = o.progress ?? ((t - (o.start ?? 0)) / (o.duration ?? 1.2));
  if (p <= 0 || p >= 1) return;
  const ang = o.angle ?? -0.5;
  const bw = (o.width ?? 0.18) * w;
  const c = offscreen('sheen', Math.max(1, Math.ceil(w)), Math.max(1, Math.ceil(h)));
  const cx = c.getContext('2d');
  cx.setTransform(1, 0, 0, 1, 0, 0);
  cx.clearRect(0, 0, c.width, c.height);
  if (o.image) {
    cx.drawImage(o.image, 0, 0, w, h);
    cx.globalCompositeOperation = 'source-in';
  }
  const pos = lerp(-0.3 * w - bw, w * 1.3 + bw, ease.inOutCubic(p));
  cx.translate(pos, h / 2);
  cx.rotate(ang);
  const g = cx.createLinearGradient(-bw, 0, bw, 0);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.5, rgba(o.color ?? '#ffffff', o.intensity ?? 0.8));
  g.addColorStop(1, 'rgba(255,255,255,0)');
  cx.fillStyle = g;
  cx.fillRect(-bw, -h * 2, bw * 2, h * 4);
  cx.globalCompositeOperation = 'source-over';
  cx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  ctx.drawImage(c, x, y, w, h);
  ctx.restore();
}

/** Anamorphic lens flare. */
export function lensFlare(ctx, t, o = {}) {
  const W = (ctx.__W ?? ctx.canvas.width), H = (ctx.__H ?? ctx.canvas.height);
  const x = o.x ?? W * 0.7, y = o.y ?? H * 0.3;
  const k = o.intensity ?? 0.7;
  const color = o.color ?? '#ffd59a';
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  const g = ctx.createRadialGradient(x, y, 0, x, y, H * 0.25);
  g.addColorStop(0, rgba('#ffffff', 0.9 * k));
  g.addColorStop(0.1, rgba(color, 0.5 * k));
  g.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = g;
  ctx.fillRect(x - H * 0.25, y - H * 0.25, H * 0.5, H * 0.5);
  // horizontal streak
  const sg = ctx.createLinearGradient(x - W * 0.6, y, x + W * 0.6, y);
  sg.addColorStop(0, rgba(color, 0));
  sg.addColorStop(0.5, rgba('#fff8e8', 0.55 * k));
  sg.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = sg;
  ctx.fillRect(x - W * 0.6, y - 2.5, W * 1.2, 5);
  // ghosts along the axis through the center
  const cx = W / 2, cy = H / 2;
  [0.4, 0.75, 1.3, 1.7].forEach((f, i) => {
    const gx = x + (cx - x) * f * 2, gy = y + (cy - y) * f * 2;
    const rr = H * (0.02 + 0.03 * i);
    const gg = ctx.createRadialGradient(gx, gy, 0, gx, gy, rr);
    gg.addColorStop(0, rgba(i % 2 ? '#9fd4ff' : color, 0.12 * k));
    gg.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = gg;
    ctx.beginPath();
    ctx.arc(gx, gy, rr, 0, TAU);
    ctx.fill();
  });
  ctx.restore();
  void t;
}

/** Warm film light leak drifting across frame. */
export function lightLeak(ctx, t, o = {}) {
  const W = (ctx.__W ?? ctx.canvas.width), H = (ctx.__H ?? ctx.canvas.height);
  const k = o.intensity ?? 0.35;
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  const x = W * (0.1 + 0.8 * (0.5 + 0.5 * Math.sin(t * 0.35 + (o.seed ?? 0))));
  const y = H * (0.2 + 0.3 * Math.cos(t * 0.27));
  const g = ctx.createRadialGradient(x, y, 0, x, y, W * 0.6);
  g.addColorStop(0, rgba(o.color ?? '#ff9a3c', 0.6 * k));
  g.addColorStop(0.5, rgba(o.color2 ?? '#ff4f6d', 0.2 * k));
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

/**
 * Physical particle burst. kind: 'droplet' | 'image' | 'confetti' | 'petal' | 'powder' | 'spark'
 * Gravity, drag, turbulence, floor bounce (restitution/friction), spin.
 * Coordinates in px, y down. Deterministic.
 */
export function burst(ctx, t, o = {}) {
  const x = o.x ?? 960, y = o.y ?? 540;
  const start = o.start ?? 0;
  const kind = o.kind ?? 'droplet';
  const count = o.count ?? 30;
  const speed = o.speed ?? [400, 1100];
  const angle = o.angle ?? -Math.PI / 2;
  const spread = o.spread ?? Math.PI * 0.8;
  const size = o.size ?? [4, 14];
  const gravity = o.gravity ?? 2200;
  const floorY = o.floorY;
  const key = 'burst:' + JSON.stringify([x, y, start, kind, count, speed, angle, spread, size, gravity, floorY, o.seed, o.drag, o.restitution, o.turbulence, o.depth]);
  const sim = simulate(key, () => {
    const r = rng(o.seed ?? 9);
    const particles = [];
    for (let i = 0; i < count; i++) {
      const a = angle + r.range(-spread / 2, spread / 2);
      const sp = r.range(speed[0], speed[1]);
      const z = o.depth ? r.range(-1, 1) : 0;
      particles.push({
        t0: start + r.range(0, o.stagger ?? 0.05),
        // world: y up -> store -y
        p: [x, -y, z], v: [Math.cos(a) * sp, -Math.sin(a) * sp, 0],
        r: r.range(size[0], size[1]), life: o.life ?? 4,
        spin: r.range(-1, 1) * (o.spin ?? 6), rot0: r.range(0, TAU), hue: r(), flip: r.range(2, 9),
        dragMul: kind === 'petal' || kind === 'confetti' ? 3.5 : kind === 'powder' ? 6 : 1,
      });
    }
    return {
      particles,
      gravity: [0, -gravity, 0],
      drag: o.drag ?? 0.6,
      turbulence: o.turbulence ? { amp: o.turbulence, scale: 0.004 } : null,
      floor: floorY != null ? { y: -floorY, mode: kind === 'droplet' && o.absorb !== false ? 'absorb' : 'bounce', restitution: o.restitution ?? 0.35, friction: o.friction ?? 0.8 } : { mode: 'none' },
      duration: o.life ?? 4,
    };
  });
  const mat = resolveMaterial(o.material);
  const img = o.image;
  const colors = o.colors ?? ['#ffd27a', '#ffffff', '#f08a12'];
  ctx.save();
  for (const p of sim.list) {
    const st = sample(p, t);
    if (!st) continue;
    const px = st.x, py = -st.y;
    const fade = o.fade === false ? 1 : clamp(1 - Math.max(0, st.lifeK - 0.75) * 4);
    const ds = 1 + st.z * 0.35;
    if (kind === 'droplet') {
      drawDroplet(ctx, px, py, p.r * ds, mat, { vx: st.vx, vy: -st.vy, alpha: fade, light: o.light });
    } else if (kind === 'image' && img) {
      const rot = p.rot0 + p.spin * st.age;
      const s = p.r * 2 * ds;
      const ar = (img.naturalWidth || img.width) / (img.naturalHeight || img.height) || 1;
      ctx.save();
      ctx.globalAlpha *= fade;
      ctx.translate(px, py);
      ctx.rotate(rot);
      if (o.motionBlur !== false) ctx.filter = `blur(${Math.min(6, Math.hypot(st.vx, st.vy) / 400)}px)`;
      ctx.drawImage(img, (-s * ar) / 2, -s / 2, s * ar, s);
      ctx.restore();
    } else if (kind === 'confetti' || kind === 'petal') {
      const rot = p.rot0 + p.spin * st.age;
      const flip = Math.cos(st.age * p.flip);
      ctx.save();
      ctx.globalAlpha *= fade;
      ctx.translate(px, py);
      ctx.rotate(rot);
      ctx.scale(1, flip);
      ctx.fillStyle = colors[Math.floor(p.hue * colors.length)];
      if (kind === 'petal') {
        ctx.beginPath();
        ctx.ellipse(0, 0, p.r, p.r * 0.55, 0, 0, TAU);
        ctx.fill();
      } else ctx.fillRect(-p.r / 2, -p.r / 4, p.r, p.r / 2);
      ctx.restore();
    } else if (kind === 'powder') {
      const s = p.r * (1 + st.age * 2.5);
      const g = ctx.createRadialGradient(px, py, 0, px, py, s);
      const c = colors[Math.floor(p.hue * colors.length)];
      g.addColorStop(0, rgba(c, 0.35 * fade));
      g.addColorStop(1, rgba(c, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(px, py, s, 0, TAU);
      ctx.fill();
    } else if (kind === 'spark') {
      ctx.strokeStyle = rgba(colors[Math.floor(p.hue * colors.length)], fade);
      ctx.lineWidth = p.r * 0.3;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px - st.vx * 0.02, py + st.vy * 0.02);
      ctx.stroke();
    }
  }
  ctx.restore();
  return sim.events.map((e) => ({ t: e.t, x: e.x, y: -e.y }));
}

export { smoothstep };
