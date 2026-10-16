// Nature scene composer: one 3D world (metres, Y up, water at Y = 0) shared by
// sky, far bank, reeds, falling leaves, a hero leaf with dew, and the WebGL
// water surface. Everything is driven by ONE wind field and ONE clock, and
// coupled: leaves and drops that land on the water inject impulses into the
// ripple simulation, and every element above the water is also drawn through
// a mirrored camera into a planar-reflection buffer that the water shader
// distorts with its normals.
//
// Usage inside a shot:
//   const sc = s.nature({ camera, wind, sun, sky, time });
//   sc.sky(); sc.treeline({...}); sc.reeds({...}); sc.leaves({...});
//   const leaf = sc.leaf({...drops});  sc.water({...});
//   const info = sc.render();
import { clamp, rgba, mix, fbm, rng, TAU, lerp } from '../math.js';
import { makeCamera } from './camera3d.js';
import { makeWind } from './wind.js';
import { makeWaves, getWaveSim, renderWater, waveHeight } from './water.js';
import { simulateLeaves, sampleLeaf, leafFrame, drawLeaf3D, simulateReeds, drawReeds, add, scl } from './foliage.js';
import { renderLeafGL } from './leafgl.js';
import { simulateDew, sampleDew, leafGeometry, drawHeroLeaf, drawTwig, drawLensDrop, pendantShape, DROP_STATE } from './dew.js';

const canvases = new Map();
function canvasFor(key, w, h) {
  let c = canvases.get(key);
  if (!c || c.width !== w || c.height !== h) {
    c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
    canvases.set(key, c);
  }
  return c;
}

/**
 * Draw fn(ctx) with a defocus blur. Renders at reduced resolution and blurs
 * there (cheap on the CPU rasteriser), then upsamples.
 */
function blurDraw(ctx, scale, pw, ph, blurPx, fn, tag = 'b') {
  if (!(blurPx > 0.9)) {
    fn(ctx);
    return;
  }
  const bp = blurPx * scale;
  const k = clamp(2.2 / bp, 0.08, 0.6);
  const w = Math.max(4, Math.round(pw * k)), h = Math.max(4, Math.round(ph * k));
  // pad so content beyond the frame edge blurs in (no light/transparent border)
  const pad = Math.ceil(bp * k * 2.5) + 2;
  const A = canvasFor(tag + 'A', w + pad * 2, h + pad * 2), B = canvasFor(tag + 'B', w + pad * 2, h + pad * 2);
  const a = A.getContext('2d'), b = B.getContext('2d');
  a.setTransform(1, 0, 0, 1, 0, 0);
  a.clearRect(0, 0, A.width, A.height);
  a.setTransform(scale * k, 0, 0, scale * k, pad, pad);
  a.__W = ctx.__W; a.__H = ctx.__H;
  fn(a);
  b.setTransform(1, 0, 0, 1, 0, 0);
  b.clearRect(0, 0, B.width, B.height);
  b.filter = `blur(${(bp * k).toFixed(2)}px)`;
  b.drawImage(A, 0, 0);
  b.filter = 'none';
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(B, pad, pad, w, h, 0, 0, pw, ph);
  ctx.restore();
}

