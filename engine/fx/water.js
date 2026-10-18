// Physically based water surface for nature scenes, rendered with WebGL2.
//
// Three layers of surface motion, all deterministic in time:
//  1. Wind waves: a small directional spectrum of travelling waves with the
//     real capillary–gravity dispersion  ω² = g·k + (σ/ρ)·k³ , carried by the
//     current (Doppler) and modulated by the shared gust field, so a gust
//     shows up as a dark "cat's paw" racing across the water.
//  2. Flow detail: turbulent boils advected at the current speed.
//  3. A height-field wave simulation (wave equation + a biharmonic term that
//     gives ripple dispersion → several concentric rings per impact) that
//     receives impulses from drops and leaves. It runs in the frame moving
//     with the current, so ripples drift downstream without numerical smear.
//
// Shading: planar reflection of the scene (distorted by the surface normal),
// Fresnel (Schlick, F0 = 0.02), refraction onto a pebble bed with animated
// caustics and Beer–Lambert absorption, sun glints with pixel-footprint
// anti-aliasing, and aerial haze.
import { rng, hexToRgb } from '../math.js';
import { gustAt, windUniforms, GLSL_WIND } from './wind.js';

const G = 9.81;
const SIGMA_RHO = 7.3e-5; // surface tension / density of water (m³/s²)
export const NWAVES = 14;

// ---------------------------------------------------------------- waves --
export function makeWaves(o = {}, wind) {
  const r = rng(o.seed ?? 5);
  const [lmin, lmax] = o.wavelength ?? [0.025, 0.9];
  const steep = o.chop ?? 0.45; // overall steepness scale
  const waves = [];
  for (let i = 0; i < NWAVES; i++) {
    const f = i / (NWAVES - 1);
    const lambda = lmin * Math.pow(lmax / lmin, f) * r.range(0.85, 1.15);
    const k = (2 * Math.PI) / lambda;
    const spread = (o.spread ?? 1.1) * (1 - 0.3 * f);
    const ang = (wind ? wind.dir : 0) + r.range(-spread, spread);
    // steepness falls for the long waves (fetch-limited stream/pond)
    const a = (steep * 0.06 * (1 - 0.65 * f) * lambda) / (2 * Math.PI);
    const w = Math.sqrt(G * k + SIGMA_RHO * k * k * k);
    waves.push({ dx: Math.cos(ang), dz: Math.sin(ang), k, a, w, ph: r.range(0, Math.PI * 2), lambda });
  }
  return waves;
}

/** wind response of the ripple amplitude (shared with the shader) */
function windAmp(wind, x, z, t, calm) {
  if (!wind) return 1;
  const s = wind.speed * gustAt(wind, x, z, t);
  return calm + (1 - calm) * Math.min(3, Math.pow(s / 2.0, 1.5));
}

/** Surface height of the analytic layer at world (x,z) — used to bob floating things. */
export function waveHeight(W, x, z, t) {
  let h = 0;
  const amp = windAmp(W.wind, x, z, t, W.calm);
  const fx = W.flow[0], fz = W.flow[1];
  const px = x - fx * t, pz = z - fz * t;
  for (const q of W.waves) h += q.a * amp * Math.sin(q.k * (q.dx * px + q.dz * pz) - q.w * t + q.ph);
  if (W.sim) h += W.sim.heightAt(x - fx * t, z - fz * t);
  return h;
}

// ------------------------------------------------------- height-field sim --
const simCache = new Map();

export function getWaveSim(key, o) {
  let s = simCache.get(key);
  if (!s) {
    s = new WaveSim(o);
    simCache.set(key, s);
    if (simCache.size > 6) simCache.delete(simCache.keys().next().value);
  }
  return s;
}
export function clearWaterCache() {
  simCache.clear();
}

