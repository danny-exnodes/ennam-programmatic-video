// Landscape backdrop (WebGL2): sky with sun & clouds, layered mountain ridges
// fading into aerial haze and valley mist, and a forest edge (far bank) built
// from individual crowns with leaf-clump shading, back-lit rims and sky holes
// through the canopy. Rendered per pixel from the scene camera's rays, so it
// sits correctly in perspective and can be rendered again through the
// mirrored camera for water reflections.
//
// Also: screen-space light shafts (crepuscular rays) — a radial accumulation
// of bright sky toward the sun, occluded by whatever was drawn in front.
import { getPass, GLSL_NOISE, hex3, compositeBlurred, makeCanvas } from './glkit.js';

const FS = `#version 300 es
precision highp float;
out vec4 outColor;
uniform vec2 uPix, uLogical; uniform float uScale;
uniform vec3 uCamPos, uCamF, uCamR, uCamU; uniform float uFocal;
uniform float uMirror, uTime, uSeed;
uniform vec3 uSun, uSunCol; uniform float uSunPow;
uniform vec3 uSkyTop, uSkyHor, uHaze, uMtnFar, uMtnNear, uForest, uForest2, uBank;
uniform float uClouds, uMist, uFog, uForestZ, uTreeH, uCrown, uWind, uMountains, uHoles, uMtnScale;
${GLSL_NOISE}

float ridge(float a, float i) {
  float f = (2.0 + i * 1.6) * uMtnScale;
  float n = fbm(vec2(a * f + uSeed * 3.1 + i * 13.7, i * 5.3));
  float r = 1.0 - abs(2.0 * fbm(vec2(a * f * 0.7 + i * 4.1, 7.0 + i)) - 1.0);
  return 0.25 + 0.5 * n + 0.35 * r * r;
}
float crowns(float X, out float edgeR) {
  float cs = uCrown;
  float c = floor(X / cs);
  float y = uTreeH * 0.22;
  edgeR = cs;
  for (int j = -2; j <= 2; j++) {
    float cc = c + float(j);
    float hj = h12(vec2(cc, uSeed));
    float cx = (cc + 0.25 + 0.5 * h12(vec2(cc, 7.0 + uSeed))) * cs;
    float ch = uTreeH * (0.55 + 0.6 * hj);
    bool con = h12(vec2(cc, 3.0)) < 0.18;
    float R = cs * (con ? 0.55 : 0.75 + 0.45 * h12(vec2(cc, 9.0)));
    float dx = abs(X - cx);
    if (dx > R * 2.2) continue;
    float yy;
    float k = dx / R;
    if (con) yy = ch * (1.0 - dx / (R * 1.1));
    else if (k < 1.0) yy = ch - R + R * sqrt(1.0 - k * k);
    else yy = (ch - R) * exp(-(k - 1.0) * 2.2);   // lower foliage skirt fills between crowns
    if (yy > y) { y = yy; edgeR = R; }
  }
  // cauliflower outline: smaller sub-crowns bulging out of each crown
  float cs2 = cs * 0.34;
  float c2 = floor(X / cs2);
  float bump = 0.0;
  for (int j = -1; j <= 1; j++) {
    float cc = c2 + float(j);
    float cx = (cc + 0.5 + 0.35 * (h12(vec2(cc, 21.0)) - 0.5)) * cs2;
    float r = cs2 * (0.55 + 0.4 * h12(vec2(cc, 23.0)));
    float k = (X - cx) / r;
    if (abs(k) < 1.0) bump = max(bump, r * sqrt(1.0 - k * k) * (0.35 + 0.65 * h12(vec2(cc, 29.0))));
  }
  y += bump - cs2 * 0.25;
  y += uCrown * (0.22 * (fbm3(vec2(X * 0.45, 2.0)) - 0.5) + 0.035 * vn(vec2(X * 7.0, 5.0)) + 0.012 * vn(vec2(X * 22.0, 1.0)));
  return y;
}

void main() {
  vec2 sp = vec2(gl_FragCoord.x, uPix.y - gl_FragCoord.y) / uScale;
  vec2 ndc = (sp - uLogical * 0.5) / uFocal;
  vec3 d = normalize(uCamF + ndc.x * uCamR - ndc.y * uCamU);
  vec3 o = uCamPos;
  if (uMirror > 0.5) { d.y = -d.y; o.y = -o.y; }
  float horiz = max(length(d.xz), 1e-4);
  float el = d.y / horiz;                       // tan(elevation)
  float az = atan(d.x, d.z);
  float sunA = max(dot(d, uSun), 0.0);
  vec3 sunc = toLin(uSunCol) * uSunPow;

  // ---------------- sky ----------------
  float tEl = clamp(el * 1.6, 0.0, 1.0);
  vec3 col = mix(toLin(uSkyHor), toLin(uSkyTop), pow(tEl, 0.55));
  col += sunc * (pow(sunA, 1800.0) * 30.0 + pow(sunA, 80.0) * 0.4 + pow(sunA, 8.0) * 0.1);
  if (el > 0.0 && uClouds > 0.0) {
    vec2 cuv = d.xz / (d.y + 0.06) * 0.55 + vec2(uTime * 0.006 * uWind, 0.0);
    float cl = smoothstep(0.42, 0.82, fbm(cuv * 1.3 + uSeed));
    float thick = fbm3(cuv * 3.0);
    vec3 cc = mix(toLin(vec3(0.82, 0.84, 0.86)), toLin(vec3(1.0)), thick) ;
    cc = mix(cc * 0.85, sunc * 0.9 + 0.2, pow(sunA, 8.0) * (1.0 - thick));  // silver lining toward the sun
    col = mix(col, cc, cl * uClouds * smoothstep(0.0, 0.18, el));
  }

  // ---------------- valley floor: forest canopy seen from above ----------------
  if (d.y < 0.0 && o.y > 2.0) {
    float tg = -o.y / d.y;
    vec3 Pg = o + d * tg;
    vec2 q = Pg.xz * 0.25;
    float cl = fbm(q);
    float gx = fbm(q + vec2(0.07, 0.0)) - cl, gz = fbm(q + vec2(0.0, 0.07)) - cl;
    vec3 n = normalize(vec3(-gx * 12.0, 1.0, -gz * 12.0));
    float diff = max(dot(n, uSun), 0.0);
    float fp = tg / uFocal / max(-d.y, 0.02);
    float leaf = mix(vn(Pg.xz * 1.3), 0.5, clamp(fp * 3.0, 0.0, 1.0));
    vec3 fc = mix(toLin(uForest), toLin(uForest2), smoothstep(0.3, 0.7, fbm3(Pg.xz * 0.01)));
    vec3 gc = fc * (0.3 + 1.1 * diff * sunc) * (0.7 + 0.5 * cl) * (0.8 + 0.4 * leaf);
    float fogK = 1.0 - exp(-tg / uFog * 1.4);
    float mistG = uMist * 0.5 * smoothstep(0.35, 0.75, fbm3(Pg.xz * 0.004 + uTime * 0.01));
    col = mix(gc, toLin(uHaze) + sunc * pow(sunA, 5.0) * 0.2, clamp(fogK + mistG, 0.0, 1.0));
  }

  // ---------------- mountains (far -> near) ----------------
  if (uMountains > 0.5) {
    for (int ii = 3; ii >= 0; ii--) {
      float i = float(ii);
      float D = 2600.0 * pow(0.55, i);
      float Hh = D * (0.10 + 0.04 * i) * uMountains;
      float h = Hh * ridge(az, i);
      float rt = (h - o.y) / D;
      bool groundFirst = d.y < 0.0 && (-o.y / d.y) * horiz < D;
      if (el < rt && !groundFirst) {
        float bt = (0.0 - o.y) / D;
        vec3 base = mix(toLin(uMtnFar), toLin(uMtnNear), i / 3.0);
        float tex = fbm3(vec2(az * 40.0 + i * 3.0, el * 60.0));
        float vert = clamp((el - bt) / max(rt - bt, 1e-4), 0.0, 1.0);   // 0 at foot, 1 at ridge
        vec3 mc = base * (0.88 + 0.24 * tex) * mix(1.12, 0.92, vert);
        float rim = exp(-(rt - el) * D * 0.08) * pow(sunA, 3.0);
        mc += sunc * rim * 0.6;
        float fogK = 1.0 - exp(-D / uFog);
        // valley mist in the lower part of each ridge
        float low = 1.0 - smoothstep(bt, bt + (rt - bt) * 0.55, el);
        float mist = uMist * low * (0.6 + 0.4 * fbm3(vec2(az * 6.0 + uTime * 0.01, i * 3.0 + uTime * 0.02)));
        vec3 hz = toLin(uHaze) + sunc * pow(sunA, 4.0) * 0.25;
        col = mix(mc, hz, clamp(fogK + mist, 0.0, 1.0));
      }
    }
  }

  // ---------------- forest edge (far bank) ----------------
  float dz = uForestZ - o.z;
  if (dz > 0.0 && d.z > 0.02) {
    float tt = dz / d.z;
    float X = o.x + d.x * tt;
    float Y = o.y + d.y * tt;
    float edgeR;
    float sway = sin(uTime * 1.1 + X * 0.35) * 0.06 * uWind;
    float top = crowns(X + sway * clamp(Y / uTreeH, 0.0, 1.0), edgeR);
    float bankH = 0.25 + 0.18 * vn(vec2(X * 0.8, 3.0));
    float edgeB;
    float topB = crowns(X * 0.81 + 57.0, edgeB) * 1.1;
    if (Y >= top && Y < topB) {
      // second, hazier row of trees behind the first
      vec2 qb = vec2(X * 0.81, Y) * 0.9;
      float cb = fbm3(qb * 1.3);
      vec3 bc = toLin(uForest) * (0.45 + 0.5 * cb) * (0.5 + 0.6 * sunc * max(uSun.y, 0.1));
      float rimB = exp(-(topB - Y) * 3.0) * pow(sunA, 3.0) * step(0.0, uSun.z);
      bc += toLin(vec3(0.8, 0.9, 0.5)) * sunc * rimB * 0.35;
      col = mix(bc, toLin(uHaze), 0.22);
    }
    if (Y < top && Y > -2.0) {
      vec2 q = vec2(X + sway * clamp(Y / uTreeH, 0.0, 1.0), Y) * 1.1;
      float cl = fbm(q * 1.4);
      float e2 = 0.05;
      float gx = fbm(q * 1.4 + vec2(e2, 0.0)) - cl, gy = fbm(q * 1.4 + vec2(0.0, e2)) - cl;
      vec3 n = normalize(vec3(-gx / e2 * 0.9, -gy / e2 * 0.9 + 0.35, -1.0));
      vec3 sw = normalize(vec3(uSun.x, uSun.y, -uSun.z));  // sun as seen on a camera-facing wall
      float diff = max(dot(n, vec3(uSun.x, uSun.y, uSun.z) * vec3(1.0, 1.0, -1.0)), 0.0);
      float leaf = vn(q * 14.0);
      vec3 fc = mix(toLin(uForest), toLin(uForest2), smoothstep(0.35, 0.75, fbm3(q * 0.35 + 9.0)));
      vec3 c2 = fc * (0.42 + 0.9 * diff * (0.5 + 0.7 * cl) * sunc + toLin(uSkyTop) * 0.15) * (0.75 + 0.45 * leaf);
      // back-lit rims glow where the canopy is thin (near the crown edge)
      float edgeDist = top - Y;
      float rim = exp(-edgeDist * 3.5) * pow(sunA, 3.0) * step(0.0, uSun.z);
      c2 += toLin(vec3(0.8, 0.9, 0.5)) * sunc * rim * 0.45;
      // darker understory and trunks near the ground
      c2 *= mix(0.35, 1.0, smoothstep(0.0, uTreeH * 0.45, Y));
      // sky showing through gaps in the canopy (bright specks against the sun)
      float hole = smoothstep(0.86, 0.93, vn(q * 1.6 + 4.0) * 0.7 + vn(q * 4.0) * 0.3) * smoothstep(uTreeH * 0.45, uTreeH * 0.9, Y) * uHoles;
      vec3 skyc = mix(toLin(uSkyHor), toLin(uSkyTop), 0.3) + sunc * pow(sunA, 20.0) * 3.0;
      c2 = mix(c2, skyc, hole);
      if (Y < bankH) {
        float g = vn(vec2(X * 6.0, Y * 20.0));
        c2 = toLin(uBank) * (0.6 + 0.6 * g) * (0.4 + 0.5 * max(uSun.y, 0.0));
      }
      float fogK = 1.0 - exp(-tt / uFog * 18.0);
      col = mix(c2, toLin(uHaze), fogK * 0.6);
    }
  }
  outColor = vec4(toSrgb(col), 1.0);
}`;

