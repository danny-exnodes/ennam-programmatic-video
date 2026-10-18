// Physical atmospheric sky + two lit cloud layers (issue #39).
//
// Written from the published methods (no third-party code was copied or translated):
//  - S. Hillaire, "A Scalable and Production Ready Sky and Atmosphere Rendering
//    Technique", EGSR 2020: transmittance LUT, multiple-scattering LUT
//    (ψms = L2nd / (1 − fms), isotropic second order), sky-view LUT with a
//    horizon-biased latitude mapping; Earth medium values (Rayleigh, Mie, ozone).
//  - E. Bruneton, F. Neyret, "Precomputed Atmospheric Scattering", EGSR 2008:
//    the (r, μ) ↔ uv parameterisation of the transmittance LUT.
//  - Phase functions: Rayleigh 3/(16π)(1+cos²θ); Mie as Cornette–Shanks
//    (Henyey–Greenstein family) — clouds use HG lobes.
//  - Clouds: two thin layers (cumulus ~1.5 km, cirrus ~8 km) on a tileable
//    noise texture; Beer–Lambert self-shadowing from a few light-march samples
//    toward the sun; multiple scattering approximated by the octave sum of
//    Wrenninge et al., "Oz: The Great and Volumetric" (SIGGRAPH 2013 talk).
//
// Determinism & caching (#18): every LUT is a pure function of its inputs and is
// cached under an EXACT key (JSON of the exact numbers it reads). The LUT math
// runs once per (sun elevation, haze) in JS so the very same arrays feed every
// WebGL2 context that needs them (sky pass, landscape pass) and the CPU fallback.
// The cloud noise tile is constant (computed once per page). Per frame, clouds
// are sampled from it at an offset that is a pure function of t and the wind.
import { getPass, compositeBlurred, makeCanvas } from './glkit.js';

// ------------------------------------------------------------ presets ----
const DEG = Math.PI / 180;
/** timeOfDay presets: sun elevation (radians) + haze (0 clear … 1 very hazy). */
export const TIME_OF_DAY = {
  dawn: { elevation: -1.2 * DEG, haze: 0.5 },
  morning: { elevation: 16 * DEG, haze: 0.35 },
  noon: { elevation: 62 * DEG, haze: 0.2 },
  golden: { elevation: 6 * DEG, haze: 0.4 },
  sunset: { elevation: 1 * DEG, haze: 0.45 },
  blue: { elevation: -5 * DEG, haze: 0.3 },
};

/**
 * Physical-sky options from s.nature(o), or null for the legacy 2-colour sky.
 * Physical when `o.timeOfDay` / `o.sky.timeOfDay` is set or `o.sky.model === 'physical'`.
 */
export function physicalSkyOptions(o = {}) {
  const sk = o.sky || {};
  const tod = o.timeOfDay ?? sk.timeOfDay;
  if (!tod && sk.model !== 'physical') return null;
  const pre = TIME_OF_DAY[tod] || TIME_OF_DAY.golden;
  const cl = sk.clouds;
  return {
    timeOfDay: tod || null,
    elevation: o.sun?.elevation ?? pre.elevation,
    haze: Math.min(1, Math.max(0, sk.haze ?? pre.haze)),
    clouds: cl === false ? null : (cl && typeof cl === 'object' ? cl : cl == null ? undefined : { cover: +cl }),
    res: sk.res,
    renderer: sk.renderer,
    blur: sk.blur,
  };
}

// --------------------------------------------------------- atmosphere ----
// Units: km. Earth values from Hillaire 2020 (scattering/absorption per m ×1000).
const RB = 6360, RT = 6460, HCAM = 0.1, HLO = 1.5, HHI = 8;
const RAY = [5.802e-3, 13.558e-3, 33.1e-3], RAY_H = 8;
const MIE_S = 3.996e-3, MIE_E = 4.4e-3, MIE_H = 1.2;
const OZO = [0.65e-3, 1.881e-3, 0.085e-3];
const ALBEDO = 0.3;
const HH = Math.sqrt(RT * RT - RB * RB);
const TW = 128, TH = 32; // transmittance LUT (x_mu, x_r)
const MW = 24, MH = 24; // multiple scattering LUT (mu_s, h)
export const SKY_W = 96, SKY_H = 96; // sky-view LUT (azimuth from sun, latitude)

const mieScale = (haze) => 0.25 + 4 * Math.pow(haze, 1.5);
const mieG = (haze) => 0.76 + 0.06 * haze;

function distTop(r, mu) {
  const disc = r * r * (mu * mu - 1) + RT * RT;
  return Math.max(0, -r * mu + Math.sqrt(Math.max(0, disc)));
}
function groundDisc(r, mu) { return r * r * (mu * mu - 1) + RB * RB; }
function hitsGround(r, mu) { return mu < 0 && groundDisc(r, mu) >= 0; }
function distGround(r, mu) { return Math.max(0, -r * mu - Math.sqrt(Math.max(0, groundDisc(r, mu)))); }
/** Soft planet shadow: 0 below the geometric horizon, 1 above (sun disk ≈ 0.27°). */
function sunVisible(r, muS) {
  const muH = -Math.sqrt(Math.max(0, 1 - (RB / r) * (RB / r)));
  const x = (muS - muH) / 0.0094 + 0.5;
  return x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x);
}

function extinction(h, mk, o) {
  const r = Math.exp(-h / RAY_H), m = Math.exp(-h / MIE_H) * mk, oz = Math.max(0, 1 - Math.abs(h - 25) / 15);
  o[0] = RAY[0] * r + MIE_E * m + OZO[0] * oz;
  o[1] = RAY[1] * r + MIE_E * m + OZO[1] * oz;
  o[2] = RAY[2] * r + MIE_E * m + OZO[2] * oz;
  o[3] = r; o[4] = m; // densities (Rayleigh, Mie incl. haze scale)
}

