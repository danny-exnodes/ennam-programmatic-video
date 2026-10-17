// Real photo → "filmed" plate (WebGL2). One full-screen pass turns a still
// photo plus its prepared maps (scripts/photo/prep.py) into a moving shot:
//
//   • 2.5D camera: dolly / truck / pedestal / zoom / roll with true parallax
//     from a monocular depth map (inverse warp solved per pixel by fixed-point
//     iteration, so near objects slide over far ones);
//   • water that flows: two-phase flow-map advection along the painted flow
//     field, phase jittered by noise (no visible pulsing), with travelling
//     specular glints;
//   • foliage that breathes in the shared wind: coherent low-frequency bend +
//     leaf flutter, scaled by the sway mask, the gust front and nearness;
//   • drifting mist banks that sit in depth (far = denser) and move with wind;
//   • lens: depth-of-field from the depth map (rack focus), bloom/halation from
//     the highlights, volumetric sun rays from the sky mask;
//   • grade: exposure, white balance, filmic shoulder, saturation, split-tone.
//
// Everything is a pure function of time (deterministic).
import { getPass, GLSL_NOISE, hex3 } from './glkit.js';

const FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uImg, uDepth, uMask, uFlow;
uniform vec2 uOut;            // output px
uniform vec2 uImgSize;        // photo px
uniform vec4 uFit;            // cover-fit: uv = fit.xy + q * fit.zw  (q in 0..1 screen)
uniform float uTime, uZoom, uDolly, uRoll, uPar, uFocus, uAperture, uMaxBlur;
uniform vec2 uTruck, uPan;    // parallax translation (depth-scaled) & pan (rigid), in screen fractions
uniform float uFlowAmt, uFlowRate, uFlowGlint, uSway, uSwayFreq, uGust, uWindDir;
uniform float uFog, uFogSpeed, uFogScale, uFogNear, uFogTop;
uniform vec3 uFogCol;
uniform float uExposure, uTemp, uSat, uContrast, uBloom, uBloomThr;
uniform vec3 uShadowTint, uHighTint;
uniform vec3 uRays;           // sun x, y (screen 0..1), amount
uniform vec3 uRayCol;
${GLSL_NOISE}

float depthAt(vec2 uv, float lod) { return textureLod(uDepth, uv, lod).r; }

// screen (0..1) -> photo uv, inverse of the camera warp
vec2 warpInv(vec2 q) {
  float asp = uOut.x / uOut.y;
  vec2 c = vec2(0.5);
  vec2 d = q - c;
  d.x *= asp;
  float cr = cos(-uRoll), sr = sin(-uRoll);
  d = mat2(cr, sr, -sr, cr) * d;
  d.x /= asp;
  vec2 qq = c + d + uPan;
  vec2 p = qq;
  for (int i = 0; i < 7; i++) {
    vec2 uv = uFit.xy + p * uFit.zw;
    float D = depthAt(uv, 2.5) * uPar;
    float s = uZoom * (1.0 + uDolly * D);
    p = c + (qq - c + uTruck * D) / s;
  }
  return p;
}

vec3 photo(vec2 uv, float lod) { return toLin(textureLod(uImg, uv, lod).rgb); }

// flowing water: two-phase flow-map advection
vec3 waterAt(vec2 uv, float lod, float w, float near) {
  vec3 f = texture(uFlow, uv).rgb;
  vec2 dir = vec2(f.b, f.g) * 2.0 - 1.0;
  float spd = f.r * 2.0;
  // a little turbulence in direction
  float tn = vn(uv * vec2(9.0, 14.0) + uTime * 0.15) - 0.5;
  dir = normalize(dir + vec2(-dir.y, dir.x) * tn * 0.5 + 1e-5);
  float jit = vn(uv * 7.0) * 0.6;
  float t = uTime * uFlowRate + jit;
  float p0 = fract(t), p1 = fract(t + 0.5);
  float L = uFlowAmt * spd * (0.4 + near);
  vec2 aspc = vec2(1.0, uImgSize.x / uImgSize.y);
  vec2 o0 = dir * L * (p0 - 0.5) * aspc, o1 = dir * L * (p1 - 0.5) * aspc;
  vec3 a = photo(uv - o0, lod), b = photo(uv - o1, lod);
  float k = abs(1.0 - 2.0 * p0);
  vec3 col = mix(a, b, k);
  // glints travelling with the current
  vec2 gp = uv * uImgSize / 6.0;
  vec2 along = dir * uTime * uFlowRate * L * uImgSize.x / 6.0 * 1.0;
  float g = vn((gp - along) * vec2(1.0, 1.0) + vec2(0.0, uTime * 0.7));
  float lum = dot(col, vec3(0.3, 0.6, 0.1));
  col += vec3(pow(g, 14.0)) * uFlowGlint * smoothstep(0.03, 0.4, lum) * w * 3.0;
  return col;
}