/**
 * Render the landscape into ctx (full frame). target: 'main' | 'mirror'.
 * o: options from sc.landscape(), sc: { cam, sun, sky, time, scale }
 */
export function renderLandscape(ctx, sc, o, mirror, outW, outH, blurPx) {
  const res = o.res ?? (blurPx > 3 ? 0.35 : 0.6);
  const w = Math.max(2, Math.round(outW * res)), h = Math.max(2, Math.round(outH * res));
  const S = getPass('landscape', w, h, FS);
  const { gl, U } = S;
  S.begin();
  const cam = sc.cam;
  gl.uniform2f(U.uPix, w, h);
  gl.uniform2f(U.uLogical, cam.W, cam.H);
  gl.uniform1f(U.uScale, w / cam.W);
  gl.uniform3fv(U.uCamPos, cam.pos);
  gl.uniform3fv(U.uCamF, cam.F);
  gl.uniform3fv(U.uCamR, cam.R);
  gl.uniform3fv(U.uCamU, cam.U);
  gl.uniform1f(U.uFocal, cam.f);
  gl.uniform1f(U.uMirror, mirror ? 1 : 0);
  gl.uniform1f(U.uTime, sc.time);
  gl.uniform1f(U.uSeed, o.seed ?? 3);
  gl.uniform3fv(U.uSun, sc.sun.dir);
  gl.uniform3fv(U.uSunCol, hex3(sc.sun.color));
  gl.uniform1f(U.uSunPow, sc.sun.intensity);
  gl.uniform3fv(U.uSkyTop, hex3(sc.sky.top));
  gl.uniform3fv(U.uSkyHor, hex3(sc.sky.horizon));
  gl.uniform3fv(U.uHaze, hex3(o.haze ?? sc.sky.horizon));
  gl.uniform3fv(U.uMtnFar, hex3(o.mountainFar ?? '#8ea3a8'));
  gl.uniform3fv(U.uMtnNear, hex3(o.mountainNear ?? '#3f5a3c'));
  gl.uniform3fv(U.uForest, hex3(o.forestColor ?? '#24461d'));
  gl.uniform3fv(U.uForest2, hex3(o.forestColor2 ?? '#4b6e2c'));
  gl.uniform3fv(U.uBank, hex3(o.bank ?? '#3a3020'));
  gl.uniform1f(U.uClouds, o.clouds ?? 0.6);
  gl.uniform1f(U.uMist, o.mist ?? 0.35);
  gl.uniform1f(U.uFog, o.fog ?? 2600);
  gl.uniform1f(U.uForestZ, o.forestZ ?? (o.forest === false ? -1 : 18));
  gl.uniform1f(U.uTreeH, o.treeHeight ?? 9);
  gl.uniform1f(U.uCrown, o.crown ?? 2.4);
  gl.uniform1f(U.uWind, o.sway ?? sc.wind?.speed ?? 1);
  gl.uniform1f(U.uMountains, o.mountains === false ? 0 : (o.mountains ?? 1));
  gl.uniform1f(U.uMtnScale, o.mountainScale ?? 1);
  gl.uniform1f(U.uHoles, o.holes ?? 0.35);
  S.draw();
  compositeBlurred(ctx, S.canvas, outW, outH, blurPx, mirror ? 'lsm' : 'ls');
}

