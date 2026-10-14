// Liquid physics: falling drop -> crown splash (Rayleigh–Plateau rim
// instability, spike pinch-off, secondary spray) -> collapse -> Worthington
// jet -> capillary ripples. Droplets are integrated with gravity + drag and
// spawn ripples where they land. Material controls both motion and optics.
import { clamp, smoothstep, rng, TAU, rgba, shade, ease } from '../math.js';
import { resolveMaterial, drawDroplet } from '../materials.js';
import { simulate, sample } from './sim.js';

function keyOf(o) {
  return JSON.stringify(o, (k, v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v));
}

const crownCache = new Map();
function buildCrown(opts) {
  const key = keyOf({ ...opts, mat: [opts.mat.viscosity, opts.mat.surfaceTension, opts.mat.density] });
  let c = crownCache.get(key);
  if (!c) {
    c = buildCrownUncached(opts);
    crownCache.set(key, c);
    if (crownCache.size > 100) crownCache.delete(crownCache.keys().next().value);
  }
  return c;
}
function buildCrownUncached(opts) {
  const mat = opts.mat;
  const r = rng(opts.seed);
  const visc = mat.viscosity;
  const energy = opts.energy;
  const g = opts.gravity;
  const H = (0.75 + 0.6 * energy) * (1 - 0.35 * visc); // sheet peak height (R units)
  const vRise = Math.sqrt(2 * g * H);
  const T = (2 * vRise) / g; // sheet lifetime
  const N = Math.round(opts.spikes ?? (26 - 12 * visc) * (0.8 + 0.4 * energy));
  const spikes = [];
  for (let i = 0; i < N; i++) {
    const theta = (i / N) * TAU + r.range(-0.35, 0.35) * (TAU / N);
    spikes.push({
      theta,
      k: r.range(0.3, 0.75) * (1 - 0.3 * visc),
      w: r.range(0.035, 0.06) * (1 + visc * 0.6),
      tp: r.range(0.16, 0.42) * T * (1 + visc * 0.5),
      rd: r.range(0.035, 0.065) * (1 + visc * 0.9),
      extra: r.range(0.1, 0.5),
      wobble: r.range(0, TAU),
    });
  }
  const particles = [];
  // droplets released from spike tips at pinch-off
  for (const s of spikes) {
    const tip = crownTip(s, s.tp, { H, vRise, g, T, spread: opts.spread });
    const outV = 1.1 + s.extra * 1.4;
    const upV = Math.max(0.6, vRise - g * s.tp) * (0.85 + s.extra * 0.6) + 0.6;
    particles.push({
      t0: opts.start + s.tp,
      p: [tip.x, tip.y, tip.z],
      v: [Math.cos(s.theta) * outV, upV, Math.sin(s.theta) * outV],
      r: s.rd, life: 3.5, kind: 'tip',
    });
    // occasional satellite droplet
    if (r() < 0.55 - visc * 0.4) {
      particles.push({
        t0: opts.start + s.tp + 0.03,
        p: [tip.x * 0.98, tip.y - 0.04, tip.z * 0.98],
        v: [Math.cos(s.theta) * outV * 0.8, upV * 0.85, Math.sin(s.theta) * outV * 0.8],
        r: s.rd * 0.45, life: 3.5, kind: 'sat',
      });
    }
  }
  // prompt splash: fine spray ejected at impact from the contact line
  const spray = Math.round((opts.spray ?? 1) * (70 - 55 * visc) * energy);
  for (let i = 0; i < spray; i++) {
    const th = r.range(0, TAU);
    const sp = r.range(1.6, 3.6) * (0.7 + 0.5 * energy);
    const el = r.range(0.35, 1.1);
    particles.push({
      t0: opts.start + r.range(0, 0.06),
      p: [Math.cos(th) * 0.3, 0.02, Math.sin(th) * 0.3],
      v: [Math.cos(th) * sp * Math.cos(el), sp * Math.sin(el), Math.sin(th) * sp * Math.cos(el)],
      r: r.range(0.008, 0.028), life: 3, kind: 'spray',
    });
  }
  // Worthington jet top droplet
  const jetV = (1.6 + 1.8 * energy) * (1 - 0.4 * visc);
  const tj0 = opts.start + T * 0.92;
  const jetPinch = (jetV / g) * 0.72;
  if (opts.jet !== false) {
    const hAt = jetV * jetPinch - 0.5 * g * jetPinch * jetPinch;
    particles.push({
      t0: tj0 + jetPinch,
      p: [0, hAt + 0.05, 0],
      v: [r.range(-0.05, 0.05), jetV - g * jetPinch + 0.9, 0],
      r: 0.085 * (1 + visc * 0.5), life: 3, kind: 'jetdrop',
    });
  }
  const sim = simulate(
    'crown:' + keyOf({ ...opts, mat: [mat.viscosity, mat.surfaceTension] }),
    () => ({
      particles,
      gravity: [0, -g, 0],
      drag: 0.25 + visc * 0.8,
      floor: { y: 0, mode: 'absorb' },
      duration: 4,
    })
  );
  return { H, vRise, T, N, spikes, sim, jetV, tj0, jetPinch, g, spread: opts.spread };
}