export function natureScene(s, eng, o = {}) {
  const W = s.W, H = s.H, scale = eng.scale;
  const pw = Math.round(W * scale), ph = Math.round(H * scale);
  const time = o.time ?? s.t;
  const until = o.until ?? Math.max(s.d + 3, time + 1);
  const cam = makeCamera(o.camera || {}, W, H);
  const wind = makeWind({ until, ...(o.wind || {}) });
  const so = o.sun || {};
  const el = so.elevation ?? 0.32, az = so.azimuth ?? -0.45; // world azimuth (0 = +Z)
  const sun = {
    dir: [Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)],
    color: so.color ?? '#fff0d0',
    intensity: so.intensity ?? 1,
    translucency: so.translucency ?? 1,
  };
  const sp = cam.project(cam.pos[0] + sun.dir[0] * 1e4, cam.pos[1] + sun.dir[1] * 1e4, cam.pos[2] + sun.dir[2] * 1e4);
  sun.screen = sp[2] > 0 ? [sp[0], sp[1]] : null;
  {
    // light direction on screen (for highlights on drops)
    const lx = sun.dir[0] * cam.R[0] + sun.dir[1] * cam.R[1] + sun.dir[2] * cam.R[2];
    const ly = -(sun.dir[0] * cam.U[0] + sun.dir[1] * cam.U[1] + sun.dir[2] * cam.U[2]);
    const n = Math.hypot(lx, ly) || 1;
    sun.screenDir = { x: lx / n, y: ly / n };
  }
  const sky = { top: '#7fa6c8', horizon: '#e9e2c8', ...(o.sky || {}) };
  const P = (x, y, z) => cam.project(x, y, z);
  const PM = (x, y, z) => cam.project(x, -y, z);
  const hy = cam.horizonY();

  const backdrops = []; // drawn far->near before water
  const leafSets = [];
  const reedSets = [];
  const heroes = [];
  let waterOpts = null;
  const extraImpulses = [];

  const sc = {
    cam, wind, sun, time, P, project: P, horizonY: hy,
    /** Sky dome: gradient, sun glow, soft clouds. */
    sky(opt = {}) {
      const so2 = { ...sky, ...opt };
      Object.assign(sky, so2);
      backdrops.push({ z: Infinity, draw: (c, mirror) => drawSky(c, W, H, hy, so2, sun, time, mirror) });
      return sc;
    },
    /** Far bank of trees (layered silhouettes, aerial haze, sun specks), reflected in the water. */
    treeline(opt = {}) {
      backdrops.push({ z: opt.z ?? 12, draw: (c, mirror) => drawTreeline(c, cam, mirror ? PM : P, opt, sky, sun, time, mirror), blur: opt.blur });
      return sc;
    },
    /** Custom backdrop drawn as a billboard at depth z (fn(ctx, project, mirror)). */
    backdrop(fn, opt = {}) {
      backdrops.push({ z: opt.z ?? 10, draw: (c, mirror) => fn(c, mirror ? PM : P, mirror), blur: opt.blur });
      return sc;
    },
    reeds(opt = {}) {
      const R = simulateReeds(opt, wind, until);
      reedSets.push({ R, opt });
      return sc;
    },
    leaves(opt = {}) {
      const area = opt.area ?? defaultLeafArea(cam, opt, wind);
      const wat = waterOpts || o.water;
      const S = simulateLeaves({ ...opt, area, until, water: opt.water === false ? null : { farZ: (wat?.farZ ?? 60) - 0.2, nearZ: wat?.nearZ, flow: wat?.flow ?? [0, 0] } }, wind);
      leafSets.push({ S, opt });
      return { landings: S.events.map((e) => ({ t: e.t, x: e.x, z: e.z })) };
    },
    /** Hero leaf with dew drops. Returns timing of slide / tip / release / impact events. */
    leaf(opt = {}) {
      const D = simulateDew(opt, wind, until);
      heroes.push({ D, opt });
      const ev = (k) => D.events.filter((e) => e.kind === k).map((e) => e.t);
      return {
        slide: ev('slide'), tip: ev('tip'), release: ev('release'), merge: ev('merge'),
        impact: D.splashes.map((x) => x.t), impactAt: D.splashes.map((x) => [x.x, 0, x.z]),
        geometry: () => { const st = sampleDew(D, time); return leafGeometry(opt, st.phi, st.chi); },
      };
    },
    water(opt = {}) {
      waterOpts = { flow: [0, 0], ...opt };
      return sc;
    },
    impulse(im) {
      extraImpulses.push(im);
      return sc;
    },
    render() {
      return renderScene();
    },
  };

  const PROF = typeof window !== 'undefined' && window.__profOn;
  const tick = (k, t0) => { if (PROF) { const pr = (window.__prof ||= {}); pr[k] = (pr[k] || 0) + performance.now() - t0; } };
  const now = () => (PROF ? performance.now() : 0);
  function renderScene() {
    const ctx = s.ctx;
    ctx.save();
    // ---- reflection buffer (half res) ----
    const rk = 0.5;
    const rw = Math.max(2, Math.round(pw * rk)), rh = Math.max(2, Math.round(ph * rk));
    const refl = canvasFor('refl', rw, rh);
    const rc = refl.getContext('2d');
    rc.setTransform(1, 0, 0, 1, 0, 0);
    rc.clearRect(0, 0, rw, rh);
    rc.setTransform(scale * rk, 0, 0, scale * rk, 0, 0);
    rc.__W = W; rc.__H = H;

    let T0 = now();
    // ---- backdrops (sky, far bank) ----
    backdrops.sort((a, b) => b.z - a.z);
    for (const b of backdrops) {
      const blur = (b.blur ?? 0) + (Number.isFinite(b.z) ? cam.blurAt(b.z) : cam.blurAt(1e4));
      blurDraw(ctx, scale, pw, ph, blur, (c) => b.draw(c, false), 'bd');
      blurDraw(rc, scale * rk, rw, rh, blur * 1.2, (c) => b.draw(c, true), 'bdr');
    }

    tick('backdrops', T0); T0 = now();
    // ---- water state ----
    let Wt = null;
    if (waterOpts) {
      const flow = waterOpts.flow ?? [0, 0];
      const waves = makeWaves(waterOpts, wind);
      const impulses = [];
      for (const ls of leafSets) for (const e of ls.S.events) impulses.push({ t: e.t, x: e.x, z: e.z, r: e.r, amp: e.amp * 0.15 * (waterOpts.leafImpact ?? 1) });
      for (const h of heroes) for (const im of h.D.impulses) impulses.push({ ...im, amp: im.amp * 0.6 * (waterOpts.dropImpact ?? 1) });
      for (const im of extraImpulses) impulses.push(im);
      for (const im of waterOpts.impulses || []) impulses.push(im);
      let sim = null;
      if (impulses.length && waterOpts.ripples !== false) {
        const simImp = impulses.map((im) => ({ ...im, x: im.x - flow[0] * im.t, z: im.z - flow[1] * im.t }));
        let area = waterOpts.simArea;
        if (!area) {
          let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
          for (const im of simImp) { x0 = Math.min(x0, im.x); x1 = Math.max(x1, im.x); z0 = Math.min(z0, im.z); z1 = Math.max(z1, im.z); }
          const m = waterOpts.simMargin ?? 0.6;
          area = [x0 - m, z0 - m, x1 + m, z1 + m];
          // keep it square-ish and bounded
          const span = Math.min(8, Math.max(area[2] - area[0], area[3] - area[1]));
          const cx = (area[0] + area[2]) / 2, cz = (area[1] + area[3]) / 2;
          area = [cx - span / 2, cz - span / 2, cx + span / 2, cz + span / 2];
        }
        const simOpt = { area, res: waterOpts.simRes ?? 256, speed: waterOpts.rippleSpeed ?? 0.3, damping: waterOpts.rippleDamping ?? 0.5, dispersion: waterOpts.dispersion ?? 1.4, impulses: simImp };
        sim = getWaveSim(JSON.stringify(simOpt, (k, v) => (typeof v === 'number' ? Math.round(v * 1e5) / 1e5 : v)), simOpt);
        sim.at(time);
      }
      Wt = { opts: waterOpts, flow, waves, sim, wind, calm: waterOpts.calm ?? 0.25 };
    }

    tick('waterSim', T0); T0 = now();
    // ---- reflections of things above the water ----
    for (const rs of reedSets) drawReeds(rc, rs.R, time, PM, sun, { ...rs.opt, alpha: 0.9 });
    for (const ls of leafSets) {
      for (const lf of ls.S.leaves) {
        const st = sampleLeaf(lf, time);
        if (!st || st.floating) continue;
        drawLeaf3D(rc, lf, [st.x, -st.y, st.z], mirrorFrame(leafFrame(st)), P, sun, cam.pos, { alpha: 0.85 });
      }
    }
    for (const h of heroes) {
      const st = sampleDew(h.D, time);
      const g = leafGeometry(h.opt, st.phi, st.chi);
      drawTwig(rc, h.opt, g, PM, 'reflection');
      drawHeroLeaf(rc, h.opt, g, PM, sun, cam.pos, 'reflection');
    }

    tick('reflections', T0); T0 = now();
    // ---- water ----
    if (Wt) {
      // depth of field for the water: defocus at the distance seen mid-frame
      let wblur = waterOpts.blur;
      if (wblur == null) {
        const hit = cam.unproject(W / 2, Math.max(hy + 20, H * 0.7));
        wblur = hit ? Math.min(40, cam.blurAt(Math.hypot(hit[0] - cam.pos[0], hit[1] - cam.pos[1], hit[2] - cam.pos[2]))) : 0;
      }
      renderWater(ctx, { cam, wind, sun, sky, time, scale, refl }, { ...Wt, opts: { ...waterOpts, blur: wblur } });
    }

    tick('waterGL', T0); T0 = now();
    // ---- reeds (drawn after water so their bases sit in it) ----
    for (const rs of reedSets) {
      const zMid = (rs.opt.z[0] + rs.opt.z[1]) / 2;
      const blur = cam.blurAt(Math.abs(zMid - cam.pos[2]));
      blurDraw(ctx, scale, pw, ph, blur, (c) => drawReeds(c, rs.R, time, P, sun, rs.opt), 'rd');
    }

    // ---- floating leaves (with depth of field) ----
    const floatB = new Map();
    for (const ls of leafSets) {
      for (const lf of ls.S.leaves) {
        const st = sampleLeaf(lf, time);
        if (!st || !st.floating) continue;
        const pr = P(st.x, 0, st.z);
        if (!(pr[2] > 0.05)) continue;
        const bl = cam.blurAt(pr[2]);
        const key = bl < 1.2 ? 0 : Math.round(Math.log2(bl) * 2) / 2;
        if (!floatB.has(key)) floatB.set(key, []);
        floatB.get(key).push({ lf, st });
      }
    }
    for (const [key, list] of floatB) {
      blurDraw(ctx, scale, pw, ph, key === 0 ? 0 : Math.pow(2, key), (c) => {
        for (const { lf, st } of list) {
          const bob = Wt ? waveHeight(Wt, st.x, st.z, time) : 0;
          drawLeaf3D(c, lf, [st.x, bob + 0.002, st.z], leafFrame(st), P, sun, cam.pos, { alpha: 0.95 });
        }
      }, 'fl');
    }

    // ---- falling leaves (depth sorted, depth-of-field buckets) ----
    const air = [];
    for (const ls of leafSets) {
      for (const lf of ls.S.leaves) {
        const st = sampleLeaf(lf, time);
        if (!st || st.floating) continue;
        const pr = P(st.x, st.y, st.z);
        if (!(pr[2] > 0.05)) continue;
        air.push({ lf, st, d: pr[2] });
      }
    }
    air.sort((a, b) => b.d - a.d);
    const buckets = new Map();
    for (const a of air) {
      const bl = cam.blurAt(a.d);
      const key = bl < 1.2 ? 0 : Math.round(Math.log2(bl) * 2) / 2;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(a);
    }
    const heroDepth = heroes.length ? (() => { const h = heroes[0]; const st = sampleDew(h.D, time); const g = leafGeometry(h.opt, st.phi, st.chi); return P(...g.center(0.5))[2]; })() : Infinity;
    const drawAir = (pred) => {
      for (const [key, list] of [...buckets.entries()].sort((a, b) => b[1][0].d - a[1][0].d)) {
        const sel = list.filter((a) => pred(a.d));
        if (!sel.length) continue;
        blurDraw(ctx, scale, pw, ph, key === 0 ? 0 : Math.pow(2, key), (c) => {
          for (const a of sel) drawLeaf3D(c, a.lf, [a.st.x, a.st.y, a.st.z], leafFrame(a.st), P, sun, cam.pos);
        }, 'lv');
      }
    };
    drawAir((d) => d > heroDepth);

    tick('reeds+leaves', T0); T0 = now();
    // ---- hero leaves + dew ----
    const info = { drops: [] };
    for (const h of heroes) drawHero(ctx, h, info, Wt);
    tick('hero', T0); T0 = now();

    drawAir((d) => d <= heroDepth);
    ctx.restore();
    return info;
  }

  function drawHero(ctx, h, info, Wt) {
    const st = sampleDew(h.D, time);
    const g = leafGeometry(h.opt, st.phi, st.chi);
    const dep = P(...g.center(0.5))[2];
    const blur = (h.opt.blur ?? 0) + cam.blurAt(dep);
    blurDraw(ctx, scale, pw, ph, blur, (c) => {
      drawTwig(c, h.opt, g, P, 'main');
      let glc = null;
      if (h.opt.render !== '2d') {
        try { glc = renderLeafGL(g, P, cam, sun, sky, scale, h.opt); } catch (err) { glc = null; h.opt.render = '2d'; }
      }
      if (glc) c.drawImage(glc, 0, 0, W, H);
      else drawHeroLeaf(c, h.opt, g, P, sun, cam.pos, 'main');
    }, 'hl');
    // snapshot of everything behind the drops (for refraction)
    const snap = canvasFor('snap', pw, ph);
    const sx = snap.getContext('2d');
    sx.setTransform(1, 0, 0, 1, 0, 0);
    sx.clearRect(0, 0, pw, ph);
    sx.drawImage(ctx.canvas, 0, 0);
    const light = sun.screenDir;
    blurDraw(ctx, scale, pw, ph, blur, (c) => {
      st.drops.forEach((d) => {
        if (d.st === DROP_STATE.GONE || d.r < 1e-4) return;
        if (d.st === DROP_STATE.PENDANT) {
          const tip = P(...g.center(1));
          const k = cam.scaleAt(tip[2]);
          const rr = d.r * k;
          const Lr = rr * (0.85 + 0.55 * d.stretch);
          drawLensDrop(c, snap, scale, tip[0] + Math.sin(d.beta) * Lr, tip[1] - rr * 0.1 + Math.cos(d.beta) * Lr, rr, rr, { light, mode: 'ball', shape: pendantShape(tip[0], tip[1] - rr * 0.1, rr, d.stretch, d.beta), lookUp: 2.5 });
        } else {
          const uu = Math.min(0.995, d.u);
          const f = g.frame(uu);
          const base = g.point(uu, d.v);
          const top = add(base, scl(f.n, d.r * 0.55));
          const p = P(...top);
          const k = cam.scaleAt(p[2]);
          // foreshortened footprint of the cap on the tilted leaf
          const view = [cam.pos[0] - top[0], cam.pos[1] - top[1], cam.pos[2] - top[2]];
          const vl = Math.hypot(...view);
          const cosv = Math.abs((f.n[0] * view[0] + f.n[1] * view[1] + f.n[2] * view[2]) / vl);
          const rx = d.r * k, ry = d.r * k * (0.62 + 0.38 * cosv);
          const t2 = P(...add(top, scl(f.tg, 0.01)));
          const rot = Math.atan2(t2[1] - p[1], t2[0] - p[0]) - Math.PI / 2;
          drawLensDrop(c, snap, scale, p[0], p[1], rx, ry, { light, mode: 'sessile', onLeaf: true, rot: d.st === DROP_STATE.SLIDING ? rot : 0 });
        }
      });
    }, 'dr');
    // falling drops + splash
    for (const f of h.D.fallers) {
      const pts = f.pts;
      const i = Math.floor((time - pts[0][0]) * 240);
      if (i < 0 || i >= pts.length - 1) continue;
      const q = pts[i];
      const pr = P(q[1], q[2], q[3]);
      const k = cam.scaleAt(pr[2]);
      const age = time - f.t0;
      // Rayleigh mode-2 shape oscillation, decaying
      const om = Math.sqrt((8 * 0.072) / (1000 * f.r ** 3));
      const wob = 0.16 * Math.exp(-age * 7) * Math.sin(om * age + f.phase);
      const rr = f.r * k;
      const b2 = cam.blurAt(pr[2]);
      blurDraw(ctx, scale, pw, ph, b2, (c) => drawLensDrop(c, snap, scale, pr[0], pr[1], rr * (1 + wob), rr * (1 - wob), { light, mode: 'ball', lookUp: 0.6, fov: 7 }), 'fd');
      info.drops.push({ x: pr[0], y: pr[1], r: rr });
    }
    for (const spl of h.D.splashes) drawSplash(ctx, spl, time, P, cam, snap, scale, light, Wt);
  }

  return sc;
}

