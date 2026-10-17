// Photo cut-outs in the 3D nature scene (WebGL2): PNG trees / plants / rocks
// with transparent backgrounds (e.g. a library of real tree photos) placed as
// vertical cards at world positions. The card is a deformable mesh, so a real
// photo of a tree bends in the shared wind (trunk stiff, crown loose, gusts
// arriving with the gust front) and its foliage flutters (UV micro-warp that
// grows toward the crown). Colour is matched to the scene: exposure, tint,
// sun-side lift, aerial haze with distance; depth of field is applied by the
// caller per depth bucket. Rendering the same cards through the mirrored
// camera gives their reflections in the water.
import { getPass, GLSL_NOISE, hex3 } from './glkit.js';
import { gustAt } from './wind.js';

const VS = `#version 300 es
in vec2 aClip; in float aDepth; in vec2 aUV; in float aDist;
out vec2 vUV; out float vDist;
void main() { vUV = aUV; vDist = aDist; gl_Position = vec4(aClip, aDepth, 1.0); }`;

const FS = `#version 300 es
precision highp float;
in vec2 vUV; in float vDist;
out vec4 outColor;
uniform sampler2D uTex;
uniform vec4 uCrop;            // u0, v0, u1, v1 of the subject inside the image
uniform float uTime, uFlutter, uExposure, uSat, uFog, uSeed, uMirror, uRim;
uniform vec3 uTint, uHaze, uSunCol;
${GLSL_NOISE}
void main() {
  // foliage flutter: tiny UV warp, stronger toward the crown (top)
  float h = vUV.y;
  vec2 w = vec2(vn(vUV * 26.0 + vec2(uTime * 2.3, uSeed)) - 0.5, vn(vUV * 31.0 + vec2(uSeed, uTime * 2.9)) - 0.5);
  vec2 uv = vUV + w * uFlutter * 0.006 * smoothstep(0.25, 1.0, h);
  vec2 tuv = vec2(mix(uCrop.x, uCrop.z, uv.x), mix(uCrop.w, uCrop.y, uv.y));
  vec4 c = texture(uTex, tuv);
  if (c.a < 0.01) discard;
  vec3 rgb = c.rgb / max(c.a, 1e-4);
  vec3 lin = toLin(rgb);
  float l = dot(lin, vec3(0.2126, 0.7152, 0.0722));
  lin = mix(vec3(l), lin, uSat) * toLin(uTint) * uExposure;
  // thin edges glow when the sun is behind the foliage
  float a2 = texture(uTex, tuv + vec2(0.004, 0.006)).a;
  lin += toLin(uSunCol) * uRim * clamp(c.a - a2, 0.0, 1.0) * 2.0;
  float fogK = 1.0 - exp(-vDist / uFog);
  lin = mix(lin, toLin(uHaze), fogK);
  if (uMirror > 0.5) lin *= 0.82;
  outColor = vec4(pow(max(lin, 0.0), vec3(1.0 / 2.2)) * c.a, c.a);
}`;

const NX = 8, NY = 18;

/**
 * Render cut-out cards into a full-frame canvas.
 * cards: [{ img, x, z, y=0, height, width?, crop:[u0,v0,u1,v1], sway, stiffness, flutter, exposure, tint, sat, rim, flip, seed }]
 */