export class WaveSim {
  constructor(o) {
    const [x0, z0, x1, z1] = o.area;
    this.area = o.area;
    this.nx = Math.min(512, o.res ?? 256);
    this.nz = Math.max(16, Math.min(512, Math.round((this.nx * (z1 - z0)) / (x1 - x0))));
    this.dx = (x1 - x0) / this.nx;
    this.dz = (z1 - z0) / this.nz;
    const cell = Math.min(this.dx, this.dz);
    this.c = o.speed ?? 0.32; // ripple speed, m/s
    this.dt = Math.min(1 / 240, (0.34 * cell) / this.c);
    this.damp = o.damping ?? 0.6;
    this.gamma = o.dispersion ?? 1.4;
    const n = this.nx * this.nz;
    this.h = new Float32Array(n);
    this.v = new Float32Array(n);
    this.L = new Float32Array(n);
    this.sponge = new Float32Array(n);
    const B = 10;
    for (let j = 0; j < this.nz; j++) {
      for (let i = 0; i < this.nx; i++) {
        const d = Math.min(i, j, this.nx - 1 - i, this.nz - 1 - j);
        this.sponge[j * this.nx + i] = d < B ? Math.pow(1 - d / B, 2) * 40 : 0;
      }
    }
    // impulses: { t, x, z, r, amp } in the SIM frame, sorted by time
    this.impulses = (o.impulses || []).slice().sort((a, b) => a.t - b.t);
    this.n = 0;
    this.ptr = 0; // next impulse to apply
    // Snapshots of the full sim state (heights, velocities AND the impulse
    // cursor) every snapEvery steps. at(t) resumes from the latest snapshot at
    // or before t and replays the same fixed steps, so the state at t is a pure
    // function of t whatever was rendered before (scrubbing, parallel workers).
    this.snaps = new Map();
    this.snapEvery = Math.max(1, Math.round(0.25 / this.dt));
    this.snaps.set(0, { h: this.h.slice(), v: this.v.slice(), ptr: 0 });
    this.out = new Float32Array(n); // texture payload
  }

  /** advance (or rewind via snapshot) to time t */
  at(t) {
    const target = Math.max(0, Math.floor(t / this.dt));
    if (target < this.n) {
      let best = 0;
      for (const k of this.snaps.keys()) if (k <= target && k > best) best = k;
      const s = this.snaps.get(best);
      this.h.set(s.h);
      this.v.set(s.v);
      this.n = best;
      // restore the cursor as it was, instead of re-deriving it from the time:
      // the first step applies every impulse with t <= dt (incl. t <= 0, e.g.
      // leaves that landed before the shot), which "t <= best*dt" skipped
      // when rewinding to step 0 (#18)
      this.ptr = s.ptr;
    }
    while (this.n < target) {
      this.step();
      this.n++;
      if (this.n % this.snapEvery === 0 && !this.snaps.has(this.n)) {
        this.snaps.set(this.n, { h: this.h.slice(), v: this.v.slice(), ptr: this.ptr });
        if (this.snaps.size > 160) {
          // drop the oldest non-zero snapshot
          for (const k of this.snaps.keys()) if (k !== 0) { this.snaps.delete(k); break; }
        }
      }
    }
    return this;
  }

  step() {
    const { nx, nz, h, v, L, sponge } = this;
    const dt = this.dt;
    const t1 = (this.n + 1) * dt;
    while (this.ptr < this.impulses.length && this.impulses[this.ptr].t <= t1) this.applyImpulse(this.impulses[this.ptr++]);
    const k1 = (this.c * this.c) / (this.dx * this.dx);
    const k2 = (this.gamma * k1) / 8;
    // Laplacian
    for (let j = 1; j < nz - 1; j++) {
      const row = j * nx;
      for (let i = 1; i < nx - 1; i++) {
        const p = row + i;
        L[p] = h[p - 1] + h[p + 1] + h[p - nx] + h[p + nx] - 4 * h[p];
      }
    }
    const damp = this.damp;
    for (let j = 2; j < nz - 2; j++) {
      const row = j * nx;
      for (let i = 2; i < nx - 2; i++) {
        const p = row + i;
        const bil = L[p - 1] + L[p + 1] + L[p - nx] + L[p + nx] - 4 * L[p];
        const acc = k1 * L[p] - k2 * bil;
        let vv = v[p] + acc * dt;
        vv *= 1 - (damp + sponge[p]) * dt;
        v[p] = vv;
      }
    }
    for (let p = 0; p < h.length; p++) h[p] += v[p] * dt;
  }

  applyImpulse(im) {
    const { nx, nz, area } = this;
    const ci = (im.x - area[0]) / this.dx, cj = (im.z - area[1]) / this.dz;
    const rc = Math.max(1.2, im.r / this.dx);
    const R = Math.ceil(rc * 3);
    for (let j = Math.max(2, Math.floor(cj - R)); j <= Math.min(nz - 3, Math.ceil(cj + R)); j++) {
      for (let i = Math.max(2, Math.floor(ci - R)); i <= Math.min(nx - 3, Math.ceil(ci + R)); i++) {
        const d2 = ((i - ci) ** 2 + (j - cj) ** 2) / (rc * rc);
        if (d2 > 9) continue;
        // crater: push down in the middle, lift a little rim
        this.v[j * nx + i] += -im.amp * Math.exp(-d2) * (1 - 0.35 * d2);
      }
    }
  }

