// Golden-frame render tests (part of `npm run check`).
//
//   node scripts/golden.js            # compare against test/golden/expected/
//   node scripts/golden.js --update   # rewrite expected PNGs + perf baseline (intentional visual change)
//   node scripts/golden.js --only liquid,text
//
// Renders fixed frames of the self-contained fixtures in test/golden/fixtures/
// (project JSON + tiny synthetic assets, no data/ dependency) at low scale in
// headless Chromium, through the same render page/engine as the MP4 export.
//
// Rasterisation differs between Chromium builds and font setups, so the
// browser is pinned: the binary comes from the `@sparticuz/chromium`
// devDependency (exact version in package-lock.json) and fontconfig is pointed
// at the fonts bundled with it. Same binary locally and on CI → same pixels.
//
// Checks:
//   1. golden   — per-pixel threshold (max channel diff > GOLDEN_PIXEL_THRESHOLD)
//                 and max ratio of differing pixels (GOLDEN_MAX_RATIO); diff
//                 images go to test/golden/out/ (uploaded as a CI artifact).
//   2. determinism — every frame is rendered twice in two fresh pages (second
//                 one in reverse order) → must be bit-identical.
//   3. perf     — warm ms/frame per fixture, normalised by a fixed in-browser
//                 calibration workload, vs test/golden/expected/perf.json;
//                 > GOLDEN_PERF_TOLERANCE (30%) slower → FAIL with CI set, WARN locally.
//
// Exit code: 0 pass (warnings allowed), 1 fail, 2 setup error.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GDIR = path.join(ROOT, 'test/golden');
const FIX = path.join(GDIR, 'fixtures');
const EXP = path.join(GDIR, 'expected');
const OUT = path.join(GDIR, 'out');

const argv = process.argv.slice(2);
const UPDATE = argv.includes('--update');
const ONLY = (argv[argv.indexOf('--only') + 1] && argv.includes('--only')) ? argv[argv.indexOf('--only') + 1].split(',') : null;
const CI = !!process.env.CI;
const GH = !!process.env.GITHUB_ACTIONS;
const SCALE = Number(process.env.GOLDEN_SCALE || 0.25);
const PIX_T = Number(process.env.GOLDEN_PIXEL_THRESHOLD || 8);   // 0..255, max channel difference
const MAX_RATIO = Number(process.env.GOLDEN_MAX_RATIO || 0.001); // share of pixels allowed over PIX_T
const PERF_TOL = Number(process.env.GOLDEN_PERF_TOLERANCE || 0.3);
const PERF_RUNS = 3;

let failed = false;
const ok = (m) => console.log(`PASS  ${m}`);
const bad = (m) => { console.log(`FAIL  ${m}`); failed = true; if (GH) console.log(`::error::${m}`); };
const warn = (m) => { console.log(`WARN  ${m}`); if (GH) console.log(`::warning::${m}`); };
const info = (m) => console.log(`      ${m}`);

// ---------- pinned Chromium ----------
async function pinnedChrome() {
  if (process.env.CHROME_PATH) {
    warn(`dùng CHROME_PATH=${process.env.CHROME_PATH} thay cho @sparticuz/chromium — golden có thể lệch nếu khác phiên bản`);
    return process.env.CHROME_PATH;
  }
  if (process.platform !== 'linux' || process.arch !== 'x64') return null;
  const chromium = (await import('@sparticuz/chromium')).default;
  const exe = await chromium.executablePath();
  // fonts.conf bundled with the package → identical fallback fonts on every machine
  process.env.FONTCONFIG_PATH ??= path.join(os.tmpdir(), 'fonts');
  return exe;
}

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.unref();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

async function decode(buf) {
  const { data, info: i } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, w: i.width, h: i.height };
}

/** Compare two RGBA rasters. Returns { count, ratio, max, diffPng? }. */
async function compare(a, b, { image = false } = {}) {
  if (a.w !== b.w || a.h !== b.h) return { count: a.w * a.h, ratio: 1, max: 255, sizeMismatch: true };
  const n = a.w * a.h;
  let count = 0, exact = 0, max = 0;
  const vis = image ? Buffer.alloc(n * 3) : null;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const d = Math.max(Math.abs(a.data[o] - b.data[o]), Math.abs(a.data[o + 1] - b.data[o + 1]), Math.abs(a.data[o + 2] - b.data[o + 2]), Math.abs(a.data[o + 3] - b.data[o + 3]));
    if (d) exact++;
    if (d > max) max = d;
    if (d > PIX_T) count++;
    if (vis) {
      const g = Math.round((b.data[o] * 0.3 + b.data[o + 1] * 0.59 + b.data[o + 2] * 0.11) * 0.35);
      if (d > PIX_T) { vis[i * 3] = 255; vis[i * 3 + 1] = 0; vis[i * 3 + 2] = 0; }
      else if (d) { vis[i * 3] = 255; vis[i * 3 + 1] = 200; vis[i * 3 + 2] = g; }
      else { vis[i * 3] = g; vis[i * 3 + 1] = g; vis[i * 3 + 2] = g; }
    }
  }
  const r = { count, exact, ratio: count / n, max };
  if (vis) r.diffPng = await sharp(vis, { raw: { width: a.w, height: a.h, channels: 3 } }).png().toBuffer();
  return r;
}

