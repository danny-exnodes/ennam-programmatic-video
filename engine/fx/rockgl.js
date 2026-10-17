// River rocks as real meshes (WebGL2): a subdivided icosphere displaced by
// deterministic fractal noise, flattened at the bottom, lit per pixel with
// sun + sky ambient, mineral albedo variation, moss on upward faces, a wet
// darkening band and glossy sheen near the waterline.
import { getPass, GLSL_NOISE, hex3 } from './glkit.js';
import { rng, noise2 } from '../math.js';

const VS = `#version 300 es
in vec2 aClip; in float aDepth; in vec3 aW; in vec3 aN;
out vec3 vW; out vec3 vN;
void main() { vW = aW; vN = aN; gl_Position = vec4(aClip, aDepth, 1.0); }`;

const FS = `#version 300 es
precision highp float;
in vec3 vW; in vec3 vN;
out vec4 outColor;
uniform vec3 uSun, uSunCol, uSky, uCam, uBase, uMoss;
uniform float uSunPow, uMirror, uWet;
${GLSL_NOISE}
void main() {
  if (uMirror < 0.5 && vW.y < -0.002) discard;
  vec3 N = normalize(vN);
  vec3 V = normalize(uCam - vW);
  vec3 p = vW * 9.0;
  float n1 = fbm(p.xz + p.y * 0.7), n2 = vn(p.xy * 3.0 + p.z), n3 = vn(vW.xz * 60.0 + vW.y * 40.0);
  // micro relief
  N = normalize(N + 0.25 * vec3(n2 - 0.5, 0.0, n3 - 0.5));
  vec3 alb = toLin(uBase) * (0.65 + 0.6 * n1) * (0.85 + 0.3 * n3);
  alb = mix(alb, toLin(vec3(0.75, 0.72, 0.66)), smoothstep(0.82, 0.95, n2) * 0.35);   // pale mineral veins
  float moss = smoothstep(0.55, 0.85, N.y) * smoothstep(0.35, 0.65, fbm(vW.xz * 6.0)) * step(0.05, vW.y);
  alb = mix(alb, toLin(uMoss) * (0.7 + 0.5 * n2), moss);
  float wet = (1.0 - smoothstep(0.0, uWet, vW.y)) * (1.0 - moss);
  alb *= mix(1.0, 0.45, wet);
  vec3 sunc = toLin(uSunCol) * uSunPow;
  float ndl = max(dot(N, uSun), 0.0);
  float sky = 0.5 + 0.5 * N.y;
  vec3 col = alb * (sunc * ndl * 0.95 + toLin(uSky) * sky * 0.45);
  vec3 H = normalize(uSun + V);
  float spec = pow(max(dot(N, H), 0.0), mix(18.0, 120.0, wet)) * mix(0.06, 0.9, wet);
  float F = 0.04 + 0.96 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
  col += sunc * spec + toLin(uSky) * F * mix(0.05, 0.35, wet);
  // ambient occlusion toward the waterline / underside
  col *= mix(0.55, 1.0, smoothstep(-0.02, 0.12, vW.y + N.y * 0.05));
  if (uMirror > 0.5) col *= 0.8;
  outColor = vec4(pow(max(col, 0.0), vec3(1.0 / 2.2)), 1.0);
}`;