function mirrorFrame(fr) {
  const f = (v) => [v[0], -v[1], v[2]];
  return { m: f(fr.m), w: f(fr.w), n: f(fr.n) };
}

function defaultLeafArea(cam, opt, wind) {
  const z = opt.z ?? [cam.pos[2] + 1.5, cam.pos[2] + 7];
  const zm = (z[0] + z[1]) / 2;
  const half = (zm * (cam.W / 2)) / cam.f;
  const up = wind.speed * 3 * wind.dx;
  return {
    x: opt.x ?? [cam.pos[0] - half * 1.3 - up, cam.pos[0] + half * 1.3 - up * 0.3],
    y: opt.y ?? [cam.pos[1] + (zm * (cam.H / 2)) / cam.f + 0.3, cam.pos[1] + (zm * (cam.H / 2)) / cam.f + 1.6],
    z,
  };
}

// ----------------------------------------------------------------- sky ---
function drawSky(ctx, W, H, hy, o, sun, t, mirror) {
  ctx.save();
  if (mirror) {
    ctx.translate(0, 2 * hy);
    ctx.scale(1, -1);
  }
  const top = Math.min(0, hy - H);
  const g = ctx.createLinearGradient(0, top, 0, hy);
  g.addColorStop(0, rgba(o.top));
  g.addColorStop(0.7, rgba(mix(o.top, o.horizon, 0.55)));
  g.addColorStop(1, rgba(o.horizon));
  ctx.fillStyle = g;
  ctx.fillRect(-W, top - H * 2, W * 3, hy - top + H * 2 + 2);
  // below-horizon fill (behind the far bank) continues the haze colour
  ctx.fillStyle = rgba(o.horizon);
  ctx.fillRect(-W, hy, W * 3, H * 4);
  if (sun.screen && o.sunGlow !== false) {
    const [x, y] = sun.screen;
    const R = H * (o.glowSize ?? 0.9);
    const sg = ctx.createRadialGradient(x, y, 0, x, y, R);
    sg.addColorStop(0, rgba('#fffaf0', 0.95 * sun.intensity));
    sg.addColorStop(0.05, rgba(sun.color, 0.7 * sun.intensity));
    sg.addColorStop(0.3, rgba(sun.color, 0.22 * sun.intensity));
    sg.addColorStop(1, rgba(sun.color, 0));
    ctx.globalCompositeOperation = 'screen';
    ctx.fillStyle = sg;
    ctx.fillRect(x - R, y - R, R * 2, R * 2);
    ctx.globalCompositeOperation = 'source-over';
  }
  if (o.clouds !== false) {
    const r = rng(o.seed ?? 4);
    const n = o.cloudCount ?? 7;
    ctx.globalCompositeOperation = 'screen';
    for (let i = 0; i < n; i++) {
      const cx = ((r() * W * 1.4 + t * (o.cloudSpeed ?? 6)) % (W * 1.4)) - W * 0.2;
      const cy = top + (hy - top) * r.range(0.15, 0.75);
      const rw = W * r.range(0.12, 0.3), rh = rw * r.range(0.18, 0.32);
      const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, rw);
      cg.addColorStop(0, rgba('#ffffff', 0.18 * (o.cloudOpacity ?? 1)));
      cg.addColorStop(1, rgba('#ffffff', 0));
      ctx.fillStyle = cg;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(1, rh / rw);
      ctx.translate(-cx, -cy);
      ctx.beginPath();
      ctx.arc(cx, cy, rw, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.restore();
}

// ------------------------------------------------------------ treeline ---
// Far bank: rows of individual tree crowns (round broadleaf + some conifers)
// unioned into a silhouette, lit from the sun side, hazier with distance.
function treeProfile(x0, x1, hgt, seed, l) {
  const r = rng(seed * 31 + l * 7);
  const trees = [];
  let x = x0 - 2;
  while (x < x1 + 2) {
    const h = hgt * r.range(0.55, 1.05);
    const conifer = r() < 0.22;
    const R = conifer ? h * r.range(0.16, 0.22) : h * r.range(0.24, 0.36);
    trees.push({ x, h, R, conifer, j: r() });
    x += R * r.range(0.9, 1.6);
  }
  return (xx) => {
    let y = hgt * 0.18 * (0.8 + 0.2 * Math.sin(xx * 0.7 + seed));
    for (const t of trees) {
      const d = xx - t.x;
      if (Math.abs(d) > t.R * 1.2) continue;
      let yy;
      if (t.conifer) yy = t.h * (1 - Math.abs(d) / (t.R * 1.15)) ;
      else {
        const k = d / t.R;
        if (Math.abs(k) >= 1) continue;
        yy = t.h - t.R + t.R * Math.sqrt(1 - k * k) * 0.95;
      }
      const Rr = Math.max(0.5, t.R);
      // leafy, irregular crown edge at several scales
      yy += t.R * (0.08 * fbm(xx * 9 / Rr, t.j * 10, 3) + 0.06 * fbm(xx * 34 / Rr, t.j * 7, 5) + 0.035 * fbm(xx * 110 / Rr, t.j * 3, 6));
      if (t.conifer) yy -= t.R * 0.12 * Math.abs(Math.sin(xx * 26 / Rr + t.j * 9));
      if (yy > y) y = yy;
    }
    return y;
  };
}

function drawTreeline(ctx, cam, P, o, sky, sun, t, mirror) {
  const z0 = o.z ?? 14;
  const layers = o.layers ?? 3;
  const base = o.color ?? '#2f4426';
  const haze = o.haze ?? sky.horizon;
  const seed = o.seed ?? 3;
  const sway = (o.sway ?? 1) * 0.04;
  for (let l = layers - 1; l >= 0; l--) {
    const z = z0 + l * (o.spacing ?? 6);
    const dz = z - cam.pos[2];
    const cxv = cam.pos[0] + (cam.F[0] / Math.max(0.2, cam.F[2])) * dz; // where the view axis meets depth z
    const half = (dz / Math.max(0.3, Math.cos(cam.yaw))) * (cam.W / 2) / cam.f * 1.5 + 3;
    const x0 = cxv - half, x1 = cxv + half;
    const hgt = (o.height ?? 7) * (1 + l * 0.25);
    const prof = treeProfile(x0, x1, hgt, seed, l);
    const N = 420;
    const col = mix(base, haze, clamp(0.08 + l * 0.3 + (o.hazeAmount ?? 0)));
    const pts = [];
    let top = Infinity;
    for (let i = 0; i <= N; i++) {
      const x = x0 + ((x1 - x0) * i) / N;
      const yy = prof(x) + Math.sin(t * 1.1 + x * 0.9) * sway * (l === 0 ? 1 : 0.4);
      const p = P(x, yy, z);
      pts.push(p);
      top = Math.min(top, p[1]);
    }
    const pb0 = P(x0, 0, z), pb1 = P(x1, 0, z);
    const path = new Path2D();
    path.moveTo(pb0[0], pb0[1]);
    for (const p of pts) path.lineTo(p[0], p[1]);
    path.lineTo(pb1[0], pb1[1]);
    path.closePath();
    const yb = pb0[1];
    const g = ctx.createLinearGradient(0, mirror ? yb + (yb - top) : top, 0, yb);
    const lit = mix(col, mix('#c8d890', sun.color, 0.5), 0.22 * (1 - l * 0.3));
    g.addColorStop(0, rgba(mirror ? mix(col, '#000000', 0.1) : lit));
    g.addColorStop(0.55, rgba(col));
    g.addColorStop(1, rgba(mix(col, '#000000', 0.35)));
    ctx.fillStyle = g;
    ctx.fill(path);
    if (l === 0) {
      const r = rng(seed * 13 + l);
      ctx.save();
      ctx.clip(path);
      // foliage clumps: light & shadow variation inside the canopy
      for (let i = 0; i < 120; i++) {
        const x = lerp(x0, x1, r());
        const yy = prof(x) * r.range(0.25, 0.98);
        const p = P(x, yy, z);
        const rad = cam.scaleAt(p[2]) * r.range(0.25, 0.7);
        const lc = r() < 0.45 ? mix(base, '#a6c060', 0.45) : mix(base, '#0a1208', 0.55);
        const cg = ctx.createRadialGradient(p[0], p[1], 0, p[0], p[1], rad);
        cg.addColorStop(0, rgba(lc, 0.45));
        cg.addColorStop(1, rgba(lc, 0));
        ctx.fillStyle = cg;
        ctx.fillRect(p[0] - rad, p[1] - rad, rad * 2, rad * 2);
      }
      ctx.restore();
      // bank where the trees meet the water
      const bh = o.bank ?? 0.3;
      ctx.beginPath();
      for (let i = 0; i <= 60; i++) {
        const x = x0 + ((x1 - x0) * i) / 60;
        const p = P(x, bh * (0.5 + 0.5 * Math.abs(Math.sin(x * 1.7 + seed))) , z - 0.4);
        if (i) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]);
      }
      const q1 = P(x1, -0.4, z - 0.4), q0 = P(x0, -0.4, z - 0.4);
      ctx.lineTo(q1[0], q1[1]);
      ctx.lineTo(q0[0], q0[1]);
      ctx.closePath();
      ctx.fillStyle = rgba(o.bankColor ?? mix(base, '#1a140a', 0.55));
      ctx.fill();
      // sun breaking through the canopy edge (turns into bokeh with defocus)
      if (sun.screen && (o.specks ?? 18) > 0) {
        const rs = rng(seed + 99);
        ctx.globalCompositeOperation = 'screen';
        for (let i = 0; i < (o.specks ?? 18); i++) {
          const x = lerp(x0 + half * 0.25, x1 - half * 0.25, rs());
          const yy = prof(x) * rs.range(0.7, 0.97);
          const p = P(x, yy, z);
          const tw = 0.55 + 0.45 * Math.sin(t * rs.range(1, 3) + i);
          const rad = cam.scaleAt(p[2]) * rs.range(0.05, 0.11);
          const sg = ctx.createRadialGradient(p[0], p[1], 0, p[0], p[1], rad * 2);
          sg.addColorStop(0, rgba('#fff6d8', 0.85 * tw * (mirror ? 0.4 : 1)));
          sg.addColorStop(1, rgba('#fff6d8', 0));
          ctx.fillStyle = sg;
          ctx.fillRect(p[0] - rad * 2, p[1] - rad * 2, rad * 4, rad * 4);
        }
        ctx.globalCompositeOperation = 'source-over';
      }
    }
  }
}

