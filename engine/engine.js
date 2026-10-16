// The motion engine: compiles each shot's code, builds the per-frame `s`
// API, composites shots with transitions, motion blur and post. The same
// module runs in the editor preview and in headless Chromium for export,
// so what you see is exactly what renders.
import * as M from './math.js';
import { MATERIALS, resolveMaterial, drawDroplet } from './materials.js';
import { liquidCrown, liquidPour, liquidDrip } from './fx/liquid.js';
import * as A from './fx/atmosphere.js';
import { text, underline, badge, icon, ICON_NAMES, FONTS } from './fx/text.js';
import { applyPost, GRADES } from './post.js';
import { clearSimCache } from './fx/sim.js';
import { natureScene } from './fx/nature.js';
import { clearWaterCache } from './fx/water.js';
import { clearFoliageCache } from './fx/foliage.js';
import { clearDewCache } from './fx/dew.js';

export { MATERIALS, GRADES, ICON_NAMES };

export const TRANSITIONS = {
  cut: 'Cắt thẳng', fade: 'Mờ qua đen', dissolve: 'Hoà tan', flash: 'Loé sáng', push: 'Đẩy ngang',
  zoom: 'Zoom xuyên', whip: 'Lia nhanh', blur: 'Nhoè chuyển', wipe: 'Quét chéo', rise: 'Trượt lên',
};

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

export function compileShot(code) {
  // eslint-disable-next-line no-new-func
  return new Function('s', '"use strict";\n' + (code || ''));
}

/** Static check usable on server and client: syntax only. */
export function lintShotCode(code) {
  try {
    compileShot(code);
    return null;
  } catch (e) {
    return String(e.message || e);
  }
}

export class Engine {
  constructor(canvas, { scale = 1, onError } = {}) {
    this.out = canvas;
    this.scale = scale;
    this.onError = onError;
    this.project = null;
    this.assets = new Map();
    this.compiled = new Map();
    this.errors = new Map();
    this.layerPool = [];
    this.videoRequests = [];
  }

  setProject(project) {
    const prevCodes = this.project ? new Map(this.project.shots.map((s) => [s.id, s.code])) : new Map();
    this.project = project;
    this.W = project.width || 1920;
    this.H = project.height || 1080;
    this.resize();
    for (const sh of project.shots) {
      if (prevCodes.get(sh.id) !== sh.code || !this.compiled.has(sh.id)) {
        try {
          this.compiled.set(sh.id, compileShot(sh.code));
          this.errors.delete(sh.id);
        } catch (e) {
          this.compiled.set(sh.id, null);
          this.errors.set(sh.id, 'Lỗi cú pháp: ' + e.message);
        }
      }
    }
    this.timeline = this.computeTimeline();
  }

  setScale(scale) {
    this.scale = scale;
    this.resize();
  }

  resize() {
    const pw = Math.round(this.W * this.scale), ph = Math.round(this.H * this.scale);
    if (this.out.width !== pw) this.out.width = pw;
    if (this.out.height !== ph) this.out.height = ph;
    this.bufA = makeCanvas(pw, ph);
    this.bufB = makeCanvas(pw, ph);
    this.frameBuf = makeCanvas(pw, ph);
    this.accum = makeCanvas(pw, ph);
    this.layerPool = [];
  }

  computeTimeline() {
    let t = 0;
    return this.project.shots.map((sh, i) => {
      const item = { shot: sh, index: i, start: t, end: t + sh.duration };
      t += sh.duration;
      return item;
    });
  }

  get duration() {
    return this.project ? this.project.shots.reduce((s, x) => s + (x.duration || 0), 0) : 0;
  }

  setAsset(name, el, type = 'image') {
    this.assets.set(name, { el, type });
  }

  shotAt(t) {
    const tl = this.timeline;
    for (const it of tl) if (t >= it.start && t < it.end) return it;
    return tl[tl.length - 1];
  }

