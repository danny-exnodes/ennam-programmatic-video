// Per-segment render cache (issue #29).
//
// The export timeline is split into contiguous frame ranges ("segments") whose frames
// depend on the same set of shots: the interior of each shot, and each transition
// overlap (and any motion-blur sample that crosses a cut) as its own segment keyed by
// both neighbouring shots. Each segment is encoded to its own MP4 with identical x264
// parameters (independent encode → starts with an IDR frame, closed GOP), so cached
// segments are joined with the ffmpeg concat demuxer without re-encoding.
//
// Cache key (two levels, conservative — a stale hit is the worst possible failure):
//   key1 = sha256 over: cache format, engine version (content of engine/**, render page,
//          fonts, Chromium binary + flags, ffmpeg build), encoder params (quality, crf,
//          preset, scale, motion-blur samples, output fps, x264 args), project size/fps/
//          style, frame range, total duration (when a sample is clamped at the end) and
//          every field of every shot the segment depends on (code, fields, name, index,
//          start, duration, transition, …; only `notes` / `needsReview` are left out).
//   The render page traces which asset names were looked up while rendering the
//   segment (public/render-page.js `__frameInfo`). That list is stored in the manifest
//   `<key1>.json`; the encoded file is `<key1>-<digest>.mp4` where digest = hash of the
//   CURRENT content hash of each traced asset (all image/video assets if the asset map
//   was enumerated). Rendering is deterministic, so identical inputs for everything read
//   ⇒ identical execution ⇒ identical asset reads (the dynamic-dependency argument
//   build systems use). Changing an asset only re-renders the segments that read it.
//
// Layout: DATA_DIR/projects/<id>/cache/{<key1>.json, <key1>-<digest>.mp4}. LRU by mtime
// (touched on every reuse), capped per project by RENDER_CACHE_MAX_MB (default 2000,
// 0 = cache off). The cache lives inside the project folder, so deleting the project
// deletes it.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { projectDir } from './store.js';
import { FFMPEG, run } from './media.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CACHE_FORMAT = 1;

export function cacheMaxBytes() {
  const v = process.env.RENDER_CACHE_MAX_MB;
  const mb = v == null || v === '' ? 2000 : Number(v);
  return Number.isFinite(mb) && mb > 0 ? Math.floor(mb * 1024 * 1024) : 0;
}

export const cacheDir = (projectId) => path.join(projectDir(projectId), 'cache');

const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');

/** JSON with sorted object keys (stable hash input). */
export function stableJson(v) {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']';
  return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + stableJson(v[k])).join(',') + '}';
}

// ---------------------------------------------------------------- engine version
function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

let ffmpegVersionP = null;
function ffmpegVersion() {
  ffmpegVersionP ??= run(FFMPEG, ['-version']).then((r) => sha(r.out), () => 'ffmpeg?');
  return ffmpegVersionP;
}

/**
 * Everything outside the project that changes rendered pixels or the bitstream:
 * engine/** + render page + fonts (content), Chromium binary (path, size, mtime) and
 * flags, ffmpeg build. Recomputed per render (engine/ is ~300 KB) so editing the engine
 * while the server runs can never reuse old segments.
 */