  heightAt(x, z) {
    const fi = (x - this.area[0]) / this.dx, fj = (z - this.area[1]) / this.dz;
    if (fi < 1 || fj < 1 || fi >= this.nx - 2 || fj >= this.nz - 2) return 0;
    const i = Math.floor(fi), j = Math.floor(fj), a = fi - i, b = fj - j, nx = this.nx;
    const p = j * nx + i;
    return (this.h[p] * (1 - a) + this.h[p + 1] * a) * (1 - b) + (this.h[p + nx] * (1 - a) + this.h[p + nx + 1] * a) * b;
  }
}

// ------------------------------------------------------------------ GLSL --
const VS = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FS = `#version 300 es
precision highp float;
precision highp sampler2D;
out vec4 outColor;
uniform vec2 uPix;        // framebuffer size in px
uniform float uScale;     // px per logical unit
uniform vec2 uLogical;    // W, H
uniform vec3 uCamPos, uCamF, uCamR, uCamU;
uniform float uFocal;
uniform float uTime;
uniform vec2 uFlow;
uniform sampler2D uRefl;
uniform float uReflDistort;
uniform sampler2D uHeight;
uniform vec4 uSimArea;
uniform float uHasSim;
uniform float uSimGain;
uniform vec4 uWaves[${NWAVES}];   // dirX, dirZ, k, amp
uniform vec2 uWavesB[${NWAVES}];  // omega, phase
uniform float uCalm;
uniform vec3 uSunDir, uSunCol;
uniform float uSunPower;
uniform vec3 uSkyTop, uSkyHor, uHaze;
uniform float uHazeDist;
uniform vec3 uDeep, uBedA, uBedB, uAbsorb;
uniform float uDepth, uClarity, uFarZ, uFlowDetail, uFoam, uCaustics, uBedScale;
uniform float uYMin;      // logical y above which nothing is drawn
uniform vec4 uRocks[8];   // x, z, radius, 0
uniform int uNRocks;
uniform int uDebug;
${GLSL_WIND}

float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx+33.33); return fract((p3.xx+p3.yz)*p3.zy); }
float vnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  vec3 u = f*f*(3.0-2.0*f);
  float n000 = hash12(i.xy + i.z*17.13), n100 = hash12(i.xy + vec2(1,0) + i.z*17.13);
  float n010 = hash12(i.xy + vec2(0,1) + i.z*17.13), n110 = hash12(i.xy + vec2(1,1) + i.z*17.13);
  float n001 = hash12(i.xy + (i.z+1.0)*17.13), n101 = hash12(i.xy + vec2(1,0) + (i.z+1.0)*17.13);
  float n011 = hash12(i.xy + vec2(0,1) + (i.z+1.0)*17.13), n111 = hash12(i.xy + vec2(1,1) + (i.z+1.0)*17.13);
  return mix(mix(mix(n000,n100,u.x), mix(n010,n110,u.x), u.y), mix(mix(n001,n101,u.x), mix(n011,n111,u.x), u.y), u.z)*2.0-1.0;
}
vec3 toLin(vec3 c) { return pow(c, vec3(2.2)); }
vec3 toSrgb(vec3 c) { return pow(max(c, 0.0), vec3(1.0/2.2)); }

// joltz0r's tileable caustic
float caustic(vec2 p, float t) {
  vec2 i = p; float c = 1.0; float inten = 0.005;
  for (int n = 0; n < 4; n++) {
    float t2 = t * (1.0 - (3.5 / float(n + 1)));
    i = p + vec2(cos(t2 - i.x) + sin(t2 + i.y), sin(t2 - i.y) + cos(t2 + i.x));
    c += 1.0 / length(vec2(p.x / (sin(i.x + t2) / inten), p.y / (cos(i.y + t2) / inten)));
  }
  c /= 4.0;
  c = 1.17 - pow(c, 1.4);
  return pow(abs(c), 8.0);
}

vec3 bedColor(vec2 q, out float rough) {
  // rounded pebbles (Voronoi cells shaded as domes) bedded in silt
  vec2 g = q * uBedScale;
  vec2 ip = floor(g), fp = fract(g);
  float d1 = 9.0, d2 = 9.0; vec2 id = vec2(0); vec2 rr = vec2(0);
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 o = vec2(x, y);
    vec2 h = hash22(ip + o);
    vec2 r = o + 0.15 + 0.7*h - fp;
    float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; id = ip + o; rr = r; } else if (d < d2) d2 = d;
  }
  float edge = sqrt(d2) - sqrt(d1);
  float size = 0.35 + 0.3 * hash12(id + 3.0);
  float dome = clamp(edge / size, 0.0, 1.0);
  float hgt = sqrt(dome);
  vec3 nrm = normalize(vec3(-rr.x * (1.0 - hgt) * 2.0, 0.6 + hgt, -rr.y * (1.0 - hgt) * 2.0));
  float lit = clamp(dot(nrm, normalize(uSunDir + vec3(0.0, 0.6, 0.0))), 0.0, 1.0);
  float hv = hash12(id);
  vec3 stone = mix(uBedA, uBedB, hv) * (0.7 + 0.6 * hash12(id + 7.0));
  float n = vnoise(vec3(q * 18.0, 1.0)) * 0.5 + 0.5;
  vec3 c = stone * (0.45 + 0.75 * lit) * (0.85 + 0.3 * n);
  vec3 siltC = mix(uBedA, uBedB, 0.45) * (0.8 + 0.3 * n);
  // gravel and sand fill the gaps between stones
  vec2 g2 = q * uBedScale * 3.7 + 11.0;
  float gv = hash12(floor(g2));
  vec3 gravel = mix(uBedA, uBedB, gv) * (0.7 + 0.4 * vnoise(vec3(g2 * 2.0, 2.0)));
  c = mix(mix(siltC, gravel, 0.6) * 0.85, c, smoothstep(0.03, 0.2, edge) * (0.55 + 0.45 * hash12(id + 13.0)));
  float silt = smoothstep(-0.1, 0.4, vnoise(vec3(q * 0.7, 5.0)) + 0.3 * vnoise(vec3(q * 2.3, 9.0)));
  c = mix(c, siltC, silt * 0.65);
  rough = edge;
  return c;
}

void main() {
  vec2 sp = vec2(gl_FragCoord.x, uPix.y - gl_FragCoord.y) / uScale; // logical
  if (sp.y < uYMin) { outColor = vec4(0); return; }
  vec2 ndc = (sp - uLogical * 0.5) / uFocal;
  vec3 ray = normalize(uCamF + ndc.x * uCamR - ndc.y * uCamU);
  if (ray.y > -1e-4) { outColor = vec4(0); return; }
  float tHit = -uCamPos.y / ray.y;
  vec3 P = uCamPos + ray * tHit;
  if (P.z > uFarZ + 0.5) { outColor = vec4(0); return; }
  float fp = tHit / (uFocal * max(-ray.y, 0.04)); // metres per pixel (depth axis)
  float t = uTime;
  vec2 adv = P.xz - uFlow * t;

  // ---- wind waves (analytic, dispersive, gust-modulated) ----
  float gust = gustAt(P.xz, t) * uWind.x;
  float patchy = 0.65 + 0.35 * vnoise(vec3(adv * 0.45, t * 0.15));
  float wamp = (uCalm + (1.0 - uCalm) * min(3.0, pow(gust / 2.0, 1.5))) * patchy;
  vec2 grad = vec2(0);
  for (int i = 0; i < ${NWAVES}; i++) {
    vec4 w = uWaves[i];
    float lambda = 6.2831853 / w.z;
    float aa = clamp((lambda / fp - 2.5) / 5.0, 0.0, 1.0);
    if (aa <= 0.0) continue;
    float ph = w.z * dot(w.xy, adv) - uWavesB[i].x * t + uWavesB[i].y;
    grad += w.w * wamp * aa * w.z * cos(ph) * w.xy;
  }
  // ---- flow turbulence (boils, advected) ----
  if (uFlowDetail > 0.0) {
    float e = 0.02;
    float s1 = 2.4, s2 = 6.5;
    float aa1 = clamp((1.0/s1 / fp - 3.0)/6.0, 0.0, 1.0), aa2 = clamp((1.0/s2 / fp - 3.0)/6.0, 0.0, 1.0);
    vec3 q1 = vec3(adv * s1, t * 0.35), q2 = vec3(adv * s2 + 3.7, t * 0.7);
    float n0 = vnoise(q1) * aa1 + 0.5 * vnoise(q2) * aa2;
    float nx = vnoise(q1 + vec3(e*s1, 0, 0)) * aa1 + 0.5 * vnoise(q2 + vec3(e*s2, 0, 0)) * aa2;
    float nz = vnoise(q1 + vec3(0, e*s1, 0)) * aa1 + 0.5 * vnoise(q2 + vec3(0, e*s2, 0)) * aa2;
    grad += uFlowDetail * 0.012 * vec2(nx - n0, nz - n0) / e;
  }
  // ---- rocks: pillow + turbulent wake downstream, foam ----
  float rockFoam = 0.0;
  if (uNRocks > 0) {
    vec2 fd = length(uFlow) > 1e-3 ? normalize(uFlow) : vec2(1.0, 0.0);
    vec2 fn = vec2(-fd.y, fd.x);
    float fs = length(uFlow);
    for (int i = 0; i < 8; i++) {
      if (i >= uNRocks) break;
      vec2 rel = P.xz - uRocks[i].xy;
      float r = uRocks[i].z;
      float sAl = dot(rel, fd), nC = dot(rel, fn);
      float dist = length(rel);
      // foam collar hugging the rock, thicker upstream
      float ang = atan(rel.y, rel.x);
      float jit = 1.0 + 0.22 * (vnoise(vec3(ang * 2.5, t * 0.8, float(i))) );
      float collar = smoothstep(r * 1.5 * jit, r * 1.05, dist) * smoothstep(r * 0.8, r * 1.0, dist);
      collar *= (0.45 + 0.55 * smoothstep(0.5 * r, -r, sAl)) * smoothstep(-0.25, 0.45, vnoise(vec3(rel / r * 3.0 - fd * t * 2.0, t)));
      // wake: widening, decaying turbulence downstream
      float ds = max(sAl, 0.0);
      float width = r * (1.0 + 0.45 * ds / r);
      float wake = step(0.0, sAl) * exp(-ds / (r * 6.0)) * exp(-pow(nC / width, 2.0)) * smoothstep(r * 0.9, r * 1.3, dist);
      vec2 wq = vec2(sAl - fs * t * 0.6, nC) / r;
      float e = 0.15;
      float w0 = vnoise(vec3(wq * 2.2, t * 1.4)), wx = vnoise(vec3((wq + vec2(e, 0.0)) * 2.2, t * 1.4)), wz = vnoise(vec3((wq + vec2(0.0, e)) * 2.2, t * 1.4));
      vec2 wg = vec2(wx - w0, wz - w0) / (e * r);
      vec2 g2 = wg.x * fd + wg.y * fn;
      grad += g2 * 0.035 * (wake + collar * 0.6) * min(1.5, fs * 3.0 + 0.3);
      // standing V-waves off the rock
      float kv = 6.2831 / (r * 0.9);
      grad += fn * sign(nC) * 0.06 * wake * cos(kv * (abs(nC) - 0.35 * ds)) * min(1.0, fs * 3.0);
      rockFoam = max(rockFoam, collar * 0.9 + wake * smoothstep(0.55, 0.85, vnoise(vec3(wq * vec2(1.2, 3.5), t * 0.8))) * 0.7);
    }
  }

  // ---- simulated ripples ----
  if (uHasSim > 0.5) {
    vec2 sp2 = adv;
    vec2 uv = (sp2 - uSimArea.xy) / (uSimArea.zw - uSimArea.xy);
    if (uv.x > 0.0 && uv.y > 0.0 && uv.x < 1.0 && uv.y < 1.0) {
      vec2 ts = 1.0 / vec2(textureSize(uHeight, 0));
      float hl = texture(uHeight, uv - vec2(ts.x, 0)).r, hr = texture(uHeight, uv + vec2(ts.x, 0)).r;
      float hd = texture(uHeight, uv - vec2(0, ts.y)).r, hu = texture(uHeight, uv + vec2(0, ts.y)).r;
      vec2 cell = (uSimArea.zw - uSimArea.xy) * ts;
      vec2 sg = vec2(hr - hl, hu - hd) / (2.0 * cell);
      float aa = clamp((cell.x * 3.0 / fp), 0.0, 1.0);
      float edge = smoothstep(0.0, 0.06, min(min(uv.x, uv.y), min(1.0 - uv.x, 1.0 - uv.y)));
      grad += sg * uSimGain * edge * mix(0.35, 1.0, aa);
    }
  }
  vec3 N = normalize(vec3(-grad.x, 1.0, -grad.y));
  vec3 V = -ray;
  float cosv = max(dot(N, V), 0.0);
  float F = 0.02 + 0.98 * pow(1.0 - cosv, 5.0);

  // ---- reflection: planar, distorted by the normal ----
  vec3 R = reflect(ray, N);
  vec2 off = vec2(N.x, N.z) * uReflDistort;
  vec2 ruv = (sp + vec2(off.x, -off.y)) / uLogical;
  vec3 sky = mix(uSkyHor, uSkyTop, pow(clamp(R.y, 0.0, 1.0), 0.6));
  vec4 rs = texture(uRefl, clamp(ruv, vec2(0.001), vec2(0.999)));
  vec3 refl = mix(toLin(sky), toLin(rs.rgb), rs.a);

  // ---- refraction to the bed ----
  // at grazing angles little light comes back from the bed: water reads as its body colour
  float bedVis = smoothstep(0.03, 0.45, cosv);
  vec3 deep = toLin(uDeep);
  vec3 refr = deep * 0.8;
  if (bedVis > 0.004) {
    vec3 T = refract(ray, N, 1.0 / 1.333);
    float depth = uDepth * (0.75 + 0.25 * vnoise(vec3(P.xz * 0.6, 3.0)));
    float tb = depth / max(-T.y, 0.05);
    vec3 Pb = P + T * tb;
    float rough;
    vec3 bed = toLin(bedColor(Pb.xz, rough));
    // far away the bed texture is below pixel size: fade to its mean
    bed = mix(bed, toLin(mix(uBedA, uBedB, 0.5)) * 0.8, clamp(fp * uBedScale * 2.5, 0.0, 1.0));
    float cz = clamp(caustic(Pb.xz * 7.0 - uFlow * t * 7.0, t * 0.9 + 23.0), 0.0, 1.5);
    float cfade = clamp(0.012 / fp, 0.0, 1.0);
    bed *= 0.75 + uCaustics * (0.15 + 1.4 * cz * cfade) * toLin(uSunCol);
    vec3 ab = exp(-uAbsorb * (tb + depth) / max(uClarity, 0.05));
    refr = (bed * ab + deep * (1.0 - ab)) * bedVis + deep * (1.0 - bedVis) * 0.8;
  }

  vec3 col = mix(refr, refl, F);

  // ---- sun glints ----
  vec3 Hh = normalize(V + uSunDir);
  float nh = max(dot(N, Hh), 0.0);
  float sharp = mix(2600.0, 260.0, clamp(fp * 60.0, 0.0, 1.0));
  float glint = pow(nh, sharp) * sharp * 0.0016 + pow(nh, 400.0) * 0.12;
  col += toLin(uSunCol) * glint * uSunPower * (0.25 + F) * 3.0;

  if (rockFoam > 0.0) col = mix(col, toLin(vec3(0.86, 0.88, 0.85)), clamp(rockFoam, 0.0, 0.85));
  // ---- foam streaks ----
  if (uFoam > 0.0) {
    // thin bubble lines stretched along the current, gathered in patches
    float ridge = 1.0 - abs(vnoise(vec3(adv.x * 1.2, adv.y * 7.0, t * 0.2)));
    float lines = pow(ridge, 10.0);
    float mask = smoothstep(0.1, 0.6, vnoise(vec3(adv * 0.6, t * 0.1 + 4.0)));
    float specks = smoothstep(0.75, 0.95, vnoise(vec3(adv * 26.0, t * 0.6)));
    float foam = (lines * 0.8 + specks * 0.5) * mask * uFoam * clamp(0.012 / fp, 0.0, 1.0);
    col = mix(col, toLin(vec3(0.82, 0.84, 0.8)), clamp(foam, 0.0, 0.7));
  }

  // ---- aerial haze ----
  float hz = 1.0 - exp(-tHit / uHazeDist);
  col = mix(col, toLin(uHaze), hz);

  if (uDebug == 1) col = refl; else if (uDebug == 2) col = refr; else if (uDebug == 3) col = vec3(F);
  float alpha = 1.0 - smoothstep(uFarZ - 0.05, uFarZ + 0.45, P.z);
  col = toSrgb(col);
  outColor = vec4(col * alpha, alpha);
}`;

