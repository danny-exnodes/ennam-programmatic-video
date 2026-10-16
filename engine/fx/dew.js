// Hero leaf with dew: a large leaf on a twig that sways in the wind, carrying
// water drops that behave like real sessile / pendant drops.
//
//  • Leaf: two damped rotational oscillators (pitch, roll) driven by quadratic
//    wind drag + turbulence, and loaded by the weight of the drops it carries.
//    When a drop falls off, the load vanishes and the leaf recoils.
//  • Sessile drops stay pinned by contact-line hysteresis until gravity along
//    the leaf beats the pinning force  (m·g·sinα > k·r): big drops slide on a
//    gentle slope, small ones never do. A sliding drop collects the drops in
//    its path (coalescence: r = ∛(r₁³ + r₂³)) and runs to the drip tip.
//  • At the tip it hangs as a pendant drop that swings with the leaf and
//    detaches by Tate's law (weight + inertial load > 2π·r_tip·σ), leaving a
//    small residual drop behind.
//  • The falling drop oscillates (Rayleigh mode-2), hits the water, sends a
//    ripple impulse, throws up a Worthington jet whose tip droplet falls back
//    for a second, smaller impact.
import { rng, clamp, rgba, mix, smoothstep, TAU, noise2 } from '../math.js';
import { windAt } from './wind.js';
import { add, scl, sub, dot, cross } from './foliage.js';

const DT = 1 / 240;
const G = 9.81;
const RHO = 1000;
const SIGMA = 0.072;
const cache = new Map();
const keyOf = (o) => JSON.stringify(o, (k, v) => (typeof v === 'number' ? Math.round(v * 1e5) / 1e5 : v));
export function clearDewCache() {
  cache.clear();
}

const ST = { GONE: 0, SESSILE: 1, SLIDING: 2, PENDANT: 3 };
const capMass = (r) => RHO * (2 / 3) * Math.PI * r * r * r * 0.85;
const sphMass = (r) => RHO * (4 / 3) * Math.PI * r * r * r;

/** Leaf outline half-width (fraction of length) along the midrib, with a drip tip. */
export function leafWidth(u, shape = 1) {
  if (u <= 0 || u >= 1) return 0;
  const body = Math.pow(Math.sin(Math.PI * Math.pow(u, 0.72)), 0.8);
  const tip = u > 0.72 ? Math.pow(1 - (u - 0.72) / 0.28, 1.15 + 0.6 * shape) : 1;
  const base = smoothstep(0, 0.08, u);
  return body * tip * (0.35 + 0.65 * base);
}

/** World geometry of the leaf for a given pitch/roll state. */
export function leafGeometry(o, phi, chi) {
  const L = o.length ?? 0.11;
  const yaw = o.yaw ?? 0;
  const k = o.curve ?? 0.9; // midrib curvature (rad over the length)
  const A = o.anchor ?? [0, 0.3, 1];
  const h = [Math.cos(yaw), 0, Math.sin(yaw)];
  const side0 = [-Math.sin(yaw), 0, Math.cos(yaw)];
  const wr = o.width ?? 0.36;
  const fold = o.fold ?? 0.12;
  const cosC = Math.cos(chi), sinC = Math.sin(chi);
  const center = (u) => {
    const a = phi + k * u;
    let fh, fd;
    if (Math.abs(k) < 1e-4) { fh = u * Math.cos(phi); fd = u * Math.sin(phi); }
    else { fh = (Math.sin(a) - Math.sin(phi)) / k; fd = (Math.cos(phi) - Math.cos(a)) / k; }
    return [A[0] + h[0] * fh * L, A[1] - fd * L, A[2] + h[2] * fh * L];
  };
  const tangent = (u) => {
    const a = phi + k * u;
    return [h[0] * Math.cos(a), -Math.sin(a), h[2] * Math.cos(a)];
  };
  const frame = (u) => {
    const tg = tangent(u);
    // up-ish normal of an unrolled leaf
    let n = cross(side0, tg);
    if (n[1] < 0) n = scl(n, -1);
    const side = add(scl(side0, cosC), scl(n, sinC));
    const nn = add(scl(n, cosC), scl(side0, -sinC));
    return { tg, side, n: nn };
  };
  const point = (u, v) => {
    const c = center(u);
    const f = frame(u);
    const hw = leafWidth(u, o.tipShape ?? 1) * wr * L;
    // V-shaped fold along the midrib lifts the margins
    return add(add(c, scl(f.side, v * hw)), scl(f.n, Math.abs(v) * hw * fold));
  };
  return { L, center, tangent, frame, point, slope: (u) => phi + k * u, halfWidth: (u) => leafWidth(u, o.tipShape ?? 1) * wr * L };
}