vec3 sampleScene(vec2 uv, float lod, out float wmask) {
  vec3 m = texture(uMask, uv).rgb;   // r water, g sway, b sky
  float D = depthAt(uv, 1.0);
  // foliage sway (coherent bend + flutter)
  if (m.g > 0.01 && uSway > 0.0) {
    vec2 wd = vec2(cos(uWindDir), sin(uWindDir) * 0.3);
    float big = fbm3(uv * vec2(2.2, 1.6) + vec2(uTime * 0.18 * uSwayFreq, 0.0)) - 0.5;
    float osc = sin(uTime * 1.3 * uSwayFreq + uv.x * 9.0 + big * 4.0);
    float fl = vn(uv * vec2(70.0, 55.0) + vec2(uTime * 3.1, uTime * 2.3)) - 0.5;
    vec2 off = wd * (big * 1.4 + osc * 0.35) * uGust * 0.0035 + vec2(fl, fl * 0.7) * 0.0012 * uGust;
    uv += off * uSway * m.g * (0.35 + D);
  }
  wmask = m.r;
  vec3 col = photo(uv, lod);
  if (m.r > 0.01 && uFlowAmt > 0.0) col = mix(col, waterAt(uv, lod, m.r, D), m.r);
  return col;
}

void main() {
  vec2 q = vec2(vUv.x, 1.0 - vUv.y);
  vec2 p = warpInv(q);
  vec2 uv = uFit.xy + p * uFit.zw;
  float D = depthAt(uv, 1.0);
  // depth of field: circle of confusion (output px) from inverse depth
  float coc = min(uMaxBlur, uAperture * abs(D - uFocus) * uOut.y / 1080.0);
  float wm;
  vec3 col;
  if (coc < 1.2) {
    col = sampleScene(uv, max(0.0, log2(uImgSize.x * uFit.z / uOut.x)), wm);
  } else {
    float lod = log2(coc * uImgSize.x * uFit.z / uOut.x * 0.5);
    col = vec3(0.0);
    float tw = 0.0;
    for (int i = 0; i < 8; i++) {
      float a = float(i) * 2.39996 + h12(q * 911.0) * 6.283;
      float r = sqrt((float(i) + 0.5) / 8.0) * coc;
      vec2 o = vec2(cos(a), sin(a)) * r / uOut * uFit.zw;
      // do not let sharp foreground bleed into a blurred background
      float Ds = depthAt(uv + o, 1.0);
      float w = Ds > D + 0.08 && uFocus < Ds - 0.04 ? 0.25 : 1.0;
      col += sampleScene(uv + o, lod, wm) * w;
      tw += w;
    }
    col /= tw;
  }
  // mist banks drifting with the wind, denser with distance and low down
  if (uFog > 0.0) {
    vec2 fp = p * vec2(uOut.x / uOut.y, 1.0) * uFogScale;
    float n = fbm(fp * vec2(1.4, 3.2) + vec2(uTime * uFogSpeed, 0.0));
    float n2 = fbm(fp * vec2(0.7, 1.6) - vec2(uTime * uFogSpeed * 0.55, 0.0) + 7.3);
    float far = pow(clamp(1.0 - D, 0.0, 1.0), 1.6);
    float band = mix(1.0, 1.0 - smoothstep(0.15, 0.7, p.y), uFogTop);
    float dens = smoothstep(0.35, 0.85, n * 0.65 + n2 * 0.55) * (uFogNear + far * (1.0 - uFogNear)) * band;
    col = mix(col, toLin(uFogCol), clamp(dens * uFog, 0.0, 0.92));
  }
  // bloom / halation from highlights
  if (uBloom > 0.0) {
    vec3 b = photo(uv, 5.5) * 0.5 + photo(uv, 4.0) * 0.5;
    col += max(b - uBloomThr, 0.0) * uBloom * vec3(1.0, 0.92, 0.82);
  }
  // sun rays: march toward the sun through the sky mask (in photo space)
  if (uRays.z > 0.0) {
    vec2 sp = uRays.xy;
    vec2 su = uFit.xy + warpInv(sp) * uFit.zw;
    const int N = 20;
    vec2 du = (su - uv) / float(N);
    vec2 u2 = uv + du * h12(q * 731.0 + uTime);
    float acc = 0.0, decay = 1.0;
    for (int i = 0; i < N; i++) {
      float sky = textureLod(uMask, u2, 2.0).b;
      float l = dot(photo(u2, 3.0), vec3(0.3, 0.6, 0.1));
      acc += (sky * 0.6 + smoothstep(0.5, 0.95, l) * 0.5) * decay;
      decay *= 0.92;
      u2 += du;
    }
    float fall = exp(-length((q - sp) * vec2(uOut.x / uOut.y, 1.0)) * 1.6);
    col += toLin(uRayCol) * acc / float(N) * uRays.z * fall * 2.0;
  }
  // grade
  col *= uExposure;
  col *= mix(vec3(1.0), vec3(1.0 + uTemp * 0.10, 1.0 + uTemp * 0.02, 1.0 - uTemp * 0.12), 1.0);
  float L = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(L), col, uSat);
  col *= mix(uShadowTint, uHighTint, smoothstep(0.02, 0.5, L));
  // filmic shoulder (keeps highlights from clipping hard)
  col = col / (1.0 + col * 0.18) * 1.18;
  vec3 s = toSrgb(col);
  s = mix(s, s * s * (3.0 - 2.0 * s), uContrast);
  outColor = vec4(clamp(s, 0.0, 1.0), 1.0);
}`;

const texCache = new WeakMap();

function bindTex(S, el, unit, uniform, mip) {
  const { gl, U } = S;
  let rec = texCache.get(el);
  gl.activeTexture(gl.TEXTURE0 + unit);
  if (!rec || rec.gl !== gl) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, el);
    if (mip) gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    rec = { gl, t };
    texCache.set(el, rec);
  }
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, rec.t);
  gl.uniform1i(U[uniform], unit);
}

const blanks = {};
function blankCanvas(color) {
  if (blanks[color]) return blanks[color];
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(2, 2) : Object.assign(document.createElement('canvas'), { width: 2, height: 2 });
  const x = c.getContext('2d');
  x.fillStyle = color;
  x.fillRect(0, 0, 2, 2);
  blanks[color] = c;
  return c;
}

const depthCache = new WeakMap();
/** CPU copy of the depth map (for projecting overlay anchors). */
export function depthSampler(el) {
  let d = depthCache.get(el);
  if (d) return d;
  const w = 256, h = Math.max(2, Math.round(256 * (el.naturalHeight || el.height) / (el.naturalWidth || el.width)));
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const x = c.getContext('2d', { willReadFrequently: true });
  x.filter = 'blur(2px)';
  x.drawImage(el, 0, 0, w, h);
  const px = x.getImageData(0, 0, w, h).data;
  const arr = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) arr[i] = px[i * 4] / 255;
  d = (u, v) => {
    const X = Math.min(w - 1, Math.max(0, u * (w - 1))), Y = Math.min(h - 1, Math.max(0, v * (h - 1)));
    const x0 = Math.floor(X), y0 = Math.floor(Y), x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
    const fx = X - x0, fy = Y - y0;
    const a = arr[y0 * w + x0] * (1 - fx) + arr[y0 * w + x1] * fx;
    const b = arr[y1 * w + x0] * (1 - fx) + arr[y1 * w + x1] * fx;
    return a * (1 - fy) + b * fy;
  };
  depthCache.set(el, d);
  return d;
}

/**
 * Render a photo plate. Returns { canvas, toScreen(u, v) → [x, y] (output px at scale 1), depthAt(u,v) }.
 * maps: { img, depth, mask, flow } elements. o: see SHOT_API "Ảnh thật quay như phim".
 */
export function renderPhoto(maps, o, outW, outH, scale) {
  const S = getPass('photo', outW, outH, FS);
  const { gl, U } = S;
  S.begin();
  const img = maps.img;
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  bindTex(S, img, 0, 'uImg', true);
  bindTex(S, maps.depth || blankCanvas('#000'), 1, 'uDepth', true);
  bindTex(S, maps.mask || blankCanvas('#000'), 2, 'uMask', false);
  bindTex(S, maps.flow || blankCanvas('#80807f'), 3, 'uFlow', false);
  // cover-fit with optional framing (centre & scale in photo uv)
  const fr = o.frame || {};
  const outA = outW / outH, imA = iw / ih;
  let fw = 1, fh = 1;
  if (imA > outA) fw = outA / imA; else fh = imA / outA;
  const fz = fr.zoom ?? 1;
  fw /= fz; fh /= fz;
  const cx = fr.x ?? 0.5, cy = fr.y ?? 0.5;
  const fit = [Math.min(1 - fw, Math.max(0, cx - fw / 2)), Math.min(1 - fh, Math.max(0, cy - fh / 2)), fw, fh];
  const cam = o.camera || {};
  const t = o.time ?? 0;
  // handheld: low-frequency wander + micro jitter, deterministic
  const hh = cam.handheld ?? 0;
  const n1 = (a) => Math.sin(t * 0.71 + a) * 0.6 + Math.sin(t * 1.37 + a * 2.1) * 0.3 + Math.sin(t * 3.9 + a * 3.3) * 0.1;
  const pan = [(cam.pan?.[0] ?? 0) + hh * 0.004 * n1(1.3), (cam.pan?.[1] ?? 0) + hh * 0.004 * n1(4.1)];
  const roll = (cam.roll ?? 0) + hh * 0.0016 * n1(7.7);
  const truck = cam.truck ?? [0, 0];
  const zoom = cam.zoom ?? 1;
  const dolly = cam.dolly ?? 0;
  const par = cam.parallax ?? 1;
  gl.uniform2f(U.uOut, outW, outH);
  gl.uniform2f(U.uImgSize, iw, ih);
  gl.uniform4fv(U.uFit, fit);
  gl.uniform1f(U.uTime, t);
  gl.uniform1f(U.uZoom, zoom);
  gl.uniform1f(U.uDolly, dolly);
  gl.uniform1f(U.uRoll, roll);
  gl.uniform1f(U.uPar, par);
  gl.uniform2f(U.uTruck, truck[0], truck[1]);
  gl.uniform2f(U.uPan, pan[0], pan[1]);
  const dof = o.dof || {};
  gl.uniform1f(U.uFocus, dof.focus ?? 0.5);
  gl.uniform1f(U.uAperture, dof.aperture ?? 0);
  gl.uniform1f(U.uMaxBlur, dof.max ?? 28);
  const fl = o.flow || {};
  gl.uniform1f(U.uFlowAmt, fl.amount ?? (maps.flow ? 0.02 : 0));
  gl.uniform1f(U.uFlowRate, fl.rate ?? 0.6);
  gl.uniform1f(U.uFlowGlint, fl.glint ?? 0.25);
  const sw = o.sway || {};
  gl.uniform1f(U.uSway, sw.amount ?? 1);
  gl.uniform1f(U.uSwayFreq, sw.freq ?? 1);
  gl.uniform1f(U.uGust, o.gust ?? 1);
  gl.uniform1f(U.uWindDir, o.windDir ?? 0);
  const fog = o.fog || {};
  gl.uniform1f(U.uFog, fog.amount ?? 0);
  gl.uniform1f(U.uFogSpeed, fog.speed ?? 0.03);
  gl.uniform1f(U.uFogScale, fog.scale ?? 1);
  gl.uniform1f(U.uFogNear, fog.near ?? 0.15);
  gl.uniform1f(U.uFogTop, fog.top ?? 0);
  gl.uniform3fv(U.uFogCol, hex3(fog.color ?? '#d9e0de'));
  const g = o.grade || {};
  gl.uniform1f(U.uExposure, g.exposure ?? 1);
  gl.uniform1f(U.uTemp, g.temperature ?? 0);
  gl.uniform1f(U.uSat, g.saturation ?? 1);
  gl.uniform1f(U.uContrast, g.contrast ?? 0.15);
  gl.uniform3fv(U.uShadowTint, hex3(g.shadows ?? '#ffffff'));
  gl.uniform3fv(U.uHighTint, hex3(g.highlights ?? '#ffffff'));
  gl.uniform1f(U.uBloom, o.bloom ?? 0.25);
  gl.uniform1f(U.uBloomThr, o.bloomThreshold ?? 0.55);
  const r = o.rays || null;
  gl.uniform3f(U.uRays, r ? r.x : 0, r ? r.y : 0, r ? r.amount ?? 0.5 : 0);
  gl.uniform3fv(U.uRayCol, hex3(r?.color ?? '#fff1d0'));
  S.draw();

  const dS = maps.depth ? depthSampler(maps.depth) : () => 0;
  // forward camera map: photo uv → screen px (scale 1), mirrors warpInv
  const W1 = outW / scale, H1 = outH / scale;
  const toScreen = (u, v, Dover) => {
    const px = (u - fit[0]) / fit[2], py = (v - fit[1]) / fit[3];
    const D = (Dover ?? dS(u, v)) * par;
    const s = zoom * (1 + dolly * D);
    let qx = 0.5 + (px - 0.5) * s - truck[0] * D - pan[0];
    let qy = 0.5 + (py - 0.5) * s - truck[1] * D - pan[1];
    // roll
    const asp = W1 / H1;
    let dx = (qx - 0.5) * asp, dy = qy - 0.5;
    const c = Math.cos(roll), sn = Math.sin(roll);
    const rx = c * dx - sn * dy, ry = sn * dx + c * dy;
    qx = 0.5 + rx / asp; qy = 0.5 + ry;
    return [qx * W1, qy * H1, s];
  };
  return { canvas: S.canvas, toScreen, depthAt: dS, fit, scaleAt: (u, v) => zoom * (1 + dolly * dS(u, v) * par) / fit[2] };
}
