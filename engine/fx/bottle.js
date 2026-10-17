// Clear PET water bottle (WebGL2), shaded per pixel from an analytic lathe
// profile: the water-filled body works as a cylindrical lens (the scene
// behind appears inverted & magnified), thick plastic darkens the silhouette,
// Fresnel reflections of the sky and two soft highlight strips define the
// form, the label wraps around the cylinder, the cap is ridged and opaque.
// Condensation drops are added on top (2D lens drops from dew.js).
import { getPass, GLSL_NOISE, hex3, makeCanvas } from './glkit.js';
import { rng, rgba, mix } from '../math.js';

const FS = `#version 300 es
precision highp float;
out vec4 outColor;
uniform vec2 uPix;               // GL canvas size (px) = bbox size
uniform vec4 uBox;               // bbox in output px: x0, y0, w, h
uniform vec2 uOut;               // output frame size (px)
uniform vec2 uBase, uTop;        // screen px of bottle base centre & top centre
uniform float uRBase, uRTop;     // px per unit radius at base / top (perspective)
uniform sampler2D uBg, uLabel;
uniform vec3 uSunCol, uSky, uCap, uTint;
uniform vec2 uLight;             // screen-space light direction
uniform float uFill, uFrost, uTime, uSunPow, uLabelOn;
${GLSL_NOISE}

// lathe profile: radius (body = 1) at height fraction v
float prof(float v) {
  if (v < 0.025) return mix(0.86, 1.0, smoothstep(0.0, 0.025, v));
  if (v < 0.56) {
    float r = 1.0;
    // horizontal grip ribs above and below the label
    r -= 0.035 * smoothstep(0.012, 0.0, abs(v - 0.1)) + 0.035 * smoothstep(0.012, 0.0, abs(v - 0.16));
    r -= 0.03 * smoothstep(0.012, 0.0, abs(v - 0.6 + 0.07));
    return r;
  }
  if (v < 0.79) { float k = (v - 0.56) / 0.23; return mix(1.0, 0.42, 0.5 - 0.5 * cos(3.14159 * k)); }
  if (v < 0.865) return 0.42 + 0.07 * smoothstep(0.008, 0.0, abs(v - 0.805));
  if (v < 1.0) return 0.47 * (1.0 - 0.06 * smoothstep(0.97, 1.0, v));
  return 0.0;
}

void main() {
  vec2 px = vec2(uBox.x + gl_FragCoord.x * uBox.z / uPix.x, uBox.y + (uPix.y - gl_FragCoord.y) * uBox.w / uPix.y);
  float v = clamp((uBase.y - px.y) / (uBase.y - uTop.y), -0.01, 1.01);
  if (v < 0.0 || v > 1.0) { outColor = vec4(0); return; }
  float cx = mix(uBase.x, uTop.x, v);
  float rpx = mix(uRBase, uRTop, v);
  float R = prof(v);
  float u = (px.x - cx) / (R * rpx);
  float aa = rpx * R;                         // radius in px for AA
  float edge = 1.0 - smoothstep(1.0 - 1.5 / aa, 1.0, abs(u));
  if (abs(u) > 1.0) { outColor = vec4(0); return; }
  float nz = sqrt(max(0.0, 1.0 - u * u));
  float dv = 0.004;
  float slope = (prof(v + dv) - prof(v - dv)) / (2.0 * dv) * rpx / ((uBase.y - uTop.y));
  vec3 N = normalize(vec3(u, -slope * 2.0, nz));
  vec3 sunc = toLin(uSunCol) * uSunPow;
  vec2 L = normalize(uLight);
  vec3 col;
  float alpha = 1.0;
  if (v > 0.865) {
    // ---- cap: opaque, vertical ridges, glossy top edge
    float ridges = 0.82 + 0.18 * sin(asin(clamp(u, -1.0, 1.0)) * 46.0);
    float diff = 0.35 + 0.65 * max(dot(N, normalize(vec3(L.x, -L.y, 0.8))), 0.0);
    col = toLin(uCap) * diff * ridges;
    float hl = smoothstep(0.25, 0.0, abs(u + 0.45 * L.x)) * 0.5;
    col += sunc * hl * 0.35 + toLin(uSky) * pow(1.0 - nz, 3.0) * 0.25;
    col *= mix(1.0, 0.75, smoothstep(0.97, 1.0, v));
  } else {
    // ---- clear plastic + water: refraction of what is behind
    bool water = v < uFill;
    float lens = water ? -0.75 : 0.18;       // water-filled cylinder inverts the background
    vec2 off = vec2(u * R * rpx * lens, (water ? -0.12 : 0.0) * R * rpx);
    vec2 buv = (vec2(cx, px.y) + off) / uOut;
    vec3 bg = toLin(texture(uBg, clamp(buv, 0.001, 0.999)).rgb);
    vec3 tint = water ? toLin(uTint) : vec3(0.97, 0.99, 1.0);
    col = bg * tint * (water ? 1.08 : 1.0);
    // light focused through the water column (bright core)
    if (water) col += sunc * 0.12 * smoothstep(0.6, 0.0, abs(u - 0.25 * L.x)) * nz;
    // meniscus line at the fill level
    col = mix(col, vec3(0.9), smoothstep(0.006, 0.0, abs(v - uFill)) * 0.6 * nz);
    // Fresnel reflection of the sky + soft studio strips
    float F = 0.04 + 0.96 * pow(1.0 - nz, 4.0);
    vec3 env = mix(toLin(uSky) * 0.9, toLin(vec3(1.0)), 0.3 + 0.4 * clamp(N.y + 0.3, 0.0, 1.0));
    float strip = smoothstep(0.1, 0.0, abs(u - (-0.62 * sign(L.x + 1e-3)))) * 1.3 + smoothstep(0.06, 0.0, abs(u - 0.78 * sign(L.x + 1e-3))) * 0.5;
    col = mix(col, env, F) + env * strip * 0.8 * (0.7 + 0.3 * nz);
    // thick plastic at the silhouette
    col *= 1.0 - 0.55 * pow(abs(u), 10.0);
    // frosty condensation film
    float fr = uFrost * smoothstep(0.03, 0.08, v) * (1.0 - smoothstep(0.55, 0.62, v)) * (0.55 + 0.45 * vn(vec2(u * 30.0, v * 140.0)));
    col = mix(col, toLin(vec3(0.86, 0.9, 0.92)), fr * 0.35);
    // ---- label
    if (uLabelOn > 0.5 && v > 0.205 && v < 0.505) {
      float lu = 0.5 + asin(clamp(u, -1.0, 1.0)) / 3.14159;   // front half of the wrap
      float lv = (v - 0.205) / 0.3;
      vec4 lab = texture(uLabel, vec2(lu, 1.0 - lv));
      float diff = 0.45 + 0.55 * max(dot(N, normalize(vec3(L.x, -L.y, 0.9))), 0.0);
      vec3 lc = toLin(lab.rgb) * diff * (0.85 + 0.15 * nz);
      lc += env * F * 0.6 + sunc * pow(max(0.0, 1.0 - abs(u + 0.4 * L.x) * 3.0), 6.0) * 0.12;
      col = mix(col, lc, lab.a);
    }
  }
  col = pow(max(col, 0.0), vec3(1.0 / 2.2));
  outColor = vec4(col * edge * alpha, edge * alpha);
}`;