export async function engineVersion(chromePath) {
  const h = crypto.createHash('sha256');
  const files = [
    ...walk(path.join(ROOT, 'engine')),
    path.join(ROOT, 'public/render-page.js'), path.join(ROOT, 'public/render.html'), path.join(ROOT, 'public/fonts.css'),
  ].sort();
  for (const f of files) {
    h.update(path.relative(ROOT, f) + '\0');
    h.update(fs.readFileSync(f));
    h.update('\0');
  }
  for (const pkg of ['@fontsource/be-vietnam-pro', '@fontsource/playfair-display']) {
    try { h.update(pkg + '@' + JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', pkg, 'package.json'), 'utf8')).version); } catch { h.update(pkg + '@?'); }
  }
  let chrome = String(chromePath || '');
  try { const st = fs.statSync(chromePath); chrome += `|${st.size}|${st.mtimeMs}`; } catch { /* unknown binary */ }
  h.update(stableJson({ chrome, args: process.env.CHROME_ARGS || '', gpu: !!process.env.RENDER_GPU, fontconfig: process.env.FONTCONFIG_PATH || '' }));
  h.update(await ffmpegVersion());
  return h.digest('hex');
}

// ---------------------------------------------------------------- assets
const fileHashMemo = new Map(); // path -> { size, mtimeMs, hash }
async function fileHash(file) {
  let st;
  try { st = await fsp.stat(file); } catch { return null; }
  const m = fileHashMemo.get(file);
  if (m && m.size === st.size && m.mtimeMs === st.mtimeMs) return m.hash;
  const hash = await new Promise((res, rej) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('error', rej).on('end', () => res(h.digest('hex')));
  }).catch(() => null);
  if (hash) fileHashMemo.set(file, { size: st.size, mtimeMs: st.mtimeMs, hash });
  return hash;
}

/**
 * name -> content descriptor of every asset the render page loads (image/video), exactly
 * as the engine sees them (by name). Missing file → 'missing'.
 */
export async function assetTable(project) {
  const dir = projectDir(project.id);
  const out = {};
  for (const a of project.assets || []) {
    if (a.type !== 'image' && a.type !== 'video') continue;
    const h = await fileHash(path.join(dir, 'assets', a.file));
    out[a.name] = `${a.type}:${h || 'missing'}`;
  }
  // Brand Kit logo (#8): loaded by the render page as asset 'brand-logo' from assets/brand-*
  // (not in project.assets) → same traced dependency as any image asset
  const logo = project.brand?.kit?.logo?.file;
  if (logo) out['brand-logo'] = `image:${(await fileHash(path.join(dir, 'assets', path.basename(logo)))) || 'missing'}`;
  return out;
}

/**
 * Brand Kit inputs that are NOT read through the asset map: the kit snapshot itself (palette,
 * fonts, outro… → s.palette / s.brand / default text fonts of every shot) and the CONTENT of
 * uploaded font files (registered as FontFace by the render page, used by any s.text). Part of
 * key1 of every segment. The logo is also hashed here (conservative; it is traced as well).
 */
export async function brandInputs(project) {
  const b = project.brand;
  const kit = b?.kit && typeof b.kit === 'object' ? b.kit : null;
  if (!kit) return null;
  const dir = path.join(projectDir(project.id), 'assets');
  const files = {};
  for (const f of [kit.logo?.file, ...(kit.fontFiles || []).map((x) => x?.file)]) {
    if (f) files[f] = (await fileHash(path.join(dir, path.basename(f)))) || 'missing';
  }
  return { id: b.id ?? null, version: b.version ?? null, kit, files };
}

// ---------------------------------------------------------------- timeline plan
/**
 * Mirror of Engine.computeTimeline / shotAt / composite / renderFrame (engine/engine.js)
 * used to know which shots each frame reads. Verified at runtime: the render page
 * reports the shots that actually ran; a segment whose trace is not a subset of its
 * predicted deps is rendered correctly but NOT stored in the cache.
 */
export function timelineOf(project) {
  let t = 0;
  return project.shots.map((sh, i) => {
    const it = { shot: sh, index: i, start: t, end: t + sh.duration };
    t += sh.duration;
    return it;
  });
}

function shotsAtTime(tl, t) {
  let it = tl[tl.length - 1];
  for (const x of tl) if (t >= x.start && t < x.end) { it = x; break; }
  const local = t - it.start;
  const tr = it.shot.transition || { type: 'cut' };
  const td = Math.min(tr.duration ?? 0.5, it.shot.duration * 0.9);
  if (it.index > 0 && tr.type && tr.type !== 'cut' && local < td) return [it.index - 1, it.index];
  return [it.index];
}

/**
 * Split frames 0..total-1 (time f / outFps) into contiguous segments with the same
 * dependency set. Returns [{ f0, f1 (exclusive), deps: [shot index], clamped }].
 */
export function planSegments(project, { outFps, mb = 1, total }) {
  const tl = timelineOf(project);
  if (!tl.length) return [];
  const fps = project.fps || 30;
  const duration = project.shots.reduce((s, x) => s + (x.duration || 0), 0);
  const samples = Math.max(1, mb || 1);
  const shutter = 0.5 / fps; // engine default (renderFrame opts.shutter is never set by export)
  const segs = [];
  for (let f = 0; f < total; f++) {
    const t = f / outFps;
    const deps = new Set();
    let clamped = false;
    if (samples === 1) {
      for (const i of shotsAtTime(tl, t)) deps.add(i);
    } else {
      for (let i = 0; i < samples; i++) {
        const st = t + (i / (samples - 1) - 0.5) * shutter;
        if (st > duration - 1e-4) clamped = true;
        for (const k of shotsAtTime(tl, Math.max(0, Math.min(duration - 1e-4, st)))) deps.add(k);
      }
    }
    const d = [...deps].sort((a, b) => a - b);
    const last = segs[segs.length - 1];
    if (last && last.f1 === f && last.deps.join(',') === d.join(',')) {
      last.f1 = f + 1;
      last.clamped ||= clamped;
    } else segs.push({ f0: f, f1: f + 1, deps: d, clamped });
  }
  return segs;
}

const SHOT_IGNORED = new Set(['notes', 'needsReview']); // never read by the engine

/** First-level key of a segment (everything except asset content, see header). */
export function segmentKey(project, seg, { engine, encoder, outFps, brand = null }) {
  const tl = timelineOf(project);
  const duration = project.shots.reduce((s, x) => s + (x.duration || 0), 0);
  const shots = seg.deps.map((i) => {
    const sh = {};
    for (const [k, v] of Object.entries(tl[i].shot)) if (!SHOT_IGNORED.has(k)) sh[k] = v;
    return { index: i, start: tl[i].start, end: tl[i].end, shot: sh };
  });
  return sha(stableJson({
    v: CACHE_FORMAT, engine, encoder, outFps,
    project: { width: project.width, height: project.height, fps: project.fps || 30, style: project.style || {} },
    brand,
    range: [seg.f0, seg.f1],
    clampDuration: seg.clamped ? duration : null,
    shots,
  }));
}

function assetDigest(table, names, all) {
  const used = {};
  for (const n of all ? Object.keys(table) : names) used[n] = table[n] ?? null;
  return sha(stableJson({ all: !!all, used })).slice(0, 24);
}

// ---------------------------------------------------------------- cache store
const isKey = (k) => /^[0-9a-f]{64}$/.test(k);

/** Cached file for key1 given the current asset table, or null. */
export async function lookup(dir, key1, table) {
  if (!isKey(key1)) return null;
  let man;
  try { man = JSON.parse(await fsp.readFile(path.join(dir, `${key1}.json`), 'utf8')); } catch { return null; }
  if (man?.v !== CACHE_FORMAT || !Array.isArray(man.assets)) return null;
  const file = path.join(dir, `${key1}-${assetDigest(table, man.assets, man.all)}.mp4`);
  try {
    const st = await fsp.stat(file);
    if (!st.isFile() || st.size === 0) return null;
  } catch { return null; }
  return { file, manifest: man };
}

/** Mark as recently used (LRU uses mtime: atime is unreliable with noatime mounts). */
export async function touch(dir, key1, file) {
  const now = new Date();
  await fsp.utimes(file, now, now).catch(() => {});
  await fsp.utimes(path.join(dir, `${key1}.json`), now, now).catch(() => {});
}

/**
 * Store a freshly encoded segment (hard link, copy as fallback; best effort — a failure
 * only means no reuse next time). manifest: { frames, renderMs, assets: [names], all }.
 */
export async function store(dir, key1, srcFile, table, manifest) {
  try {
    await fsp.mkdir(dir, { recursive: true });
    const name = `${key1}-${assetDigest(table, manifest.assets, manifest.all)}.mp4`;
    const dst = path.join(dir, name);
    const tmp = `${dst}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
    await fsp.link(srcFile, tmp).catch(() => fsp.copyFile(srcFile, tmp));
    await fsp.rename(tmp, dst);
    const man = { v: CACHE_FORMAT, file: name, ...manifest, createdAt: new Date().toISOString() };
    const mtmp = path.join(dir, `${key1}.json.${process.pid}.tmp`);
    await fsp.writeFile(mtmp, JSON.stringify(man));
    await fsp.rename(mtmp, path.join(dir, `${key1}.json`));
    return true;
  } catch {
    return false;
  }
}

/** { segments, bytes } of a project's cache. */
export async function cacheStats(projectId) {
  const dir = cacheDir(projectId);
  let names = [];
  try { names = await fsp.readdir(dir); } catch { return { segments: 0, bytes: 0, maxBytes: cacheMaxBytes() }; }
  let segments = 0, bytes = 0;
  for (const n of names) {
    try {
      const st = await fsp.stat(path.join(dir, n));
      bytes += st.size;
      if (n.endsWith('.mp4')) segments++;
    } catch { /* deleted meanwhile */ }
  }
  return { segments, bytes, maxBytes: cacheMaxBytes() };
}

/** "Xoá cache": remove the whole cache folder. Returns bytes freed. */
export async function clearCache(projectId) {
  const { bytes } = await cacheStats(projectId);
  await fsp.rm(cacheDir(projectId), { recursive: true, force: true });
  return bytes;
}

/**
 * LRU cap: delete least-recently-used segments (and their manifest) until the folder is
 * ≤ maxBytes. Stray temp files older than 1 h are removed too. Returns bytes freed.
 */
export async function enforceCap(dir, maxBytes) {
  let names;
  try { names = await fsp.readdir(dir); } catch { return 0; }
  const segs = [];
  let total = 0, freed = 0;
  const now = Date.now();
  for (const n of names) {
    const p = path.join(dir, n);
    let st;
    try { st = await fsp.stat(p); } catch { continue; }
    if (n.endsWith('.tmp')) {
      if (now - st.mtimeMs > 3600e3) { await fsp.rm(p, { force: true }); continue; }
    }
    total += st.size;
    if (n.endsWith('.mp4')) segs.push({ n, p, size: st.size, mtime: st.mtimeMs });
  }
  segs.sort((a, b) => a.mtime - b.mtime || a.n.localeCompare(b.n));
  for (const s of segs) {
    if (total <= maxBytes) break;
    await fsp.rm(s.p, { force: true });
    total -= s.size; freed += s.size;
    const key1 = s.n.slice(0, 64);
    const mp = path.join(dir, `${key1}.json`);
    try {
      const man = JSON.parse(await fsp.readFile(mp, 'utf8'));
      if (man.file === s.n) {
        const st = await fsp.stat(mp);
        await fsp.rm(mp, { force: true });
        total -= st.size; freed += st.size;
      }
    } catch { /* no manifest */ }
  }
  return freed;
}