  // ---------------- per-frame API ----------------
  buildApi(ctx, item, localT, frameIndex) {
    const eng = this;
    const W = this.W, H = this.H;
    const sh = item.shot;
    const d = sh.duration;
    const style = this.project.style || {};
    const palette = { primary: '#f08a12', accent: '#f5b54a', text: '#ffffff', ...(style.palette || {}) };
    const cam = { zoom: 1, x: 0, y: 0, rotate: 0 };
    const getAsset = (name) => {
      const a = eng.assets.get(name);
      return a ? a.el : null;
    };
    const applyCam = (c, depth = 1) => {
      if (depth === 0) return;
      const z = 1 + (cam.zoom - 1) * depth;
      c.translate(W / 2, H / 2);
      c.scale(z, z);
      c.rotate(cam.rotate * depth);
      c.translate(-W / 2 - cam.x * depth, -H / 2 - cam.y * depth);
    };
    const s = {
      t: localT, d, p: M.clamp(localT / d), W, H, frame: frameIndex, fps: this.project.fps || 30,
      shot: { id: sh.id, name: sh.name, index: item.index },
      ctx, palette, fonts: FONTS, materials: MATERIALS,
      // math
      clamp: M.clamp, lerp: M.lerp, map: M.map, smoothstep: M.smoothstep, ease: M.ease, TAU: M.TAU,
      rgba: M.rgba, mix: M.mix, noise: M.noise2, fbm: M.fbm, rand: M.rng,
      prog: (a, b) => M.clamp((localT - a) / (b - a)),
      spring: (o = {}) => M.spring(localT - (o.delay ?? 0), o),
      asset: getAsset,
      has: (name) => eng.assets.has(name),
      // camera: call before drawing; values persist for the rest of the frame
      camera(o = {}) {
        if (o.zoom != null) cam.zoom = o.zoom;
        if (o.x != null) cam.x = o.x;
        if (o.y != null) cam.y = o.y;
        if (o.rotate != null) cam.rotate = o.rotate;
        if (o.shake) {
          const amp = typeof o.shake === 'number' ? o.shake : o.shake.amp ?? 6;
          const f = o.shake.freq ?? 1.3;
          cam.x += M.fbm(localT * f, 1.7, 5) * amp;
          cam.y += M.fbm(localT * f, 9.1, 6) * amp;
          cam.rotate += M.fbm(localT * f * 0.7, 4.2, 7) * amp * 0.0006;
        }
        return cam;
      },
      background(c = '#000') {
        s.ctx.save();
        s.ctx.setTransform(eng.scale, 0, 0, eng.scale, 0, 0);
        if (Array.isArray(c)) {
          const g = s.ctx.createLinearGradient(0, 0, 0, H);
          c.forEach((col, i) => g.addColorStop(i / Math.max(1, c.length - 1), col));
          s.ctx.fillStyle = g;
        } else if (c && typeof c === 'object' && c.radial) {
          const g = s.ctx.createRadialGradient(c.x ?? W / 2, c.y ?? H / 2, 0, c.x ?? W / 2, c.y ?? H / 2, c.r ?? Math.hypot(W, H) / 2);
          c.radial.forEach((col, i) => g.addColorStop(i / Math.max(1, c.radial.length - 1), col));
          s.ctx.fillStyle = g;
        } else s.ctx.fillStyle = c;
        s.ctx.fillRect(0, 0, W, H);
        s.ctx.restore();
      },
      image(name, o = {}) {
        const el = typeof name === 'string' ? getAsset(name) : name;
        if (!el) {
          eng.warn(sh.id, `Không tìm thấy chất liệu "${name}"`);
          return null;
        }
        return drawMedia(s.ctx, el, o, W, H, (c) => applyCam(c, o.depth ?? 1));
      },
      video(name, o = {}) {
        const a = eng.assets.get(name);
        if (!a) { eng.warn(sh.id, `Không tìm thấy video "${name}"`); return null; }
        const el = a.el;
        const vt = (o.time ?? localT) * (o.rate ?? 1) + (o.offset ?? 0);
        const dur = el.duration || 1;
        const want = o.loop === false ? Math.min(vt, dur - 0.04) : ((vt % dur) + dur) % dur;
        eng.videoRequests.push({ el, time: want });
        return drawMedia(s.ctx, el, o, W, H, (c) => applyCam(c, o.depth ?? 1));
      },
      /** Draw into an isolated layer, then composite with blur / opacity / blend / mask. */
      layer(o, fn) {
        if (typeof o === 'function') { fn = o; o = {}; }
        const L = eng.takeLayer();
        const lc = L.getContext('2d');
        lc.setTransform(1, 0, 0, 1, 0, 0);
        lc.clearRect(0, 0, L.width, L.height);
        lc.setTransform(eng.scale, 0, 0, eng.scale, 0, 0);
        lc.__W = W; lc.__H = H;
        const prev = s.ctx;
        s.ctx = lc;
        try { fn(s); } finally { s.ctx = prev; }
        prev.save();
        prev.setTransform(1, 0, 0, 1, 0, 0);
        prev.globalAlpha *= o.opacity ?? 1;
        if (o.blend) prev.globalCompositeOperation = o.blend;
        const filters = [];
        if (o.blur > 0.2) filters.push(`blur(${o.blur * eng.scale}px)`);
        if (o.brightness != null) filters.push(`brightness(${o.brightness})`);
        if (o.saturate != null) filters.push(`saturate(${o.saturate})`);
        if (o.contrast != null) filters.push(`contrast(${o.contrast})`);
        if (filters.length) prev.filter = filters.join(' ');
        prev.drawImage(L, 0, 0);
        prev.restore();
        eng.releaseLayer(L);
      },
      /** Run fn with the camera transform applied (for custom drawing in world space). */
      world(fn, depth = 1) {
        s.ctx.save();
        applyCam(s.ctx, depth);
        try { fn(s.ctx); } finally { s.ctx.restore(); }
      },
      text: (str, o = {}) => withDepth(o.depth ?? 0, () => text(s.ctx, localT, str, { color: palette.text, accent: palette.accent, ...o })),
      underline: (o = {}) => withDepth(o.depth ?? 0, () => underline(s.ctx, localT, { color: palette.primary, ...o })),
      badge: (o = {}) => withDepth(o.depth ?? 0, () => badge(s.ctx, localT, { ring: palette.accent, ...o })),
      icon: (name, o = {}) => withDepth(o.depth ?? 0, () => icon(s.ctx, name, o)),
      droplet: (o = {}) => withDepth(o.depth ?? 1, () => drawDroplet(s.ctx, o.x, o.y, o.r ?? 20, resolveMaterial(o.material), o)),
      /** Soft contact shadow under an object sitting on a surface. */
      contactShadow(o = {}) {
        withDepth(o.depth ?? 1, () => {
          const c = s.ctx, x = o.x ?? W / 2, y = o.y ?? H * 0.8, w = o.width ?? 300;
          const g = c.createRadialGradient(x, y, 0, x, y, w / 2);
          g.addColorStop(0, `rgba(0,0,0,${o.opacity ?? 0.55})`);
          g.addColorStop(1, 'rgba(0,0,0,0)');
          c.save();
          c.translate(x, y);
          c.scale(1, o.squash ?? 0.18);
          c.translate(-x, -y);
          c.fillStyle = g;
          c.beginPath();
          c.arc(x, y, w / 2, 0, M.TAU);
          c.fill();
          c.restore();
        });
      },
      fx: {},
      /** 3D nature scene (water, wind, leaves, dew) — see SHOT_API "Thiên nhiên 3D". */
      nature: (o = {}) => natureScene(s, eng, o),
      physics: {
        drop: (o = {}) => M.dropBounce(localT - (o.delay ?? 0), o),
        spring: (o = {}) => M.spring(localT - (o.delay ?? 0), o),
        pendulum: (o = {}) => M.pendulum(localT - (o.delay ?? 0), o),
      },
    };
    function withDepth(depth, fn) {
      s.ctx.save();
      applyCam(s.ctx, depth);
      try { return fn(); } finally { s.ctx.restore(); }
    }
    const fxWrap = (f, defDepth = 1) => (o = {}) => withDepth(o.depth ?? defDepth, () => {
      const res = f(s.ctx, localT, resolveAssetRefs(o, getAsset));
      return res;
    });
    Object.assign(s.fx, {
      liquidCrown: fxWrap(liquidCrown),
      splash: fxWrap(liquidCrown),
      pour: fxWrap(liquidPour),
      drip: fxWrap(liquidDrip),
      burst: fxWrap(A.burst),
      bokeh: fxWrap(A.bokeh, 0.3),
      dust: fxWrap(A.dust, 0.5),
      mist: fxWrap(A.mist),
      smoke: fxWrap(A.mist),
      bubbles: fxWrap(A.bubbles),
      caustics: fxWrap(A.caustics, 0),
      rays: fxWrap(A.lightRays, 0.2),
      sheen: fxWrap(A.sheen),
      flare: fxWrap(A.lensFlare, 0),
      leak: fxWrap(A.lightLeak, 0),
    });
    return s;
  }

