// s.photo(): a real photograph shot like live footage (see photogl.js for the
// per-pixel work). Draws immediately and returns overlay helpers anchored to
// the photo (they follow the same parallax camera):
//
//   const ph = s.photo({ image: 'river', camera: {...}, flow: {...}, fog: {...} });
//   ph.drop({ u, v, r, ... })      // water drop lens at a photo point
//   ph.bottle({ u, v, height })    // product bottle standing on a photo point
//   ph.toScreen(u, v)              // photo uv → output px
import { renderPhoto, depthSampler } from './photogl.js';
import { makeWind, gustAt } from './wind.js';
import { compositeBottle } from './bottle.js';
import { drawLensDrop, pendantShape } from './dew.js';
import { makeCanvas, compositeBlurred } from './glkit.js';
import { renderCutouts } from './cutoutgl.js';

const scratch = new Map();
function canvasFor(key, w, h) {
  let c = scratch.get(key);
  if (!c || c.width !== w || c.height !== h) {
    c = makeCanvas(w, h);
    scratch.set(key, c);
  }
  return c;
}

export function photoScene(s, eng, o = {}) {
  const W = s.W, H = s.H, scale = eng.scale;
  const pw = Math.round(W * scale), ph = Math.round(H * scale);
  const get = (n) => (typeof n === 'string' ? eng.assets.get(n)?.el ?? null : n || null);
  const name = typeof o.image === 'string' ? o.image : null;
  const maps = {
    img: get(o.image),
    depth: get(o.depth ?? (name && name + '.depth')),
    mask: get(o.mask ?? (name && name + '.mask')),
    flow: get(o.flowMap ?? (name && name + '.flow')),
  };
  if (!maps.img) {
    eng.warn(s.shot.id, `Không tìm thấy ảnh "${o.image}"`);
    return { toScreen: (u, v) => [u * W, v * H, 1], drop() {}, bottle() {} };
  }
  const time = o.time ?? s.t;
  const wind = makeWind({ until: Math.max(s.d + 3, time + 1), ...(o.wind || {}) });
  const gust = gustAt(wind, 0, 0, time) * (wind.speed ?? 1);
  let dof = o.dof;
  if (dof?.focusAt && maps.depth) {
    // focus on the depth found at a photo point, optionally racking from dof.focus
    const f = depthSampler(maps.depth)(dof.focusAt[0], dof.focusAt[1]);
    dof = { ...dof, focus: dof.focus == null ? f : dof.focus + (f - dof.focus) * (dof.focusMix ?? 1) };
  }
  const r = renderPhoto(maps, { ...o, dof, time, gust, windDir: wind.dir ?? 0 }, pw, ph, scale);
  const ctx = s.ctx;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(r.canvas, 0, 0);
  ctx.restore();
  const light = o.light ?? { x: -0.55, y: -0.8 };
  const sun = { color: o.sunColor ?? '#fff3dc', intensity: o.sunIntensity ?? 1.2, screenDir: light };

  const snapshot = () => {
    const snap = canvasFor('photoSnap', pw, ph);
    const sx = snap.getContext('2d');
    sx.setTransform(1, 0, 0, 1, 0, 0);
    sx.clearRect(0, 0, pw, ph);
    sx.drawImage(ctx.canvas, 0, 0);
    return snap;
  };

  return {
    toScreen: r.toScreen,
    depthAt: r.depthAt,
    wind,
    gust,
    /**
     * Water drop at photo point (u, v) or screen point (x, y).
     * mode 'ball' (falling / free), 'pendant' (hanging from (x,y) with stretch & beta), 'sessile' (resting on a surface).
     */
    drop(d) {
      const [x, y] = d.x != null ? [d.x, d.y] : r.toScreen(d.u, d.v);
      const ox = (d.dx ?? 0), oy = (d.dy ?? 0);
      const snap = snapshot();
      const rr = d.r ?? 10;
      ctx.save();
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      if (d.mode === 'pendant') {
        const st = d.stretch ?? 0.3, beta = d.beta ?? 0;
        const L = rr * (0.85 + 0.55 * st);
        drawLensDrop(ctx, snap, scale, x + ox + Math.sin(beta) * L, y + oy + Math.cos(beta) * L, rr, rr, { light, mode: 'ball', shape: pendantShape(x + ox, y + oy, rr, st, beta), lookUp: d.lookUp ?? 2.5 });
      } else {
        drawLensDrop(ctx, snap, scale, x + ox, y + oy, rr * (d.sx ?? 1), rr * (d.sy ?? 1), { light, mode: d.mode ?? 'ball', onLeaf: d.mode === 'sessile', lookUp: d.lookUp ?? 0.6, fov: d.fov ?? 6 });
      }
      ctx.restore();
      return [x + ox, y + oy];
    },
    /**
     * Real cut-out tree/plant (transparent PNG) standing at photo point (u, v), bending in the wind.
     * depth: inverse depth like the depth map (0 far … 1 nearest photo pixel, >1 = in front of the photo);
     * height in output px at zoom 1. Gets parallax, depth-of-field blur and haze from the shot.
     * { image, u, v, depth, height, sway, stiffness, flutter, exposure, saturation, tint, haze, flip, seed, crop }
     */
    tree(c) {
      const img = get(c.image);
      if (!img) { eng.warn(s.shot.id, `Không tìm thấy chất liệu "${c.image}"`); return null; }
      const D = c.depth ?? r.depthAt(c.u, c.v);
      const [x, y, k] = r.toScreen(c.u, c.v, D);
      const Hh = (c.height ?? 400) * k;
      const project = (wx, wy) => [wx, -wy, 1];
      const FOG = 1e6; // haze set by distance along z only (card width is in px)
      const cam = { R: [1, 0, 0], pos: [x, 0, 1 + Math.log(1 - Math.min(0.95, c.haze ?? 0)) * FOG] };
      const card = { ...c, img, x, z: 1, y: -y, height: Hh, sway: c.sway ?? 1, stiffness: c.stiffness ?? 1, flutter: c.flutter ?? 1, rim: c.rim ?? 0, choke: c.choke ?? 0.35, seed: c.seed ?? 3 };
      const sky = { horizon: c.hazeColor ?? o.fog?.color ?? '#dfe5e3' };
      const glc = renderCutouts([card], project, cam, sun, sky, wind, time, pw, ph, scale, false, FOG);
      const dd = dof || {};
      const blur = Math.min(dd.max ?? 28, (dd.aperture ?? 0) * Math.abs(D - (dd.focus ?? 0.5))) + (c.blur ?? 0);
      compositeBlurred(ctx, glc, pw, ph, blur * scale, 'tree');
      return [x, y];
    },
    /** Product bottle standing on photo point (u, v); height in output px (scaled by the camera). */
    bottle(b) {
      const [x, y, k] = b.x != null ? [b.x, b.y, 1] : r.toScreen(b.u, b.v);
      const kk = b.x != null ? 1 : k / (o.camera?.zoom ?? 1);
      const Hh = (b.height ?? 420) * kk, R = Hh * (b.radius ?? 0.152);
      const tilt = b.tilt ?? 0;
      const geo = { base: [x, y], top: [x + Math.sin(tilt) * Hh, y - Math.cos(tilt) * Hh], rBase: R, rTop: R * (b.taper ?? 0.985) };
      ctx.save();
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      const f = [b.brightness != null ? `brightness(${b.brightness})` : '', b.saturate != null ? `saturate(${b.saturate})` : '', b.contrast != null ? `contrast(${b.contrast})` : '', b.blur > 0.3 ? `blur(${(b.blur * scale).toFixed(2)}px)` : ''].filter(Boolean).join(' ');
      compositeBottle(ctx, geo, { ...b, time, filter: f || b.filter }, { time, sun, scale, pw, ph, snap: canvasFor('photoSnapB', pw, ph) });
      ctx.restore();
      return geo;
    },
  };
}