export function simulateDew(o, wind, until) {
  const key = 'dew:' + keyOf({ o, until, w: [wind.speed, wind.dir, wind.gusts, wind.gustiness, wind.turbulence, wind.seed] });
  let res = cache.get(key);
  if (res) return res;
  const r = rng(o.seed ?? 1);
  const L = o.length ?? 0.11;
  const w0 = TAU * (o.freq ?? 2.2); // natural frequency of the leaf on its petiole
  const zeta = o.damping ?? 0.09;
  const phiRest = o.pitch ?? 0.32;
  const chiRest = o.roll ?? 0;
  const kWind = (o.windGain ?? 1) * 4;
  const kLoad = (o.loadGain ?? 1) * 1.2e4;
  const kPin = o.pin ?? 0.11; // N/m contact-line pinning
  const rTip = o.tipRadius ?? 0.005;
  const drops = (o.drops || []).map((d) => ({ st: ST.SESSILE, u: d.u, v: d.v ?? 0, r: d.r, vel: 0, beta: 0, bv: 0, stretch: 0 }));
  const nd = drops.length;
  const steps = Math.ceil(until / DT) + 2;
  const REC = 4 + nd * 6 + 8;
  const buf = new Float32Array(steps * REC);
  const events = [];
  const falling = [];
  let phi = phiRest, phiV = 0, chi = chiRest, chiV = 0;
  let tipPrev = null, tipPrev2 = null;
  const geomAt = (p, c) => leafGeometry(o, p, c);
  // settle on the static load first so the shot starts at rest
  let loadT = 0;
  for (const d of drops) loadT += capMass(d.r) * G * d.u;
  phi = phiRest + (kLoad * loadT) / (w0 * w0);
  let released = false;
  for (let s = 0; s < steps; s++) {
    const t = s * DT;
    const g = geomAt(phi, chi);
    const mid = g.center(0.5);
    const w = windAt(wind, mid[0], mid[1], mid[2], t);
    const sp2 = w[0] * w[0] + w[1] * w[1] + w[2] * w[2];
    const turb = noise2(t * 3.1, 1.7, o.seed ?? 1) + 0.5 * noise2(t * 7.3, 4.1, (o.seed ?? 1) + 3);
    // load torque from drops (sessile + sliding + pendant)
    let load = 0;
    for (const d of drops) if (d.st !== ST.GONE) load += (d.st === ST.PENDANT ? sphMass(d.r) : capMass(d.r)) * G * Math.min(1, d.u);
    const tauPhi = kWind * sp2 * (0.55 + 0.45 * turb) + kLoad * load;
    const phiA = -w0 * w0 * (phi - phiRest) - 2 * zeta * w0 * phiV + tauPhi;
    const chiA = -w0 * w0 * 1.6 * (chi - chiRest) - 2 * zeta * w0 * 1.3 * chiV + kWind * 0.8 * sp2 * noise2(t * 2.3, 9.2, (o.seed ?? 1) + 5);
    phiV += phiA * DT; phi += phiV * DT;
    chiV += chiA * DT; chi += chiV * DT;
    // tip kinematics (for the pendant drop)
    const tip = g.center(1);
    let tipAcc = [0, 0, 0], tipVel = [0, 0, 0];
    if (tipPrev && tipPrev2) {
      tipAcc = scl(add(sub(tip, scl(tipPrev, 2)), tipPrev2), 1 / (DT * DT));
      tipVel = scl(sub(tip, tipPrev), 1 / DT);
    }
    tipPrev2 = tipPrev; tipPrev = tip;
    const shake = Math.min(25, Math.abs(phiA) * 0.03);
    // drops
    for (let i = 0; i < nd; i++) {
      const d = drops[i];
      if (d.st === ST.SESSILE || d.st === ST.SLIDING) {
        const slope = g.slope(d.u);
        const m = capMass(d.r);
        const along = G * Math.sin(slope) + shake * 0.3 * d.u;
        if (d.st === ST.SESSILE) {
          if (m * along > kPin * d.r) { d.st = ST.SLIDING; events.push({ t, kind: 'slide', i }); }
        } else {
          const acc = along - (0.75 * kPin * d.r) / m - (o.drag ?? 70) * d.vel;
          d.vel = Math.max(0, d.vel + acc * DT);
          if (d.vel === 0 && m * along < kPin * d.r) d.st = ST.SESSILE;
          d.u += (d.vel * DT) / L;
          d.v += (0 - d.v) * 3 * DT; // runs down the midrib groove
          // coalescence with drops in the path
          for (let j = 0; j < nd; j++) {
            const e = drops[j];
            if (j === i || e.st !== ST.SESSILE) continue;
            const hw = Math.max(1e-4, g.halfWidth(Math.min(0.999, (d.u + e.u) / 2)));
            const dist = Math.hypot((d.u - e.u) * L, (d.v - e.v) * hw);
            if (dist < (d.r + e.r) * 0.95) {
              const m1 = capMass(d.r), m2 = capMass(e.r);
              d.r = Math.cbrt(d.r ** 3 + e.r ** 3);
              d.vel *= m1 / (m1 + m2);
              d.v = (d.v * m1 + e.v * m2) / (m1 + m2);
              e.st = ST.GONE;
              events.push({ t, kind: 'merge', i, j });
            }
          }
          if (d.u >= 0.985) {
            d.u = 1; d.st = ST.PENDANT; d.v = 0; d.beta = 0; d.bv = 0;
            events.push({ t, kind: 'tip', i, r: d.r });
          }
        }
      } else if (d.st === ST.PENDANT) {
        const M = sphMass(d.r);
        const ell = d.r * 1.5;
        // pendulum in the camera-ish plane, driven by tip acceleration
        const ax = tipAcc[0];
        d.bv += (-(G / ell) * Math.sin(d.beta) - 6 * d.bv - (ax / ell) * Math.cos(d.beta)) * DT;
        d.beta += d.bv * DT;
        const gEff = G - tipAcc[1] + ell * d.bv * d.bv; // weight + inertia + centripetal
        const Fhold = 2 * Math.PI * rTip * SIGMA;
        d.stretch += (clamp((M * gEff) / Fhold) - d.stretch) * 10 * DT;
        const force = o.releaseBy != null && t >= o.releaseBy && !released;
        if (M * gEff > Fhold || force) {
          released = true;
          // pinch-off: the main drop falls, a small residue stays on the tip
          const rFall = d.r * 0.97;
          const start = add(tip, [Math.sin(d.beta) * ell, -ell * Math.cos(d.beta) - d.r * 0.4, 0]);
          const vel = add(tipVel, [Math.cos(d.beta) * d.bv * ell, 0, 0]);
          falling.push({ t0: t, p: start, v: vel, r: rFall, phase: r.range(0, TAU) });
          events.push({ t, kind: 'release', i, r: rFall, x: start[0], y: start[1], z: start[2] });
          d.r = d.r * 0.38;
          d.stretch = 0;
          d.beta = 0; d.bv = 0;
        }
      }
    }
    // record
    const ob = s * REC;
    buf[ob] = phi; buf[ob + 1] = chi; buf[ob + 2] = tipVel[1]; buf[ob + 3] = 0;
    for (let i = 0; i < nd; i++) {
      const d = drops[i], q = ob + 4 + i * 6;
      buf[q] = d.st; buf[q + 1] = d.u; buf[q + 2] = d.v; buf[q + 3] = d.r; buf[q + 4] = d.beta; buf[q + 5] = d.stretch;
    }
  }
  // falling drops: ballistic + air drag, impact on water (y = waterY)
  const waterY = o.waterY ?? 0;
  const impacts = [];
  const fallers = falling.map((f) => {
    const pts = [];
    let p = f.p.slice(), v = f.v.slice();
    let t = f.t0;
    for (let k = 0; k < 2400; k++) {
      pts.push([t, p[0], p[1], p[2], v[1]]);
      const kd = 0.12 / Math.max(0.0008, f.r) * 0.0006; // weak drag for mm drops
      v = add(v, scl([-kd * v[0], -G - kd * v[1], -kd * v[2]], DT));
      p = add(p, scl(v, DT));
      t += DT;
      if (p[1] <= waterY) {
        impacts.push({ t, x: p[0], z: p[2], r: f.r, v: Math.abs(v[1]) });
        break;
      }
    }
    return { ...f, pts };
  });
  // splash secondaries: Worthington jet tip droplet falls back
  const splashes = impacts.map((im, i) => {
    const vj = clamp(0.14 * im.v + 0.25, 0.3, 0.9);
    const tp = (0.55 * vj) / G; // pinch-off time of the jet tip
    const rj = im.r * 0.55;
    const h0 = vj * tp - 0.5 * G * tp * tp;
    const v0 = vj - G * tp + 0.12;
    // time to land again: h0 + v0 τ - g τ²/2 = 0
    const tau = (v0 + Math.sqrt(v0 * v0 + 2 * G * h0)) / G;
    const sec = { t: im.t + tp + tau, x: im.x + 0.002 * Math.sin(i * 7), z: im.z, r: rj, v: Math.abs(v0 - G * tau) };
    return { ...im, vj, tp, rj, h0, v0, sec };
  });
  const impulses = [];
  for (const sp of splashes) {
    impulses.push({ t: sp.t, x: sp.x, z: sp.z, r: sp.r * 2.6, amp: 0.55 * sp.v * (sp.r / 0.0025), kind: 'drop' });
    impulses.push({ t: sp.sec.t, x: sp.sec.x, z: sp.sec.z, r: sp.sec.r * 2.4, amp: 0.4 * sp.sec.v * (sp.sec.r / 0.0025), kind: 'jetdrop' });
  }
  res = { buf, REC, nd, steps, events, fallers, splashes, impulses };
  cache.set(key, res);
  if (cache.size > 20) cache.delete(cache.keys().next().value);
  return res;
}