const meshCache = new Map();
function icosphere(sub) {
  const t = (1 + Math.sqrt(5)) / 2;
  let v = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map((p) => { const l = Math.hypot(...p); return p.map((c) => c / l); });
  let f = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  for (let s = 0; s < sub; s++) {
    const mid = new Map();
    const m = (a, b) => {
      const k = a < b ? a + '_' + b : b + '_' + a;
      if (mid.has(k)) return mid.get(k);
      const p = [0, 1, 2].map((i) => (v[a][i] + v[b][i]) / 2);
      const l = Math.hypot(...p);
      v.push(p.map((c) => c / l));
      mid.set(k, v.length - 1);
      return v.length - 1;
    };
    const nf = [];
    for (const [a, b, c] of f) {
      const ab = m(a, b), bc = m(b, c), ca = m(c, a);
      nf.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    f = nf;
  }
  return { v, f };
}

/** Displaced rock mesh in local units (radius ~1, base at y=0). Cached per seed. */
function rockMesh(seed, flat) {
  const key = seed + ':' + flat;
  let M = meshCache.get(key);
  if (M) return M;
  const { v, f } = icosphere(3);
  const r = rng(seed);
  const sx = r.range(0.85, 1.25), sz = r.range(0.75, 1.15), sy = r.range(0.55, 0.85) * flat;
  const o1 = r.range(0, 50), o2 = r.range(0, 50);
  const P = v.map(([x, y, z]) => {
    let d = 1 + 0.22 * noise2(x * 1.6 + o1, z * 1.6 + y * 1.3, seed) + 0.1 * noise2(x * 3.7 + o2, y * 3.7 - z, seed + 1) + 0.04 * noise2(x * 9 + z * 3, y * 9, seed + 2);
    // a couple of flat facets, like a broken boulder
    if (x * 0.6 + y * 0.8 > 0.75) d *= 0.93;
    if (-z * 0.7 + y * 0.4 > 0.7) d *= 0.95;
    return [x * d * sx, Math.max(y * d * sy, -0.25), z * d * sz];
  });
  const N = P.map(() => [0, 0, 0]);
  for (const [a, b, c] of f) {
    const u = [0, 1, 2].map((i) => P[b][i] - P[a][i]), w = [0, 1, 2].map((i) => P[c][i] - P[a][i]);
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    for (const i of [a, b, c]) for (let k = 0; k < 3; k++) N[i][k] += n[k];
  }
  N.forEach((n) => { const l = Math.hypot(...n) || 1; n[0] /= l; n[1] /= l; n[2] /= l; });
  const idx = new Uint16Array(f.length * 3);
  f.forEach((t, i) => idx.set(t, i * 3));
  M = { P, N, idx };
  meshCache.set(key, M);
  return M;
}

/**
 * Render rocks into a full-frame GL canvas. rocks: [{x,z,r,h,color,moss,seed}]
 * project: world->screen fn, mirror: render the reflection (y flipped).
 */
export function renderRocksGL(rocks, project, cam, sun, sky, outW, outH, scale, mirror) {
  const res = 1;
  const w = Math.round(outW * res), h = Math.round(outH * res);
  const S = getPass('rocks' + (mirror ? 'M' : ''), w, h, FS, { vs: VS, depth: true, antialias: true });
  const { gl, U } = S;
  S.begin();
  gl.enable(gl.DEPTH_TEST);
  if (!S.vbo) {
    S.vbo = gl.createBuffer();
    S.ibo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, S.vbo);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, S.ibo);
    const st = 9 * 4;
    const at = (n, sz, off) => { const l = gl.getAttribLocation(S.prog, n); if (l >= 0) { gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, sz, gl.FLOAT, false, st, off * 4); } };
    at('aClip', 2, 0); at('aDepth', 1, 2); at('aW', 3, 3); at('aN', 3, 6);
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, S.vbo);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, S.ibo);
  gl.uniform3fv(U.uSun, sun.dir);
  gl.uniform3fv(U.uSunCol, hex3(sun.color));
  gl.uniform1f(U.uSunPow, sun.intensity ?? 1);
  gl.uniform3fv(U.uSky, hex3(sky.top));
  gl.uniform3fv(U.uCam, cam.pos);
  gl.uniform1f(U.uMirror, mirror ? 1 : 0);
  for (const rk of rocks) {
    const M = rockMesh(rk.seed ?? Math.round(Math.abs(rk.x * 1000 + rk.z * 77)) + 1, (rk.h ?? rk.r * 0.6) / (rk.r * 0.7));
    const n = M.P.length;
    const data = new Float32Array(n * 9);
    for (let i = 0; i < n; i++) {
      const lp = M.P[i];
      const wp = [rk.x + lp[0] * rk.r, lp[1] * rk.r * 0.7 - (rk.sink ?? 0.05) * rk.r, rk.z + lp[2] * rk.r];
      const pp = mirror ? [wp[0], -wp[1], wp[2]] : wp;
      const pr = project(pp[0], pp[1], pp[2]);
      const ok = pr[2] > 0.01;
      data.set([
        ok ? ((pr[0] * scale * res) / w) * 2 - 1 : 0, ok ? 1 - ((pr[1] * scale * res) / h) * 2 : 0,
        ok ? Math.min(0.999, Math.max(-0.999, pr[2] / 60 - 0.5)) : 2,
        wp[0], wp[1], wp[2], M.N[i][0], M.N[i][1], M.N[i][2],
      ], i * 9);
    }
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, M.idx, gl.STATIC_DRAW);
    gl.uniform3fv(U.uBase, hex3(rk.color ?? '#6d6a60'));
    gl.uniform3fv(U.uMoss, hex3(rk.mossColor ?? '#55702a'));
    gl.uniform1f(U.uWet, rk.wet ?? rk.r * 0.25);
    gl.drawElements(gl.TRIANGLES, M.idx.length, gl.UNSIGNED_SHORT, 0);
  }
  return S.canvas;
}
