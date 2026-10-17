// Per-pixel shaded hero leaf (WebGL2). The leaf surface comes from
// dew.js leafGeometry (curved midrib, V-fold, drip tip); this renders it as
// a mesh with a procedural lamina shader:
//  • venation: tapering midrib, curved secondary veins that loop near the
//    margin (brochidodromous), reticulate tertiary network (Voronoi edges);
//  • front-lit: sunken vein grooves perturb the normal, waxy cuticle gives a
//    Fresnel sky sheen + sun specular;
//  • back-lit: light transmitted through the lamina (warm, saturated glow),
//    veins read as a brighter network, margins darker (thicker tissue).
import { hexToRgb } from '../math.js';

const VS = `#version 300 es
in vec2 aClip; in float aDepth; in vec2 aUV; in vec3 aN; in vec3 aV; in float aHW;
out vec2 vUV; out vec3 vN; out vec3 vV; out float vHW;
void main() {
  vUV = aUV; vN = aN; vV = aV; vHW = aHW;
  gl_Position = vec4(aClip, aDepth, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec2 vUV; in vec3 vN; in vec3 vV; in float vHW;
out vec4 outColor;
uniform vec3 uSun, uSunCol, uSky, uBase, uBase2;
uniform float uL, uTrans, uGloss, uSeed, uSunPow, uVeins, uAge;
float h12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 h22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031,.1030,.0973)); p3 += dot(p3, p3.yzx+33.33); return fract((p3.xx+p3.yz)*p3.zy); }
float vn(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.-2.*f);
  return mix(mix(h12(i),h12(i+vec2(1,0)),u.x), mix(h12(i+vec2(0,1)),h12(i+vec2(1,1)),u.x), u.y); }
float voronoiEdge(vec2 x) {
  vec2 ip = floor(x), fp = fract(x); float d1 = 9., d2 = 9.;
  for (int j=-1;j<=1;j++) for (int i=-1;i<=1;i++) {
    vec2 o = vec2(i,j); vec2 r = o + h22(ip+o+uSeed) - fp; float d = dot(r,r);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
  }
  return sqrt(d2) - sqrt(d1);
}
vec3 toLin(vec3 c){ return pow(c, vec3(2.2)); }
// vein field: returns mask 0..1 and a gradient-ish groove factor
float veinMask(vec2 uv, float hw, out float midr) {
  float u = uv.x, v = uv.y, s = abs(v);
  float x = u * uL, y = v * hw;              // metres in the lamina
  // midrib
  float mw = mix(0.0011, 0.00025, u) * uVeins;
  float dm = abs(y);
  midr = 1.0 - smoothstep(mw * 0.4, mw, dm);
  // secondary veins: u_k + a·s^0.85 curves toward the tip
  float n = 11.0;
  float off = 0.20 * pow(s, 0.85) * (1.0 - 0.35 * u);
  float kf = (u - off - 0.04) * n;
  float fk = fract(kf + 0.5) - 0.5;
  float du = abs(fk) / n * uL;               // distance along u in metres
  float vw = mix(0.00045, 0.00012, s) * uVeins;
  float sec = (1.0 - smoothstep(vw * 0.4, vw, du * (0.6 + 0.6 * s))) * (1.0 - smoothstep(0.78, 0.95, s)) * step(0.02, u) * step(u, 0.93);
  // looping marginal vein
  float marg = (1.0 - smoothstep(0.0, 0.035, abs(s - 0.88))) * 0.6 * step(0.05, u) * step(u, 0.9);
  // tertiary reticulate network
  float tert = 1.0 - smoothstep(0.0, 0.06, voronoiEdge(vec2(x, y) / 0.0022));
  return clamp(max(max(midr, sec), marg * 0.7) + tert * 0.2 * uVeins, 0.0, 1.0);
}
void main() {
  float hw = vHW;
  float midr;
  float vm = veinMask(vUV, hw, midr);
  // AA at the margin (mesh boundary sits at |v| = 1)
  float aa = 1.0 - smoothstep(1.0 - 2.0 * fwidth(vUV.y), 1.0, abs(vUV.y));
  vec3 V = normalize(vV);
  vec3 N = normalize(vN);
  bool flip = dot(N, V) < 0.0;
  if (flip) N = -N;                       // we see the underside
  // vein grooves + micro relief perturb the normal
  vec2 e = vec2(0.002, 0.0);
  float m1 = veinMask(vUV + e.xy, hw, midr), m2 = veinMask(vUV + e.yx * 0.5, hw, midr);
  float bump = (vn(vUV * vec2(140.0, 60.0) + uSeed) - 0.5) * 0.25;
  vec3 T = normalize(cross(N, vec3(0.0, 1.0, 0.0)) + 1e-4);
  vec3 B = normalize(cross(N, T));
  N = normalize(N + (T * (m1 - vm) * 6.0 + B * (m2 - vm) * 6.0 + T * bump * 0.6) * (flip ? -0.5 : 0.8));
  float ndl = dot(N, uSun);
  // albedo: colour variation, yellowing toward margin and tip, darker base
  float n1 = vn(vUV * vec2(9.0, 4.0) + uSeed * 3.0), n2 = vn(vUV * vec2(40.0, 18.0) + uSeed);
  vec3 alb = toLin(mix(uBase, uBase2, smoothstep(0.35, 0.95, n1 * 0.7 + vUV.x * 0.45 + abs(vUV.y) * 0.2) * uAge));
  alb *= 0.82 + 0.3 * n2;
  alb = mix(alb, alb * vec3(1.25, 1.2, 0.75), smoothstep(0.75, 1.0, abs(vUV.y)) * 0.35);
  vec3 veinCol = mix(alb, toLin(vec3(0.82, 0.86, 0.55)), 0.55);
  vec3 sky = toLin(uSky), sunc = toLin(uSunCol) * uSunPow;
  vec3 col;
  if (ndl > 0.0) {
    // front lit: diffuse + sky ambient + waxy cuticle reflections
    vec3 a = mix(alb, veinCol, vm * 0.75);
    vec3 H = normalize(uSun + V);
    float spec = pow(max(dot(N, H), 0.0), 70.0) * 1.2 + pow(max(dot(N, H), 0.0), 900.0) * 6.0;
    float F = 0.04 + 0.96 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
    col = a * (sunc * ndl * 0.95 + sky * 0.35) + (spec * sunc + F * sky * 0.6) * uGloss;
  } else {
    // back lit: transmitted light through the lamina
    float thick = 0.6 + 0.5 * n2 + vm * 0.25 + smoothstep(0.85, 1.0, abs(vUV.y)) * 0.6;
    vec3 trans = toLin(mix(uBase, vec3(0.82, 0.9, 0.25), 0.55)) * exp(-thick * 1.2) * 2.2;
    trans = mix(trans, trans * vec3(1.35, 1.3, 0.8), vm * 0.6);
    float F = 0.04 + 0.96 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
    col = trans * sunc * (0.25 + 0.75 * (-ndl)) * uTrans + alb * (sky * 0.35 + sunc * 0.12) + F * sky * 0.15 * uGloss;
  }
  col = pow(max(col, 0.0), vec3(1.0 / 2.2));
  outColor = vec4(col * aa, aa);
}`;