// ------------------------------------------------------- light shafts ----
const RAYS_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uScene;
uniform vec2 uSunUv;
uniform float uThresh, uDecay, uDensity, uIntensity;
uniform vec3 uTint;
void main() {
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  vec2 dlt = (uSunUv - uv) * uDensity / 48.0;
  vec2 p = uv;
  float w = 1.0, acc = 0.0;
  for (int i = 0; i < 48; i++) {
    p += dlt;
    vec3 c = texture(uScene, clamp(p, 0.0, 1.0)).rgb;
    float l = dot(c, vec3(0.3, 0.55, 0.15));
    acc += max(l - uThresh, 0.0) * w;
    w *= uDecay;
  }
  float r = acc / 48.0 * uIntensity;
  outColor = vec4(uTint * r, r);
}`;

let small = null;
/** Add crepuscular rays to ctx (full-frame canvas at outW×outH). */
export function lightShafts(ctx, sunScreen, W, H, outW, outH, o = {}) {
  if (!sunScreen) return;
  const k = 0.25;
  const w = Math.max(2, Math.round(outW * k)), h = Math.max(2, Math.round(outH * k));
  if (!small || small.width !== w || small.height !== h) small = makeCanvas(w, h);
  const sc = small.getContext('2d');
  sc.clearRect(0, 0, w, h);
  sc.drawImage(ctx.canvas, 0, 0, w, h);
  const S = getPass('rays', w, h, RAYS_FS);
  const { gl, U } = S;
  S.begin();
  S.image('uScene', 0, small);
  gl.uniform2f(U.uSunUv, sunScreen[0] / W, sunScreen[1] / H);
  gl.uniform1f(U.uThresh, o.threshold ?? 0.72);
  gl.uniform1f(U.uDecay, o.decay ?? 0.975);
  gl.uniform1f(U.uDensity, o.density ?? 0.9);
  gl.uniform1f(U.uIntensity, o.intensity ?? 2.2);
  gl.uniform3fv(U.uTint, hex3(o.color ?? '#fff1cf'));
  S.draw();
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'screen';
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(S.canvas, 0, 0, outW, outH);
  ctx.restore();
}