/** Optical-depth march toward the top of the atmosphere (exact, no LUT). */
function transmittanceMarch(r, mu, mk, out, n = 40) {
  const d = distTop(r, mu), dt = d / n, e = [0, 0, 0, 0, 0];
  let t0 = 0, t1 = 0, t2 = 0;
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) * dt;
    const rr = Math.sqrt(r * r + t * t + 2 * r * mu * t);
    extinction(rr - RB, mk, e);
    t0 += e[0] * dt; t1 += e[1] * dt; t2 += e[2] * dt;
  }
  out[0] = Math.exp(-t0); out[1] = Math.exp(-t1); out[2] = Math.exp(-t2);
  return out;
}

function buildTransmittance(mk) {
  const T = new Float32Array(TW * TH * 3), o = [0, 0, 0];
  for (let j = 0; j < TH; j++) {
    const rho = HH * (j / (TH - 1));
    const r = Math.sqrt(rho * rho + RB * RB);
    const dmin = RT - r, dmax = rho + HH;
    for (let i = 0; i < TW; i++) {
      const d = dmin + (i / (TW - 1)) * (dmax - dmin);
      let mu = d === 0 ? 1 : (HH * HH - rho * rho - d * d) / (2 * r * d);
      mu = Math.max(-1, Math.min(1, mu));
      transmittanceMarch(r, mu, mk, o, 40);
      T.set(o, (j * TW + i) * 3);
    }
  }
  return T;
}

function lutT(T, r, mu, out) {
  const rho = Math.sqrt(Math.max(0, r * r - RB * RB));
  const d = distTop(r, mu), dmin = RT - r, dmax = rho + HH;
  const xm = Math.max(0, Math.min(1, (d - dmin) / Math.max(1e-6, dmax - dmin)));
  const xr = Math.max(0, Math.min(1, rho / HH));
  return bilerp3(T, TW, TH, xm * (TW - 1), xr * (TH - 1), out);
}

function bilerp3(A, w, h, fx, fy, out) {
  const x0 = Math.min(w - 2, Math.max(0, Math.floor(fx))), y0 = Math.min(h - 2, Math.max(0, Math.floor(fy)));
  const ax = Math.max(0, Math.min(1, fx - x0)), ay = Math.max(0, Math.min(1, fy - y0));
  const i00 = (y0 * w + x0) * 3, i10 = i00 + 3, i01 = i00 + w * 3, i11 = i01 + 3;
  for (let c = 0; c < 3; c++) {
    const a = A[i00 + c] + (A[i10 + c] - A[i00 + c]) * ax;
    const b = A[i01 + c] + (A[i11 + c] - A[i01 + c]) * ax;
    out[c] = a + (b - a) * ay;
  }
  return out;
}

// 32 fixed directions on the sphere (Fibonacci) for the multiple-scattering integral.
const SPH = (() => {
  const n = 32, out = [];
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n, rr = Math.sqrt(1 - y * y);
    out.push([Math.cos(ga * i) * rr, y, Math.sin(ga * i) * rr]);
  }
  return out;
})();

function buildMultiScatter(T, mk) {
  const M = new Float32Array(MW * MH * 3);
  const e = [0, 0, 0, 0, 0], ts = [0, 0, 0];
  const iso = 1 / (4 * Math.PI), N = 16;
  for (let j = 0; j < MH; j++) {
    const h = Math.max(0.01, (RT - RB) * (j / (MH - 1)) ** 2);
    const r = RB + h;
    for (let i = 0; i < MW; i++) {
      const muS = -1 + (2 * i) / (MW - 1);
      const sx = Math.sqrt(1 - muS * muS);
      const L = [0, 0, 0], F = [0, 0, 0];
      for (const dv of SPH) {
        const mu = dv[1], ds = dv[0] * sx + dv[1] * muS; // dir · sun (sun in the x-y plane)
        const g = hitsGround(r, mu);
        const tmax = g ? distGround(r, mu) : distTop(r, mu);
        const dt = tmax / N;
        let T0 = 1, T1 = 1, T2 = 1;
        for (let k = 0; k < N; k++) {
          const t = (k + 0.5) * dt;
          const rk = Math.sqrt(r * r + t * t + 2 * r * mu * t);
          const muk = (r * muS + t * ds) / rk;
          extinction(rk - RB, mk, e);
          const ss = [RAY[0] * e[3] + MIE_S * e[4], RAY[1] * e[3] + MIE_S * e[4], RAY[2] * e[3] + MIE_S * e[4]];
          lutT(T, rk, muk, ts);
          const vis = sunVisible(rk, muk);
          const Tk = [T0, T1, T2];
          for (let c = 0; c < 3; c++) {
            const st = Math.exp(-e[c] * dt), integ = (1 - st) / Math.max(e[c], 1e-9);
            L[c] += Tk[c] * ss[c] * ts[c] * vis * iso * integ;
            F[c] += Tk[c] * ss[c] * integ;
          }
          T0 *= Math.exp(-e[0] * dt); T1 *= Math.exp(-e[1] * dt); T2 *= Math.exp(-e[2] * dt);
        }
        if (g) {
          const muG = (r * muS + tmax * ds) / RB;
          lutT(T, RB, muG, ts);
          const k = Math.max(0, muG) * sunVisible(RB, muG) * ALBEDO / Math.PI;
          L[0] += T0 * ts[0] * k; L[1] += T1 * ts[1] * k; L[2] += T2 * ts[2] * k;
        }
      }
      const o = (j * MW + i) * 3;
      for (let c = 0; c < 3; c++) {
        const l2 = L[c] / SPH.length, fms = F[c] / SPH.length;
        M[o + c] = l2 / (1 - Math.min(0.99, fms));
      }
    }
  }
  return M;
}

function lutMS(M, r, muS, out) {
  const h = Math.max(0, r - RB) / (RT - RB);
  return bilerp3(M, MW, MH, (muS * 0.5 + 0.5) * (MW - 1), Math.sqrt(Math.max(0, Math.min(1, h))) * (MH - 1), out);
}

