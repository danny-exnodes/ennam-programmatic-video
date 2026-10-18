// Headless render page. Driven by server/render.js via page.evaluate().
import { Engine, loadAssets, loadFonts } from '/engine/engine.js';

const qs = new URLSearchParams(location.search);
const id = qs.get('project');
const scale = Number(qs.get('scale') || 1);
const canvas = document.getElementById('out');
const engine = new Engine(canvas, { scale });
window.__engine = engine;

async function boot(project) {
  try {
    await loadFonts();
    engine.setProject(project);
    await loadAssets(engine, project, (a) => `/files/${project.id}/assets/${encodeURIComponent(a.file)}`);
    window.__ready = true;
  } catch (e) {
    window.__fatal = e.message;
  }
}

window.__setProject = (p) => boot(p);

// fmt 'png' = lossless (golden-frame tests), default JPEG for the MP4 pipe.
async function frame(t, mb = 1, fmt = 'jpeg') {
  engine.renderFrame(t, { motionBlur: mb });
  if (await engine.syncVideos()) engine.renderFrame(t, { motionBlur: mb });
  return (fmt === 'png' ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.94)).split(',')[1];
}
window.__frame = frame;

// Dependency trace for the per-segment render cache (server/render-cache.js): which shots
// (timeline index) ran and which asset names were looked up while rendering a frame.
// Read-only wrappers → pixels unchanged. `all` = something enumerated the asset map.
const trace = { on: false, shots: new Set(), assets: new Set(), all: false };
{
  const rs = engine.renderShot.bind(engine);
  engine.renderShot = (ctx, item, ...rest) => { if (trace.on) trace.shots.add(item.index); return rs(ctx, item, ...rest); };
  const A = engine.assets;
  const get = A.get.bind(A), has = A.has.bind(A);
  A.get = (k) => { if (trace.on) trace.assets.add(String(k)); return get(k); };
  A.has = (k) => { if (trace.on) trace.assets.add(String(k)); return has(k); };
  for (const m of ['forEach', 'entries', 'keys', 'values', Symbol.iterator]) {
    const orig = A[m].bind(A);
    A[m] = (...a) => { if (trace.on) trace.all = true; return orig(...a); };
  }
  const size = Object.getOwnPropertyDescriptor(Map.prototype, 'size').get;
  Object.defineProperty(A, 'size', { get() { if (trace.on) trace.all = true; return size.call(A); } });
}
window.__frameInfo = async (t, mb = 1) => {
  trace.on = true; trace.shots.clear(); trace.assets.clear(); trace.all = false;
  try {
    const b64 = await frame(t, mb);
    return { b64, shots: [...trace.shots], assets: [...trace.assets], all: trace.all };
  } finally {
    trace.on = false;
  }
};

// Pixel statistics of a canvas (pre-post shot buffer), sampled on a 2px grid.
// Luma 0..255 (Rec. 601). bright = share of pixels with luma > 20 (near-black detection).
function lumaStats(cv) {
  const w = cv.width, h = cv.height;
  const d = cv.getContext('2d').getImageData(0, 0, w, h).data;
  let n = 0, sum = 0, sq = 0, bright = 0;
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      const o = (y * w + x) * 4;
      const l = 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2];
      sum += l; sq += l * l; n++;
      if (l > 20) bright++;
    }
  }
  const mean = sum / Math.max(1, n);
  return { mean, std: Math.sqrt(Math.max(0, sq / Math.max(1, n) - mean * mean)), bright: bright / Math.max(1, n) };
}

// Contact sheet + runtime errors + per-shot QA metrics for the AI director's self-review.
// metrics[shotId] = { samples: [{ t, mean, std, bright, ms, text: [{x,y,w,h,text}] }] }
// (pixel stats are taken before post — grade/vignette/grain would hide a flat frame).
// ms/frame needs a clock injected by the caller (window.__profNow, see server/render.js);
// this page and the engine never read a real clock themselves → ms is null without it.
window.__inspect = async (n = 3, tw = 480) => {
  const p = engine.project;
  const th = Math.round((tw * p.height) / p.width);
  const labelH = 34;
  const sheet = document.createElement('canvas');
  sheet.width = tw * n;
  sheet.height = (th + labelH) * p.shots.length;
  const sc = sheet.getContext('2d');
  sc.fillStyle = '#111';
  sc.fillRect(0, 0, sheet.width, sheet.height);
  const tmp = document.createElement('canvas');
  tmp.width = canvas.width; tmp.height = canvas.height;
  const tc = tmp.getContext('2d');
  const clock = typeof window.__profNow === 'function' ? window.__profNow : null;
  engine.errors.clear();
  engine._warned = new Set();
  const metrics = {};
  try {
    for (let i = 0; i < p.shots.length; i++) {
      const sh = p.shots[i];
      const samples = [];
      for (let j = 0; j < n; j++) {
        const lt = (sh.duration * (j + 0.5)) / n;
        engine.textProbe = [];
        const t0 = clock ? clock() : 0;
        engine.renderShotFrame(tc, i, lt);
        tc.getImageData(0, 0, 1, 1); // flush raster work before stopping the clock
        const ms = clock ? clock() - t0 : null;
        samples.push({ t: lt, ...lumaStats(engine.frameBuf), ms, text: engine.textProbe });
        engine.textProbe = null;
        sc.drawImage(tmp, j * tw, i * (th + labelH) + labelH, tw, th);
        sc.fillStyle = '#ddd';
        sc.font = '600 18px "Be Vietnam Pro", sans-serif';
        sc.fillText(`Shot ${i + 1} · ${sh.name} · t=${lt.toFixed(1)}s`, j * tw + 8, i * (th + labelH) + 23);
      }
      metrics[sh.id] = { samples };
    }
  } finally {
    engine.textProbe = null;
  }
  const errors = {};
  for (const [k, v] of engine.errors) errors[k] = v;
  return { errors, metrics, width: p.width, height: p.height, sheet: sheet.toDataURL('image/jpeg', 0.82).split(',')[1] };
};

if (!qs.get('override')) {
  fetch(`/api/projects/${id}`).then((r) => r.json()).then(boot).catch((e) => (window.__fatal = e.message));
}