const glCache = new Map();
function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function getGL(pw, ph) {
  const key = pw + 'x' + ph;
  let s = glCache.get(key);
  if (s) return s;
  const canvas = makeCanvas(pw, ph);
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: true });
  if (!gl) throw new Error('WebGL2 không khả dụng — không vẽ được mặt nước');
  gl.getExtension('OES_texture_float_linear');
  const sh = (type, src) => {
    const o = gl.createShader(type);
    gl.shaderSource(o, src);
    gl.compileShader(o);
    if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error('GLSL: ' + gl.getShaderInfoLog(o));
    return o;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('GLSL link: ' + gl.getProgramInfoLog(prog));
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const loc = gl.getAttribLocation(prog, 'aPos');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const U = {};
  const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(prog, i);
    const name = info.name.replace(/\[0\]$/, '');
    U[name] = gl.getUniformLocation(prog, info.name);
  }
  const tex = () => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  };
  s = { canvas, gl, prog, vao, U, texRefl: tex(), texH: tex(), hSize: [0, 0] };
  glCache.set(key, s);
  if (glCache.size > 3) glCache.delete(glCache.keys().next().value);
  return s;
}

const c3 = (hex) => hexToRgb(hex).map((v) => v / 255);

/**
 * Render the water plane into ctx (logical coordinates, scale already set).
 * sc: { cam, wind, time, scale, refl (canvas), W: water state from setupWater }
 */