// ------------------------------------------------------------- label ----
const labelCache = new Map();
export function drawLabel(o = {}) {
  const key = JSON.stringify(o);
  if (labelCache.has(key)) return labelCache.get(key);
  const W = 1400, H = 640;
  const c = makeCanvas(W, H);
  const x = c.getContext('2d');
  const green = o.color ?? '#0d6b4c', green2 = o.color2 ?? '#3fa777', sky = o.sky ?? '#d8f0ea';
  // translucent wrap with a white printed panel in the middle
  x.clearRect(0, 0, W, H);
  const g = x.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, rgba(sky, 0.95));
  g.addColorStop(1, rgba('#ffffff', 0.97));
  x.fillStyle = g;
  x.fillRect(0, 0, W, H);
  // mountain ridge line art + green band at the bottom
  x.fillStyle = rgba(green2, 0.85);
  x.beginPath();
  x.moveTo(0, H * 0.78);
  const r = rng(o.seed ?? 3);
  for (let i = 0; i <= 28; i++) {
    const px = (i / 28) * W;
    const py = H * (0.62 + 0.12 * Math.sin(i * 0.9 + 1) + 0.05 * r());
    x.lineTo(px, py);
  }
  x.lineTo(W, H);
  x.lineTo(0, H);
  x.closePath();
  x.fill();
  x.fillStyle = green;
  x.beginPath();
  x.moveTo(0, H * 0.84);
  for (let i = 0; i <= 28; i++) x.lineTo((i / 28) * W, H * (0.76 + 0.07 * Math.sin(i * 0.7 + 3)));
  x.lineTo(W, H);
  x.lineTo(0, H);
  x.closePath();
  x.fill();
  // swallow emblem
  const cx = W / 2, cy = H * 0.22;
  x.save();
  x.translate(cx, cy);
  x.scale(1.25, 1.25);
  x.fillStyle = green;
  x.beginPath();
  x.moveTo(-70, -8);
  x.bezierCurveTo(-30, -30, 10, -26, 34, -8);   // wing top
  x.bezierCurveTo(48, -2, 60, -6, 74, -18);      // head
  x.bezierCurveTo(66, 0, 52, 8, 36, 8);
  x.bezierCurveTo(14, 12, -6, 24, -26, 44);       // tail fork 1
  x.lineTo(-18, 18);
  x.bezierCurveTo(-34, 30, -52, 34, -66, 30);     // tail fork 2
  x.bezierCurveTo(-46, 18, -36, 8, -30, 2);
  x.bezierCurveTo(-46, 0, -60, -2, -70, -8);
  x.closePath();
  x.fill();
  x.restore();
  // wordmark
  x.textAlign = 'center';
  x.fillStyle = green;
  x.font = '700 170px "Playfair Display", Georgia, serif';
  x.fillText(o.name ?? 'Én Nam', cx, H * 0.56);
  x.font = '600 40px "Be Vietnam Pro", sans-serif';
  x.fillStyle = '#20453a';
  x.fillText(o.subtitle ?? 'NƯỚC KHOÁNG THIÊN NHIÊN', cx, H * 0.66);
  x.font = '400 30px "Be Vietnam Pro", sans-serif';
  x.fillStyle = '#ffffff';
  x.fillText(o.volume ?? '500 ml', cx, H * 0.93);
  x.font = '400 26px "Be Vietnam Pro", sans-serif';
  x.fillStyle = rgba('#20453a', 0.8);
  x.fillText(o.tagline ?? 'Tinh khiết từ đại ngàn', cx, H * 0.725);
  // fine print at the sides (wraps out of view)
  x.font = '400 22px "Be Vietnam Pro", sans-serif';
  x.fillStyle = rgba('#20453a', 0.7);
  x.textAlign = 'left';
  ['Khoáng chất tự nhiên', 'Ca²⁺ · Mg²⁺ · HCO₃⁻', 'pH 7.2'].forEach((t, i) => x.fillText(t, 70, H * (0.3 + i * 0.06)));
  x.textAlign = 'right';
  ['Đóng chai tại nguồn', 'Không chất bảo quản', 'www.ennam.vn'].forEach((t, i) => x.fillText(t, W - 70, H * (0.3 + i * 0.06)));
  labelCache.set(key, c);
  return c;
}