// Crown geometry at sheet-age tau (R units). The lamella rises ballistically
// while its rim keeps expanding outward — a tulip that opens as it grows.
function geom(c, tau) {
  const h = Math.max(0, c.vRise * tau - 0.5 * c.g * tau * tau);
  const fall = smoothstep(c.T * 0.5, c.T, tau);
  const open = 1 - Math.exp(-tau * 3.0);
  const rb = (0.34 + 0.36 * open) * (c.spread ?? 1);
  const rt = rb * (1 + 0.55 * clamp(h / c.H) + 0.25 * open) * (1 - 0.32 * fall);
  return { h, fall, rb, rt };
}
function spikeLen(s, tau, c) {
  const grow = smoothstep(0.02 * c.T, 0.3 * c.T, tau);
  let L = s.k * c.H * 0.55 * grow;
  if (tau > s.tp) L *= Math.exp(-(tau - s.tp) * 9); // retract after pinch-off
  return L;
}
function crownTip(s, tau, c) {
  const G = geom(c, tau);
  const L = spikeLen(s, Math.min(tau, s.tp), c);
  const out = 1 + 0.18 * (L / c.H);
  return { x: Math.cos(s.theta) * G.rt * out, y: G.h + L, z: Math.sin(s.theta) * G.rt * out, h: G.h, L, rt: G.rt };
}

/**
 * Render a crown splash.
 * opts: x,y (impact point on surface, px), radius (px, final crown radius),
 * start (s, impact time), material, seed, tilt (0..1 perspective of surface),
 * energy (0.3..1.5), drop (bool: show falling drop), dropFrom (R units),
 * light {x,y}, ripples (bool), pool (bool: draw pool surface), slowmo (time scale)
 */