export function sampleDew(D, t) {
  const f = clamp(t / DT, 0, D.steps - 2);
  const i = Math.floor(f), k = f - i;
  const a = i * D.REC, b = a + D.REC, B = D.buf;
  const lerp = (x) => B[a + x] + (B[b + x] - B[a + x]) * k;
  const drops = [];
  for (let j = 0; j < D.nd; j++) {
    const q = 4 + j * 6;
    const st = B[a + q];
    drops.push({ st, u: lerp(q + 1), v: lerp(q + 2), r: B[b + q] === st ? lerp(q + 3) : B[a + q + 3], beta: lerp(q + 4), stretch: lerp(q + 5) });
  }
  return { phi: lerp(0), chi: lerp(1), drops };
}

// ------------------------------------------------------------ drawing ----
let noiseTile = null;
function leafTexture() {
  if (noiseTile) return noiseTile;
  const N = 256;
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(N, N) : Object.assign(document.createElement('canvas'), { width: N, height: N });
  const x = c.getContext('2d');
  const img = x.createImageData(N, N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      // tileable cellular-ish mottling of the leaf surface
      const u = i / N, v = j / N;
      let s = 0, amp = 0.5, f = 8;
      for (let o = 0; o < 4; o++) {
        s += amp * (0.5 + 0.5 * Math.sin(TAU * (u * f + 0.3 * Math.sin(TAU * v * f * 0.5 + o))) * Math.sin(TAU * (v * f + 0.3 * Math.sin(TAU * u * f * 0.5 + o * 2))));
        f *= 2;
        amp *= 0.5;
      }
      const g = 128 + (s - 0.47) * 120;
      const p = (j * N + i) * 4;
      img.data[p] = img.data[p + 1] = img.data[p + 2] = clamp(g, 0, 255);
      img.data[p + 3] = 255;
    }
  }
  x.putImageData(img, 0, 0);
  noiseTile = c;
  return c;
}