const phaseR = (c) => (3 / (16 * Math.PI)) * (1 + c * c);
const phaseM = (c, g) => {
  const g2 = g * g;
  return ((3 / (8 * Math.PI)) * (1 - g2) * (1 + c * c)) / ((2 + g2) * Math.pow(1 + g2 - 2 * g * c, 1.5));
};

function buildSkyView(T, M, el, mk, g) {
  const S = new Float32Array(SKY_W * SKY_H * 4);
  const e = [0, 0, 0, 0, 0], ts = [0, 0, 0], ms = [0, 0, 0];
  const r0 = RB + HCAM, muS = Math.sin(el), sx = Math.cos(el), N = 28;
  for (let j = 0; j < SKY_H; j++) {
    const v = j / (SKY_H - 1);
    const q = (v - 0.5) * 2;
    const lat = Math.sign(q) * q * q * (Math.PI / 2);
    const mu = Math.sin(lat), cl = Math.cos(lat);
    const g0 = hitsGround(r0, mu);
    const tmax = g0 ? distGround(r0, mu) : distTop(r0, mu);
    for (let i = 0; i < SKY_W; i++) {
      const u = i / (SKY_W - 1);
      const phi = Math.PI * u * u;
      const ds = cl * Math.cos(phi) * sx + mu * muS; // cos(view, sun)
      const pr = phaseR(ds), pm = phaseM(ds, g);
      let T0 = 1, T1 = 1, T2 = 1, L0 = 0, L1 = 0, L2 = 0, tPrev = 0;
      for (let k = 0; k < N; k++) {
        const tN = tmax * ((k + 1) / N) ** 2;
        const dt = tN - tPrev;
        const t = tPrev + dt * 0.3;
        tPrev = tN;
        const rk = Math.sqrt(r0 * r0 + t * t + 2 * r0 * mu * t);
        const muk = (r0 * muS + t * ds) / rk;
        extinction(rk - RB, mk, e);
        const sR = e[3], sM = MIE_S * e[4];
        lutT(T, rk, muk, ts);
        lutMS(M, rk, muk, ms);
        const vis = sunVisible(rk, muk);
        const a0 = Math.exp(-e[0] * dt), a1 = Math.exp(-e[1] * dt), a2 = Math.exp(-e[2] * dt);
        const s0 = (RAY[0] * sR * pr + sM * pm) * ts[0] * vis + (RAY[0] * sR + sM) * ms[0];
        const s1 = (RAY[1] * sR * pr + sM * pm) * ts[1] * vis + (RAY[1] * sR + sM) * ms[1];
        const s2 = (RAY[2] * sR * pr + sM * pm) * ts[2] * vis + (RAY[2] * sR + sM) * ms[2];
        L0 += T0 * s0 * (1 - a0) / e[0]; L1 += T1 * s1 * (1 - a1) / e[1]; L2 += T2 * s2 * (1 - a2) / e[2];
        T0 *= a0; T1 *= a1; T2 *= a2;
      }
      const o = (j * SKY_W + i) * 4;
      S[o] = L0; S[o + 1] = L1; S[o + 2] = L2; S[o + 3] = 1;
    }
  }
  return S;
}

// ----------------------------------------------------------- caches ----
const baseCache = new Map(); // haze → { T, M }
const skyCache = new Map(); // (elevation, haze) → atmosphere
function lruSet(m, k, v, max) { m.set(k, v); if (m.size > max) m.delete(m.keys().next().value); return v; }

function luminance(c) { return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }
function smooth(a, b, x) { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); }

/**
 * Atmosphere for a sun elevation (radians) and haze (0..1): sky-view LUT plus the
 * derived quantities shared by every consumer. Cached under the exact inputs.
 */
export function getAtmosphere(elevation, haze) {
  const key = JSON.stringify({ v: 1, el: elevation, haze });
  const hit = skyCache.get(key);
  if (hit) { skyCache.delete(key); skyCache.set(key, hit); return hit; }
  const mk = mieScale(haze), g = mieG(haze);
  const bk = JSON.stringify({ v: 1, haze });
  let base = baseCache.get(bk);
  if (!base) {
    const T = buildTransmittance(mk);
    base = lruSet(baseCache, bk, { T, M: buildMultiScatter(T, mk) }, 4);
  }
  const lut = buildSkyView(base.T, base.M, elevation, mk, g);
  const muS = Math.sin(elevation);
  const tr = (h) => {
    const r = RB + h, o = transmittanceMarch(r, muS, mk, [0, 0, 0], 48), v = sunVisible(r, muS);
    return [o[0] * v, o[1] * v, o[2] * v];
  };
  const sunCam = tr(HCAM), sunLo = tr(HLO + 0.4), sunHi = tr(HHI);
  // mean sky radiance over the upper hemisphere (solid-angle weighted)
  const avg = [0, 0, 0];
  let wsum = 0;
  for (let j = SKY_H / 2; j < SKY_H; j++) {
    const q = (j / (SKY_H - 1) - 0.5) * 2, lat = q * q * (Math.PI / 2);
    const dl = (2 * q * (Math.PI / 2)) * (2 / (SKY_H - 1)); // dlat/dj
    for (let i = 0; i < SKY_W; i++) {
      const u = i / (SKY_W - 1), du = 1 / (SKY_W - 1);
      const w = Math.cos(lat) * dl * (2 * Math.PI * u * du + 1e-4);
      const o = (j * SKY_W + i) * 4;
      avg[0] += lut[o] * w; avg[1] += lut[o + 1] * w; avg[2] += lut[o + 2] * w;
      wsum += w;
    }
  }
  for (let c = 0; c < 3; c++) avg[c] /= wsum;
  // auto exposure: map mean sky luminance to a key that drops after sunset
  const deg = elevation / DEG;
  const keyV = 0.05 + 0.08 * smooth(-7, 0, deg) + 0.17 * smooth(0, 25, deg);
  const exposure = Math.min(4000, keyV / Math.max(1e-7, luminance(avg)));
  // camera white balance after sunset (daylight-balanced film reads twilight as blue, not violet)
  const tw = smooth(0, -6, deg);
  const wb = [1 - 0.24 * tw, 1 - 0.06 * tw, 1 + 0.1 * tw];
  const ambTop = avg.map((c) => c * 1.1);
  const ambBot = sunCam.map((c, i) => c * Math.max(0, muS) * ALBEDO / Math.PI + avg[i] * ALBEDO * 0.6);
  const A = {
    key, elevation, haze, lut, exposure, wb, sunCam, sunLo, sunHi, ambTop, ambBot, avg,
    aerialKm: 22 / Math.sqrt(mk),
  };
  return lruSet(skyCache, key, A, 8);
}