export function liquidCrown(ctx, t, o = {}) {
  const mat = resolveMaterial(o.material);
  const S = o.radius ?? 200;
  const cx = o.x ?? 960, cy = o.y ?? 700;
  const tilt = o.tilt ?? 0.28;
  const slow = o.slowmo ?? 1;
  const g = 6.5 * (1 + mat.density * 0.1);
  const opts = {
    seed: o.seed ?? 7, start: o.start ?? 0.6, energy: o.energy ?? 1, spread: o.spread ?? 1,
    gravity: g, spikes: o.spikes, spray: o.spray, jet: o.jet, mat,
  };
  const C = buildCrown(opts);
  C.tilt = tilt;
  const tt = opts.start + (t - opts.start) / slow; // simulation time
  const tau = tt - opts.start;
  const light = o.light || { x: -0.5, y: -0.85 };
  const proj = (x, y, z) => [cx + x * S, cy - y * S + z * S * tilt];
  const alpha = o.opacity ?? 1;

  ctx.save();
  ctx.globalAlpha *= alpha;

  if (o.pool) drawPool(ctx, cx, cy, S, tilt, mat, tau, o);

  // ---- ripples (impact + every droplet landing) ----
  if (o.ripples !== false) {
    const rings = [];
    if (tau > 0) rings.push({ x: 0, z: 0, age: tau, amp: 1, speed: 1.05, r0: 0.75 });
    if (tt > C.tj0) rings.push({ x: 0, z: 0, age: tt - C.tj0, amp: 0.5, speed: 0.9, r0: 0.15 });
    for (const e of C.sim.events) {
      if (e.t <= tt && tt - e.t < 2.5) rings.push({ x: e.x, z: e.z, age: tt - e.t, amp: Math.min(0.6, e.r * 10), speed: 0.8, r0: e.r });
    }
    for (const rg of rings) drawRipple(ctx, proj, rg, S, tilt, mat);
  }

  // ---- falling drop ----
  if (o.drop !== false && tau < 0) {
    const h0 = o.dropFrom ?? 3.2;
    const tf = Math.sqrt((2 * h0) / g);
    const a = tt - (opts.start - tf);
    if (a > 0) {
      const y = h0 - 0.5 * g * a * a;
      const v = g * a;
      const [px, py] = proj(0, y + 0.12, 0);
      drawDroplet(ctx, px, py, 0.13 * S, mat, { light, vx: 0, vy: v * S, stretchK: 0.0009 / slow });
    }
  }

  const live = [];
  for (const p of C.sim.list) {
    const st = sample(p, tt);
    if (st) live.push({ p, st });
  }
  live.sort((a, b) => a.st.z - b.st.z);
  const drawParticles = (front) => {
    for (const { p, st } of live) {
      if (front ? st.z < 0 : st.z >= 0) continue;
      const [px, py] = proj(st.x, st.y, st.z);
      const depthScale = 1 + st.z * 0.12;
      drawDroplet(ctx, px, py, p.r * S * depthScale, mat, {
        light, vx: st.vx * S, vy: -st.vy * S, stretchK: 0.0011 / slow,
        alpha: clamp(1 - Math.max(0, st.lifeK - 0.9) * 10),
      });
    }
  };

  // ---- crown sheet ----
  const sheetOn = tau > 0 && tau < C.T * 1.02;
  if (sheetOn) drawSheet(ctx, proj, C, tau, mat, light, S, false);
  drawParticles(false);
  // ---- Worthington jet ----
  if (o.jet !== false && tt > C.tj0) drawJet(ctx, proj, C, tt - C.tj0, mat, light, S, g);
  if (sheetOn) drawSheet(ctx, proj, C, tau, mat, light, S, true);
  drawParticles(true);

  ctx.restore();
  return { impactTime: opts.start, sheetEnd: opts.start + C.T * slow, jetTime: opts.start + (C.tj0 - opts.start) * slow };
}

function sheetProfile(C, theta, tau) {
  let extra = 0;
  for (const s of C.spikes) {
    let d = Math.abs(theta - s.theta) % TAU;
    if (d > Math.PI) d = TAU - d;
    if (d > s.w * 3) continue;
    const L = spikeLen(s, tau, C);
    // sharp tapered peak (not a gaussian bump): film thins toward the tip
    extra += L * Math.pow(Math.max(0, 1 - d / (s.w * 3)), 2.2);
  }
  return extra;
}

