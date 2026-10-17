// Tiny WebGL2 helpers shared by the full-screen shader passes (landscape,
// light shafts, bottle). Each pass gets its own context per output size.

export function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

export const QUAD_VS = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

export const GLSL_NOISE = `
float h12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 h22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031,.1030,.0973)); p3 += dot(p3, p3.yzx+33.33); return fract((p3.xx+p3.yz)*p3.zy); }
float vn(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.-2.*f);
  return mix(mix(h12(i),h12(i+vec2(1,0)),u.x), mix(h12(i+vec2(0,1)),h12(i+vec2(1,1)),u.x), u.y); }
float fbm(vec2 p){ float s=0., a=.5; for(int i=0;i<5;i++){ s+=a*vn(p); p=p*2.03+17.1; a*=.5; } return s; }
float fbm3(vec2 p){ float s=0., a=.5; for(int i=0;i<3;i++){ s+=a*vn(p); p=p*2.07+11.3; a*=.5; } return s; }
vec3 toLin(vec3 c){ return pow(c, vec3(2.2)); }
vec3 toSrgb(vec3 c){ return pow(max(c, 0.0), vec3(1.0/2.2)); }
`;

const cache = new Map();

/** Get (or build) a program bound to a canvas of size w×h. */
export function getPass(name, w, h, fs, opts = {}) {
  const key = name + ':' + w + 'x' + h;
  let S = cache.get(key);
  if (S) return S;
  const canvas = makeCanvas(w, h);
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, antialias: !!opts.antialias, depth: !!opts.depth, preserveDrawingBuffer: true });
  if (!gl) throw new Error('WebGL2 không khả dụng (' + name + ')');
  gl.getExtension('OES_texture_float_linear');
  const sh = (t, src) => {
    const o = gl.createShader(t);
    gl.shaderSource(o, src);
    gl.compileShader(o);
    if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error('GLSL ' + name + ': ' + gl.getShaderInfoLog(o));
    return o;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, opts.vs || QUAD_VS));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('GLSL link ' + name + ': ' + gl.getProgramInfoLog(prog));
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  if (!opts.vs) {
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  }
  const U = {};
  const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(prog, i);
    U[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(prog, info.name);
  }
  const textures = {};
  S = {
    canvas, gl, prog, vao, U,
    tex(name2) {
      if (textures[name2]) return textures[name2];
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      textures[name2] = t;
      return t;
    },
    /** upload an image/canvas into texture unit `unit` and bind to uniform */
    image(uniform, unit, src) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, S.tex(uniform));
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      gl.uniform1i(U[uniform], unit);
    },
    begin() {
      gl.viewport(0, 0, w, h);
      gl.disable(gl.BLEND);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | (opts.depth ? gl.DEPTH_BUFFER_BIT : 0));
      gl.useProgram(prog);
      gl.bindVertexArray(vao);
    },
    draw() {
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
  };
  cache.set(key, S);
  if (cache.size > 16) cache.delete(cache.keys().next().value);
  return S;
}

export const hex3 = (h) => {
  const s = String(h).replace('#', '');
  const n = parseInt(s.length === 3 ? s.split('').map((c) => c + c).join('') : s, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

const scr = {};
function scratch(name, w, h) {
  let c = scr[name];
  if (!c || c.width !== w || c.height !== h) c = scr[name] = makeCanvas(w, h);
  return c;
}

/**
 * Composite a (possibly reduced-resolution) GL canvas onto ctx at full frame,
 * with an optional defocus blur done at low resolution with clamp-to-edge
 * padding (no light/dark border). blurPx is in output pixels.
 */
export function compositeBlurred(ctx, src, outW, outH, blurPx, tag = 'cb') {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingQuality = 'high';
  if (!(blurPx > 0.8)) {
    ctx.drawImage(src, 0, 0, outW, outH);
    ctx.restore();
    return;
  }
  const k = Math.max(0.06, Math.min(0.5, 2.5 / blurPx));
  const sw = Math.max(2, Math.round(outW * k)), sh = Math.max(2, Math.round(outH * k));
  const pad = Math.ceil(blurPx * k * 2.5) + 2;
  const small = scratch(tag + 's', sw, sh);
  const sc = small.getContext('2d');
  sc.clearRect(0, 0, sw, sh);
  sc.drawImage(src, 0, 0, sw, sh);
  const tmp = scratch(tag + 't', sw + pad * 2, sh + pad * 2);
  const tc = tmp.getContext('2d');
  tc.clearRect(0, 0, tmp.width, tmp.height);
  tc.drawImage(small, pad, pad);
  tc.drawImage(small, 0, 0, sw, 1, pad, 0, sw, pad);
  tc.drawImage(small, 0, sh - 1, sw, 1, pad, pad + sh, sw, pad);
  tc.drawImage(tmp, pad, 0, 1, sh + pad * 2, 0, 0, pad, sh + pad * 2);
  tc.drawImage(tmp, pad + sw - 1, 0, 1, sh + pad * 2, pad + sw, 0, pad, sh + pad * 2);
  const out = scratch(tag + 'o', sw + pad * 2, sh + pad * 2);
  const oc = out.getContext('2d');
  oc.clearRect(0, 0, out.width, out.height);
  oc.filter = `blur(${(blurPx * k).toFixed(2)}px)`;
  oc.drawImage(tmp, 0, 0);
  oc.filter = 'none';
  ctx.drawImage(out, pad, pad, sw, sh, 0, 0, outW, outH);
  ctx.restore();
}