  warn(shotId, msg) {
    if (!this._warned) this._warned = new Set();
    const k = shotId + msg;
    if (this._warned.has(k)) return;
    this._warned.add(k);
    const list = this.errors.get(shotId);
    this.errors.set(shotId, list ? list + '\n' + msg : msg);
    this.onError && this.onError(shotId, msg);
  }

  takeLayer() {
    const L = this.layerPool.pop();
    return L || makeCanvas(this.out.width, this.out.height);
  }
  releaseLayer(L) {
    this.layerPool.push(L);
  }

  renderShot(ctx, item, localT, frameIndex) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    ctx.__W = this.W; ctx.__H = this.H;
    const fn = this.compiled.get(item.shot.id);
    if (fn) {
      const s = this.buildApi(ctx, item, localT, frameIndex);
      try {
        fn(s);
      } catch (e) {
        const msg = `Lỗi khi chạy (t=${localT.toFixed(2)}s): ${e.message}`;
        this.warn(item.shot.id, msg);
        if (this.showErrors) this.drawError(ctx, msg);
      }
    } else if (this.showErrors && this.errors.get(item.shot.id)) {
      this.drawError(ctx, this.errors.get(item.shot.id));
    }
    ctx.restore();
  }

  drawError(ctx, msg) {
    ctx.save();
    ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    ctx.fillStyle = 'rgba(120,0,0,0.75)';
    ctx.fillRect(40, 40, this.W - 80, 90);
    ctx.fillStyle = '#fff';
    ctx.font = '28px monospace';
    ctx.fillText(String(msg).slice(0, 110), 60, 95);
    ctx.restore();
  }

  /** Composite (shots + transition) at global time t into target ctx (no post). */
  composite(target, t, frameIndex = 0) {
    const tl = this.timeline;
    if (!tl.length) return;
    let it = this.shotAt(t);
    const local = t - it.start;
    const tr = it.shot.transition || { type: 'cut' };
    const td = Math.min(tr.duration ?? 0.5, it.shot.duration * 0.9);
    if (it.index > 0 && tr.type && tr.type !== 'cut' && local < td) {
      const prev = tl[it.index - 1];
      const k = local / td;
      this.renderShot(this.bufA.getContext('2d'), prev, prev.shot.duration + local, frameIndex);
      this.renderShot(this.bufB.getContext('2d'), it, local, frameIndex);
      blendTransition(target, this.bufA, this.bufB, tr.type, k);
    } else {
      this.renderShot(this.bufB.getContext('2d'), it, local, frameIndex);
      target.save();
      target.setTransform(1, 0, 0, 1, 0, 0);
      target.drawImage(this.bufB, 0, 0);
      target.restore();
    }
  }

  /**
   * Render a finished frame to the output canvas.
   * opts.motionBlur: samples (1 = off), opts.shutter: fraction of a frame (0.5 = 180°)
   */
  renderFrame(t, opts = {}) {
    if (!this.project) return;
    this.videoRequests = [];
    const fps = this.project.fps || 30;
    const frameIndex = Math.round(t * fps);
    const samples = Math.max(1, opts.motionBlur || 1);
    const fb = this.frameBuf.getContext('2d');
    if (samples === 1) {
      this.composite(fb, t, frameIndex);
    } else {
      const shutter = (opts.shutter ?? 0.5) / fps;
      const ac = this.accum.getContext('2d');
      ac.setTransform(1, 0, 0, 1, 0, 0);
      for (let i = 0; i < samples; i++) {
        const st = t + (i / (samples - 1) - 0.5) * shutter;
        this.composite(fb, Math.max(0, Math.min(this.duration - 1e-4, st)), frameIndex);
        ac.globalAlpha = 1 / (i + 1);
        ac.drawImage(this.frameBuf, 0, 0);
      }
      ac.globalAlpha = 1;
      fb.setTransform(1, 0, 0, 1, 0, 0);
      fb.drawImage(this.accum, 0, 0);
    }
    const oc = this.out.getContext('2d');
    oc.setTransform(1, 0, 0, 1, 0, 0);
    applyPost(oc, this.frameBuf, this.project.style || {}, frameIndex);
  }

  /** Seek any <video> assets the last frame asked for; resolves when ready. */
  async syncVideos() {
    const reqs = this.videoRequests;
    if (!reqs.length) return false;
    let changed = false;
    await Promise.all(reqs.map(({ el, time }) => {
      if (Math.abs(el.currentTime - time) < 0.5 / (this.project.fps || 30)) return null;
      changed = true;
      return new Promise((res) => {
        const done = () => { el.removeEventListener('seeked', done); res(); };
        el.addEventListener('seeked', done);
        el.currentTime = time;
        setTimeout(done, 3000);
      });
    }));
    return changed;
  }

  /** Render a frame of a single shot (ignores transitions) — for thumbnails/contact sheets. */
  renderShotFrame(target, shotIndex, localT) {
    const it = this.timeline[shotIndex];
    if (!it) return;
    this.renderShot(this.frameBuf.getContext('2d'), it, localT, 0);
    target.save();
    target.setTransform(1, 0, 0, 1, 0, 0);
    applyPost(target, this.frameBuf, this.project.style || {}, 0);
    target.restore();
  }

  reset() {
    clearSimCache();
    clearWaterCache();
    clearFoliageCache();
    clearDewCache();
  }
}

