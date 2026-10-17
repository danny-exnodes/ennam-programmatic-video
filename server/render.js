// Export pipeline: headless Chromium runs the SAME engine as the editor,
// steps frames deterministically, streams JPEG frames into ffmpeg, then
// mixes music + voice-over and muxes the final MP4.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { chromium } from 'playwright-core';
import { FFMPEG, run } from './media.js';
import { projectDir } from './store.js';

let browserP = null;

function findChrome() {
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
      args: ['--disable-web-security', '--autoplay-policy=no-user-gesture-required', ...(process.env.RENDER_GPU ? ['--use-gl=angle', '--enable-gpu-rasterization'] : ['--disable-gpu', '--disable-accelerated-2d-canvas', '--disable-gpu-compositing'])],
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
    httpCredentials: process.env.APP_PASSWORD ? { username: 'team', password: process.env.APP_PASSWORD } : undefined,
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
 * Render a project to MP4.
 * opts: quality ('draft'|'standard'|'high'), onProgress(k, msg), signal
 */
export async function renderProject(project, opts = {}) {
  const q = { draft: { mb: 1, crf: 23, preset: 'veryfast', scale: 0.5 }, standard: { mb: 3, crf: 18, preset: 'medium', scale: 1 }, high: { mb: 6, crf: 15, preset: 'slow', scale: 1 } }[opts.quality || 'standard'];
  if (opts.motionBlur) q.mb = opts.motionBlur;
  const fps = project.fps || 30;
  const duration = project.shots.reduce((s, x) => s + x.duration, 0);
  const total = Math.max(1, Math.round(duration * fps));
  const dir = projectDir(project.id);
  const slug = project.name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'video';
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/^(\d{8})(\d{4})$/, '$1-$2');
  const outName = `${slug}-${stamp}${opts.quality === 'draft' ? '-nhap' : ''}.mp4`;
  const videoTmp = path.join(dir, 'exports', `.tmp-${Date.now()}-v.mp4`);
  const outFile = path.join(dir, 'exports', outName);
  const prog = opts.onProgress || (() => {});

  // Frames are deterministic, so several headless pages render in parallel
  // and frames are re-ordered before going into ffmpeg.
  const nWorkers = Math.max(1, Math.min(Number(process.env.RENDER_WORKERS) || Math.max(1, os.cpus().length - 1), 8, total));
  const pages = await Promise.all(Array.from({ length: nWorkers }, () => openRenderPage(project.id, { override: project, scale: q.scale })));
  const ff = spawn(FFMPEG, [
    '-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', String(q.crf), '-preset', q.preset,
    ...(q.scale !== 1 ? ['-vf', `scale=${project.width}:${project.height}:flags=bicubic`] : []),
    '-movflags', '+faststart', videoTmp,
  ], { stdio: ['pipe', 'ignore', 'pipe'] });
  let ffErr = '';
  ff.stderr.on('data', (d) => (ffErr = (ffErr + d).slice(-4000)));
  const ffDone = new Promise((res, rej) => ff.on('close', (c) => (c === 0 ? res() : rej(new Error('ffmpeg: ' + ffErr)))));
  ff.stdin.on('error', () => {});
  const write = (buf) => new Promise((res, rej) => (ff.stdin.write(buf, (e) => (e ? rej(e) : res()))));
  try {
    const t0 = Date.now();
    const ready = new Map();
    let nextWrite = 0, nextFrame = 0, done = 0;
    let flushing = Promise.resolve();
    const flush = () => (flushing = flushing.then(async () => {
      while (ready.has(nextWrite)) {
        const buf = ready.get(nextWrite);
        ready.delete(nextWrite);
        await write(buf);
        nextWrite++;
      }
    }));
    await Promise.all(pages.map(async ({ page }) => {
      for (;;) {
        if (opts.signal?.aborted) throw new Error('Đã huỷ');
        // backpressure: don't run too far ahead of the writer
        while (nextFrame - nextWrite > nWorkers * 4) await new Promise((r) => setTimeout(r, 15));
        const f = nextFrame++;
        if (f >= total) return;
        const b64 = await page.evaluate(([tt, mb]) => window.__frame(tt, mb), [f / fps, q.mb]);
        ready.set(f, Buffer.from(b64, 'base64'));
        flush();
        done++;
        if (done % 5 === 0 || done === total) {
          const el = (Date.now() - t0) / 1000;
          const eta = ((el / done) * (total - done)).toFixed(0);
          prog((done / total) * 0.9, `Khung ${done}/${total} · ${nWorkers} luồng · còn ~${eta}s`);
        }
      }
    }));
    await flush();
    ff.stdin.end();
    await ffDone;
  } catch (e) {
    try { ff.stdin.end(); ff.kill('SIGKILL'); } catch { /* */ }
    await fsp.rm(videoTmp, { force: true });
    throw new Error(e.message + '\n' + pages.flatMap((p) => p.logs.slice(-3)).join('\n'));
  } finally {
    await Promise.all(pages.map((p) => p.close()));
  }

  prog(0.93, 'Trộn âm thanh');
  await mixAudio(project, videoTmp, outFile, duration);
  await fsp.rm(videoTmp, { force: true });
  prog(1, 'Xong');
  return { file: outName, duration, createdAt: new Date().toISOString(), quality: opts.quality || 'standard' };
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

/**
 * Quick verification used by the AI director: renders a few frames per shot,
 * returns runtime errors and a contact-sheet JPEG (base64) of the cut.
 */
export async function inspectProject(project, { framesPerShot = 3, thumbWidth = 480 } = {}) {
  const { page, close, logs } = await openRenderPage(project.id, { override: project, scale: 0.5 });
  try {
    return await page.evaluate(([n, tw]) => window.__inspect(n, tw), [framesPerShot, thumbWidth]);
  } catch (e) {
    return { errors: { _page: e.message + '\n' + logs.slice(-5).join('\n') }, sheet: null };
  } finally {
    await close();
  }
}