function drawSheet(ctx, proj, C, tau, mat, light, S, front) {
  const G = geom(C, tau);
  const seg = 160;
  const thick = 1 - G.fall * 0.8;
  const a0 = front ? 0 : Math.PI, a1 = front ? Math.PI : TAU;
  const top = [], bot = [];
  // wall profile: smooth foot rising out of the surface, concave tulip wall
  const radiusAt = (k) => G.rb + (G.rt - G.rb) * Math.pow(k, 1.6) + G.rb * 0.35 * Math.pow(Math.max(0, 1 - k / 0.22), 2);
  const hTop = [];
  for (let i = 0; i <= seg; i++) {
    const th = a0 + ((a1 - a0) * i) / seg;
    const prof = sheetProfile(C, th, tau);
    const flare = 1 + 0.12 * (prof / C.H);
    const hh = G.h * (1 - 0.45 * G.fall);
    hTop.push(hh);
    top.push(proj(Math.cos(th) * G.rt * flare, hh + prof, Math.sin(th) * G.rt * flare));
    bot.push(proj(Math.cos(th) * radiusAt(0), 0, Math.sin(th) * radiusAt(0)));
  }
  const side = (th, hh) => {
    const out = [];
    for (let k = 0; k <= 14; k++) {
      const kk = k / 14;
      out.push(proj(Math.cos(th) * radiusAt(kk), hh * kk, Math.sin(th) * radiusAt(kk)));
    }
    return out;
  };
  const sideEnd = side(a1, hTop[seg]);
  const sideStart = side(a0, hTop[0]).reverse();
  const path = new Path2D();
  path.moveTo(bot[0][0], bot[0][1]);
  for (const p of bot) path.lineTo(p[0], p[1]);
  for (const p of sideEnd) path.lineTo(p[0], p[1]);
  for (let i = top.length - 1; i >= 0; i--) path.lineTo(top[i][0], top[i][1]);
  for (const p of sideStart) path.lineTo(p[0], p[1]);
  path.closePath();
  let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;
  for (const p of top) { minY = Math.min(minY, p[1]); minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); }
  for (const p of [...bot, ...sideEnd, ...sideStart]) { maxY = Math.max(maxY, p[1]); minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); }
  ctx.save();
  ctx.clip(path);
  // 1) body: transmission gradient, darker & thicker at the base
  const op = mat.opacity * thick * (front ? 0.42 : 0.75);
  const gv = ctx.createLinearGradient(0, maxY, 0, minY);
  gv.addColorStop(0, rgba(mat.edge, Math.min(1, op * 1.25)));
  gv.addColorStop(0.3, rgba(mat.color, op));
  gv.addColorStop(0.75, rgba(mat.core, op * (0.55 + 0.4 * mat.scatter)));
  gv.addColorStop(1, rgba(shade(mat.core, 0.35), op * 0.9));
  ctx.fillStyle = gv;
  ctx.fillRect(minX - 2, minY - 2, maxX - minX + 4, maxY - minY + 4);
  // 2) Fresnel: film seen edge-on at the silhouettes is thicker & brighter
  const cx = (minX + maxX) / 2, hw = (maxX - minX) / 2;
  const gh = ctx.createLinearGradient(minX, 0, maxX, 0);
  const rim = rgba(mat.edge, 0.55 * thick);
  gh.addColorStop(0, rim);
  gh.addColorStop(0.12, rgba(mat.color, 0.25 * thick));
  gh.addColorStop(0.5, rgba(mat.color, 0));
  gh.addColorStop(0.88, rgba(mat.color, 0.25 * thick));
  gh.addColorStop(1, rim);
  ctx.fillStyle = gh;
  ctx.fillRect(minX - 2, minY - 2, maxX - minX + 4, maxY - minY + 4);
  // 3) key-light reflection: soft vertical highlight bands on the lit side
  if (front) {
    for (const [off, w, a] of [[-0.55, 0.07, 0.55], [-0.38, 0.03, 0.35], [0.5, 0.05, 0.22]]) {
      const x = cx + off * hw * (light.x < 0 ? 1 : -1);
      const gs = ctx.createLinearGradient(x - w * hw, 0, x + w * hw, 0);
      gs.addColorStop(0, rgba(mat.spec, 0));
      gs.addColorStop(0.5, rgba(mat.spec, a * mat.gloss * thick));
      gs.addColorStop(1, rgba(mat.spec, 0));
      ctx.fillStyle = gs;
      ctx.fillRect(x - w * hw, minY, w * hw * 2, maxY - minY);
    }
    // inner glow where light passes through the thin film near the rim
    const gg = ctx.createRadialGradient(cx, minY + (maxY - minY) * 0.35, 0, cx, minY + (maxY - minY) * 0.35, hw);
    gg.addColorStop(0, rgba(mat.core, 0.25 * mat.scatter * thick));
    gg.addColorStop(1, rgba(mat.core, 0));
    ctx.fillStyle = gg;
    ctx.fillRect(minX, minY, maxX - minX, maxY - minY);
  }
  ctx.restore();
  // 4) rim: thickened bright edge (the rim is a cylinder of liquid)
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  top.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
  ctx.lineWidth = Math.max(1.5, S * 0.022 * thick);
  ctx.strokeStyle = rgba(mat.color, mat.opacity * thick);
  ctx.stroke();
  ctx.lineWidth = Math.max(0.8, S * 0.008);
  ctx.strokeStyle = rgba(mat.spec, (front ? 0.7 : 0.35) * mat.gloss * thick);
  ctx.stroke();
  ctx.restore();
  // 5) tip bulbs: droplets forming before pinch-off (Rayleigh–Plateau)
  for (const s of C.spikes) {
    const z = Math.sin(s.theta);
    if (front ? z < 0 : z >= 0) continue;
    if (tau >= s.tp || tau < 0.04) continue;
    const tip = crownTip(s, tau, C);
    const [px, py] = proj(tip.x, tip.y, tip.z);
    const grow = smoothstep(0, s.tp, tau);
    drawDroplet(ctx, px, py, s.rd * S * (0.45 + 0.65 * grow), mat, { light });
  }
  // 6) meniscus line where the film meets the surface
  if (front) {
    ctx.save();
    ctx.strokeStyle = rgba(mat.spec, 0.3 * thick);
    ctx.lineWidth = Math.max(1, S * 0.01);
    ctx.beginPath();
    bot.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1] + 1) : ctx.moveTo(p[0], p[1] + 1)));
    ctx.stroke();
    ctx.restore();
  }
}