function resolveAssetRefs(o, getAsset) {
  if (o && typeof o.image === 'string') return { ...o, image: getAsset(o.image) };
  return o;
}

function mediaSize(el) {
  return [el.videoWidth || el.naturalWidth || el.width || 1, el.videoHeight || el.naturalHeight || el.height || 1];
}

/**
 * Draw an image/video with layout + effects.
 * fit: 'cover' | 'contain' (fills the frame) when no w/h given.
 * x,y = anchor point (default center of frame); anchor [ax, ay] in 0..1 of the image box.
 */
function drawMedia(ctx, el, o, W, H, applyCam) {
  const [iw, ih] = mediaSize(el);
  let w, h;
  if (o.w && o.h) { w = o.w; h = o.h; }
  else if (o.w) { w = o.w; h = (o.w * ih) / iw; }
  else if (o.h) { h = o.h; w = (o.h * iw) / ih; }
  else {
    const k = (o.fit === 'contain' ? Math.min : Math.max)(W / iw, H / ih);
    w = iw * k; h = ih * k;
  }
  const sc = o.scale ?? 1;
  w *= sc; h *= sc;
  const x = o.x ?? W / 2, y = o.y ?? H / 2;
  const [ax, ay] = o.anchor ?? [0.5, 0.5];
  ctx.save();
  applyCam(ctx);
  ctx.translate(x, y);
  if (o.rotate) ctx.rotate(o.rotate);
  if (o.flipX) ctx.scale(-1, 1);
  if (o.skewX) ctx.transform(1, 0, o.skewX, 1, 0, 0);
  ctx.globalAlpha *= o.opacity ?? 1;
  if (o.blend) ctx.globalCompositeOperation = o.blend;
  const f = [];
  if (o.blur > 0.2) f.push(`blur(${o.blur}px)`);
  if (o.brightness != null) f.push(`brightness(${o.brightness})`);
  if (o.contrast != null) f.push(`contrast(${o.contrast})`);
  if (o.saturate != null) f.push(`saturate(${o.saturate})`);
  if (o.hue != null) f.push(`hue-rotate(${o.hue}deg)`);
  if (o.shadow) {
    const sd = o.shadow === true ? {} : o.shadow;
    f.push(`drop-shadow(0px ${sd.y ?? 30}px ${sd.blur ?? 40}px ${sd.color ?? 'rgba(0,0,0,0.55)'})`);
  }
  if (f.length) ctx.filter = f.join(' ');
  const dx = -w * ax, dy = -h * ay;
  // Large blurs are expensive on CPU canvas: blur a downscaled copy instead
  // (visually identical for strong blur, 10–30x cheaper).
  if (o.blur > 4 && !o.crop) {
    const k = Math.max(0.08, Math.min(0.5, 3 / o.blur));
    const sw = Math.max(2, Math.round(w * k)), sh = Math.max(2, Math.round(h * k));
    const tmp = blurScratch(sw + 8, sh + 8);
    const tc = tmp.getContext('2d');
    tc.setTransform(1, 0, 0, 1, 0, 0);
    tc.clearRect(0, 0, tmp.width, tmp.height);
    tc.filter = `blur(${(o.blur * k).toFixed(2)}px)`;
    tc.drawImage(el, 4, 4, sw, sh);
    tc.filter = 'none';
    ctx.filter = f.filter((x) => !x.startsWith('blur')).join(' ') || 'none';
    ctx.drawImage(tmp, 4, 4, sw, sh, dx, dy, w, h);
    ctx.restore();
    return { x: x + dx, y: y + dy, w, h, cx: x + dx + w / 2, cy: y + dy + h / 2 };
  }
  if (o.crop) {
    const [cx, cy, cw, ch] = o.crop; // normalized
    ctx.drawImage(el, cx * iw, cy * ih, cw * iw, ch * ih, dx, dy, w, h);
  } else {
    ctx.drawImage(el, dx, dy, w, h);
  }
  if (o.reflect) {
    const r = o.reflect === true ? {} : o.reflect;
    ctx.filter = `blur(${r.blur ?? 2}px)`;
    ctx.save();
    ctx.translate(0, dy + h * 2 + (r.gap ?? 0));
    ctx.scale(1, -1);
    ctx.globalAlpha *= r.opacity ?? 0.25;
    ctx.beginPath();
    ctx.rect(dx, dy + h * (1 - (r.height ?? 0.4)), w, h * (r.height ?? 0.4));
    ctx.clip();
    ctx.drawImage(el, dx, dy, w, h);
    ctx.restore();
  }
  ctx.restore();
  return { x: x + dx, y: y + dy, w, h, cx: x + dx + w / 2, cy: y + dy + h / 2 };
}