// --------------------------------------------------------- cloud tile ----
// One constant RGBA8 tile (tileable): R cumulus shape (fbm + inverted Worley),
// G cumulus detail, B cirrus streaks (anisotropic, domain-warped), A cirrus fine.
// Each channel is histogram-equalised so `cover` maps ~linearly to sky coverage.
export const TILE = 512;
let tileData = null;
function hashP(ix, iy, px, py, s) {
  ix = ((ix % px) + px) % px; iy = ((iy % py) + py) % py;
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(s, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function vnP(x, y, px, py, s) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10), uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const a = hashP(ix, iy, px, py, s), b = hashP(ix + 1, iy, px, py, s);
  const c = hashP(ix, iy + 1, px, py, s), d = hashP(ix + 1, iy + 1, px, py, s);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
function fbmP(u, v, px, py, oct, s) {
  let sum = 0, amp = 0.5, norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += amp * vnP(u * px, v * py, px, py, s + i * 7);
    norm += amp; amp *= 0.5; px *= 2; py *= 2;
  }
  return sum / norm;
}
function worleyP(u, v, n, s) {
  const x = u * n, y = v * n, ix = Math.floor(x), iy = Math.floor(y);
  let best = 9;
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const cx = ix + i, cy = iy + j;
    const qx = cx + hashP(cx, cy, n, n, s), qy = cy + hashP(cx, cy, n, n, s + 1);
    const d = (qx - x) * (qx - x) + (qy - y) * (qy - y);
    if (d < best) best = d;
  }
  return Math.min(1, Math.sqrt(best));
}
function equalize(src, dst, ch) {
  const n = src.length, H = new Uint32Array(1024);
  for (let i = 0; i < n; i++) H[Math.min(1023, Math.max(0, Math.floor(src[i] * 1024)))]++;
  const cdf = new Float32Array(1024);
  let acc = 0;
  for (let i = 0; i < 1024; i++) { acc += H[i]; cdf[i] = acc / n; }
  for (let i = 0; i < n; i++) {
    const f = Math.min(1023.999, Math.max(0, src[i] * 1024)), k = Math.floor(f), a = f - k;
    const lo = k > 0 ? cdf[k - 1] : 0, hi = cdf[k];
    dst[i * 4 + ch] = Math.round(Math.min(1, lo + (hi - lo) * a) * 255);
  }
}
export function cloudTile() {
  if (tileData) return tileData;
  const N = TILE, n = N * N, out = new Uint8Array(n * 4);
  const a = new Float32Array(n), b = new Float32Array(n), c = new Float32Array(n), d = new Float32Array(n);
  for (let y = 0; y < N; y++) {
    const v = y / N;
    for (let x = 0; x < N; x++) {
      const u = x / N, i = y * N + x;
      const f = fbmP(u, v, 4, 4, 5, 11);
      const w = 1 - worleyP(u, v, 7, 3);
      a[i] = f * 0.55 + w * 0.45;
      b[i] = fbmP(u, v, 8, 8, 3, 29) * 0.6 + (1 - worleyP(u, v, 12, 5)) * 0.4;
      const wu = u + 0.12 * (fbmP(u, v, 3, 3, 3, 41) - 0.5);
      c[i] = fbmP(wu, v + 0.05 * (fbmP(u, v, 4, 4, 2, 43) - 0.5), 3, 10, 5, 47);
      d[i] = fbmP(u, v, 6, 40, 3, 53);
    }
  }
  equalize(a, out, 0); equalize(b, out, 1); equalize(c, out, 2); equalize(d, out, 3);
  tileData = out;
  return out;
}