export function renderCutouts(cards, project, cam, sun, sky, wind, time, outW, outH, scale, mirror, fog = 400) {
  const S = getPass('cutouts' + (mirror ? 'M' : ''), outW, outH, FS, { vs: VS, depth: true, antialias: true });
  const { gl, U } = S;
  S.begin();
  gl.enable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  if (!S.vbo) {
    S.vbo = gl.createBuffer();
    S.ibo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, S.vbo);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, S.ibo);
    const st = 6 * 4;
    const at = (n, sz, off) => { const l = gl.getAttribLocation(S.prog, n); if (l >= 0) { gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, sz, gl.FLOAT, false, st, off * 4); } };
    at('aClip', 2, 0); at('aDepth', 1, 2); at('aUV', 2, 3); at('aDist', 1, 5);
    const idx = new Uint16Array(NX * NY * 6);
    let q = 0;
    for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
      const a = j * (NX + 1) + i, b = a + NX + 1;
      idx.set([a, b, a + 1, a + 1, b, b + 1], q);
      q += 6;
    }
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    S.nIdx = idx.length;
    S.texCache = new Map();
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, S.vbo);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, S.ibo);
  // far to near (alpha blending of overlapping cards)
  const sorted = cards.slice().sort((a, b) => project(b.x, 0, b.z)[2] - project(a.x, 0, a.z)[2]);
  gl.uniform1f(U.uTime, time);
  gl.uniform1f(U.uMirror, mirror ? 1 : 0);
  gl.uniform1f(U.uFog, fog);
  gl.uniform3fv(U.uHaze, hex3(sky.horizon));
  gl.uniform3fv(U.uSunCol, hex3(sun.color));
  // a card faces the camera (billboard around the vertical axis)
  const right = [cam.R[0], 0, cam.R[2]];
  const rl = Math.hypot(right[0], right[2]) || 1;
  right[0] /= rl; right[2] /= rl;
  const data = new Float32Array((NX + 1) * (NY + 1) * 6);
  for (const c of sorted) {
    const img = c.img;
    if (!img) continue;
    const iw = img.naturalWidth || img.videoWidth || img.width, ih = img.naturalHeight || img.videoHeight || img.height;
    if (!iw || !ih) continue;
    let tex = S.texCache.get(img);
    if (!tex) {
      tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      S.texCache.set(img, tex);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(U.uTex, 0);
    const crop = c.crop ?? [0, 0, 1, 1];
    const aspect = ((crop[2] - crop[0]) * iw) / ((crop[3] - crop[1]) * ih);
    const H = c.height ?? 8, Wd = c.width ?? H * aspect;
    const y0 = c.y ?? 0;
    // wind response: low-passed gust at the card + a slow sway
    const g = wind ? gustAt(wind, c.x, c.z, time) : 1;
    const sp = wind ? wind.speed : 1;
    const bendAmp = (c.sway ?? 1) * 0.012 * sp * sp * g * (1 / (c.stiffness ?? 1)) * H;
    const ph = (c.seed ?? c.x * 3.7 + c.z) * 1.7;
    const osc = Math.sin(time * (1.1 + 0.3 * Math.sin(ph)) + ph) * 0.35 + Math.sin(time * 2.7 + ph * 2) * 0.12;
    const dirx = wind ? wind.dx : 1, dirz = wind ? wind.dz : 0;
    let k = 0;
    for (let j = 0; j <= NY; j++) {
      const v = j / NY;
      const bend = bendAmp * (1 + osc) * v * v;
      for (let i = 0; i <= NX; i++) {
        const u = i / NX;
        const uu = c.flip ? 1 - u : u;
        const wx = c.x + right[0] * (u - 0.5) * Wd + dirx * bend;
        const wz = c.z + right[2] * (u - 0.5) * Wd + dirz * bend;
        const wy = y0 + v * H - Math.abs(bend) * 0.08 * v;
        const pr = project(wx, mirror ? -wy : wy, wz);
        const ok = pr[2] > 0.02;
        data[k++] = ok ? ((pr[0] * scale) / outW) * 2 - 1 : 0;
        data[k++] = ok ? 1 - ((pr[1] * scale) / outH) * 2 : 0;
        data[k++] = ok ? Math.min(0.999, Math.max(-0.999, pr[2] / 400 - 0.5)) : 2;
        data[k++] = uu;
        data[k++] = v;
        data[k++] = Math.hypot(wx - cam.pos[0], wz - cam.pos[2]);
      }
    }
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    gl.uniform4fv(U.uCrop, crop);
    gl.uniform1f(U.uFlutter, c.flutter ?? 1);
    gl.uniform1f(U.uExposure, c.exposure ?? 1);
    gl.uniform1f(U.uSat, c.saturation ?? 1);
    gl.uniform1f(U.uSeed, c.seed ?? 1);
    gl.uniform1f(U.uRim, c.rim ?? 0.15);
    gl.uniform3fv(U.uTint, hex3(c.tint ?? '#ffffff'));
    gl.drawElements(gl.TRIANGLES, S.nIdx, gl.UNSIGNED_SHORT, 0);
  }
  gl.disable(gl.BLEND);
  return S.canvas;
}
