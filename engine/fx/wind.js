// Shared wind field for nature scenes (world units: metres, seconds).
//
// The field is a pure function of (x, y, z, t) so every consumer — falling
// leaves, swaying reeds, the hero leaf, cat's-paw ripples in the water shader
// — sees the SAME gusts. Gust fronts travel downwind at `front` m/s, so a gust
// hits things on the upwind side first and visibly sweeps across the frame.
// Small-scale turbulence is "frozen" noise advected with the mean wind
// (Taylor's hypothesis), which is how real gusty air behaves at this scale.
import { rng, noise2 } from '../math.js';

export const MAX_GUSTS = 8;

/** Normalise user wind options into a config shared by JS and GLSL. */
export function makeWind(o = {}) {
  const speed = o.speed ?? 1.6; // mean wind, m/s
  const dir = o.dir ?? 0; // radians in the XZ plane, 0 = towards +X (screen right)
  const gustiness = o.gust ?? 0.8;
  let gusts = o.gusts;
  if (!gusts) {
    // automatic gusts from a seed: irregular, 2–4 s apart
    const r = rng(o.seed ?? 17);
    gusts = [];
    let t = r.range(0.4, 1.8);
    while (t < (o.until ?? 30) && gusts.length < MAX_GUSTS) {
      gusts.push({ t, amp: r.range(0.6, 1.4), dur: r.range(0.7, 1.6) });
      t += r.range(2.2, 4.2);
    }
  }
  gusts = gusts.slice(0, MAX_GUSTS).map((g) => ({ t: g.t, amp: g.amp ?? 1, dur: g.dur ?? 1.2 }));
  return {
    speed, dir, gustiness, gusts,
    dx: Math.cos(dir), dz: Math.sin(dir),
    front: o.front ?? speed * 1.3 + 2.5, // gust front propagation speed, m/s
    turbulence: o.turbulence ?? 0.35,
    seed: o.seed ?? 17,
  };
}

// Asymmetric gust bump: fast attack, slower decay (as measured gusts do).
export function gustBump(u) {
  return u < 0 ? Math.exp(-u * u * 7) : Math.exp(-u * u * 1.6);
}

/** Gust multiplier (>= 0) at a point and time. Mirrored exactly in the water shader. */
export function gustAt(w, x, z, t) {
  const xi = t - (x * w.dx + z * w.dz) / w.front;
  let g = 0;
  for (const q of w.gusts) g += q.amp * gustBump((xi - q.t) / q.dur);
  // continuous low-level breathing of the wind
  const b = 0.18 * Math.sin(xi * 1.3 + 0.7) + 0.12 * Math.sin(xi * 2.9 + 2.1);
  return Math.max(0.05, 1 + b + w.gustiness * g);
}

/** Wind velocity [wx, wy, wz] in m/s at a world point. */
export function windAt(w, x, y, z, t) {
  const S = w.speed * gustAt(w, x, z, t);
  // frozen turbulence advected by the mean flow
  const ax = x - w.dx * w.speed * t, az = z - w.dz * w.speed * t;
  const k = 1.4;
  const tu = w.turbulence * S;
  const n1 = noise2(ax * k + 0.31 * t, az * k + y * 0.7, w.seed);
  const n2 = noise2(az * k - 0.27 * t, ax * k + y * 0.9, w.seed + 7);
  const n3 = noise2(ax * k * 0.8 + y, az * k * 0.8 + 0.4 * t, w.seed + 13);
  return [S * w.dx + tu * n1, tu * 0.55 * n3, S * w.dz + tu * n2];
}

/** Uniform payload for the GLSL mirror of gustAt(). */
export function windUniforms(w) {
  const g = new Float32Array(MAX_GUSTS * 4);
  w.gusts.forEach((q, i) => { g[i * 4] = q.t; g[i * 4 + 1] = q.amp; g[i * 4 + 2] = q.dur; });
  return { gusts: g, n: w.gusts.length, params: [w.speed, w.dx, w.dz, w.gustiness], front: w.front };
}

export const GLSL_WIND = `
uniform vec4 uGusts[${MAX_GUSTS}];
uniform int uNGusts;
uniform vec4 uWind;   // speed, dirX, dirZ, gustiness
uniform float uFront;
float gustBump(float u) { return u < 0.0 ? exp(-u*u*7.0) : exp(-u*u*1.6); }
float gustAt(vec2 p, float t) {
  float xi = t - (p.x*uWind.y + p.y*uWind.z) / uFront;
  float g = 0.0;
  for (int i = 0; i < ${MAX_GUSTS}; i++) {
    if (i >= uNGusts) break;
    g += uGusts[i].y * gustBump((xi - uGusts[i].x) / uGusts[i].z);
  }
  float b = 0.18*sin(xi*1.3+0.7) + 0.12*sin(xi*2.9+2.1);
  return max(0.05, 1.0 + b + uWind.w * g);
}
`;