// ------------------------------------------------------------- GLSL ----
// Shared sky + clouds shading GLSL (uniforms prefixed uP, functions ps* and physSky).
export const GLSL_PHYS_SKY = `
const float PS_PI = 3.14159265;
const float PS_RB = 6360.0, PS_HCAM = 0.1;
uniform sampler2D uPSkyLut, uPCloudTex;
uniform vec2 uPLutSize;
uniform vec3 uPSun, uPDisk, uPSunLo, uPSunHi, uPAmbTop, uPAmbBot;
uniform float uPExposure, uPPixAng, uPAerial;
uniform vec3 uPWb;
uniform vec4 uPCloud;   // cover, low, high, enabled
uniform vec4 uPDrift;   // low.xy, high.xy (km, pure function of t and wind)
uniform vec2 uPWind;    // unit wind direction (x, z)
vec3 psLut(vec3 d) {
  float lat = asin(clamp(d.y, -1.0, 1.0));
  float l = length(d.xz) * length(uPSun.xz);
  float cphi = l > 1e-6 ? dot(d.xz, uPSun.xz) / l : 1.0;
  float u = sqrt(acos(clamp(cphi, -1.0, 1.0)) / PS_PI);
  float v = 0.5 + 0.5 * sign(lat) * sqrt(abs(lat) / (0.5 * PS_PI));
  return texture(uPSkyLut, (vec2(u, v) * (uPLutSize - 1.0) + 0.5) / uPLutSize).rgb;
}
float psHG(float c, float g) { float g2 = g * g; return (1.0 - g2) / (4.0 * PS_PI * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5)); }
float psShell(float h, float dy) {
  float b = (PS_RB + PS_HCAM) * dy, c = (h - PS_HCAM) * (2.0 * PS_RB + h + PS_HCAM);
  return c / (sqrt(b * b + c) + b);
}
// cubic B-spline filtered tile lookup from 4 bilinear taps (no texel-grid staircase when magnified)
vec4 psCubic(vec2 uv) {
  vec2 st = uv * ${TILE}.0 - 0.5, i = floor(st), f = st - i;
  vec2 f2 = f * f, f3 = f2 * f;
  vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0, w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
  vec2 w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0, w3 = f3 / 6.0;
  vec2 g0 = w0 + w1, g1 = w2 + w3;
  vec2 h0 = (i - 0.5 + w1 / g0) / ${TILE}.0, h1 = (i + 1.5 + w3 / g1) / ${TILE}.0;
  return g0.y * (g0.x * texture(uPCloudTex, vec2(h0.x, h0.y)) + g1.x * texture(uPCloudTex, vec2(h1.x, h0.y)))
       + g1.y * (g0.x * texture(uPCloudTex, vec2(h0.x, h1.y)) + g1.x * texture(uPCloudTex, vec2(h1.x, h1.y)));
}
vec3 psAces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
// Returns display-linear colour (tonemapped, before the 1/2.2 gamma of toSrgb()).
vec3 physSky(vec3 d, float withClouds) {
  vec3 dd = normalize(vec3(d.x, max(d.y, 0.0) + 1e-4, d.z));
  vec3 col = psLut(dd) * uPExposure;
  float cs = dot(dd, uPSun);
  // sun disk with limb darkening, anti-aliased by the pixel's angular size
  float ang = acos(clamp(cs, -1.0, 1.0)), R = 0.0062;
  float disk = smoothstep(R + uPPixAng, R - uPPixAng, ang) * step(0.0, d.y);
  float q = clamp(ang / R, 0.0, 1.0);
  col += uPDisk * 9.0 * disk * (0.6 + 0.4 * sqrt(1.0 - q * q));
  if (withClouds > 0.5 && uPCloud.w > 0.5 && d.y > 0.0) {
    float hor = smoothstep(0.0, 0.1, d.y);
    // ---- high cirrus: thin, forward-scattering, lit by the sun at 8 km ----
    float dH = psShell(8.0, dd.y);
    vec2 pH = dd.xz * dH + uPDrift.zw;
    vec2 rH = vec2(pH.x * uPWind.x + pH.y * uPWind.y, -pH.x * uPWind.y + pH.y * uPWind.x);
    vec2 uvH = rH / vec2(70.0, 40.0);
    float ch = texture(uPCloudTex, uvH).b * 0.72 + texture(uPCloudTex, uvH * vec2(2.0, 3.0) + 0.37).a * 0.28;
    ch *= 0.55 + 0.6 * smoothstep(0.3, 0.8, texture(uPCloudTex, uvH * 0.31 + 0.53).r);
    float thrH = 1.0 - 0.55 * uPCloud.z;
    float wH = fwidth(ch);
    float aH = smoothstep(thrH - wH, thrH + 0.35 + wH, ch) * 0.5 * min(1.0, uPCloud.z * 1.6);
    aH *= exp(-dH / (uPAerial * 3.0)) * hor;
    vec3 LH = uPSunHi * (psHG(cs, 0.75) * 0.9 + psHG(cs, 0.1) * 0.6) * 2.4 + uPAmbTop * 0.9;
    col = mix(col, LH * uPExposure, aH);
    // ---- low cumulus: self-shadowed via light-march samples toward the sun ----
    float dL = psShell(1.5, dd.y);
    vec2 uvL = (dd.xz * dL + uPDrift.xy) / 16.0;
    float n = psCubic(uvL).r;
    float det = psCubic(uvL * 6.0 + 0.21).g;
    float thr = 1.0 - uPCloud.x;
    float nn = n - (1.0 - det) * 0.24 * (1.0 - smoothstep(thr, thr + 0.4, n));
    float wL = max(fwidth(nn) * 2.0, 0.022);
    float dens = smoothstep(thr - wL, thr + 0.18 + wL, nn);
    if (dens > 0.0) {
      vec2 sd = uPSun.xz; float sl = length(sd);
      sd = sl > 1e-4 ? sd / sl : vec2(1.0, 0.0);
      float cot = min(sl / max(uPSun.y, 0.02), 8.0);
      float core = smoothstep(thr, thr + 0.45, nn);
      float opt = core * 0.8 + (1.0 - det) * 0.3 * dens;
      for (int k = 1; k <= 3; k++) {
        float off = float(k) * (0.1 + 0.22 * cot);
        opt += smoothstep(thr, thr + 0.45, texture(uPCloudTex, uvL + sd * off / 16.0).r);
      }
      opt *= 0.9 + 0.12 * cot;
      vec3 Ls = vec3(0.0);
      float a = 1.0, b = 1.0, c = 1.0;
      for (int i = 0; i < 3; i++) {
        Ls += a * exp(-opt * 2.6 * b) * (psHG(cs, 0.6 * c) * 0.75 + psHG(cs, -0.2 * c) * 0.25);
        a *= 0.55; b *= 0.4; c *= 0.5;
      }
      float detS = texture(uPCloudTex, uvL * 6.0 + 0.21 + sd * 0.006).g;
      Ls *= 1.0 + 0.6 * clamp((det - detS) * 5.0, -1.0, 1.0) * core;
      vec3 LL = uPSunLo * Ls * 3.6 + uPAmbTop * (0.9 - 0.55 * core) + uPAmbBot * 0.5;
      float aL = (1.0 - exp(-dens * 7.0 * uPCloud.y)) * exp(-dL / uPAerial) * hor;
      col = mix(col, LL * uPExposure, aL);
    }
  }
  return psAces(col * uPWb);
}
`;