/**
 * Render the bottle. geo: { base:[sx,sy], top:[sx,sy], rBase, rTop } in LOGICAL px.
 * bg: snapshot canvas of the frame (full res). Returns { canvas, box } in output px.
 */
export function renderBottleGL(geo, bg, scale, outW, outH, o, sun) {
  const pad = 6;
  const rMax = Math.max(geo.rBase, geo.rTop) * scale * 1.05;
  const x0 = Math.floor(Math.min(geo.base[0], geo.top[0]) * scale - rMax - pad);
  const x1 = Math.ceil(Math.max(geo.base[0], geo.top[0]) * scale + rMax + pad);
  const y0 = Math.floor(geo.top[1] * scale - pad), y1 = Math.ceil(geo.base[1] * scale + pad);
  const bw = Math.max(4, x1 - x0), bh = Math.max(4, y1 - y0);
  // quantise GL canvas size to limit context churn
  const qw = Math.ceil(bw / 32) * 32, qh = Math.ceil(bh / 32) * 32;
  const S = getPass('bottle', qw, qh, FS);
  const { gl, U } = S;
  S.begin();
  S.image('uBg', 0, bg);
  S.image('uLabel', 1, drawLabel(o.label || {}));
  gl.uniform2f(U.uPix, qw, qh);
  gl.uniform4f(U.uBox, x0, y0, qw, qh);
  gl.uniform2f(U.uOut, outW, outH);
  gl.uniform2f(U.uBase, geo.base[0] * scale, geo.base[1] * scale);
  gl.uniform2f(U.uTop, geo.top[0] * scale, geo.top[1] * scale);
  gl.uniform1f(U.uRBase, geo.rBase * scale);
  gl.uniform1f(U.uRTop, geo.rTop * scale);
  gl.uniform3fv(U.uSunCol, hex3(sun.color));
  gl.uniform1f(U.uSunPow, sun.intensity ?? 1);
  gl.uniform3fv(U.uSky, hex3(o.sky ?? '#cfe3f0'));
  gl.uniform3fv(U.uCap, hex3(o.cap ?? '#0d6b4c'));
  gl.uniform3fv(U.uTint, hex3(o.tint ?? '#e4f4f6'));
  gl.uniform2f(U.uLight, sun.screenDir.x, sun.screenDir.y);
  gl.uniform1f(U.uFill, o.fill ?? 0.83);
  gl.uniform1f(U.uFrost, o.frost ?? 0.4);
  gl.uniform1f(U.uTime, o.time ?? 0);
  gl.uniform1f(U.uLabelOn, o.label === false ? 0 : 1);
  S.draw();
  return { canvas: S.canvas, box: [x0, y0, qw, qh] };
}

/** Deterministic condensation drop layout on the bottle (u ∈ -1..1, v 0..1, r in body radii). */
export function condensation(o = {}) {
  const r = rng(o.seed ?? 21);
  const drops = [];
  for (let i = 0; i < (o.count ?? 70); i++) {
    const v = r.range(0.04, 0.78);
    if (v > 0.2 && v < 0.51 && r() < 0.75) continue; // fewer on the label
    drops.push({ u: r.range(-0.92, 0.92), v, r: Math.pow(r(), 2.2) * 0.075 + 0.012, run: r() < 0.08 ? r.range(0, 3) : -1 });
  }
  return drops;
}

export { mix };