let _blurScratch = null;
function blurScratch(w, h) {
  if (!_blurScratch || _blurScratch.width < w || _blurScratch.height < h) _blurScratch = makeCanvas(Math.max(w, _blurScratch?.width || 0), Math.max(h, _blurScratch?.height || 0));
  return _blurScratch;
}

function blendTransition(target, A, B, type, k) {
  const W = target.canvas.width, H = target.canvas.height;
  const e = M.ease.inOutCubic(k);
  target.save();
  target.setTransform(1, 0, 0, 1, 0, 0);
  target.globalCompositeOperation = 'source-over';
  target.fillStyle = '#000';
  target.fillRect(0, 0, W, H);
  const draw = (img, alpha = 1, tx = 0, ty = 0, sc = 1, blur = 0) => {
    target.save();
    target.globalAlpha = alpha;
    if (blur > 0.3) target.filter = `blur(${blur}px)`;
    target.translate(W / 2 + tx, H / 2 + ty);
    target.scale(sc, sc);
    target.drawImage(img, -W / 2, -H / 2);
    target.restore();
  };
  switch (type) {
    case 'fade':
      if (k < 0.5) draw(A, 1 - k * 2);
      else draw(B, k * 2 - 1);
      break;
    case 'flash':
      draw(A);
      draw(B, e);
      target.fillStyle = `rgba(255,248,235,${Math.sin(Math.PI * k) * 0.85})`;
      target.fillRect(0, 0, W, H);
      break;
    case 'push':
      draw(A, 1, -W * e);
      draw(B, 1, W * (1 - e));
      break;
    case 'rise':
      draw(A, 1, 0, -H * e * 0.3, 1);
      draw(B, 1, 0, H * (1 - e));
      break;
    case 'zoom':
      draw(A, 1 - e, 0, 0, 1 + e * 0.6, e * 20);
      draw(B, e, 0, 0, 1.25 - 0.25 * e, (1 - e) * 16);
      break;
    case 'whip': {
      const b = Math.sin(Math.PI * k) * 40;
      draw(A, 1, -W * e, 0, 1, b);
      draw(B, 1, W * (1 - e), 0, 1, b);
      break;
    }
    case 'blur':
      draw(A, 1 - e, 0, 0, 1, e * 30);
      draw(B, e, 0, 0, 1, (1 - e) * 30);
      break;
    case 'wipe':
      draw(A);
      target.save();
      target.beginPath();
      const p = e * (W + H);
      target.moveTo(0, 0);
      target.lineTo(p, 0);
      target.lineTo(p - H, H);
      target.lineTo(0, H);
      target.closePath();
      target.clip();
      draw(B);
      target.restore();
      break;
    default: // dissolve
      draw(A);
      draw(B, e);
  }
  target.restore();
}