export function renderWater(ctx, sc, Wt) {
  const fullW = Math.round(sc.cam.W * sc.scale), fullH = Math.round(sc.cam.H * sc.scale);
  // shading resolution: the water is smooth (and usually defocused), so it is
  // shaded at reduced resolution and upsampled — 3–4× cheaper on CPU GL
  const rs = Wt.opts.res ?? ((Wt.opts.blur ?? 0) > 1.5 ? 0.5 : 0.85);
  const pw = Math.max(2, Math.round(fullW * rs)), ph = Math.max(2, Math.round(fullH * rs));
  const S = getGL(pw, ph);
  const { gl, U } = S;
  gl.viewport(0, 0, pw, ph);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(S.prog);
  gl.bindVertexArray(S.vao);
  const cam = sc.cam, o = Wt.opts;
  gl.uniform2f(U.uPix, pw, ph);
  gl.uniform1f(U.uScale, sc.scale * rs);
  gl.uniform2f(U.uLogical, cam.W, cam.H);
  gl.uniform3fv(U.uCamPos, cam.pos);
  gl.uniform3fv(U.uCamF, cam.F);
  gl.uniform3fv(U.uCamR, cam.R);
  gl.uniform3fv(U.uCamU, cam.U);
  gl.uniform1f(U.uFocal, cam.f);
  gl.uniform1f(U.uTime, sc.time);
  gl.uniform2f(U.uFlow, Wt.flow[0], Wt.flow[1]);
  gl.uniform1f(U.uReflDistort, o.distort ?? cam.f * 0.35);
  const wv = new Float32Array(NWAVES * 4), wb = new Float32Array(NWAVES * 2);
  Wt.waves.forEach((q, i) => {
    wv.set([q.dx, q.dz, q.k, q.a], i * 4);
    wb.set([q.w, q.ph], i * 2);
  });
  gl.uniform4fv(U.uWaves, wv);
  gl.uniform2fv(U.uWavesB, wb);
  gl.uniform1f(U.uCalm, Wt.calm);
  const wu = windUniforms(sc.wind);
  gl.uniform4fv(U.uGusts, wu.gusts);
  gl.uniform1i(U.uNGusts, wu.n);
  gl.uniform4fv(U.uWind, wu.params);
  gl.uniform1f(U.uFront, wu.front);
  const sun = sc.sun;
  gl.uniform3fv(U.uSunDir, sun.dir);
  gl.uniform3fv(U.uSunCol, c3(sun.color));
  gl.uniform1f(U.uSunPower, sun.intensity);
  gl.uniform3fv(U.uSkyTop, c3(sc.sky.top));
  gl.uniform3fv(U.uSkyHor, c3(sc.sky.horizon));
  gl.uniform3fv(U.uHaze, c3(o.haze ?? sc.sky.horizon));
  gl.uniform1f(U.uHazeDist, o.hazeDist ?? 120);
  gl.uniform3fv(U.uDeep, c3(o.color ?? '#17322a'));
  gl.uniform3fv(U.uBedA, c3(o.bedA ?? '#3e3628'));
  gl.uniform3fv(U.uBedB, c3(o.bedB ?? '#6a5e48'));
  gl.uniform3fv(U.uAbsorb, o.absorb ?? [3.4, 1.6, 1.5]);
  gl.uniform1f(U.uDepth, o.depth ?? 0.35);
  gl.uniform1f(U.uClarity, o.clarity ?? 1);
  gl.uniform1f(U.uFarZ, o.farZ ?? 60);
  gl.uniform1f(U.uFlowDetail, o.turbulence ?? Math.min(1.5, Math.hypot(...Wt.flow) * 2));
  gl.uniform1f(U.uFoam, o.foam ?? 0);
  gl.uniform1f(U.uCaustics, o.caustics ?? 0.7);
  gl.uniform1f(U.uBedScale, o.bedScale ?? 14);
  gl.uniform1f(U.uYMin, Math.max(0, o.top ?? 0));
  gl.uniform1i(U.uDebug, { refl: 1, refr: 2, fresnel: 3 }[o.debug] || 0);
  const rocks = (o.rocks || []).slice(0, 8);
  const rk = new Float32Array(32);
  rocks.forEach((r, i) => rk.set([r.x, r.z, r.r, 0], i * 4));
  gl.uniform4fv(U.uRocks, rk);
  gl.uniform1i(U.uNRocks, rocks.length);
  // reflection texture
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, S.texRefl);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sc.refl);
  gl.uniform1i(U.uRefl, 0);
  // height field
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, S.texH);
  if (Wt.sim) {
    const sim = Wt.sim.at(sc.time);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, sim.nx, sim.nz, 0, gl.RED, gl.FLOAT, sim.h);
    gl.uniform4fv(U.uSimArea, sim.area);
    gl.uniform1f(U.uHasSim, 1);
    gl.uniform1f(U.uSimGain, o.rippleGain ?? 1);
  } else {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 1, 1, 0, gl.RED, gl.FLOAT, new Float32Array(1));
    gl.uniform1f(U.uHasSim, 0);
  }
  gl.uniform1i(U.uHeight, 1);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const blur = (o.blur ?? 0) * sc.scale * rs;
  if (blur > 0.6) {
    // defocus: blur a downscaled copy (cheap on CPU canvas)
    const k = Math.max(0.12, Math.min(0.5, 2.5 / blur));
    const sw = Math.round(pw * k), shh = Math.round(ph * k);
    const pad = Math.ceil(blur * k * 2.5) + 2;
    const tmp = scratch(sw + pad * 2, shh + pad * 2);
    const tc = tmp.getContext('2d');
    tc.setTransform(1, 0, 0, 1, 0, 0);
    tc.clearRect(0, 0, tmp.width, tmp.height);
    // downscale, then clamp-to-edge into the padding so the blur has no dark/light border
    const small = scratch2(sw, shh);
    const sc2 = small.getContext('2d');
    sc2.clearRect(0, 0, sw, shh);
    sc2.drawImage(S.canvas, 0, 0, sw, shh);
    tc.drawImage(small, pad, pad);
    tc.drawImage(small, 0, 0, sw, 1, pad, 0, sw, pad);
    tc.drawImage(small, 0, shh - 1, sw, 1, pad, pad + shh, sw, pad);
    tc.drawImage(tmp, pad, 0, 1, shh + pad * 2, 0, 0, pad, shh + pad * 2);
    tc.drawImage(tmp, pad + sw - 1, 0, 1, shh + pad * 2, pad + sw, 0, pad, shh + pad * 2);
    const out = scratch3(sw + pad * 2, shh + pad * 2);
    const oc = out.getContext('2d');
    oc.clearRect(0, 0, out.width, out.height);
    oc.filter = `blur(${(blur * k).toFixed(2)}px)`;
    oc.drawImage(tmp, 0, 0);
    oc.filter = 'none';
    ctx.drawImage(out, pad, pad, sw, shh, 0, 0, fullW, fullH);
  } else {
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(S.canvas, 0, 0, fullW, fullH);
  }
  ctx.restore();
}

const _scr = {};
function scr(name, w, h) {
  let c = _scr[name];
  if (!c || c.width !== w || c.height !== h) c = _scr[name] = makeCanvas(w, h);
  return c;
}
const scratch = (w, h) => scr('a', w, h);
const scratch2 = (w, h) => scr('b', w, h);
const scratch3 = (w, h) => scr('c', w, h);
