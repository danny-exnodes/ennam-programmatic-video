// Vegetation in the wind: falling leaves, reeds / grass blades.
//
// Falling leaves use a quasi-steady thin-plate aerodynamics model (after
// Andersen, Pesavento & Wang 2005): anisotropic quadratic drag (broadside ≫
// edgewise), a pitching torque that turns the plate broadside to the relative
// flow, and rotational damping. Integrated in the RELATIVE air flow from the
// shared wind field, this produces the real behaviours — side-to-side
// fluttering glides, occasional tumbling, being swept away by a gust — rather
// than scripted sine wobbles. Leaves that reach the water float, drift with
// the current and leave ripple impulses for the water simulation.
//
// Reeds are damped oscillators driven by quadratic wind drag, so a gust front
// visibly ripples through a row of blades from the upwind side.
import { rng, clamp, rgba, mix, TAU, noise2 } from '../math.js';
import { windAt } from './wind.js';

const DT = 1 / 240;
const G = 9.81;
const cache = new Map();
function cached(key, fn) {
  let v = cache.get(key);
  if (!v) {
    v = fn();
    cache.set(key, v);
    if (cache.size > 40) cache.delete(cache.keys().next().value);
  }
  return v;
}
export function clearFoliageCache() {
  cache.clear();
}
// Cache keys are EXACT (full-precision JSON, which round-trips doubles) and
// cover every input the simulation reads. Rounded keys made two slightly
// different specs (e.g. a leaf area that follows a slowly moving camera) share
// the result of whichever was simulated FIRST, so a frame depended on what had
// been rendered before it (#18).
const keyOf = (o) => JSON.stringify(o);
/** every wind field windAt() reads */
const windKey = (w) => [w.speed, w.dx, w.dz, w.front, w.gusts, w.gustiness, w.turbulence, w.seed];

export const LEAF_PALETTES = {
  autumn: ['#c8641c', '#e0a030', '#a8401a', '#d48a28', '#8a5a22', '#e6b84a'],
  green: ['#5f8a2e', '#7aa23a', '#4e7426', '#8fb04a', '#6b9431'],
  spring: ['#9cc24a', '#b6d65e', '#7fae3c', '#cfe27a'],
  mixed: ['#7aa23a', '#c8941c', '#5f8a2e', '#d27426', '#a8b440', '#8a5a22'],
};

// ------------------------------------------------------------ falling ----
/**
 * Simulate falling leaves. All units metres / seconds.
 * o: { count, start, end, area:{x:[a,b], y:[a,b], z:[a,b]}, size:[a,b] (half-length m),
 *      seed, flutter (0..2), water:{ farZ, flow:[fx,fz] } | null, until }
 */