function drawJet(ctx, proj, C, a, mat, light, S, g) {
  const v = C.jetV;
  const h = Math.max(0, v * a - 0.5 * g * a * a);
  if (h <= 0.02) return;
  const pinched = a > C.jetPinch;
  const top = pinched ? h * 0.78 : h;
  const w0 = 0.075 * (1 + mat.viscosity * 0.4);
  const [bx, by] = proj(0, 0, 0);
  const [tx, ty] = proj(0, top, 0);
  const wb = w0 * S, wt = w0 * S * 0.55;
  const gr = ctx.createLinearGradient(bx - wb * 2, 0, bx + wb * 2, 0);
  gr.addColorStop(0, rgba(mat.edge, mat.opacity * 0.9));
  gr.addColorStop(0.35, rgba(mat.color, mat.opacity));
  gr.addColorStop(0.55, rgba(mat.core, mat.opacity * (0.7 + 0.3 * mat.scatter)));
  gr.addColorStop(1, rgba(mat.edge, mat.opacity * 0.9));
  ctx.fillStyle = gr;
  ctx.beginPath();
  // flared base (fluid drawn up from the surface), slender column, rounded top
  ctx.moveTo(bx - wb * 2.6, by);
  ctx.quadraticCurveTo(bx - wb * 0.9, by - 2, bx - wb * 0.85, by - (by - ty) * 0.25);
  ctx.lineTo(bx - wt, ty + wt);
  ctx.arc(tx, ty + wt, wt, Math.PI, 0);
  ctx.lineTo(bx + wb * 0.85, by - (by - ty) * 0.25);
  ctx.quadraticCurveTo(bx + wb * 0.9, by - 2, bx + wb * 2.6, by);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = rgba(mat.spec, 0.55 * mat.gloss);
  ctx.lineWidth = Math.max(1, wt * 0.25);
  ctx.beginPath();
  ctx.moveTo(bx - wb * 0.45, by - 6);
  ctx.lineTo(tx - wt * 0.45, ty + wt * 1.2);
  ctx.stroke();
  if (!pinched) drawDroplet(ctx, tx, ty, wt * 1.35, mat, { light });
}

function drawRipple(ctx, proj, rg, S, tilt, mat) {
  const r = rg.r0 + rg.speed * rg.age;
  const amp = rg.amp * Math.exp(-rg.age * 1.3);
  if (amp < 0.02) return;
  const [x, y] = proj(rg.x, 0, rg.z);
  for (let k = 0; k < 3; k++) {
    const rr = (r - k * 0.09) * S;
    if (rr <= 0) continue;
    const a = amp * (1 - k * 0.3);
    ctx.lineWidth = Math.max(0.8, S * 0.012 * a);
    ctx.strokeStyle = rgba(mat.spec, 0.32 * a);
    ctx.beginPath();
    ctx.ellipse(x, y - 1, rr, rr * tilt, 0, Math.PI * 1.05, Math.PI * 1.95);
    ctx.stroke();
    ctx.strokeStyle = rgba(mat.edge, 0.35 * a);
    ctx.beginPath();
    ctx.ellipse(x, y + 1.5, rr, rr * tilt, 0, 0.05 * Math.PI, 0.95 * Math.PI);
    ctx.stroke();
  }
}