// -------------------------------------------------------------- splash ---
function drawSplash(ctx, spl, t, P, cam, snap, scale, light, Wt) {
  const tau = t - spl.t;
  if (tau < 0 || tau > 1.2) return;
  const G = 9.81;
  const fl = Wt ? Wt.flow : [0, 0];
  spl = { ...spl, x: spl.x + fl[0] * tau, z: spl.z + fl[1] * tau };
  const base = P(spl.x, 0, spl.z);
  const k = cam.scaleAt(base[2]);
  ctx.save();
  // crater rim flash at impact
  if (tau < 0.09) {
    const a = 1 - tau / 0.09;
    ctx.strokeStyle = `rgba(255,255,255,${0.55 * a})`;
    ctx.lineWidth = Math.max(0.8, spl.r * k * 0.3);
    ctx.beginPath();
    const rr = spl.r * k * (1.4 + tau * 30);
    ctx.ellipse(base[0], base[1], rr, rr * Math.max(0.15, Math.abs(cam.F[1]) + 0.12), 0, 0, TAU);
    ctx.stroke();
  }
  // Worthington jet: rises, pinches its tip off, recedes
  const jetEnd = (2 * spl.vj) / G;
  if (tau > 0.02 && tau < jetEnd) {
    const tj = tau - 0.02;
    let hgt = spl.vj * tj - 0.5 * G * tj * tj;
    if (tj > spl.tp) hgt = Math.min(hgt, spl.h0 * (1 - (tj - spl.tp) / (jetEnd - spl.tp)));
    if (hgt > 0.0005) {
      const top = P(spl.x, hgt, spl.z);
      const wb = spl.r * 1.25 * k, wt = spl.r * 0.62 * k;
      ctx.beginPath();
      ctx.moveTo(base[0] - wb * 1.8, base[1]);
      ctx.quadraticCurveTo(base[0] - wb * 0.6, base[1] - 1, base[0] - wt * 1.1, (base[1] + top[1]) / 2);
      ctx.lineTo(top[0] - wt, top[1] + wt);
      ctx.arc(top[0], top[1] + wt, wt, Math.PI, 0);
      ctx.lineTo(base[0] + wt * 1.1, (base[1] + top[1]) / 2);
      ctx.quadraticCurveTo(base[0] + wb * 0.6, base[1] - 1, base[0] + wb * 1.8, base[1]);
      ctx.closePath();
      ctx.save();
      ctx.clip();
      if (snap) {
        ctx.save();
        ctx.translate(top[0], (top[1] + base[1]) / 2);
        ctx.scale(-1, 1);
        const sw = wb * 6, shh = Math.abs(base[1] - top[1]) * 2 + 4;
        try { ctx.drawImage(snap, (top[0] - sw / 2) * scale, (top[1] - shh) * scale, sw * scale, shh * scale, -wb * 2, -shh / 4, wb * 4, shh / 2 + 2); } catch { /* */ }
        ctx.restore();
      }
      const g = ctx.createLinearGradient(base[0] - wb, 0, base[0] + wb, 0);
      g.addColorStop(0, 'rgba(8,24,18,0.5)');
      g.addColorStop(0.18, 'rgba(255,255,255,0.28)');
      g.addColorStop(0.3, 'rgba(255,255,255,0.04)');
      g.addColorStop(0.7, 'rgba(200,230,220,0.02)');
      g.addColorStop(0.85, 'rgba(255,255,255,0.12)');
      g.addColorStop(1, 'rgba(8,24,18,0.45)');
      ctx.fillStyle = g;
      ctx.fillRect(base[0] - wb * 2, top[1] - wt * 2, wb * 4, base[1] - top[1] + wt * 3);
      ctx.restore();
    }
  }
  // jet-tip droplet
  if (tau > spl.tp + 0.02) {
    const a = tau - spl.tp - 0.02;
    const y = spl.h0 + spl.v0 * a - 0.5 * G * a * a;
    if (y > 0) {
      const p = P(spl.x, y + spl.rj, spl.z);
      const rr = spl.rj * k;
      drawLensDrop(ctx, snap, scale, p[0], p[1], rr, rr * (1 + 0.1 * Math.sin(a * 90)), { light, mode: 'ball', lookUp: 3, fov: 4, rim: 0.6 });
    }
  }
  ctx.restore();
}
