// Export pipeline: headless Chromium runs the SAME engine as the editor,
// steps frames deterministically, streams JPEG frames into ffmpeg (one encode per
// timeline segment, reused from the per-segment cache when nothing it depends on
// changed — server/render-cache.js), concats the segments, then mixes music +
// voice-over and muxes the final MP4.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { chromium } from 'playwright-core';
import crypto from 'node:crypto';
import { FFMPEG, FFPROBE, run } from './media.js';
import { projectDir } from './store.js';
import { renderAuthHeaders } from './auth.js';
import { planSegments, segmentKey, engineVersion, assetTable, brandInputs, lookup, touch, store, enforceCap, cacheDir, cacheMaxBytes } from './render-cache.js';

let browserP = null;

export function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(process.env.HOME || '', '.cache/ms-playwright'), '/opt/pw-browsers'].filter(Boolean);
  for (const r of roots) {
    try {
      const dirs = fs.readdirSync(r).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse();
      for (const d of dirs) {
        for (const rel of ['chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-win/chrome.exe']) {
          const p = path.join(r, d, rel);
          if (fs.existsSync(p)) return p;
        }
      }
    } catch { /* ignore */ }
  }
  for (const p of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) if (fs.existsSync(p)) return p;
  return undefined;
}

export async function getBrowser() {
  if (!browserP) {
    browserP = chromium.launch({
      executablePath: findChrome(),
      headless: true,
      // CHROME_ARGS: extra space-separated flags (scripts/golden.js pins font hinting this way)
      args: ['--disable-web-security', '--autoplay-policy=no-user-gesture-required', ...(process.env.CHROME_ARGS || '').split(' ').filter(Boolean), ...(process.env.RENDER_GPU ? ['--use-gl=angle', '--enable-gpu-rasterization'] : ['--disable-gpu', '--disable-accelerated-2d-canvas', '--disable-gpu-compositing'])],
    }).catch((e) => {
      browserP = null;
      throw new Error('Không mở được Chromium để render. Cài bằng `npx playwright install chromium` hoặc đặt CHROME_PATH. ' + e.message);
    });
    const b = await browserP;
    b.on('disconnected', () => (browserP = null));
  }
  return browserP;
}

export function baseUrl() {
  return `http://127.0.0.1:${process.env.PORT || 5173}`;
}

/** Open the render page for a project (optionally with an in-memory project override). */
export async function openRenderPage(projectId, { override, scale = 1 } = {}) {
  const browser = await getBrowser();
  const ctx = await browser.newContext({
    viewport: { width: 800, height: 600 },
    // pass server/auth.js: internal per-process token (server process) + EMS_TOKEN / APP_PASSWORD for dev scripts
    extraHTTPHeaders: renderAuthHeaders(),
  });
  const page = await ctx.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  await page.goto(`${baseUrl()}/render.html?project=${encodeURIComponent(projectId)}&scale=${scale}${override ? '&override=1' : ''}`);
  if (override) await page.evaluate((p) => window.__setProject(p), override);
  await page.waitForFunction(() => window.__ready === true || window.__fatal, null, { timeout: 60000 });
  const fatal = await page.evaluate(() => window.__fatal || null);
  if (fatal) throw new Error('Render page lỗi: ' + fatal);
  return { page, close: () => ctx.close(), logs };
}

/**
 * Export qualities. `preview` = "Xem nhanh" (#29): 12 fps, 1/3 resolution kept small
 * (not upscaled), no motion blur, fastest x264 preset; shown in the editor, never added
 * to the exports list.
 */
export const QUALITIES = {
  preview: { fps: 12, mb: 1, crf: 28, preset: 'ultrafast', scale: 0.33, upscale: false },
  draft: { mb: 1, crf: 23, preset: 'veryfast', scale: 0.5 },
  standard: { mb: 3, crf: 18, preset: 'medium', scale: 1 },
  high: { mb: 6, crf: 15, preset: 'slow', scale: 1 },
};