/** Unit wind direction + cloud drift offsets (km) — a pure function of t and the wind. */
function cloudState(info) {
  const A = info.atmo, cl = info.clouds;
  const w = info.wind || { dx: 1, dz: 0, speed: 1.6 };
  const sp = cl ? (cl.speed ?? 1) : 0;
  const t = info.time || 0;
  const seed = cl?.seed ?? 0;
  const so = [Math.sin(seed * 12.9898) * 37.1, Math.cos(seed * 78.233) * 41.3];
  const vLo = 0.012 * sp, vHi = 0.03 * sp; // km/s
  return {
    on: cl ? 1 : 0,
    cover: cl ? Math.max(0, Math.min(1, cl.cover ?? 0.4)) : 0,
    low: cl ? Math.max(0, Math.min(2, cl.low ?? 1)) : 0,
    high: cl ? Math.max(0, Math.min(1, cl.high ?? 0.3)) : 0,
    drift: [-w.dx * vLo * t + so[0], -w.dz * vLo * t + so[1], -w.dx * vHi * t - so[1], -w.dz * vHi * t + so[0]],
    wind: [w.dx, w.dz],
    A,
  };
}

/** Bind the physical sky textures + uniforms on a WebGL2 pass (texture units 2, 3). */
export function bindPhysSky(S, info, pixAng) {
  const { gl, U } = S;
  const A = info.atmo, C = cloudState(info);
  const st = S._psky || (S._psky = { lutKey: null, lut: gl.createTexture(), tile: null });
  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, st.lut);
  if (st.lutKey !== A.key) {
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, SKY_W, SKY_H, 0, gl.RGBA, gl.FLOAT, A.lut);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    st.lutKey = A.key;
  }
  gl.uniform1i(U.uPSkyLut, 2);
  gl.activeTexture(gl.TEXTURE3);
  if (!st.tile) {
    st.tile = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, st.tile);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, TILE, TILE, 0, gl.RGBA, gl.UNSIGNED_BYTE, cloudTile());
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.generateMipmap(gl.TEXTURE_2D);
    // isotropic trilinear on purpose: near the horizon the layer is strongly foreshortened and
    // the larger footprint is what keeps cloud edges from combing / flickering under a pan
  } else gl.bindTexture(gl.TEXTURE_2D, st.tile);
  gl.uniform1i(U.uPCloudTex, 3);
  gl.uniform2f(U.uPLutSize, SKY_W, SKY_H);
  gl.uniform3fv(U.uPSun, info.sun.dir);
  gl.uniform3fv(U.uPDisk, A.sunCam);
  gl.uniform3fv(U.uPSunLo, A.sunLo);
  gl.uniform3fv(U.uPSunHi, A.sunHi);
  gl.uniform3fv(U.uPAmbTop, A.ambTop);
  gl.uniform3fv(U.uPAmbBot, A.ambBot);
  gl.uniform1f(U.uPExposure, A.exposure);
  gl.uniform3fv(U.uPWb, A.wb);
  gl.uniform1f(U.uPPixAng, pixAng);
  gl.uniform1f(U.uPAerial, A.aerialKm);
  gl.uniform4f(U.uPCloud, C.cover, C.low, C.high, C.on);
  gl.uniform4fv(U.uPDrift, C.drift);
  gl.uniform2fv(U.uPWind, C.wind);
}

// ------------------------------------------------------- sky GL pass ----
const SKY_FS = `#version 300 es
precision highp float;
out vec4 outColor;
uniform vec2 uPix, uLogical; uniform float uScale;
uniform vec3 uCamF, uCamR, uCamU; uniform float uFocal, uMirror;
${GLSL_PHYS_SKY}
void main() {
  vec2 sp = vec2(gl_FragCoord.x, uPix.y - gl_FragCoord.y) / uScale;
  vec2 ndc = (sp - uLogical * 0.5) / uFocal;
  vec3 d = normalize(uCamF + ndc.x * uCamR - ndc.y * uCamU);
  if (uMirror > 0.5) d.y = -d.y;
  outColor = vec4(pow(physSky(d, 1.0), vec3(1.0 / 2.2)), 1.0);
}`;

/**
 * Draw the physical sky (full frame) into ctx. info: { cam, sun, atmo, clouds, wind, time }.
 * WebGL2 when available, CPU fallback otherwise (or with sky.renderer === 'cpu').
 */
export function renderPhysSky(ctx, info, mirror, outW, outH, blurPx, o = {}) {
  const cam = info.cam;
  if (o.renderer !== 'cpu') {
    try {
      const res = o.res ?? (blurPx > 3 ? 0.35 : 0.5);
      const w = Math.max(2, Math.round(outW * res)), h = Math.max(2, Math.round(outH * res));
      const S = getPass('physsky', w, h, SKY_FS);
      const { gl, U } = S;
      S.begin();
      gl.uniform2f(U.uPix, w, h);
      gl.uniform2f(U.uLogical, cam.W, cam.H);
      gl.uniform1f(U.uScale, w / cam.W);
      gl.uniform3fv(U.uCamF, cam.F);
      gl.uniform3fv(U.uCamR, cam.R);
      gl.uniform3fv(U.uCamU, cam.U);
      gl.uniform1f(U.uFocal, cam.f);
      gl.uniform1f(U.uMirror, mirror ? 1 : 0);
      bindPhysSky(S, info, cam.W / w / cam.f);
      S.draw();
      compositeBlurred(ctx, S.canvas, outW, outH, blurPx, mirror ? 'psm' : 'ps');
      return;
    } catch { /* no WebGL2 → CPU fallback below */ }
  }
  renderPhysSkyCPU(ctx, info, mirror, outW, outH, blurPx, o);
}

// ------------------------------------------------------- CPU fallback ----
// Same model evaluated in JS at reduced resolution (no WebGL2 in the page).
const aces = (x) => Math.max(0, Math.min(1, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)));
const hg = (c, g) => (1 - g * g) / (4 * Math.PI * Math.pow(Math.max(1e-4, 1 + g * g - 2 * g * c), 1.5));
const sstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

