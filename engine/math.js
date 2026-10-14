// Deterministic math helpers shared by every shot.
// Everything here is a pure function of its inputs so any frame can be
// rendered in any order (seek, export, contact sheet) and look identical.

export const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, k) => a + (b - a) * k;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const map = (v, a, b, c, d, doClamp = true) => {
  const k = invLerp(a, b, v);
  return lerp(c, d, doClamp ? clamp(k) : k);
};
export const smoothstep = (a, b, v) => {
  const k = clamp(invLerp(a, b, v));
  return k * k * (3 - 2 * k);
};
export const TAU = Math.PI * 2;

// ---------- easing ----------
const c1 = 1.70158, c3 = c1 + 1;
export const ease = {
  linear: (k) => k,
  inQuad: (k) => k * k,
  outQuad: (k) => 1 - (1 - k) * (1 - k),
  inOutQuad: (k) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2),
  inCubic: (k) => k * k * k,
  outCubic: (k) => 1 - Math.pow(1 - k, 3),
  inOutCubic: (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2),
  outQuart: (k) => 1 - Math.pow(1 - k, 4),
  inOutQuart: (k) => (k < 0.5 ? 8 * k ** 4 : 1 - Math.pow(-2 * k + 2, 4) / 2),
  outExpo: (k) => (k >= 1 ? 1 : 1 - Math.pow(2, -10 * k)),
  inExpo: (k) => (k <= 0 ? 0 : Math.pow(2, 10 * k - 10)),
  inOutExpo: (k) =>
    k <= 0 ? 0 : k >= 1 ? 1 : k < 0.5 ? Math.pow(2, 20 * k - 10) / 2 : (2 - Math.pow(2, -20 * k + 10)) / 2,
  outBack: (k) => 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2),
  inOutSine: (k) => -(Math.cos(Math.PI * k) - 1) / 2,
  outSine: (k) => Math.sin((k * Math.PI) / 2),
  // "Cinematic" ease: slow-in, long glide out — good for camera moves.
  cine: (k) => {
    k = clamp(k);
    return k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2 * (1 - 0.15 * (1 - k));
  },
};
for (const k of Object.keys(ease)) {
  const f = ease[k];
  ease[k] = (v) => f(clamp(v));
}

// ---------- seeded random ----------
export function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
export function rng(seed = 1) {
  let a = (typeof seed === 'string' ? hashString(seed) : seed >>> 0) || 1;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.range = (lo, hi) => lo + (hi - lo) * next();
  next.int = (lo, hi) => Math.floor(lo + (hi - lo + 1) * next());
  next.pick = (arr) => arr[Math.floor(next() * arr.length)];
  next.sign = () => (next() < 0.5 ? -1 : 1);
  // approx normal distribution
  next.gauss = (mu = 0, sd = 1) => {
    let u = 0, v = 0;
    while (u === 0) u = next();
    while (v === 0) v = next();
    return mu + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
  };
  return next;
}

// ---------- value noise (smooth, deterministic) ----------
function hash2(ix, iy, seed) {
  let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
export function noise2(x, y, seed = 0) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
  return lerp(lerp(a, b, ux), lerp(c, d, ux), uy) * 2 - 1; // -1..1
}
export function noise1(x, seed = 0) {
  return noise2(x, 0.5, seed);
}
export function fbm(x, y, seed = 0, oct = 4) {
  let amp = 0.5, f = 1, s = 0;
  for (let i = 0; i < oct; i++) {
    s += amp * noise2(x * f, y * f, seed + i * 17);
    f *= 2;
    amp *= 0.5;
  }
  return s;
}

// ---------- physics primitives (closed form, seekable) ----------

/**
 * Damped harmonic oscillator, analytic. Returns value going from `from` to `to`.
 * stiffness/damping/mass like react-spring / framer-motion.
 */
export function spring(t, { from = 0, to = 1, stiffness = 120, damping = 14, mass = 1, velocity = 0 } = {}) {
  if (t <= 0) return from;
  const x0 = from - to;
  const w0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  let x;
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    x = Math.exp(-zeta * w0 * t) * (x0 * Math.cos(wd * t) + ((velocity + zeta * w0 * x0) / wd) * Math.sin(wd * t));
  } else if (zeta === 1) {
    x = Math.exp(-w0 * t) * (x0 + (velocity + w0 * x0) * t);
  } else {
    const r1 = -w0 * (zeta - Math.sqrt(zeta * zeta - 1));
    const r2 = -w0 * (zeta + Math.sqrt(zeta * zeta - 1));
    const B = (velocity - r1 * x0) / (r2 - r1);
    const A = x0 - B;
    x = A * Math.exp(r1 * t) + B * Math.exp(r2 * t);
  }
  return to + x;
}

/**
 * Rigid object dropped onto a floor with restitution — piecewise ballistic,
 * exact bounces. Returns { y, vy, contact, squash, impacts:[times] }.
 * y measured downward like screen space: from `from` to `floor`.
 */
export function dropBounce(t, { from = 0, floor = 500, gravity = 4000, restitution = 0.35, minBounce = 6, v0 = 0 } = {}) {
  const impacts = [];
  if (t <= 0) return { y: from, vy: v0, contact: false, squash: 0, impacts };
  // first fall
  const h = floor - from;
  // solve from + v0 t + 0.5 g t^2 = floor
  const tImpact = (-v0 + Math.sqrt(v0 * v0 + 2 * gravity * h)) / gravity;
  if (t < tImpact) return { y: from + v0 * t + 0.5 * gravity * t * t, vy: v0 + gravity * t, contact: false, squash: 0, impacts };
  let tt = t - tImpact;
  let vUp = (v0 + gravity * tImpact) * restitution;
  let acc = tImpact;
  impacts.push(acc);
  while (vUp > Math.sqrt(2 * gravity * minBounce)) {
    const flight = (2 * vUp) / gravity;
    if (tt < flight) {
      const y = floor - (vUp * tt - 0.5 * gravity * tt * tt);
      const sinceImpact = tt;
      const sq = Math.exp(-sinceImpact * 30) * Math.min(1, vUp / 1500);
      return { y, vy: -vUp + gravity * tt, contact: false, squash: sq, impacts };
    }
    tt -= flight;
    acc += flight;
    impacts.push(acc);
    vUp *= restitution;
  }
  return { y: floor, vy: 0, contact: true, squash: Math.exp(-tt * 18) * 0.25, impacts };
}

/** Pendulum / settle swing: angle that decays like a hanging object released. */
export function pendulum(t, { amplitude = 0.3, period = 1.2, decay = 1.5 } = {}) {
  if (t <= 0) return amplitude;
  return amplitude * Math.exp(-decay * t) * Math.cos((TAU * t) / period);
}

// ---------- color ----------
export function hexToRgb(hex) {
  if (Array.isArray(hex)) return hex;
  let h = String(hex).replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function rgba(c, a = 1) {
  const [r, g, b] = hexToRgb(c);
  return `rgba(${r | 0},${g | 0},${b | 0},${a})`;
}
export function mix(c1, c2, k) {
  const a = hexToRgb(c1), b = hexToRgb(c2);
  return [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)];
}
export function shade(c, k) {
  // k>0 lighten toward white, k<0 darken toward black
  return k >= 0 ? mix(c, [255, 255, 255], k) : mix(c, [0, 0, 0], -k);
}