/** x264 output args, identical for every segment of a render (part of the cache key). */
function encoderArgs(project, q) {
  const vf = q.upscale === false ? 'scale=trunc(iw/2)*2:trunc(ih/2)*2' : q.scale !== 1 ? `scale=${project.width}:${project.height}:flags=bicubic` : null;
  return [
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', String(q.crf), '-preset', q.preset,
    // each segment is an independent encode → starts with an IDR frame; GOPs stay closed
    // so the concat demuxer can join segments without re-encoding
    '-x264-params', 'open-gop=0',
    ...(vf ? ['-vf', vf] : []),
    '-movflags', '+faststart',
  ];
}

async function countFrames(file) {
  const { out } = await run(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', file]);
  return parseInt(out.trim(), 10);
}

const slugOf = (name) => name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'video';

/**
 * Render a project to MP4 through the per-segment cache (server/render-cache.js).
 * opts: quality ('preview'|'draft'|'standard'|'high'), motionBlur, onProgress(k, msg),
 *       log(line), signal, cache (false = render every segment, store nothing),
 *       onEvent(name, data) (tests: 'planned', 'segment').
 * Returns { file, duration, createdAt, quality, preview?, cache: stats }.
 */
export async function renderProject(project, opts = {}) {
  const quality = QUALITIES[opts.quality] ? opts.quality : 'standard';
  const q = { ...QUALITIES[quality] };
  if (opts.motionBlur) q.mb = opts.motionBlur;
  const preview = quality === 'preview';
  const outFps = q.fps || project.fps || 30;
  const duration = project.shots.reduce((s, x) => s + x.duration, 0);
  const total = Math.max(1, Math.round(duration * outFps));
  const dir = projectDir(project.id);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/^(\d{8})(\d{4})$/, '$1-$2');
  const outName = preview ? `xem-nhanh-${stamp}-${crypto.randomBytes(2).toString('hex')}.mp4` : `${slugOf(project.name)}-${stamp}${quality === 'draft' ? '-nhap' : ''}.mp4`;
  const outDir = path.join(dir, preview ? 'preview' : 'exports');
  const outFile = path.join(outDir, outName);
  const workDir = path.join(outDir, `.tmp-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
  const prog = opts.onProgress || (() => {});
  const log = opts.log || (() => {});
  const maxBytes = opts.cache === false ? 0 : cacheMaxBytes();
  const t0 = Date.now();
  let res;
  await fsp.mkdir(workDir, { recursive: true });
  try {
    const args = { project, q, outFps, total, workDir, prog, log, signal: opts.signal, onEvent: opts.onEvent || (() => {}) };
    try {
      res = await renderVideo({ ...args, useCache: maxBytes > 0 });
    } catch (e) {
      if (e.code !== 'CONCAT_MISMATCH' || !e.reused?.length) throw e;
      // a cached segment did not join cleanly: drop the reused entries and render everything
      log(`⚠ Ghép đoạn cache lệch số khung (${e.message}) — bỏ ${e.reused.length} đoạn cache, render lại toàn bộ`);
      for (const f of e.reused) await fsp.rm(f, { force: true });
      await fsp.rm(workDir, { recursive: true, force: true });
      await fsp.mkdir(workDir, { recursive: true });
      res = await renderVideo({ ...args, useCache: false });
    }
    prog(0.93, 'Trộn âm thanh');
    await mixAudio(project, res.video, outFile, duration);
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
  if (preview) {
    // only the latest quick preview is kept
    for (const n of await fsp.readdir(outDir).catch(() => [])) {
      if (n !== outName && n.endsWith('.mp4')) await fsp.rm(path.join(outDir, n), { force: true }).catch(() => {});
    }
  }
  if (maxBytes) await enforceCap(cacheDir(project.id), maxBytes).catch(() => {});
  const st = res.stats;
  st.totalSec = +((Date.now() - t0) / 1000).toFixed(2);
  const msg = `Xong · tái sử dụng ${st.reused}/${st.segments} đoạn (${st.reusedFrames}/${st.frames} khung)${st.savedSec > 0 ? ` · tiết kiệm ~${Math.round(st.savedSec)}s` : ''} · ${st.totalSec}s`;
  log(msg);
  prog(1, msg);
  return { file: outName, duration, createdAt: new Date().toISOString(), quality, ...(preview ? { preview: true } : {}), cache: st };
}

/** Plan segments, pin cache hits, render + encode the missing ones, concat. → { video, stats } */
async function renderVideo({ project, q, outFps, total, workDir, useCache, prog, log, signal, onEvent }) {
  const encArgs = encoderArgs(project, q);
  const segs = planSegments(project, { outFps, mb: q.mb, total });
  const cdir = cacheDir(project.id);
  const table = await assetTable(project);
  const engineV = useCache ? await engineVersion(findChrome()) : '';
  const brand = useCache ? await brandInputs(project) : null;
  const encoder = { args: encArgs, mb: q.mb, scale: q.scale, upscale: q.upscale !== false };
  const reusedFiles = [];
  for (const [i, s] of segs.entries()) {
    s.file = path.join(workDir, `seg-${String(i).padStart(4, '0')}.mp4`);
    s.frames = s.f1 - s.f0;
    if (!useCache) continue;
    s.key = segmentKey(project, s, { engine: engineV, encoder, outFps, brand });
    const hit = await lookup(cdir, s.key, table);
    if (!hit) continue;
    // pin: hard link into this job's work dir, so deleting / evicting the cache from now
    // on cannot break this export; a vanished file simply means "render it"
    try {
      await fsp.link(hit.file, s.file).catch(() => fsp.copyFile(hit.file, s.file));
      s.reused = true;
      s.savedMs = Number(hit.manifest.renderMs) || 0;
      reusedFiles.push(hit.file);
      await touch(cdir, s.key, hit.file);
    } catch { /* gone meanwhile → render */ }
  }
  await onEvent('planned', { segments: segs });
  const todo = segs.filter((s) => !s.reused);
  const reused = segs.length - todo.length;
  const reusedFrames = segs.reduce((n, s) => n + (s.reused ? s.frames : 0), 0);
  const renderFrames = total - reusedFrames;
  log(`${segs.length} đoạn · tái sử dụng ${reused}/${segs.length} đoạn (${reusedFrames}/${total} khung) · cần render ${renderFrames} khung`);

  const tr0 = Date.now();
  if (todo.length) await renderSegments({ project, q, outFps, todo, encArgs, renderFrames, reused, nSegs: segs.length, prog, signal, onEvent });
  else prog(0.9, `Tái sử dụng ${segs.length}/${segs.length} đoạn từ cache`);
  const renderMs = Date.now() - tr0;
  const msPerFrame = renderFrames ? renderMs / renderFrames : 0;

  if (useCache) {
    for (const s of todo) {
      const extra = s.trace.shots.filter((i) => !s.deps.includes(i));
      if (extra.length) { log(`⚠ Đoạn khung ${s.f0}–${s.f1 - 1} đọc shot ngoài dự đoán (${extra.join(',')}) — không lưu cache`); continue; }
      await store(cdir, s.key, s.file, table, { frames: s.frames, renderMs: Math.round(s.frames * msPerFrame), assets: [...s.trace.assets].sort(), all: s.trace.all });
    }
  }

  let video = segs[0].file;
  if (segs.length > 1) {
    const list = path.join(workDir, 'concat.txt');
    await fsp.writeFile(list, segs.map((s) => `file '${path.basename(s.file)}'`).join('\n') + '\n');
    video = path.join(workDir, 'video.mp4');
    await run(FFMPEG, ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', video]);
  }
  const n = await countFrames(video);
  if (n !== total) throw Object.assign(new Error(`ghép được ${n} khung, cần ${total}`), { code: 'CONCAT_MISMATCH', reused: reusedFiles });
  const savedMs = segs.reduce((a, s) => a + (s.reused ? (s.savedMs || s.frames * msPerFrame) : 0), 0);
  return {
    video,
    stats: {
      segments: segs.length, reused, rendered: todo.length, frames: total, reusedFrames, renderedFrames: renderFrames,
      renderedSegments: todo.map((s) => ({ f0: s.f0, f1: s.f1, deps: s.deps })),
      renderSec: +(renderMs / 1000).toFixed(2), savedSec: +(savedMs / 1000).toFixed(1), cache: useCache,
    },
  };
}

/**
 * Render the frames of the missing segments with N parallel headless pages (frames are
 * deterministic), re-order them and stream each segment into its own ffmpeg.
 * Each segment gets s.trace = { shots, assets, all } (what the render page read).
 */
async function renderSegments({ project, q, outFps, todo, encArgs, renderFrames, reused, nSegs, prog, signal, onEvent }) {
  const items = [];
  for (const s of todo) {
    s.trace = { shots: [], assets: new Set(), all: false };
    for (let f = s.f0; f < s.f1; f++) items.push({ s, f, last: f === s.f1 - 1 });
  }
  const nWorkers = Math.max(1, Math.min(Number(process.env.RENDER_WORKERS) || Math.max(1, os.cpus().length - 1), 8, items.length));
  const pages = await Promise.all(Array.from({ length: nWorkers }, () => openRenderPage(project.id, { override: project, scale: q.scale })));
  const encs = [];
  const startEnc = (s) => {
    const ff = spawn(FFMPEG, ['-y', '-f', 'image2pipe', '-framerate', String(outFps), '-c:v', 'mjpeg', '-i', '-', ...encArgs, s.file], { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    ff.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
    const done = new Promise((res, rej) => {
      ff.on('error', rej);
      ff.on('close', (c) => (c === 0 ? res() : rej(new Error('ffmpeg: ' + err))));
    });
    done.catch(() => {}); // killed on cancel/error without awaiting — no unhandled rejection
    ff.stdin.on('error', () => {});
    const enc = { ff, done };
    encs.push(enc);
    return enc;
  };
  const write = (ff, buf) => new Promise((res, rej) => (ff.stdin.write(buf, (e) => (e ? rej(e) : res()))));
  const finished = [];
  try {
    const t0 = Date.now();
    const ready = new Map();
    let nextWrite = 0, nextFrame = 0, done = 0;
    let flushing = Promise.resolve();
    let failed = null; // writer/encoder error → workers stop instead of waiting forever
    const flush = () => (flushing = flushing.then(async () => {
      while (!failed && ready.has(nextWrite)) {
        const buf = ready.get(nextWrite);
        ready.delete(nextWrite);
        const it = items[nextWrite];
        it.s.enc ??= startEnc(it.s);
        await write(it.s.enc.ff, buf);
        if (it.last) {
          it.s.enc.ff.stdin.end();
          const seg = it.s;
          const p = seg.enc.done.then(async () => {
            const n = await countFrames(seg.file);
            if (n !== seg.frames) throw new Error(`đoạn khung ${seg.f0}–${seg.f1 - 1}: encode ra ${n}/${seg.frames} khung`);
            await onEvent('segment', { segment: seg });
          });
          p.catch((e) => { failed ||= e; });
          finished.push(p);
        }
        nextWrite++;
      }
    }).catch((e) => { failed ||= e; }));
    await Promise.all(pages.map(async ({ page }) => {
      for (;;) {
        if (signal?.aborted) throw new Error('Đã huỷ');
        if (failed) throw failed;
        // backpressure: don't run too far ahead of the writer
        while (nextFrame - nextWrite > nWorkers * 4) {
          if (failed) throw failed;
          if (signal?.aborted) throw new Error('Đã huỷ');
          await new Promise((r) => setTimeout(r, 15));
        }
        const k = nextFrame++;
        if (k >= items.length) return;
        const { s, f } = items[k];
        const r = await page.evaluate(([tt, mb]) => window.__frameInfo(tt, mb), [f / outFps, q.mb]);
        for (const i of r.shots) if (!s.trace.shots.includes(i)) s.trace.shots.push(i);
        for (const a of r.assets) s.trace.assets.add(a);
        if (r.all) s.trace.all = true;
        ready.set(k, Buffer.from(r.b64, 'base64'));
        flush();
        done++;
        if (done % 5 === 0 || done === items.length) {
          const el = (Date.now() - t0) / 1000;
          const eta = ((el / done) * (items.length - done)).toFixed(0);
          prog((done / renderFrames) * 0.9, `Khung ${done}/${renderFrames}${reused ? ` · tái sử dụng ${reused}/${nSegs} đoạn` : ''} · ${nWorkers} luồng · còn ~${eta}s`);
        }
      }
    }));
    await flush();
    await Promise.all(finished);
    if (failed) throw failed;
  } catch (e) {
    for (const { ff } of encs) { try { ff.stdin.end(); ff.kill('SIGKILL'); } catch { /* */ } }
    throw new Error(e.message + '\n' + pages.flatMap((p) => p.logs.slice(-3)).join('\n'));
  } finally {
    await Promise.all(pages.map((p) => p.close()));
  }
}

async function mixAudio(project, videoIn, outFile, duration) {
  const dir = projectDir(project.id);
  const assetFile = (id) => {
    const a = project.assets.find((x) => x.id === id);
    return a ? path.join(dir, 'assets', a.file) : null;
  };
  const inputs = [];
  const filters = [];
  const labels = [];
  const m = project.music;
  if (m && m.assetId && assetFile(m.assetId) && fs.existsSync(assetFile(m.assetId))) {
    inputs.push('-i', assetFile(m.assetId));
    const idx = inputs.filter((x) => x === '-i').length;
    const fi = m.fadeIn ?? 0.5, fo = m.fadeOut ?? 1.2;
    const off = m.offset ?? 0;
    filters.push(`[${idx}:a]atrim=start=${off},asetpts=PTS-STARTPTS,atrim=0:${duration},volume=${m.volume ?? 0.3},afade=t=in:st=0:d=${fi},afade=t=out:st=${Math.max(0, duration - fo)}:d=${fo}[mus]`);
    labels.push('[mus]');
  }
  for (const v of project.voice || []) {
    const f = v.assetId && assetFile(v.assetId);
    if (!f || !fs.existsSync(f)) continue;
    inputs.push('-i', f);
    const idx = inputs.filter((x) => x === '-i').length;
    const ms = Math.round((v.start || 0) * 1000);
    const lab = `[v${idx}]`;
    filters.push(`[${idx}:a]volume=${v.volume ?? 1},adelay=${ms}|${ms}${lab}`);
    labels.push(lab);
  }
  if (!labels.length) {
    await fsp.copyFile(videoIn, outFile);
    return;
  }
  // duck music under voice: simple sidechain if both exist
  let mixLabel;
  if (labels.length === 1) {
    mixLabel = labels[0];
  } else {
    filters.push(`${labels.join('')}amix=inputs=${labels.length}:normalize=0:dropout_transition=0[mix]`);
    mixLabel = '[mix]';
  }
  filters.push(`${mixLabel}alimiter=limit=0.95,apad,atrim=0:${duration}[aout]`);
  await run(FFMPEG, ['-y', '-i', videoIn, ...inputs, '-filter_complex', filters.join(';'), '-map', '0:v', '-map', '[aout]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', outFile]);
}

/** Scale of the inspection render (QA ms/frame thresholds are measured at this scale). */
export const INSPECT_SCALE = 0.5;

/**
 * Quick verification used by the AI director: renders a few frames per shot,
 * returns runtime errors, per-shot QA metrics (see public/render-page.js and
 * server/qa.js) and a contact-sheet JPEG (base64) of the cut.
 */
export async function inspectProject(project, { framesPerShot = 3, thumbWidth = 480 } = {}) {
  const { page, close, logs } = await openRenderPage(project.id, { override: project, scale: INSPECT_SCALE });
  try {
    // Wall clock for ms/frame is injected here, outside the engine (engine stays deterministic).
    await page.evaluate(() => { window.__profNow = () => performance.now(); });
    return await page.evaluate(([n, tw]) => window.__inspect(n, tw), [framesPerShot, thumbWidth]);
  } catch (e) {
    return { errors: { _page: e.message + '\n' + logs.slice(-5).join('\n') }, metrics: {}, sheet: null };
  } finally {
    await close();
  }
}