export function simulateLeaves(o, wind) {
  const key = 'leaves:' + keyOf({ o, w: windKey(wind) });
  return cached(key, () => {
    const r = rng(o.seed ?? 3);
    const n = o.count ?? 16;
    const [t0, t1] = [o.start ?? -4, o.end ?? 8];
    const until = o.until ?? t1 + 6;
    const area = o.area;
    const pal = Array.isArray(o.colors) ? o.colors : LEAF_PALETTES[o.colors || 'autumn'];
    const water = o.water;
    const leaves = [];
    const events = [];
    for (let i = 0; i < n; i++) {
      const birth = t0 + ((i + r()) / n) * (t1 - t0);
      const L = r.range(...(o.size ?? [0.025, 0.045]));
      const lf = {
        i, birth, L,
        aspect: r.range(0.42, 0.62),
        shape: r.int(0, 2),
        color: r.pick(pal),
        color2: r.pick(pal),
        spot: r(),
        curl: r.range(-0.35, 0.35),
      };
      // aerodynamic coefficients (per unit mass). Terminal broadside speed
      // sqrt(g/Kn) ≈ 0.7–1.2 m/s like real leaves.
      const Kn = r.range(7, 16) / (0.035 / L) ** 0.3;
      const Kt = Kn * r.range(0.025, 0.04);
      const Ktau = (r.range(0.6, 1.2) / L) * (o.flutter ?? 1);
      const Kw = 1;
      const lift = r.range(0.1, 0.3);
      const tumbleBias = r() < (o.tumble ?? 0.2);
      // quadratic rotational damping selects the regime: high = fluttering
      // limit cycle (±60–80°), low = tumbling (Andersen et al. phase diagram)
      const Kq = tumbleBias ? r.range(0.25, 0.4) : r.range(1, 2.5);
      let X = r.range(area.x[0], area.x[1]);
      let Y = r.range(area.y[0], area.y[1]);
      let Z = r.range(area.z[0], area.z[1]);
      let vs = 0, vy = -0.3, vq = 0;
      let th = r.range(-0.6, 0.6), om = tumbleBias ? r.range(6, 10) * r.sign() : r.range(-2, 2);
      let psi = r.range(0, TAU), psiRate = r.range(-0.6, 0.6);
      let zeta = r.range(0, TAU), zetaRate = r.range(-1.2, 1.2);
      // pre-roll so the leaf enters the frame already flying naturally
      const steps = Math.ceil((until - birth) / DT);
      const buf = new Float32Array(steps * 8);
      let floating = false, gone = steps;
      let fx = 0, fz = 0;
      for (let k = 0; k < steps; k++) {
        const t = birth + k * DT;
        const ex = Math.cos(psi), ez = Math.sin(psi);
        const o8 = k * 8;
        buf[o8] = X; buf[o8 + 1] = Y; buf[o8 + 2] = Z; buf[o8 + 3] = th; buf[o8 + 4] = psi; buf[o8 + 5] = zeta;
        buf[o8 + 6] = floating ? 1 : 0; buf[o8 + 7] = Math.hypot(vs, vy);
        if (!floating) {
          const w = windAt(wind, X, Y, Z, t);
          const ws = w[0] * ex + w[2] * ez, wq = -w[0] * ez + w[2] * ex;
          const us = vs - ws, uy = vy - w[1];
          const c = Math.cos(th), s = Math.sin(th);
          const ut = us * c + uy * s, un = -us * s + uy * c;
          // drag (broadside >> edgewise)
          const Fn = -Kn * Math.abs(un) * un, Ft = -Kt * Math.abs(ut) * ut;
          let as = Ft * c - Fn * s;
          let ay = Ft * s + Fn * c - G;
          // circulation lift ~ |u| sin(2α), perpendicular to relative flow
          const um = Math.hypot(us, uy) + 1e-6;
          const Fl = lift * Kn * (ut * un) / um;
          as -= Fl * (-uy / um);
          ay -= Fl * (us / um);
          // pitching moment turns the plate broadside to the flow + damping
          const tau = -Ktau * un * ut - Kw * om - Kq * om * Math.abs(om);
          vs += as * DT; vy += ay * DT; om += tau * DT; th += om * DT;
          if (th > Math.PI) th -= TAU;
          if (th < -Math.PI) th += TAU;
          // out-of-plane: carried by the cross wind
          const uq = vq - wq;
          vq += -Kn * 0.35 * Math.abs(uq) * uq * DT;
          // flutter plane slowly yaws with turbulence
          psiRate += (noise2(t * 0.9, i * 3.1, 11) * 2.2 - psiRate * 0.8) * DT;
          psi += psiRate * DT;
          zeta += zetaRate * DT;
          X += (vs * ex - vq * ez) * DT;
          Z += (vs * ez + vq * ex) * DT;
          Y += vy * DT;
          if (Y <= 0) {
            if (water && Z < water.farZ && Z > (water.nearZ ?? -1e9)) {
              floating = true;
              Y = 0;
              events.push({ t, x: X, z: Z, r: L * 0.6, amp: clamp(Math.abs(vy) * 0.06, 0.01, 0.06), kind: 'leaf', i });
              fx = vs * ex - vq * ez; fz = vs * ez + vq * ex;
            } else {
              gone = k;
              break;
            }
          }
        } else {
          // floating: relax to current + a little wind push, settle flat
          const w = windAt(wind, X, 0.02, Z, t);
          const tx = water.flow[0] + w[0] * 0.035, tz = water.flow[1] + w[2] * 0.035;
          fx += (tx - fx) * 2.2 * DT; fz += (tz - fz) * 2.2 * DT;
          X += fx * DT; Z += fz * DT;
          th += (0 - th) * 6 * DT;
          zeta += zetaRate * 0.25 * DT + noise2(t * 0.3, i, 5) * 0.4 * DT;
          vs = 0; vy = 0;
        }
      }
      lf.buf = buf;
      lf.steps = gone;
      leaves.push(lf);
    }
    return { leaves, events };
  });
}