const ctxCache = new Map();
function getGL(pw, ph) {
  const key = pw + 'x' + ph;
  let S = ctxCache.get(key);
  if (S) return S;
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(pw, ph) : Object.assign(document.createElement('canvas'), { width: pw, height: ph });
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, antialias: true, depth: true, preserveDrawingBuffer: true });
  if (!gl) throw new Error('WebGL2 không khả dụng — không vẽ được lá');
  const sh = (t, src) => {
    const o = gl.createShader(t);
    gl.shaderSource(o, src);
    gl.compileShader(o);
    if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error('GLSL lá: ' + gl.getShaderInfoLog(o));
    return o;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  const U = {};
  for (const n of ['uSun', 'uSunCol', 'uSky', 'uBase', 'uBase2', 'uL', 'uTrans', 'uGloss', 'uSeed', 'uSunPow', 'uVeins', 'uAge']) U[n] = gl.getUniformLocation(prog, n);
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const vbo = gl.createBuffer();
  const ibo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  const STRIDE = 14 * 4;
  const attr = (name, size, off) => {
    const l = gl.getAttribLocation(prog, name);
    if (l < 0) return;
    gl.enableVertexAttribArray(l);
    gl.vertexAttribPointer(l, size, gl.FLOAT, false, STRIDE, off * 4);
  };
  attr('aClip', 2, 0); attr('aDepth', 1, 2); attr('aUV', 2, 3); attr('aN', 3, 5); attr('aV', 3, 8); attr('aHW', 1, 11);
  S = { canvas, gl, prog, U, vao, vbo, ibo, nIdx: 0, meshKey: '' };
  ctxCache.set(key, S);
  if (ctxCache.size > 3) ctxCache.delete(ctxCache.keys().next().value);
  return S;
}

