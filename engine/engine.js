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
import { photoScene } from './fx/photo.js';
import { clearWaterCache } from './fx/water.js';
import { clearFoliageCache } from './fx/foliage.js';
import { clearDewCache } from './fx/dew.js';

export { MATERIALS, GRADES, ICON_NAMES };

/** Asset name of the Brand Kit logo (`s.brand.logo`), loaded by loadAssets / loadBrandAssets. */
export const BRAND_LOGO = 'brand-logo';

/**
 * Brand view of a project (pure): kit snapshot in `project.brand.kit` (server/brands.js) →
 * colors by role, CSS font families for heading/body, logo asset name, outro. No kit → neutral
 * values (built-in sans fonts, no logo, no colors) so shots without a kit render exactly as before.
 */
export function brandOf(project) {
  const b = project?.brand;
  const k = b && b.kit && typeof b.kit === 'object' ? b.kit : null;
  const colors = {};
  for (const c of k?.palette || []) if (c && typeof c.role === 'string' && typeof c.color === 'string') colors[c.role] = c.color;
  const fam = (v) => {
    if (!v || v === 'sans') return FONTS.sans;
    if (v === 'serif') return FONTS.serif;
    const f = (k?.fontFiles || []).find((x) => x && x.id === v);
    return f && f.family ? `"${f.family}", ${FONTS.sans}` : FONTS.sans;
  };
  return {
    key: k ? `${b.id}:${b.version}` : '',
    id: k ? b.id : null,
    name: k?.name || '',
    logo: k?.logo?.file ? BRAND_LOGO : null,
    colors,
    fonts: { heading: fam(k?.fonts?.heading), body: fam(k?.fonts?.body) },
    customBody: !!(k && k.fonts?.body && k.fonts.body !== 'sans'),
    outro: k?.outro?.text || '',
  };
}

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
    this.fieldDecls = new Map(); // shotId -> Map(key -> declaration), see field()/fieldsOf()
    // QA hook (internal, not part of the shot API): when set to an array, every s.text call
    // appends its laid-out block rect in project pixels. Read-only on the canvas → pixels unchanged.
    this.textProbe = null;
  }

  setProject(project) {
    const prevCodes = this.project ? new Map(this.project.shots.map((s) => [s.id, s.code])) : new Map();
    this.project = project;
    this.W = project.width || 1920;
    this.H = project.height || 1080;
    this.resize();
    for (const sh of project.shots) {
      if (prevCodes.get(sh.id) !== sh.code || !this.compiled.has(sh.id)) {
        this.fieldDecls.delete(sh.id); // declarations come from code: recollect
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
    const brand = brandOf(project);
    // brandColor field defaults come from the kit → recollect declarations when the kit changes
    if (this.brand && this.brand.key !== brand.key) this.fieldDecls.clear();
    this.brand = brand;
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
    const brand = this.brand || brandOf(this.project);
    // Brand Kit colors (by role) win over the project palette; no kit → unchanged
    const palette = { primary: '#f08a12', accent: '#f5b54a', text: '#ffffff', ...(style.palette || {}), ...brand.colors };
    const fonts = { ...FONTS, heading: brand.fonts.heading, body: brand.fonts.body };
    // s.text font: 'heading' | 'body' → kit families; unspecified → kit body font when the kit sets one
    const textFont = (o) => (o.font === 'heading' || o.font === 'body' ? { ...o, font: fonts[o.font] } : o.font == null && brand.customBody ? { ...o, font: fonts.body } : o);
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
      ctx, palette, fonts, materials: MATERIALS,
      /** Brand Kit of the project (see SHOT_API "Brand Kit"): logo asset name or null, colors, fonts, outro. */
      brand: { id: brand.id, name: brand.name, logo: brand.logo, colors: { ...palette }, fonts: { heading: fonts.heading, body: fonts.body }, outro: brand.outro },
      // math
      clamp: M.clamp, lerp: M.lerp, map: M.map, smoothstep: M.smoothstep, ease: M.ease, TAU: M.TAU,
      rgba: M.rgba, mix: M.mix, noise: M.noise2, fbm: M.fbm, rand: M.rng,
      prog: (a, b) => M.clamp((localT - a) / (b - a)),
      spring: (o = {}) => M.spring(localT - (o.delay ?? 0), o),
      asset: getAsset,
      has: (name) => eng.assets.has(name),
      /**
       * Editable value of this shot (Inspector form). Returns shot.fields[key] ?? def.
       * Pure: never depends on t. Declarations are recorded for fieldsOf().
       */
      field(key, def, o = {}) {
        return eng.readField(sh, key, def, o);
      },
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
      text: (str, o = {}) => withDepth(o.depth ?? 0, () => {
        const r = text(s.ctx, localT, str, { color: palette.text, accent: palette.accent, ...textFont(o) });
        if (eng.textProbe) eng.probeText(s.ctx, str, o, r);
        return r;
      }),
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
      /** Real photo shot like live footage (2.5D camera, flowing water, sway, mist, DOF) — see SHOT_API "Ảnh thật". */
      photo: (o = {}) => photoScene(s, eng, o),
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

  /**
   * QA hook: record the block rect of one s.text call (project pixels, after the current
   * transform — camera depth, layers). Vertical extent covers Vietnamese stacked marks and
   * descenders of every line. Pure function of layout → deterministic.
   */
  probeText(ctx, str, o, r) {
    if (!r || !r.words) return;
    const x = o.x ?? 0, y = o.y ?? 0, align = o.align ?? 'left';
    const left = align === 'center' ? x - r.width / 2 : align === 'right' ? x - r.width : x;
    const lh = r.height / Math.max(1, r.lines);
    const top = y - r.size * 1.05, bottom = y + (r.lines - 1) * lh + r.size * 0.3;
    const m = ctx.getTransform();
    const k = 1 / this.scale;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [px, py] of [[left, top], [left + r.width, top], [left, bottom], [left + r.width, bottom]]) {
      const X = (m.a * px + m.c * py + m.e) * k, Y = (m.b * px + m.d * py + m.f) * k;
      x0 = Math.min(x0, X); y0 = Math.min(y0, Y); x1 = Math.max(x1, X); y1 = Math.max(y1, Y);
    }
    this.textProbe.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, text: String(str).replace(/\*/g, '').slice(0, 40) });
  }

  /** Record a field declaration for shot `sh` and return its current value. */
  readField(sh, key, def, o = {}) {
    key = String(key ?? '');
    if (!key) return def;
    const type = FIELD_TYPES.includes(o.type) ? o.type : typeof def === 'number' ? 'number' : 'text';
    // { type: 'color', brandColor: 'accent' } → default = that Brand Kit color when the kit has the role
    if (type === 'color' && o.brandColor && this.brand?.colors[o.brandColor]) def = this.brand.colors[o.brandColor];
    let decls = this.fieldDecls.get(sh.id);
    if (!decls) { decls = new Map(); this.fieldDecls.set(sh.id, decls); }
    if (!decls.has(key)) {
      const d = { key, type, label: o.label != null ? String(o.label) : key, default: def };
      if (o.maxLength != null) d.maxLength = Number(o.maxLength);
      decls.set(key, d);
    }
    return fieldValue(sh.fields?.[key], def, type, o.maxLength);
  }

  /**
   * Declared fields of a shot, in declaration order: [{ key, type, label, default, maxLength? }].
   * If the shot has not run since its code last changed, runs a declaration pass first
   * (the shot executed once at t=0 into a scratch buffer; output discarded, no warnings).
   * Fields declared only inside time-dependent branches appear once a frame reaches them.
   */
  fieldsOf(shotId) {
    if (!this.fieldDecls.has(shotId)) this.collectFields(shotId);
    return [...(this.fieldDecls.get(shotId)?.values() || [])].map((d) => ({ ...d }));
  }

  /** Declaration pass for one shot (or all shots when shotId is omitted). */
  collectFields(shotId) {
    if (!this.project) return;
    const items = this.timeline.filter((it) => shotId == null || it.shot.id === shotId);
    const saved = { warn: this.warn, videoRequests: this.videoRequests };
    this.warn = () => {};
    try {
      for (const it of items) {
        this.fieldDecls.set(it.shot.id, new Map());
        this.renderShot(this.bufA.getContext('2d'), it, 0, 0);
      }
    } finally {
      this.warn = saved.warn;
      this.videoRequests = saved.videoRequests;
    }
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

export const FIELD_TYPES = ['text', 'color', 'number', 'image'];

/** Resolve a stored field value against its default (pure). Image values are asset names. */
function fieldValue(v, def, type, maxLength) {
  if (v == null) return def;
  if (type === 'number') {
    const n = typeof v === 'number' ? v : v === '' ? NaN : Number(v);
    return Number.isFinite(n) ? n : def;
  }
  v = String(v);
  if (type === 'text' && maxLength > 0 && v.length > maxLength) v = v.slice(0, maxLength);
  return v;
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

const brandFaces = new Set(); // FontFace families already added to document.fonts

/**
 * Register + load the uploaded fonts of a Brand Kit snapshot (`project.brand.kit.fontFiles`) as
 * FontFace (weight range 100–900: one file serves every weight without faux bold). Resolves true
 * when a new face was added. urlFor({ file }) → URL of the file in the project's assets.
 */
export async function loadBrandFonts(kit, urlFor) {
  if (!kit || typeof FontFace === 'undefined' || typeof document === 'undefined' || !document.fonts) return false;
  let added = false;
  await Promise.all((kit.fontFiles || []).filter((f) => f && f.file && f.family && !brandFaces.has(f.family)).map(async (f) => {
    try {
      const face = new FontFace(f.family, `url("${urlFor({ file: f.file })}")`, { weight: '100 900', style: 'normal' });
      await face.load();
      document.fonts.add(face);
      brandFaces.add(f.family);
      added = true;
    } catch (e) {
      console.warn(`Không tải được font kit "${f.name || f.family}": ${e.message || e}`);
    }
  }));
  return added;
}

/** Brand Kit logo (as asset BRAND_LOGO) + fonts. Awaited by the render page before frames are taken. */
export async function loadBrandAssets(engine, project, urlFor) {
  const kit = project?.brand?.kit;
  if (!kit) return;
  const jobs = [loadBrandFonts(kit, urlFor)];
  if (kit.logo?.file) {
    jobs.push(new Promise((res) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => { engine.setAsset(BRAND_LOGO, img, 'image'); res(); };
      img.onerror = () => res();
      img.src = urlFor({ file: kit.logo.file });
    }));
  }
  await Promise.all(jobs);
}

/** Load project assets (and the Brand Kit logo/fonts) into the engine (browser). */
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
  jobs.push(loadBrandAssets(engine, project, urlFor));
  await Promise.all(jobs);
}