/**
 * Draw the hero leaf. P: project fn. light: {dir, color}. camPos.
 * mode 'main' | 'reflection'
 */
export function drawHeroLeaf(ctx, o, g, P, light, camPos, mode = 'main') {
  const N = 48;
  const left = [], right = [], spine = [];
  for (let i = 0; i <= N; i++) {
    const u = i / N;
    left.push(P(...g.point(u, -1)));
    right.push(P(...g.point(u, 1)));
    spine.push(P(...g.center(u)));
  }
  if (spine.some((p) => !(p[2] > 0.01))) return;
  const base = o.color ?? '#3f7a2a';
  // lighting at a few points along the leaf (curved leaf → varying normal)
  const shadeAt = (u) => {
    const f = g.frame(u);
    const c = g.center(u);
    const view = sub(camPos, c);
    const vl = Math.hypot(...view);
    const vn = dot(f.n, view) / vl;
    const ln = dot(f.n, light.dir);
    const front = vn * ln > 0;
    const h = add(scl(view, 1 / vl), light.dir);
    const spec = Math.pow(Math.max(0, Math.abs(dot(f.n, h)) / (Math.hypot(...h) || 1)), 40);
    return { front, diff: Math.abs(ln), spec, vn };
  };
  ctx.save();
  const path = new Path2D();
  path.moveTo(left[0][0], left[0][1]);
  for (const p of left) path.lineTo(p[0], p[1]);
  for (let i = right.length - 1; i >= 0; i--) path.lineTo(right[i][0], right[i][1]);
  path.closePath();
  if (mode === 'reflection') {
    ctx.fillStyle = rgba(mix(base, '#000000', 0.45), 0.95);
    ctx.fill(path);
    ctx.restore();
    return;
  }
  const a0 = spine[0], a1 = spine[N];
  const grad = ctx.createLinearGradient(a0[0], a0[1], a1[0], a1[1]);
  const specStops = [];
  for (let i = 0; i <= 8; i++) {
    const u = i / 8;
    const sh = shadeAt(Math.min(0.99, Math.max(0.01, u)));
    let col;
    if (sh.front) col = mix(mix(base, '#000000', 0.6), mix(base, '#e8f0a0', 0.12), clamp(0.2 + 0.85 * sh.diff));
    else col = mix(mix(base, '#000000', 0.45), mix(base, '#f4f08a', 0.5), clamp(0.25 + 0.9 * sh.diff) * (light.translucency ?? 1));
    grad.addColorStop(u, rgba(col));
    specStops.push([u, sh.front ? sh.spec : 0]);
  }
  ctx.fillStyle = grad;
  ctx.fill(path);
  ctx.clip(path);
  // surface mottling
  const tile = leafTexture();
  const pat = ctx.createPattern(tile, 'repeat');
  const span = Math.hypot(a1[0] - a0[0], a1[1] - a0[1]);
  if (pat && pat.setTransform && typeof DOMMatrix !== 'undefined') {
    const sc = span / 900;
    pat.setTransform(new DOMMatrix([sc, 0, 0, sc, a0[0], a0[1]]));
  }
  ctx.globalCompositeOperation = 'overlay';
  ctx.globalAlpha = 0.22;
  ctx.fillStyle = pat;
  ctx.fill(path);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  // cross shading: darker toward the margins (leaf folds away), lighter midrib
  const steps = 16;
  for (let i = 0; i < steps; i++) {
    const u0 = i / steps, u1 = (i + 1) / steps;
    for (const side of [-1, 1]) {
      const q0 = P(...g.point(u0, side * 0.55)), q1 = P(...g.point(u1, side * 0.55));
      const r0 = P(...g.point(u0, side * 1.02)), r1 = P(...g.point(u1, side * 1.02));
      ctx.fillStyle = rgba('#0c1a06', 0.16);
      ctx.beginPath();
      ctx.moveTo(q0[0], q0[1]); ctx.lineTo(q1[0], q1[1]); ctx.lineTo(r1[0], r1[1]); ctx.lineTo(r0[0], r0[1]);
      ctx.closePath();
      ctx.fill();
    }
  }
  // waxy specular sheen along the curved blade
  const sg = ctx.createLinearGradient(a0[0], a0[1], a1[0], a1[1]);
  for (const [u, sp] of specStops) sg.addColorStop(u, rgba('#f4fbe6', clamp(sp * (o.gloss ?? 0.55))));
  ctx.fillStyle = sg;
  ctx.fill(path);
  // veins
  const lw = Math.max(0.6, span * 0.006);
  const backlit = !shadeAt(0.5).front;
  const veinCol = backlit ? '#f6f2b0' : mix(base, '#d8e4a0', 0.35);
  ctx.lineCap = 'round';
  ctx.strokeStyle = rgba(veinCol, backlit ? 0.75 : 0.55);
  ctx.lineWidth = lw * 1.6;
  ctx.beginPath();
  spine.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
  ctx.stroke();
  ctx.lineWidth = lw * 0.55;
  ctx.strokeStyle = rgba(veinCol, backlit ? 0.5 : 0.32);
  const nv = o.veins ?? 11;
  for (let k = 1; k <= nv; k++) {
    const u0 = 0.06 + (k / (nv + 1)) * 0.82;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      for (let j = 0; j <= 10; j++) {
        const s = j / 10;
        const u = u0 + s * 0.16 * (1 - u0 * 0.3);
        const p = P(...g.point(Math.min(0.99, u), side * s * 0.92));
        if (j) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]);
      }
      ctx.stroke();
    }
  }
  ctx.restore();
  // margin: thin dark edge, glowing rim when backlit
  ctx.save();
  ctx.lineWidth = Math.max(0.6, span * 0.003);
  ctx.strokeStyle = backlit ? rgba('#f8f4a0', 0.55) : rgba(mix(base, '#000000', 0.6), 0.6);
  ctx.stroke(path);
  ctx.restore();
}