// Liquid surface filling the lower frame: darker far away, reflecting the
// key light as a soft glossy band, glowing where light passes through.
function drawPool(ctx, cx, cy, S, tilt, mat, tau, o) {
  const W = ctx.__W ?? ctx.canvas.width, H = ctx.__H ?? ctx.canvas.height;
  const horizon = cy - S * tilt * (o.poolDepth ?? 3.2);
  ctx.save();
  const g = ctx.createLinearGradient(0, horizon, 0, H);
  g.addColorStop(0, rgba(mat.edge, 0));
  g.addColorStop(0.18, rgba(mat.edge, 0.85));
  g.addColorStop(0.5, rgba(mat.color, 0.9));
  g.addColorStop(1, rgba(shade(mat.edge, -0.2), 0.95));
  ctx.fillStyle = g;
  ctx.fillRect(-W, horizon, W * 3, H - horizon + 200);
  // transmitted glow around the impact
  const rg = ctx.createRadialGradient(cx, cy, 0, cx, cy, S * 2.6);
  rg.addColorStop(0, rgba(mat.core, 0.55 * mat.scatter));
  rg.addColorStop(1, rgba(mat.core, 0));
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(1, tilt * 1.4);
  ctx.translate(-cx, -cy);
  ctx.fillStyle = rg;
  ctx.fillRect(cx - S * 3, cy - S * 3, S * 6, S * 6);
  ctx.restore();
  // specular reflection band of the key light
  const sy = horizon + (cy - horizon) * 0.45;
  const sg = ctx.createLinearGradient(0, sy - S * 0.12, 0, sy + S * 0.12);
  sg.addColorStop(0, rgba(mat.spec, 0));
  sg.addColorStop(0.5, rgba(mat.spec, 0.18 * mat.gloss));
  sg.addColorStop(1, rgba(mat.spec, 0));
  ctx.fillStyle = sg;
  ctx.fillRect(-W, sy - S * 0.12, W * 3, S * 0.24);
  ctx.restore();
}

/**
 * A continuous pour / stream of liquid falling from (x,y) to a surface,
 * with gravity-thinning stream (continuity: width ~ 1/sqrt(v)) and a
 * coiling impact zone plus splash droplets.
 */