function lutSample(A, sunDir, d, out) {
  const lat = Math.asin(Math.max(-1, Math.min(1, d[1])));
  const l = Math.hypot(d[0], d[2]) * Math.hypot(sunDir[0], sunDir[2]);
  const cphi = l > 1e-6 ? (d[0] * sunDir[0] + d[2] * sunDir[2]) / l : 1;
  const u = Math.sqrt(Math.acos(Math.max(-1, Math.min(1, cphi))) / Math.PI);
  const v = 0.5 + 0.5 * Math.sign(lat) * Math.sqrt(Math.abs(lat) / (Math.PI / 2));
  const fx = u * (SKY_W - 1), fy = v * (SKY_H - 1);
  const x0 = Math.min(SKY_W - 2, Math.floor(fx)), y0 = Math.min(SKY_H - 2, Math.floor(fy));
  const ax = fx - x0, ay = fy - y0, L = A.lut;
  for (let c = 0; c < 3; c++) {
    const i00 = (y0 * SKY_W + x0) * 4 + c, i10 = i00 + 4, i01 = i00 + SKY_W * 4, i11 = i01 + 4;
    const a = L[i00] + (L[i10] - L[i00]) * ax, b = L[i01] + (L[i11] - L[i01]) * ax;
    out[c] = a + (b - a) * ay;
  }
  return out;
}

let mips = null;
function tileMips() {
  if (mips) return mips;
  mips = [{ n: TILE, d: cloudTile() }];
  while (mips[mips.length - 1].n > 4) {
    const p = mips[mips.length - 1], n = p.n >> 1, d = new Uint8Array(n * n * 4);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) for (let c = 0; c < 4; c++) {
      const s = (yy, xx) => p.d[(yy * p.n + xx) * 4 + c];
      d[(y * n + x) * 4 + c] = (s(2 * y, 2 * x) + s(2 * y, 2 * x + 1) + s(2 * y + 1, 2 * x) + s(2 * y + 1, 2 * x + 1) + 2) >> 2;
    }
    mips.push({ n, d });
  }
  return mips;
}
function tileAt(u, v, ch, lod) {
  const M = tileMips(), m = M[Math.max(0, Math.min(M.length - 1, Math.round(lod)))];
  const n = m.n, fx = (u - Math.floor(u)) * n - 0.5, fy = (v - Math.floor(v)) * n - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy), ax = fx - x0, ay = fy - y0;
  const g = (x, y) => m.d[((((y % n) + n) % n) * n + (((x % n) + n) % n)) * 4 + ch];
  const a = g(x0, y0) + (g(x0 + 1, y0) - g(x0, y0)) * ax, b = g(x0, y0 + 1) + (g(x0 + 1, y0 + 1) - g(x0, y0 + 1)) * ax;
  return (a + (b - a) * ay) / 255;
}
function shell(h, dy) {
  const b = (RB + HCAM) * dy, c = (h - HCAM) * (2 * RB + h + HCAM);
  return c / (Math.sqrt(b * b + c) + b);
}

/** CPU evaluation of physSky() (display-linear RGB). Clouds use a footprint-chosen mip. */
export function physSkyJS(info, d, withClouds, pixAng, out = [0, 0, 0]) {
  const A = info.atmo, sun = info.sun.dir;
  const dd = [d[0], Math.max(d[1], 0) + 1e-4, d[2]];
  const l = Math.hypot(dd[0], dd[1], dd[2]);
  dd[0] /= l; dd[1] /= l; dd[2] /= l;
  const col = lutSample(A, sun, dd, [0, 0, 0]);
  for (let c = 0; c < 3; c++) col[c] *= A.exposure;
  const cs = dd[0] * sun[0] + dd[1] * sun[1] + dd[2] * sun[2];
  const ang = Math.acos(Math.max(-1, Math.min(1, cs))), R = 0.0062;
  const disk = sstep(R + pixAng, R - pixAng, ang) * (d[1] >= 0 ? 1 : 0);
  if (disk > 0) { const q = Math.min(1, ang / R); for (let c = 0; c < 3; c++) col[c] += A.sunCam[c] * 9 * disk * (0.6 + 0.4 * Math.sqrt(1 - q * q)); }
  const C = withClouds ? cloudState(info) : null;
  if (C && C.on && d[1] > 0) {
    const hor = sstep(0, 0.1, d[1]);
    const dH = shell(8, dd[1]);
    const px = dd[0] * dH + C.drift[2], pz = dd[2] * dH + C.drift[3];
    const rx = px * C.wind[0] + pz * C.wind[1], rz = -px * C.wind[1] + pz * C.wind[0];
    const lodH = Math.log2(Math.max(1, (dH * pixAng / Math.max(dd[1], 0.05)) / 40 * TILE));
    let ch = tileAt(rx / 70, rz / 40, 2, lodH) * 0.72 + tileAt(rx / 70 * 2 + 0.37, rz / 40 * 3 + 0.37, 3, lodH + 1.5) * 0.28;
    ch *= 0.55 + 0.6 * sstep(0.3, 0.8, tileAt(rx / 70 * 0.31 + 0.53, rz / 40 * 0.31 + 0.53, 0, lodH - 1.7));
    const thrH = 1 - 0.55 * C.high;
    let aH = sstep(thrH, thrH + 0.35, ch) * 0.5 * Math.min(1, C.high * 1.6);
    aH *= Math.exp(-dH / (A.aerialKm * 3)) * hor;
    const kH = (hg(cs, 0.75) * 0.9 + hg(cs, 0.1) * 0.6) * 2.4;
    for (let c = 0; c < 3; c++) col[c] += ((A.sunHi[c] * kH + A.ambTop[c] * 0.9) * A.exposure - col[c]) * aH;
    const dL = shell(1.5, dd[1]);
    const u = (dd[0] * dL + C.drift[0]) / 16, v = (dd[2] * dL + C.drift[1]) / 16;
    const lod = Math.log2(Math.max(1, (dL * pixAng / Math.max(dd[1], 0.05)) / 16 * TILE));
    const n = tileAt(u, v, 0, lod), det = tileAt(u * 6 + 0.21, v * 6 + 0.21, 1, lod + 2.6);
    const thr = 1 - C.cover;
    const nn = n - (1 - det) * 0.24 * (1 - sstep(thr, thr + 0.4, n));
    const dens = sstep(thr - 0.022, thr + 0.202, nn);
    if (dens > 0) {
      let sx = sun[0], sz = sun[2];
      const sl = Math.hypot(sx, sz);
      if (sl > 1e-4) { sx /= sl; sz /= sl; } else { sx = 1; sz = 0; }
      const cot = Math.min(sl / Math.max(sun[1], 0.02), 8);
      const core = sstep(thr, thr + 0.45, nn);
      let opt = core * 0.8 + (1 - det) * 0.3 * dens;
      for (let k = 1; k <= 3; k++) {
        const off = k * (0.1 + 0.22 * cot) / 16;
        opt += sstep(thr, thr + 0.45, tileAt(u + sx * off, v + sz * off, 0, lod));
      }
      opt *= 0.9 + 0.12 * cot;
      let Ls = 0, a = 1, b = 1, cc = 1;
      for (let i = 0; i < 3; i++) { Ls += a * Math.exp(-opt * 2.6 * b) * (hg(cs, 0.6 * cc) * 0.75 + hg(cs, -0.2 * cc) * 0.25); a *= 0.55; b *= 0.4; cc *= 0.5; }
      const detS = tileAt(u * 6 + 0.21 + sx * 0.006, v * 6 + 0.21 + sz * 0.006, 1, lod + 2.6);
      Ls *= 1 + 0.6 * Math.max(-1, Math.min(1, (det - detS) * 5)) * core;
      const aL = (1 - Math.exp(-dens * 7 * C.low)) * Math.exp(-dL / A.aerialKm) * hor;
      for (let c = 0; c < 3; c++) {
        const LL = A.sunLo[c] * Ls * 3.6 + A.ambTop[c] * (0.9 - 0.55 * core) + A.ambBot[c] * 0.5;
        col[c] += (LL * A.exposure - col[c]) * aL;
      }
    }
  }
  out[0] = aces(col[0] * A.wb[0]); out[1] = aces(col[1] * A.wb[1]); out[2] = aces(col[2] * A.wb[2]);
  return out;
}