const c3 = (h) => hexToRgb(h).map((v) => v / 255);

/**
 * Render a leaf surface. g = leafGeometry(...), P = project, cam, sun, sky.
 * Returns the GL canvas (full frame, premultiplied) — caller composites it.
 */
export function renderLeafGL(g, P, cam, sun, sky, scale, o = {}) {
  const pw = Math.round(cam.W * scale), ph = Math.round(cam.H * scale);
  const S = getGL(pw, ph);
  const { gl } = S;
  const NU = 72, NV = 14;
  const data = new Float32Array((NU + 1) * (NV + 1) * 14);
  let k = 0;
  for (let i = 0; i <= NU; i++) {
    const u = Math.min(0.999, Math.max(0.001, i / NU));
    const f = g.frame(u);
    const hw = g.halfWidth(u);
    for (let j = 0; j <= NV; j++) {
      const v = -1 + (2 * j) / NV;
      const p = g.point(u, v);
      const pr = P(p[0], p[1], p[2]);
      // fold: margins tilt up, so the normal leans toward the midrib
      const tilt = (o.fold ?? 0.12) * Math.sign(v) * 1.2;
      const n = [f.n[0] - f.side[0] * tilt, f.n[1] - f.side[1] * tilt, f.n[2] - f.side[2] * tilt];
      const nl = Math.hypot(...n) || 1;
      data[k++] = ((pr[0] * scale) / pw) * 2 - 1;
      data[k++] = 1 - ((pr[1] * scale) / ph) * 2;
      data[k++] = Math.min(0.999, Math.max(-0.999, pr[2] / 5 - 0.5));
      data[k++] = u; data[k++] = v;
      data[k++] = n[0] / nl; data[k++] = n[1] / nl; data[k++] = n[2] / nl;
      data[k++] = cam.pos[0] - p[0]; data[k++] = cam.pos[1] - p[1]; data[k++] = cam.pos[2] - p[2];
      data[k++] = hw; data[k++] = 0; data[k++] = 0;
    }
  }
  gl.bindVertexArray(S.vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, S.vbo);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
  const mk = NU + 'x' + NV;
  if (S.meshKey !== mk) {
    const idx = new Uint16Array(NU * NV * 6);
    let q = 0;
    for (let i = 0; i < NU; i++) {
      for (let j = 0; j < NV; j++) {
        const a = i * (NV + 1) + j, b = a + NV + 1;
        idx.set([a, b, a + 1, a + 1, b, b + 1], q);
        q += 6;
      }
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, S.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    S.nIdx = idx.length;
    S.meshKey = mk;
  }
  gl.viewport(0, 0, pw, ph);
  if (!o.keep) {
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  }
  gl.enable(gl.DEPTH_TEST);
  gl.useProgram(S.prog);
  const U = S.U;
  gl.uniform3fv(U.uSun, sun.dir);
  gl.uniform3fv(U.uSunCol, c3(sun.color));
  gl.uniform1f(U.uSunPow, (sun.intensity ?? 1) * 1.1);
  gl.uniform3fv(U.uSky, c3(sky.top));
  gl.uniform3fv(U.uBase, c3(o.color ?? '#3d7a28'));
  gl.uniform3fv(U.uBase2, c3(o.color2 ?? '#8aa83a'));
  gl.uniform1f(U.uL, g.L);
  gl.uniform1f(U.uTrans, sun.translucency ?? 1);
  gl.uniform1f(U.uGloss, o.gloss ?? 0.6);
  gl.uniform1f(U.uSeed, o.seed ?? 1);
  gl.uniform1f(U.uVeins, o.veinStrength ?? 1);
  gl.uniform1f(U.uAge, o.age ?? 0.5);
  gl.drawElements(gl.TRIANGLES, S.nIdx, gl.UNSIGNED_SHORT, 0);
  return S.canvas;
}