export function sampleLeaf(lf, t) {
  const a = t - lf.birth;
  if (a < 0) return null;
  const f = a / DT;
  const i = Math.floor(f);
  if (i >= lf.steps - 1) return null;
  const k = f - i, b = lf.buf, p = i * 8, q = p + 8;
  const ang = (u, v) => {
    let d = v - u;
    if (d > Math.PI) d -= TAU;
    if (d < -Math.PI) d += TAU;
    return u + d * k;
  };
  return {
    x: b[p] + (b[q] - b[p]) * k, y: b[p + 1] + (b[q + 1] - b[p + 1]) * k, z: b[p + 2] + (b[q + 2] - b[p + 2]) * k,
    th: ang(b[p + 3], b[q + 3]), psi: ang(b[p + 4], b[q + 4]), zeta: b[p + 5] + (b[q + 5] - b[p + 5]) * k,
    floating: b[p + 6] > 0.5, speed: b[p + 7],
  };
}

// Leaf outline in local coords: midrib along x from -1 (stem) to +1 (tip).
// Memoised on the leaf object itself (which lives in the leaf-sim cache), i.e.
// keyed by the leaf's EXACT shape + aspect. It used to be a module-level cache
// keyed by aspect.toFixed(2): leaves whose aspects round to the same key then
// shared the outline of whichever leaf happened to be drawn FIRST, so a frame
// depended on which frames had been rendered before it (#18).
function leafPath(lf) {
  if (lf._path) return lf._path;
  const { shape, aspect } = lf;
  const N = 28;
  const pts = [];
  for (let i = 0; i <= N; i++) {
    const u = i / N; // 0 stem .. 1 tip
    let w;
    if (shape === 0) w = Math.pow(Math.sin(Math.PI * Math.pow(u, 0.85)), 0.9); // ovate
    else if (shape === 1) w = Math.pow(Math.sin(Math.PI * u), 1.3) * (1 + 0.25 * Math.sin(u * 14)); // lobed-ish (oak/maple feel)
    else w = Math.pow(Math.sin(Math.PI * Math.pow(u, 0.7)), 1.6); // lanceolate (willow)
    pts.push([u * 2 - 1, w * aspect]);
  }
  const path = new Path2D();
  path.moveTo(-1, 0);
  for (const [x, y] of pts) path.lineTo(x, -y);
  for (let i = pts.length - 1; i >= 0; i--) path.lineTo(pts[i][0], pts[i][1]);
  path.closePath();
  const veins = new Path2D();
  veins.moveTo(-1.15, 0);
  veins.lineTo(0.98, 0);
  for (let j = 1; j <= 5; j++) {
    const u0 = -0.8 + j * 0.3;
    const wv = aspect * 0.8 * Math.sin(Math.PI * ((u0 + 1) / 2 + 0.12));
    veins.moveTo(u0, 0);
    veins.quadraticCurveTo(u0 + 0.18, -wv * 0.6, u0 + 0.32, -wv);
    veins.moveTo(u0, 0);
    veins.quadraticCurveTo(u0 + 0.18, wv * 0.6, u0 + 0.32, wv);
  }
  const p = { path, veins };
  Object.defineProperty(lf, '_path', { value: p, enumerable: false });
  return p;
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scl = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export { sub, add, scl, dot, cross };

/** 3D frame of a leaf from its sim state. */
export function leafFrame(st) {
  const e = [Math.cos(st.psi), 0, Math.sin(st.psi)];
  const span = [-e[2], 0, e[0]];
  const c = Math.cos(st.th), s = Math.sin(st.th);
  const tan = [c * e[0], s, c * e[2]];
  const cz = Math.cos(st.zeta), sz = Math.sin(st.zeta);
  const m = add(scl(tan, cz), scl(span, sz));
  const w = add(scl(tan, -sz), scl(span, cz));
  const n = cross(m, w);
  return { m, w, n };
}

/**
 * Draw one leaf given its 3D frame. project: (x,y,z) -> [sx,sy,depth].
 * light: { dir (world, towards sun), color }, camPos for view vector.
 */
export function drawLeaf3D(ctx, lf, pos, fr, project, light, camPos, o = {}) {
  const pc = project(pos[0], pos[1], pos[2]);
  if (!(pc[2] > 0.05)) return;
  const pm = project(...add(pos, scl(fr.m, lf.L)));
  const pw = project(...add(pos, scl(fr.w, lf.L)));
  const ax = pm[0] - pc[0], ay = pm[1] - pc[1], bx = pw[0] - pc[0], by = pw[1] - pc[1];
  const det = ax * by - ay * bx;
  const sizePx = Math.hypot(ax, ay);
  if (sizePx < 0.6) return;
  const view = sub(camPos, pos);
  const vl = Math.hypot(...view);
  const vn = dot(fr.n, view) / vl;
  const ln = dot(fr.n, light.dir);
  const front = vn * ln > 0; // lit side faces camera
  const diff = Math.abs(ln);
  const base = lf.color;
  let col, glow = 0;
  if (front) col = mix(mix(base, '#000000', 0.55), base, clamp(0.25 + 0.95 * diff));
  else {
    // back-lit: light transmitted through the lamina (warm, saturated)
    glow = clamp(diff * 1.1) * (light.translucency ?? 1);
    col = mix(mix(base, '#000000', 0.5), mix(base, '#fff2a0', 0.35), clamp(0.2 + 0.9 * glow));
  }
  const { path, veins } = leafPath(lf);
  ctx.save();
  ctx.globalAlpha *= o.alpha ?? 1;
  ctx.transform(ax, ay, bx, by, pc[0], pc[1]);
  // gradient along the midrib: base slightly darker, colour variation
  const g = ctx.createLinearGradient(-1, 0, 1, 0);
  g.addColorStop(0, rgba(mix(col, '#000000', 0.18)));
  g.addColorStop(0.5 + 0.3 * (lf.spot - 0.5), rgba(col));
  g.addColorStop(1, rgba(mix(col, mix(lf.color2, '#000000', 0.3), 0.45)));
  ctx.fillStyle = g;
  ctx.fill(path);
  if (sizePx > 7) {
    // veins: lighter when back-lit (thinner tissue glows), darker when front-lit
    ctx.lineWidth = 0.035;
    ctx.strokeStyle = front ? rgba('#2a1a08', 0.28) : rgba('#fff4c0', 0.25 + 0.3 * glow);
    ctx.stroke(veins);
    // edge darkening for depth
    ctx.lineWidth = 0.05;
    ctx.strokeStyle = rgba(mix(col, '#000000', 0.5), 0.35);
    ctx.stroke(path);
  }
  // glossy sheen when front lit and near the mirror direction
  if (front && sizePx > 5) {
    const h = add(scl(view, 1 / vl), light.dir);
    const hl = Math.hypot(...h) || 1;
    const spec = Math.pow(Math.abs(dot(fr.n, h)) / hl, 30) * 0.6;
    if (spec > 0.02) {
      ctx.fillStyle = rgba('#ffffff', spec * (o.gloss ?? 0.7));
      ctx.fill(path);
    }
  }
  // stem
  if (sizePx > 4) {
    ctx.lineWidth = 0.06;
    ctx.strokeStyle = rgba(mix(base, '#3a2a10', 0.6), 0.9);
    ctx.beginPath();
    ctx.moveTo(-1, 0);
    ctx.lineTo(-1.28, 0.04 * Math.sign(det || 1));
    ctx.stroke();
  }
  ctx.restore();
}

// --------------------------------------------------------------- reeds ---
/**
 * Reed / grass blades along a bank. o: { x:[a,b], z:[a,b], count, height:[a,b],
 * baseY, color, seed, stiffness }
 */
export function simulateReeds(o, wind, until) {
  const key = 'reeds:' + keyOf({ o, until, w: windKey(wind) });
  return cached(key, () => {
    const r = rng(o.seed ?? 8);
    const n = o.count ?? 40;
    const blades = [];
    const dt = 1 / 120;
    const steps = Math.ceil(((until ?? 10) + 2) / dt);
    for (let i = 0; i < n; i++) {
      const b = {
        x: r.range(o.x[0], o.x[1]), z: r.range(o.z[0], o.z[1]),
        h: r.range(...(o.height ?? [0.4, 0.9])),
        w: r.range(0.006, 0.014) * (o.width ?? 1),
        lean: r.range(-0.25, 0.25),
        tone: r(),
        hue: r(),
      };
      const w0 = r.range(5.5, 9) * (o.stiffness ?? 1) / Math.sqrt(b.h / 0.6); // rad/s
      const zeta = 0.12;
      const k = (o.flex ?? 1) * 0.022 / (b.h + 0.2);
      let d = 0, v = 0, dz = 0, vz = 0;
      const buf = new Float32Array(steps * 2);
      // start from equilibrium with the mean wind to avoid a start-up twitch
      for (let s = -240; s < steps; s++) {
        const t = s * dt;
        const w = windAt(wind, b.x, b.h * 0.7, b.z, t);
        const fx = k * Math.abs(w[0]) * w[0], fz = k * Math.abs(w[2]) * w[2];
        v += (-w0 * w0 * (d - fx) - 2 * zeta * w0 * v) * dt;
        vz += (-w0 * w0 * (dz - fz) - 2 * zeta * w0 * vz) * dt;
        d += v * dt; dz += vz * dt;
        if (s >= 0) { buf[s * 2] = d; buf[s * 2 + 1] = dz; }
      }
      b.buf = buf;
      b.steps = steps;
      blades.push(b);
    }
    return { blades, dt };
  });
}

export function drawReeds(ctx, R, t, project, light, o = {}) {
  const { blades, dt } = R;
  const idx = clamp(t / dt, 0, R.blades[0]?.steps - 2 || 0);
  const i0 = Math.floor(idx), k = idx - i0;
  const baseY = o.baseY ?? 0;
  const items = [];
  for (const b of blades) {
    const p0 = project(b.x, baseY, b.z);
    if (!(p0[2] > 0.05)) continue;
    items.push([p0[2], b]);
  }
  items.sort((a, b) => b[0] - a[0]);
  for (const [, b] of items) {
    const d = b.buf[i0 * 2] * (1 - k) + b.buf[i0 * 2 + 2] * k + b.lean;
    const dz = b.buf[i0 * 2 + 1] * (1 - k) + b.buf[i0 * 2 + 3] * k;
    const N = 9;
    const left = [], right = [];
    for (let j = 0; j <= N; j++) {
      const u = j / N;
      // cantilever bending: deflection ~ u², length roughly preserved
      const bend = d * u * u;
      const bz = dz * u * u * 0.5;
      const yy = baseY + b.h * u * Math.sqrt(Math.max(0.2, 1 - (d * u) ** 2 * 0.5));
      const P = project(b.x + bend * b.h, yy, b.z + bz * b.h);
      const P2 = project(b.x + bend * b.h + b.w * (1 - u * 0.92), yy, b.z + bz * b.h);
      const wpx = Math.max(0.5, Math.hypot(P2[0] - P[0], P2[1] - P[1]));
      left.push([P[0] - wpx / 2, P[1]]);
      right.push([P[0] + wpx / 2, P[1]]);
    }
    const col = mix(o.color ?? '#46602a', o.color2 ?? '#8a9a48', b.tone * 0.7);
    const top = left[N], bot = left[0];
    const g = ctx.createLinearGradient(bot[0], bot[1], top[0], top[1]);
    g.addColorStop(0, rgba(mix(col, '#000000', 0.55), o.alpha ?? 1));
    g.addColorStop(0.6, rgba(col, o.alpha ?? 1));
    g.addColorStop(1, rgba(mix(col, '#f6e8a0', 0.35 * (light?.rim ?? 1)), o.alpha ?? 1));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(left[0][0], left[0][1]);
    for (const p of left) ctx.lineTo(p[0], p[1]);
    for (let j = right.length - 1; j >= 0; j--) ctx.lineTo(right[j][0], right[j][1]);
    ctx.closePath();
    ctx.fill();
  }
}