let cpuCanvas = null;
function renderPhysSkyCPU(ctx, info, mirror, outW, outH, blurPx, o = {}) {
  const cam = info.cam;
  const res = o.cpuRes ?? 0.2;
  const w = Math.max(2, Math.round(outW * res)), h = Math.max(2, Math.round(outH * res));
  if (!cpuCanvas || cpuCanvas.width !== w || cpuCanvas.height !== h) cpuCanvas = makeCanvas(w, h);
  const cx = cpuCanvas.getContext('2d');
  const img = cx.createImageData(w, h);
  const sc = w / cam.W, pixAng = 1 / (cam.f * sc);
  const c = [0, 0, 0], d = [0, 0, 0];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = ((x + 0.5) / sc - cam.W / 2) / cam.f, b = ((y + 0.5) / sc - cam.H / 2) / cam.f;
      d[0] = cam.F[0] + a * cam.R[0] - b * cam.U[0];
      d[1] = cam.F[1] + a * cam.R[1] - b * cam.U[1];
      d[2] = cam.F[2] + a * cam.R[2] - b * cam.U[2];
      const l = Math.hypot(d[0], d[1], d[2]);
      d[0] /= l; d[1] /= l; d[2] /= l;
      if (mirror) d[1] = -d[1];
      physSkyJS(info, d, true, pixAng, c);
      const i = (y * w + x) * 4;
      img.data[i] = Math.round(Math.pow(c[0], 1 / 2.2) * 255);
      img.data[i + 1] = Math.round(Math.pow(c[1], 1 / 2.2) * 255);
      img.data[i + 2] = Math.round(Math.pow(c[2], 1 / 2.2) * 255);
      img.data[i + 3] = 255;
    }
  }
  cx.putImageData(img, 0, 0);
  compositeBlurred(ctx, cpuCanvas, outW, outH, blurPx, mirror ? 'pcm' : 'pc');
}

// -------------------------------------------------- derived colours ----
const toHex = (c) => '#' + c.map((v) => Math.round(Math.pow(Math.max(0, Math.min(1, v)), 1 / 2.2) * 255).toString(16).padStart(2, '0')).join('');

/**
 * Scene-wide colours derived from the physical sky (for every consumer that still
 * takes plain colours: water fallback/haze, leaf/rock ambient, cut-out haze):
 *   top / horizon — sky colour (no clouds) above / at the horizon in the camera's view direction
 *   sunColor / sunIntensity — direct sunlight at the ground (afterglow tint once the sun has set)
 */
export function derivedSkyColors(info) {
  const A = info.atmo, F = info.cam.F;
  const hl = Math.hypot(F[0], F[2]) || 1;
  const fx = F[0] / hl, fz = F[2] / hl;
  const top = physSkyJS(info, [fx * 0.8, 0.6, fz * 0.8], false, 0.001);
  const hor = physSkyJS(info, [fx, 0.02, fz], false, 0.001);
  const sc = A.sunCam, m = Math.max(sc[0], sc[1], sc[2]);
  const deg = A.elevation / DEG;
  let sunColor, sunIntensity;
  if (m > 1e-3) {
    sunColor = toHex(sc.map((v) => v / m));
    sunIntensity = 0.55 + 0.45 * smooth(-1, 12, deg);
  } else {
    // sun below the horizon: light comes from the afterglow toward the sun
    const s = info.sun.dir, sl = Math.hypot(s[0], s[2]) || 1;
    const g = physSkyJS(info, [s[0] / sl, 0.05, s[2] / sl], false, 0.001);
    const gm = Math.max(g[0], g[1], g[2], 1e-4);
    sunColor = toHex(g.map((v) => v / gm));
    sunIntensity = 0.2;
  }
  return { top: toHex(top), horizon: toHex(hor), sunColor, sunIntensity };
}