/** Stem/twig from the leaf base back to an off-screen branch point. */
export function drawTwig(ctx, o, g, P, mode) {
  const a = g.center(0);
  const b = o.twig ?? [a[0] - 0.12, a[1] + 0.1, a[2] + 0.02];
  const mid = [(a[0] + b[0]) / 2 + 0.01, Math.max(a[1], b[1]) + 0.015, (a[2] + b[2]) / 2];
  const N = 24;
  const L = [], R = [];
  for (let i = 0; i <= N; i++) {
    const s = i / N;
    const q = [0, 1, 2].map((k) => (1 - s) * (1 - s) * a[k] + 2 * (1 - s) * s * mid[k] + s * s * b[k]);
    const p = P(...q);
    if (!(p[2] > 0.01)) return;
    const rad = (o.twigRadius ?? 0.0011) * (1 + s * 1.6);
    const q2 = P(q[0], q[1] + rad, q[2]);
    const w = Math.max(0.6, Math.abs(q2[1] - p[1]));
    L.push([p[0], p[1] - w]);
    R.push([p[0], p[1] + w]);
  }
  ctx.save();
  ctx.beginPath();
  L.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
  for (let i = R.length - 1; i >= 0; i--) ctx.lineTo(R[i][0], R[i][1]);
  ctx.closePath();
  if (mode === 'reflection') {
    ctx.fillStyle = rgba('#1c1608', 0.9);
    ctx.fill();
  } else {
    const p0 = L[0], p1 = R[0];
    const gr = ctx.createLinearGradient(p0[0], p0[1], p1[0], p1[1]);
    const c = o.twigColor ?? '#5a4626';
    gr.addColorStop(0, rgba(mix(c, '#e8d8a8', 0.35)));
    gr.addColorStop(0.45, rgba(c));
    gr.addColorStop(1, rgba(mix(c, '#000000', 0.55)));
    ctx.fillStyle = rgba(c);
    ctx.fill();
    // highlight along the lit side
    ctx.strokeStyle = rgba(mix(c, '#f0e0b0', 0.5), 0.6);
    ctx.lineWidth = 1;
    ctx.beginPath();
    L.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1] + 1) : ctx.moveTo(p[0], p[1] + 1)));
    ctx.stroke();
    ctx.strokeStyle = rgba(mix(c, '#000000', 0.6), 0.6);
    ctx.beginPath();
    R.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1] - 1) : ctx.moveTo(p[0], p[1] - 1)));
    ctx.stroke();
    void gr;
  }
  ctx.restore();
}