/** Wait for web fonts used by the engine (Vietnamese glyphs). */
export async function loadFonts() {
  if (typeof document === 'undefined' || !document.fonts) return;
  const specs = [
    '400 40px "Be Vietnam Pro"', '600 40px "Be Vietnam Pro"', '700 40px "Be Vietnam Pro"', '800 40px "Be Vietnam Pro"',
    '400 40px "Playfair Display"', '700 40px "Playfair Display"', 'italic 400 40px "Playfair Display"',
  ];
  await Promise.all(specs.map((f) => document.fonts.load(f, 'Ááạẫ Sáng mịn tươi tắn').catch(() => null)));
}

/** Load project assets into the engine (browser). */
export async function loadAssets(engine, project, urlFor) {
  const jobs = (project.assets || []).filter((a) => a.type === 'image' || a.type === 'video').map((a) => new Promise((res) => {
    if (a.type === 'image') {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => { engine.setAsset(a.name, img, 'image'); res(); };
      img.onerror = () => res();
      img.src = urlFor(a);
    } else {
      const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.preload = 'auto'; v.crossOrigin = 'anonymous';
      v.onloadeddata = () => { engine.setAsset(a.name, v, 'video'); res(); };
      v.onerror = () => res();
      v.src = urlFor(a);
    }
  }));
  await Promise.all(jobs);
}