const frameKey = (fx, f) => `${fx}@${f.t.toFixed(2)}${f.motionBlur > 1 ? `-mb${f.motionBlur}` : ''}`;

async function main() {
  const t00 = Date.now();
  const exe = await pinnedChrome();
  if (!exe) {
    const m = `golden cần Linux x64 (Chromium cố định từ @sparticuz/chromium); nền tảng ${process.platform}-${process.arch} — bỏ qua`;
    if (CI) { bad(m); return 1; }
    warn(m + ' (đặt CHROME_PATH để chạy thử, kết quả có thể lệch)');
    return 0;
  }
  process.env.CHROME_PATH = exe;
  // hinting from the system fontconfig would leak into text rasterisation
  process.env.CHROME_ARGS = [process.env.CHROME_ARGS, '--font-render-hinting=none'].filter(Boolean).join(' ');

  // ---------- fixtures → temp DATA_DIR ----------
  const fixtures = fs.readdirSync(FIX).filter((f) => f.endsWith('.json')).sort()
    .map((f) => ({ name: f.replace(/\.json$/, ''), project: JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8')) }))
    .filter((f) => !ONLY || ONLY.includes(f.name));
  if (!fixtures.length) { bad('không có fixture nào trong test/golden/fixtures/'); return 1; }
  const DD = await fsp.mkdtemp(path.join(os.tmpdir(), 'golden-'));
  for (const { project } of fixtures) {
    const pd = path.join(DD, 'projects', project.id);
    await fsp.mkdir(path.join(pd, 'assets'), { recursive: true });
    for (const a of project.assets || []) await fsp.copyFile(path.join(FIX, 'assets', a.file), path.join(pd, 'assets', a.file));
    await fsp.writeFile(path.join(pd, 'project.json'), JSON.stringify(project));
  }

  // ---------- temporary server ----------
  const port = await freePort();
  process.env.PORT = String(port);
  const logFile = path.join(DD, 'server.log');
  const log = fs.openSync(logFile, 'w');
  const srv = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], {
    env: { ...process.env, PORT: String(port), DATA_DIR: DD, APP_PASSWORD: '' },
    stdio: ['ignore', log, log],
  });
  const stopServer = () => { if (srv.exitCode === null) srv.kill('SIGTERM'); };
  process.on('exit', stopServer);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopServer(); process.exit(2); });

  let browser = null;
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      try { up = (await fetch(`http://127.0.0.1:${port}/engine/engine.js`)).ok; } catch { await new Promise((r) => setTimeout(r, 250)); }
    }
    if (!up) { bad('server tạm không khởi động'); console.log(fs.readFileSync(logFile, 'utf8')); return 2; }

    const { openRenderPage, getBrowser } = await import('../server/render.js');
    browser = await getBrowser();
    const version = browser.version();
    info(`Chromium ${version} · scale ${SCALE} · ngưỡng ${PIX_T}/255, tối đa ${(MAX_RATIO * 100).toFixed(2)}% pixel lệch`);

    const meta = fs.existsSync(path.join(EXP, 'meta.json')) ? JSON.parse(fs.readFileSync(path.join(EXP, 'meta.json'), 'utf8')) : null;
    if (!UPDATE && meta && meta.chromium !== version) {
      const m = `golden sinh bằng Chromium ${meta.chromium}, đang chạy ${version} — chạy \`node scripts/golden.js --update\` nếu nâng @sparticuz/chromium có chủ đích`;
      if (CI) bad(m); else warn(m);
    }

    // a fixed CPU/canvas workload, used to normalise ms/frame across machines
    const calibrate = (page) => page.evaluate(() => {
      const c = document.createElement('canvas'); c.width = 480; c.height = 270;
      const x = c.getContext('2d');
      const t0 = performance.now();
      let acc = 0;
      for (let k = 0; k < 12; k++) {
        const g = x.createRadialGradient(240, 135, 10, 240, 135, 260);
        g.addColorStop(0, `rgb(${k * 20},80,160)`); g.addColorStop(1, '#000');
        x.fillStyle = g; x.fillRect(0, 0, 480, 270);
        x.filter = 'blur(6px)'; x.drawImage(c, 0, 0); x.filter = 'none';
        for (let i = 0; i < 150000; i++) acc += Math.sin(i * 0.001 + k) * Math.sqrt(i);
        acc += x.getImageData(k, k, 1, 1).data[0];
      }
      return performance.now() - t0 + (acc === 42 ? 1 : 0);
    });

    const renderAll = async (fx, frames, { perf = false } = {}) => {
      const pg = await openRenderPage(fx.project.id, { override: fx.project, scale: SCALE });
      try {
        const pngs = new Map(), ms = [];
        for (const f of frames) {
          const b64 = await pg.page.evaluate(([t, mb]) => window.__frame(t, mb, 'png'), [f.t, f.motionBlur || 1]);
          pngs.set(frameKey(fx.name, f), Buffer.from(b64, 'base64'));
        }
        if (perf) {
          for (const f of frames) {
            let best = Infinity;
            for (let r = 0; r < PERF_RUNS; r++) {
              // mean over enough repeats to fill >= 80 ms (cheap frames are ~1 ms), best of PERF_RUNS
              best = Math.min(best, await pg.page.evaluate(([t, mb]) => {
                const t0 = performance.now();
                let n = 0, el = 0;
                do {
                  window.__engine.renderFrame(t, { motionBlur: mb });
                  window.__engine.out.getContext('2d').getImageData(0, 0, 1, 1); // flush raster work
                  n++; el = performance.now() - t0;
                } while (el < 80 && n < 200);
                return el / n;
              }, [f.t, f.motionBlur || 1]));
            }
            ms.push(best);
          }
        }
        const errs = pg.logs.filter((l) => /\[(error|pageerror)\]/.test(l));
        const engineErrs = await pg.page.evaluate(() => [...window.__engine.errors.entries()].map(([k, v]) => `${k}: ${v}`));
        return { pngs, ms, errors: [...errs, ...engineErrs], calib: perf ? Math.min(await calibrate(pg.page), await calibrate(pg.page), await calibrate(pg.page)) : 0 };
      } finally { await pg.close(); }
    };

    await fsp.rm(OUT, { recursive: true, force: true });
    await fsp.mkdir(OUT, { recursive: true });
    if (UPDATE) await fsp.mkdir(EXP, { recursive: true });
    const perfNow = { chromium: version, scale: SCALE, calibMs: 0, fixtures: {} };
    const calibs = [];
    let nFrames = 0;
    const orderDep = [];
    let worst = { key: '-', exact: 0, max: 0 };

    for (const fx of fixtures) {
      const frames = fx.project.golden?.frames || [{ t: 0.5 }];
      const t0 = Date.now();
      const A = await renderAll(fx, frames, { perf: true });
      // B: fresh page, same sequence → must be bit-identical (FAIL otherwise).
      // C: fresh page, reverse order → cache/scrub independence (WARN only: parallel
      //    export workers render interleaved frames, so this should hold too).
      const B = await renderAll(fx, frames);
      const C = frames.length > 1 ? await renderAll(fx, [...frames].reverse()) : B;
      nFrames += frames.length;
      if (A.errors.length) bad(`${fx.name}: lỗi runtime khi render — ${A.errors.slice(0, 3).join(' | ')}`);
      calibs.push(A.calib);
      const msPerFrame = A.ms.reduce((s, x) => s + x, 0) / A.ms.length;
      perfNow.fixtures[fx.name] = { msPerFrame: +msPerFrame.toFixed(2), norm: +(msPerFrame / A.calib).toFixed(4) };

      for (const f of frames) {
        const key = frameKey(fx.name, f);
        const a = await decode(A.pngs.get(key)), b = await decode(B.pngs.get(key));
        const det = await compare(a, b);
        if (det.exact) {
          bad(`${key}: không tất định — 2 lần render lệch ${det.exact} pixel (max ${det.max})`);
          await fsp.writeFile(path.join(OUT, `${key}.nondeterministic-a.png`), A.pngs.get(key));
          await fsp.writeFile(path.join(OUT, `${key}.nondeterministic-b.png`), B.pngs.get(key));
        }
        const ord = await compare(a, await decode(C.pngs.get(key)));
        if (ord.exact) {
          orderDep.push(`${key} (${ord.exact} px, max Δ${ord.max})`);
          await fsp.writeFile(path.join(OUT, `${key}.order-reverse.png`), C.pngs.get(key));
        }
        const expFile = path.join(EXP, `${key}.png`);
        if (UPDATE) { await fsp.writeFile(expFile, A.pngs.get(key)); continue; }
        if (!fs.existsSync(expFile)) { bad(`${key}: thiếu ảnh golden ${path.relative(ROOT, expFile)} — chạy --update`); await fsp.writeFile(path.join(OUT, `${key}.actual.png`), A.pngs.get(key)); continue; }
        const e = await decode(await fsp.readFile(expFile));
        const c = await compare(a, e, { image: true });
        if (c.exact > worst.exact) worst = { key, exact: c.exact, max: c.max };
        if (c.sizeMismatch) bad(`${key}: kích thước ${a.w}×${a.h} ≠ golden ${e.w}×${e.h}`);
        else if (c.ratio > MAX_RATIO) bad(`${key}: lệch golden ${(c.ratio * 100).toFixed(3)}% pixel (> ${(MAX_RATIO * 100).toFixed(2)}%, max Δ ${c.max}) → test/golden/out/${key}.diff.png`);
        else if (c.exact) info(`${key}: lệch nhỏ trong ngưỡng (${c.exact} pixel, max Δ ${c.max})`);
        if (c.ratio > MAX_RATIO || c.sizeMismatch || c.exact) {
          await fsp.writeFile(path.join(OUT, `${key}.actual.png`), A.pngs.get(key));
          await fsp.copyFile(expFile, path.join(OUT, `${key}.expected.png`));
          if (c.diffPng) await fsp.writeFile(path.join(OUT, `${key}.diff.png`), c.diffPng);
        }
      }
      info(`${fx.name}: ${frames.length} khung · ${msPerFrame.toFixed(1)} ms/khung (ấm) · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }
    perfNow.calibMs = +Math.min(...calibs).toFixed(1);

    // ---------- results ----------
    const perfFile = path.join(EXP, 'perf.json');
    if (UPDATE) {
      await fsp.writeFile(perfFile, JSON.stringify(perfNow, null, 2) + '\n');
      await fsp.writeFile(path.join(EXP, 'meta.json'), JSON.stringify({ chromium: version, scale: SCALE, note: 'sinh bởi node scripts/golden.js --update' }, null, 2) + '\n');
      ok(`golden đã cập nhật: ${nFrames} khung → test/golden/expected/ (Chromium ${version})`);
    } else {
      if (!fs.readdirSync(OUT).some((f) => f.endsWith('.diff.png') || f.includes('nondeterministic') || f.endsWith('.actual.png'))) ok(`golden-frame ${nFrames} khung khớp (${fixtures.map((f) => f.name).join(', ')})`);
    }
    if (!fs.readdirSync(OUT).some((f) => f.includes('nondeterministic'))) ok(`tất định: render 2 lần → sai khác 0 (${nFrames} khung)`);
    if (orderDep.length) warn(`kết quả phụ thuộc thứ tự render (cache mô phỏng khi tua ngược): ${orderDep.join(', ')}`);

    if (!UPDATE) {
      const base = fs.existsSync(perfFile) ? JSON.parse(fs.readFileSync(perfFile, 'utf8')) : null;
      if (!base) warn('chưa có test/golden/expected/perf.json — chạy --update để tạo baseline hiệu năng');
      else {
        const slow = [];
        for (const [name, cur] of Object.entries(perfNow.fixtures)) {
          const b = base.fixtures?.[name];
          if (!b) continue;
          const r = cur.norm / b.norm;
          info(`perf ${name}: ${cur.msPerFrame} ms/khung (baseline ${b.msPerFrame}) · chuẩn hoá ×${r.toFixed(2)}`);
          if (r > 1 + PERF_TOL && cur.msPerFrame - b.msPerFrame > 1) slow.push(`${name} ×${r.toFixed(2)}`);
        }
        info(`calib ${perfNow.calibMs} ms (baseline ${base.calibMs} ms)`);
        if (slow.length) {
          const m = `hiệu năng tụt > ${Math.round(PERF_TOL * 100)}% so với baseline: ${slow.join(', ')}`;
          if (CI) bad(m); else warn(m + ' (chỉ cảnh báo khi chạy local)');
        } else ok(`hiệu năng trong ±${Math.round(PERF_TOL * 100)}% baseline`);
      }
    }
    const total = `golden tổng ${((Date.now() - t00) / 1000).toFixed(1)}s`;
    info(total);
    // one-line summary as a CI annotation (readable from the PR without opening logs)
    if (GH && !UPDATE) {
      const perf = Object.entries(perfNow.fixtures).map(([n, f]) => `${n} ${f.msPerFrame}ms`).join(', ');
      console.log(`::notice title=golden-frame::${total} · Chromium ${version} · ${nFrames} khung · lệch golden lớn nhất ${worst.exact} px (Δ${worst.max}, ${worst.key}) · ${perf} · calib ${perfNow.calibMs}ms`);
    }
    return failed ? 1 : 0;
  } finally {
    if (browser) await browser.close().catch(() => {});
    stopServer();
    fs.closeSync(log);
    await fsp.rm(DD, { recursive: true, force: true }).catch(() => {});
  }
}

main().then((code) => process.exit(code), (e) => { bad(`golden lỗi: ${e.stack || e.message}`); process.exit(2); });