/**
 * Lens-like water drop: an inverted, minified image of the scene behind it
 * (snapshot), dark refractive rim, sun highlight, caustic focus on the leaf.
 */
export function drawLensDrop(ctx, snap, scale, x, y, rx, ry, o = {}) {
  if (rx < 0.5) return;
  const light = o.light ?? { x: -0.5, y: -0.8 };
  const sessile = o.mode === 'sessile';
  ctx.save();
  // contact shadow + caustic focus on the surface (sessile drops)
  if (o.onLeaf) {
    const sx = x - light.x * rx * 0.5, sy = y - light.y * ry * 0.5;
    const sh = ctx.createRadialGradient(sx, sy, rx * 0.3, sx, sy, rx * 1.2);
    sh.addColorStop(0, 'rgba(6,16,2,0.34)');
    sh.addColorStop(1, 'rgba(6,16,2,0)');
    ctx.fillStyle = sh;
    ctx.beginPath();
    ctx.ellipse(sx, sy, rx * 1.2, ry * 1.2, 0, 0, TAU);
    ctx.fill();
  }
  ctx.beginPath();
  if (o.shape) o.shape(ctx);
  else ctx.ellipse(x, y, rx, ry, o.rot ?? 0, 0, TAU);
  ctx.save();
  ctx.clip();
  if (snap) {
    ctx.save();
    try {
      if (sessile) {
        // a cap on a leaf magnifies (and brightens) the surface beneath it
        const mag = o.mag ?? 1.45;
        const sw = (rx * 2) / mag, shh = (ry * 2) / mag;
        ctx.filter = 'brightness(1.35) saturate(1.15)';
        ctx.drawImage(snap, (x - sw / 2 - light.x * rx * 0.15) * scale, (y - shh / 2 - light.y * ry * 0.15) * scale, sw * scale, shh * scale, x - rx, y - ry, rx * 2, ry * 2);
        ctx.filter = 'none';
      } else {
        // a free ball lens shows an inverted, wide view of what is behind it
        const k = o.fov ?? 5.5;
        const sw = rx * 2 * k, shh = ry * 2 * k;
        ctx.translate(x, y);
        ctx.scale(-1, -1);
        ctx.filter = 'brightness(1.25) contrast(1.1)';
        ctx.drawImage(snap, (x - sw / 2) * scale, (y - shh / 2 - (o.lookUp ?? 1.6) * ry) * scale, sw * scale, shh * scale, -rx, -ry * 1.6, rx * 2, ry * 3.2);
        ctx.filter = 'none';
      }
    } catch { /* source outside canvas */ }
    ctx.restore();
  }
  // refraction edge: light bends away near the silhouette -> darker band
  const R = Math.max(rx, ry);
  const g = ctx.createRadialGradient(x - light.x * rx * 0.12, y - light.y * ry * 0.12, R * 0.2, x, y, R * 1.02);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.7, 'rgba(0,0,0,0)');
  g.addColorStop(0.9, `rgba(4,12,4,${(sessile ? 0.32 : 0.45) * (o.rim ?? 1)})`);
  g.addColorStop(1, `rgba(2,6,2,${(sessile ? 0.55 : 0.7) * (o.rim ?? 1)})`);
  ctx.fillStyle = g;
  ctx.fillRect(x - R * 1.7, y - R * 3.5, R * 3.4, R * 7);
  // sky reflected on the upper rim (Fresnel)
  const fr = ctx.createLinearGradient(x + light.x * rx, y + light.y * ry, x - light.x * rx * 0.2, y - light.y * ry * 0.2);
  fr.addColorStop(0, 'rgba(225,238,255,0.38)');
  fr.addColorStop(0.35, 'rgba(225,238,255,0.08)');
  fr.addColorStop(1, 'rgba(225,238,255,0)');
  ctx.fillStyle = fr;
  ctx.fillRect(x - R * 1.7, y - R * 3.5, R * 3.4, R * 7);
  // light focused inside the drop, opposite the sun
  const bx = x - light.x * rx * 0.5, by = y - light.y * ry * 0.5;
  const bg = ctx.createRadialGradient(bx, by, 0, bx, by, R * 0.6);
  bg.addColorStop(0, 'rgba(255,255,230,0.55)');
  bg.addColorStop(1, 'rgba(255,255,230,0)');
  ctx.fillStyle = bg;
  ctx.fillRect(x - R * 1.7, y - R * 3.5, R * 3.4, R * 7);
  ctx.restore();
  ctx.lineWidth = Math.max(0.4, R * 0.035);
  ctx.strokeStyle = 'rgba(4,10,2,0.3)';
  ctx.stroke();
  // specular highlights: sharp sun glint + soft window
  const hx = x + light.x * rx * 0.45, hy = y + light.y * ry * 0.45;
  const hr = Math.max(0.7, R * 0.16);
  const hg = ctx.createRadialGradient(hx, hy, 0, hx, hy, hr * 1.6);
  hg.addColorStop(0, 'rgba(255,255,255,1)');
  hg.addColorStop(0.3, 'rgba(255,255,255,0.9)');
  hg.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = hg;
  ctx.beginPath();
  ctx.ellipse(hx, hy, hr * 1.6, hr * 1.1, Math.atan2(light.y, light.x), 0, TAU);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.22)';
  ctx.beginPath();
  ctx.ellipse(x + light.x * rx * 0.05, y + light.y * ry * 0.66, rx * 0.36, ry * 0.09, 0, 0, TAU);
  ctx.fill();
  ctx.restore();
}

/** Teardrop outline for a pendant drop hanging from (x,y) with body radius r. */
export function pendantShape(x, y, r, stretch, beta) {
  return (ctx) => {
    const L = r * (0.85 + 0.55 * stretch);
    const neck = r * (0.55 - 0.2 * stretch);
    const cx = x + Math.sin(beta) * L, cy = y + Math.cos(beta) * L;
    ctx.moveTo(x - neck, y);
    ctx.bezierCurveTo(x - neck, y + L * 0.35, cx - r * 1.05, cy - r * 0.9, cx - r, cy);
    ctx.arc(cx, cy, r, Math.PI, 0, true);
    ctx.bezierCurveTo(cx + r * 1.05, cy - r * 0.9, x + neck, y + L * 0.35, x + neck, y);
    ctx.closePath();
  };
}

export { ST as DROP_STATE };