export function liquidPour(ctx, t, o = {}) {
  const mat = resolveMaterial(o.material);
  const x = o.x ?? 960, y0 = o.y ?? 100, y1 = o.surfaceY ?? 800;
  const start = o.start ?? 0, end = o.end ?? 99;
  const w0 = o.width ?? 40;
  const g = 3200 * (1 - mat.viscosity * 0.45);
  const v0 = o.speed ?? 250;
  const a = t - start;
  if (a <= 0) return;
  const len = y1 - y0;
  // head of the stream (front falling before reaching the surface)
  const head = Math.min(len, v0 * a + 0.5 * g * a * a);
  // tail when pour ends
  const b = t - end;
  const tail = b > 0 ? Math.min(len, v0 * b + 0.5 * g * b * b) : 0;
  if (tail >= len) return;
  const steps = 40;
  const r = rng(o.seed ?? 3);
  const left = [], right = [];
  for (let i = 0; i <= steps; i++) {
    const d = tail + ((head - tail) * i) / steps;
    const v = Math.sqrt(v0 * v0 + 2 * g * d);
    const w = w0 * Math.sqrt(v0 / v) * (1 + 0.04 * Math.sin(d * 0.05 - t * 30));
    const wob = Math.sin(d * 0.012 + t * 3) * (o.wobble ?? 3);
    left.push([x - w / 2 + wob, y0 + d]);
    right.push([x + w / 2 + wob, y0 + d]);
  }
  const gr = ctx.createLinearGradient(x - w0, 0, x + w0, 0);
  gr.addColorStop(0, rgba(mat.edge, mat.opacity));
  gr.addColorStop(0.35, rgba(mat.color, mat.opacity));
  gr.addColorStop(0.5, rgba(mat.core, mat.opacity * (0.7 + 0.3 * mat.scatter)));
  gr.addColorStop(1, rgba(mat.edge, mat.opacity));
  ctx.fillStyle = gr;
  ctx.beginPath();
  ctx.moveTo(left[0][0], left[0][1]);
  for (const p of left) ctx.lineTo(p[0], p[1]);
  for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(right[i][0], right[i][1]);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = rgba(mat.spec, 0.55 * mat.gloss);
  ctx.lineWidth = Math.max(1, w0 * 0.08);
  ctx.beginPath();
  for (let i = 0; i < left.length; i++) {
    const p = left[i], q = right[i];
    const px = p[0] + (q[0] - p[0]) * 0.28;
    if (i === 0) ctx.moveTo(px, p[1]);
    else ctx.lineTo(px, p[1]);
  }
  ctx.stroke();
  // impact zone: heap + splash
  if (head >= len - 1) {
    const since = a - (Math.sqrt(v0 * v0 + 2 * g * len) - v0) / g;
    const heapR = w0 * (1.4 + mat.viscosity * 1.5) * Math.min(1, since * 3);
    const hg = ctx.createRadialGradient(x, y1 - heapR * 0.2, 1, x, y1, heapR * 1.6);
    hg.addColorStop(0, rgba(mat.core, mat.opacity));
    hg.addColorStop(0.5, rgba(mat.color, mat.opacity));
    hg.addColorStop(1, rgba(mat.color, 0));
    ctx.fillStyle = hg;
    ctx.beginPath();
    ctx.ellipse(x, y1, heapR * 1.6, heapR * 0.45, 0, 0, TAU);
    ctx.fill();
    const n = Math.round(14 * (1 - mat.viscosity));
    for (let i = 0; i < n; i++) {
      const ph = (t * (2 + r() * 2) + r()) % 1;
      const ang = r.range(-Math.PI * 0.9, -Math.PI * 0.1);
      const sp = r.range(80, 220);
      const px = x + Math.cos(ang) * sp * ph;
      const py = y1 + Math.sin(ang) * sp * ph + 0.5 * 900 * ph * ph;
      drawDroplet(ctx, px, py, r.range(2, 5) * (w0 / 40), mat, { alpha: 1 - ph });
    }
  }
}

/** Slow viscous drip hanging from a point, stretching, pinching off, falling. */
export function liquidDrip(ctx, t, o = {}) {
  const mat = resolveMaterial(o.material);
  const x = o.x ?? 960, y = o.y ?? 200, r0 = o.size ?? 22;
  const period = o.period ?? 2.2 * (1 + mat.viscosity);
  const start = o.start ?? 0;
  const floorY = o.floorY ?? 2000;
  const a = t - start;
  if (a < 0) return;
  const cyc = Math.floor(a / period);
  const k = (a % period) / period;
  // growth phase 0..0.75 then neck thins, pinch at 0.78, fall after
  const grow = ease.inOutSine(clamp(k / 0.75));
  const pinch = 0.78;
  const g = 2600;
  if (k < pinch) {
    const rr = r0 * (0.4 + 0.6 * grow);
    const neck = rr * (0.55 - 0.45 * smoothstep(0.55, pinch, k));
    const drop = rr * (0.8 + 1.4 * grow);
    ctx.fillStyle = rgba(mat.color, mat.opacity);
    ctx.beginPath();
    ctx.moveTo(x - rr, y);
    ctx.bezierCurveTo(x - rr, y + drop * 0.3, x - neck, y + drop * 0.5, x - neck * 0.9, y + drop * 0.75);
    ctx.lineTo(x + neck * 0.9, y + drop * 0.75);
    ctx.bezierCurveTo(x + neck, y + drop * 0.5, x + rr, y + drop * 0.3, x + rr, y);
    ctx.closePath();
    ctx.fill();
    drawDroplet(ctx, x, y + drop, rr * (0.75 + 0.3 * grow), mat, { light: o.light });
  } else {
    const fa = (k - pinch) * period;
    const yy = y + r0 * 2.6 + 0.5 * g * fa * fa;
    if (yy < floorY) drawDroplet(ctx, x, yy, r0 * 0.95, mat, { vy: g * fa, light: o.light });
    // retracting stub
    const stub = r0 * 0.6 * Math.exp(-fa * 6);
    drawDroplet(ctx, x, y + stub, r0 * 0.45, mat, { light: o.light });
  }
  return { cycle: cyc };
}
