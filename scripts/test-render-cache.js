// Per-segment render cache (#29) — part of `npm run check`.
//
//   node scripts/test-render-cache.js
//
// Renders a tiny fixture project (320×180, 10 fps, 4 shots with dissolve / cut / push,
// motion blur 3 → samples cross every cut) through server/render.js with the pinned
// Chromium (scripts/lib/test-env.js) + ffmpeg, in a temporary DATA_DIR + server:
//   1. identical — after a field change in one shot, the export built from cached
//      segments + concat is compared frame by frame (decoded with ffmpeg) with a full
//      render without cache, using the golden threshold method (incl. transition
//      frames); and every frame matches the lossless page frame at the same t (PSNR) →
//      no frame shifted/dropped at segment joins.
//   2. invalidation — changing each input type (code, field, asset content, style, fps)
//      re-renders exactly the segments that depend on it (job stats), the rest is
//      reused; an unrelated asset / unchanged project re-renders nothing. Brand Kit: assigning a
//      kit, changing kit color / font, the CONTENT of the kit font file or logo → every segment. The render
//      page trace of every rendered segment equals its predicted shot set.
//   3. robustness — the cache folder deleted mid-export → export still succeeds.
//   4. LRU cap (RENDER_CACHE_MAX_MB) + "Xoá cache" endpoint + "Xem nhanh" job over HTTP
//      (preview folder, not in exports, job log reports reuse).
// Exit 0 pass, 1 fail, 2 setup error. Non-Linux-x64 without CHROME_PATH: skipped (like golden).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { pinnedChrome, usePinnedChrome, startTempServer, ROOT as ROOT_DIR } from './lib/test-env.js';

const CI = !!process.env.CI;
const GH = !!process.env.GITHUB_ACTIONS;
const PIX_T = Number(process.env.GOLDEN_PIXEL_THRESHOLD || 8);
const MAX_RATIO = Number(process.env.GOLDEN_MAX_RATIO || 0.001);
const MIN_PSNR = 30; // decoded export vs lossless page frame (JPEG + x264 crf 18 ≈ 38–45 dB)

let failed = false;
const ok = (m) => console.log(`PASS  ${m}`);
const bad = (m) => { console.log(`FAIL  ${m}`); failed = true; if (GH) console.log(`::error::${m}`); };
const info = (m) => console.log(`      ${m}`);
const check = (cond, m, detail = '') => (cond ? ok(m) : bad(m + (detail ? ` — ${detail}` : '')));

const W = 320, H = 180;
const moving = (label, hue) => `const { W, H } = s;
s.background(['hsl(${hue},45%,22%)', 'hsl(${hue + 30},50%,8%)']);
const x = s.lerp(W * 0.15, W * 0.85, s.p);
s.ctx.fillStyle = 'hsl(${hue + 180},80%,60%)';
s.ctx.beginPath(); s.ctx.arc(x, H * 0.5 + Math.sin(s.t * 6) * 30, 22, 0, s.TAU); s.ctx.fill();
s.ctx.fillStyle = '#fff'; s.ctx.font = '700 22px sans-serif'; s.ctx.fillText(${JSON.stringify(label)}, 14, 30);`;

function fixture() {
  return {
    id: 'prc', name: 'render cache fixture', width: W, height: H, fps: 10,
    style: { grade: 'warm', vignette: 0.2, grain: 0.04, bloom: 0, letterbox: 0, palette: { primary: '#f08a12', accent: '#f5b54a', text: '#ffffff' } },
    assets: [
      { id: 'a1', name: 'logo', type: 'image', file: 'a1.png' },
      { id: 'a2', name: 'unused', type: 'image', file: 'a2.png' },
    ],
    voice: [], music: null, exports: [],
    shots: [
      { id: 's0', name: 'Mở', duration: 1.0, transition: { type: 'cut' }, fields: {}, code: moving('Mở', 20) },
      { id: 's1', name: 'Logo', duration: 0.8, transition: { type: 'dissolve', duration: 0.3 }, fields: {},
        code: moving('Logo', 120) + "\ns.image('logo', { x: W * 0.75, y: H * 0.6, w: 60, h: 60, rotate: s.t });" },
      { id: 's2', name: 'Chữ', duration: 1.0, transition: { type: 'cut' }, fields: {},
        code: moving('', 220) + "\ns.text(s.field('title', 'Xin chào'), { x: W / 2, y: H * 0.8, size: 26, align: 'center' });" },
      { id: 's3', name: 'Kết', duration: 0.7, transition: { type: 'push', duration: 0.3 }, fields: {}, code: moving('Kết', 300) },
    ],
  };
}

const png = (r, g, b) => sharp({ create: { width: 64, height: 64, channels: 4, background: { r, g, b, alpha: 1 } } }).png().toBuffer();

function decodeVideo(file) {
  return new Promise((res, rej) => {
    const p = spawn('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    const chunks = [];
    let err = '';
    p.stdout.on('data', (d) => chunks.push(d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (c) => {
      if (c) return rej(new Error('ffmpeg decode: ' + err));
      const buf = Buffer.concat(chunks), n = W * H * 3;
      const frames = [];
      for (let o = 0; o + n <= buf.length; o += n) frames.push(buf.subarray(o, o + n));
      res(frames);
    });
  });
}

/** golden method: share of pixels whose max channel diff > PIX_T; plus max diff and PSNR. */
function compare(a, b) {
  let over = 0, max = 0, se = 0;
  const n = a.length / 3;
  for (let i = 0; i < n; i++) {
    let d = 0;
    for (let c = 0; c < 3; c++) {
      const x = Math.abs(a[i * 3 + c] - b[i * 3 + c]);
      se += x * x;
      if (x > d) d = x;
    }
    if (d > max) max = d;
    if (d > PIX_T) over++;
  }
  const mse = se / a.length;
  return { ratio: over / n, max, psnr: mse ? 10 * Math.log10((255 * 255) / mse) : Infinity };
}

async function main() {
  const exe = await pinnedChrome({ onWarn: (m) => info(m) });
  if (!exe) {
    const m = `test-render-cache cần Linux x64 (Chromium cố định) — nền tảng ${process.platform}-${process.arch}, bỏ qua`;
    if (CI) { bad(m); return 1; }
    console.log(`WARN  ${m}`);
    return 0;
  }
  if (spawnSync('ffmpeg', ['-version']).status !== 0) { bad('không tìm thấy ffmpeg trong PATH'); return 2; }
  usePinnedChrome(exe);
  process.env.RENDER_WORKERS ||= '2';
  delete process.env.RENDER_CACHE_MAX_MB;

  const DD = await fsp.mkdtemp(path.join(os.tmpdir(), 'rcache-'));
  process.env.DATA_DIR = DD; // before importing server modules (store.js reads it at import)
  const project = fixture();
  const pdir = path.join(DD, 'projects', project.id);
  await fsp.mkdir(path.join(pdir, 'assets'), { recursive: true });
  await fsp.mkdir(path.join(pdir, 'exports'), { recursive: true });
  await fsp.writeFile(path.join(pdir, 'assets/a1.png'), await png(240, 40, 40));
  await fsp.writeFile(path.join(pdir, 'assets/a2.png'), await png(40, 40, 240));
  await fsp.writeFile(path.join(pdir, 'project.json'), JSON.stringify(project));

  const srv = await startTempServer(DD);
  let browser = null;
  const t00 = Date.now();
  try {
    if (srv.error) { bad(srv.error); console.log(srv.log()); return 2; }
    const { renderProject, openRenderPage, getBrowser } = await import('../server/render.js');
    const { cacheDir, cacheStats, enforceCap } = await import('../server/render-cache.js');
    browser = await getBrowser();
    const cdir = cacheDir(project.id);
    const exportPath = (r) => path.join(pdir, r.preview ? 'preview' : 'exports', r.file);

    let mismatchedTrace = [];
    const render = async (p, extra = {}) => {
      const logs = [];
      const r = await renderProject(p, {
        quality: 'standard', log: (l) => logs.push(l), ...extra,
        onEvent: async (name, d) => {
          if (name === 'segment') {
            const tr = [...d.segment.trace.shots].sort((a, b) => a - b).join(',');
            if (tr !== d.segment.deps.join(',')) mismatchedTrace.push(`khung ${d.segment.f0}–${d.segment.f1 - 1}: trace [${tr}] ≠ dự đoán [${d.segment.deps}]`);
          }
          await extra.onEvent?.(name, d);
        },
      });
      r.logs = logs;
      return r;
    };
    /** segments (of the plan in r) that depend on shot k */
    const depOn = (r, pred) => r.cache.renderedSegments.filter((s) => pred(s.deps));

    // ---------- 1. cached + concat == full render ----------
    let P = structuredClone(project);
    const r0 = await render(P);
    info(`lần đầu: ${r0.cache.segments} đoạn, ${r0.cache.frames} khung, render ${r0.cache.renderSec}s`);
    check(r0.cache.reused === 0 && r0.cache.rendered === r0.cache.segments, 'cache trống → render mọi đoạn');
    const plan = r0.cache.renderedSegments;
    check(plan.some((s) => s.deps.join() === '0,1') && plan.some((s) => s.deps.join() === '2,3') && plan.some((s) => s.deps.join() === '1,2'),
      'chia đoạn: vùng chuyển cảnh (dissolve, push) và mẫu motion blur qua cắt thẳng là đoạn riêng của 2 shot kề',
      plan.map((s) => `${s.f0}-${s.f1 - 1}:[${s.deps}]`).join(' '));

    P.shots[2].fields.title = 'Tạm biệt';
    const r1 = await render(P);
    const touches2 = plan.filter((s) => s.deps.includes(2)).length;
    check(r1.cache.rendered === touches2 && r1.cache.reused === r1.cache.segments - touches2 && depOn(r1, (d) => d.includes(2)).length === r1.cache.rendered,
      `sửa field shot 3 → chỉ render lại ${touches2}/${r1.cache.segments} đoạn có shot 3`, JSON.stringify(r1.cache.renderedSegments));
    check(r1.logs.some((l) => /tái sử dụng \d+\/\d+ đoạn/.test(l)), 'log job báo "tái sử dụng X/Y đoạn"');
    const rFull = await render(P, { cache: false });
    check(rFull.cache.reused === 0 && !rFull.cache.cache, 'render đầy đủ không dùng cache (đối chứng)');
    const A = await decodeVideo(exportPath(r1)), B = await decodeVideo(exportPath(rFull));
    const total = Math.round(3.5 * 10);
    check(A.length === total && B.length === total, `số khung giải mã = ${total} (cache ${A.length}, đầy đủ ${B.length})`);
    let worst = { ratio: 0, max: 0, f: -1 }, exact = 0;
    for (let f = 0; f < Math.min(A.length, B.length); f++) {
      const c = compare(A[f], B[f]);
      if (c.max === 0) exact++;
      if (c.ratio > worst.ratio || (c.ratio === worst.ratio && c.max > worst.max)) worst = { ...c, f };
    }
    check(worst.ratio <= MAX_RATIO, `bản ghép từ cache khớp bản render đầy đủ theo ngưỡng golden (${exact}/${A.length} khung giống hệt, lệch lớn nhất ${(worst.ratio * 100).toFixed(3)}% px, Δmax ${worst.max})`);
    // vs lossless page frames: every frame at its own t (no shift/drop at joins, transitions included)
    const pg = await openRenderPage(P.id, { override: P, scale: 1 });
    let minPsnr = Infinity, minF = -1, shifted = 0;
    try {
      const ref = [];
      for (let f = 0; f < total; f++) {
        const b64 = await pg.page.evaluate(([t]) => window.__frame(t, 3, 'png'), [f / 10]);
        ref.push(await sharp(Buffer.from(b64, 'base64')).removeAlpha().raw().toBuffer());
      }
      for (let f = 0; f < total; f++) {
        const c = compare(A[f], ref[f]);
        if (c.psnr < minPsnr) { minPsnr = c.psnr; minF = f; }
        // a neighbour frame must not match better than the frame itself
        for (const g of [f - 1, f + 1]) if (g >= 0 && g < total && compare(A[f], ref[g]).psnr > c.psnr + 0.5) shifted++;
      }
    } finally { await pg.close(); }
    check(minPsnr >= MIN_PSNR && shifted === 0, `mọi khung của bản ghép khớp khung gốc cùng thời điểm (PSNR thấp nhất ${minPsnr.toFixed(1)} dB ở khung ${minF}, lệch khung: ${shifted})`);

    // ---------- 2. invalidation per input type ----------
    const expectOnly = async (label, mutate, pred) => {
      const before = await render(P); // settle: everything cached for current P
      if (before.cache.rendered) info(`(${label}: ${before.cache.rendered} đoạn chưa có trong cache trước khi đổi)`);
      await mutate();
      const r = await render(P);
      const segs = r.cache.segments;
      const wrong = r.cache.renderedSegments.filter((s) => !pred(s.deps));
      const missing = pred === ALL ? segs - r.cache.rendered : 0;
      const n = pred === ALL ? segs : planOf(r0).filter((s) => pred(s.deps)).length;
      check(!wrong.length && !missing && r.cache.rendered === n && r.cache.reused === segs - n,
        `${label} → render lại ${r.cache.rendered}/${segs} đoạn, tái sử dụng ${r.cache.reused}`, `mong đợi ${n}; thừa: ${JSON.stringify(wrong)}`);
      return r;
    };
    const ALL = () => true;
    const planOf = (r) => r.cache.renderedSegments; // r0 rendered every segment = full plan at 10 fps
    await expectOnly('đổi code shot 1', () => { P.shots[0].code = P.shots[0].code.replace('22, 0, s.TAU', '26, 0, s.TAU'); }, (d) => d.includes(0));
    await expectOnly('đổi field shot 3', () => { P.shots[2].fields.title = 'Hẹn gặp lại'; }, (d) => d.includes(2));
    await expectOnly('đổi nội dung chất liệu "logo" (chỉ shot 2 dùng)', async () => { await fsp.writeFile(path.join(pdir, 'assets/a1.png'), await png(40, 200, 60)); }, (d) => d.includes(1));
    await expectOnly('đổi chất liệu không shot nào dùng', async () => { await fsp.writeFile(path.join(pdir, 'assets/a2.png'), await png(90, 90, 90)); }, () => false);
    await expectOnly('đổi chuyển cảnh shot 4 (push → wipe)', () => { P.shots[3].transition = { type: 'wipe', duration: 0.3 }; }, (d) => d.includes(3));
    await expectOnly('đổi ghi chú shot (engine không đọc)', () => { P.shots[1].notes = 'ghi chú mới'; }, () => false);
    await expectOnly('đổi style (grade)', () => { P.style.grade = 'cool'; }, ALL);
    await expectOnly('đổi bảng màu', () => { P.style.palette.text = '#ffe0a0'; }, ALL);
    {
      await render(P);
      P.fps = 12;
      const r = await render(P);
      check(r.cache.reused === 0 && r.cache.frames === Math.round(3.5 * 12), `đổi fps 10 → 12 → render lại mọi đoạn (${r.cache.rendered}/${r.cache.segments}), ${r.cache.frames} khung`);
      P.fps = 10;
    }
    // Brand Kit (#8): kit snapshot + uploaded font (FontFace, not read through the asset map) + logo
    {
      const FD = path.join(ROOT_DIR, 'node_modules/@fontsource/playfair-display/files');
      await fsp.copyFile(path.join(FD, 'playfair-display-vietnamese-400-normal.woff2'), path.join(pdir, 'assets/brand-f1.woff2'));
      await fsp.writeFile(path.join(pdir, 'assets/brand-logo1.png'), await png(250, 250, 250));
      await expectOnly('gán Brand Kit (màu, font tải lên, logo)', () => {
        P.brand = { id: 'b1', version: 1, locked: false, kit: {
          name: 'Kit thử', palette: [{ role: 'primary', color: '#ff0066' }, { role: 'accent', color: '#00ccff' }, { role: 'text', color: '#ffffff' }],
          fonts: { heading: 'sans', body: 'sans' }, fontFiles: [{ id: 'f1', file: 'brand-f1.woff2', family: 'EmsKitF1', name: 'Kit font' }],
          logo: { file: 'brand-logo1.png', width: 64, height: 64 },
        } };
      }, ALL);
      await expectOnly('đổi màu kit (text)', () => { P.brand.kit.palette[2].color = '#ffe08a'; P.brand.version = 2; }, ALL);
      await expectOnly('đổi font kit (body → font tải lên)', () => { P.brand.kit.fonts.body = 'f1'; P.brand.version = 3; }, ALL);
      await expectOnly('đổi NỘI DUNG file font kit (cùng tên, cùng snapshot)', async () => {
        await fsp.copyFile(path.join(FD, 'playfair-display-vietnamese-700-normal.woff2'), path.join(pdir, 'assets/brand-f1.woff2'));
      }, ALL);
      await expectOnly('đổi NỘI DUNG file logo kit', async () => { await fsp.writeFile(path.join(pdir, 'assets/brand-logo1.png'), await png(10, 10, 10)); }, ALL);
      await expectOnly('khoá kit (engine không đọc locked)', () => { P.brand.locked = true; }, () => false);
      delete P.brand;
    }
    check(!mismatchedTrace.length, 'trace của trang render (shot thực sự chạy) = tập shot dự đoán cho mọi đoạn', mismatchedTrace.slice(0, 3).join(' | '));

    // ---------- 3. cache folder deleted mid-export ----------
    {
      await render(P); // fully cached
      P.shots[0].fields.x = 1; // invalidates shot-1 segments only (field unused but part of the key)
      let deletions = 0;
      const del = async () => { await fsp.rm(cdir, { recursive: true, force: true }); deletions++; };
      let r, err = null;
      try {
        r = await render(P, { onEvent: async (name) => { if (name === 'planned' || (name === 'segment' && deletions < 2)) await del(); } });
      } catch (e) { err = e; }
      check(!err && r && r.cache.reused > 0 && fs.existsSync(exportPath(r)) && (await decodeVideo(exportPath(r))).length === total,
        `xoá thư mục cache giữa lúc xuất (${deletions} lần) → vẫn xuất đủ ${total} khung`, err?.message);
      const r2 = await render(P);
      check(r2.cache.rendered === r2.cache.segments - (r.cache.rendered), 'sau đó đoạn vừa render được lưu lại, đoạn đã mất được render lại', `${r2.cache.rendered} render, mong đợi ${r2.cache.segments - r.cache.rendered}`);
    }

    // ---------- 4. LRU cap + "Xoá cache" + Xem nhanh job ----------
    {
      const st0 = await cacheStats(project.id);
      const capMb = (st0.bytes * 0.6) / 1048576;
      process.env.RENDER_CACHE_MAX_MB = String(capMb);
      P.style.vignette = 0.3; // new keys for every segment
      const r = await render(P);
      const st1 = await cacheStats(project.id);
      check(st1.bytes <= capMb * 1048576 && st1.segments > 0 && r.cache.rendered === r.cache.segments,
        `RENDER_CACHE_MAX_MB=${capMb.toFixed(3)} → cache ${(st1.bytes / 1024).toFixed(0)} KB ≤ giới hạn (${st1.segments} đoạn còn lại)`);
      // the survivors are the most recent ones: re-render reuses only them
      const r2 = await render(P);
      check(r2.cache.reused >= st1.segments - 1 && r2.cache.reused > 0, `đoạn còn lại sau khi dọn LRU vẫn dùng lại được (${r2.cache.reused}/${r2.cache.segments})`);
      delete process.env.RENDER_CACHE_MAX_MB;
      // pure LRU order on synthetic files
      const ld = path.join(DD, 'lru');
      await fsp.mkdir(ld);
      for (let i = 0; i < 5; i++) {
        const k = String(i).repeat(64);
        await fsp.writeFile(path.join(ld, `${k}-x.mp4`), Buffer.alloc(1000));
        await fsp.writeFile(path.join(ld, `${k}.json`), JSON.stringify({ file: `${k}-x.mp4` }));
        const t = new Date(Date.UTC(2026, 0, 1, 0, i === 1 ? 10 : i)); // #1 was used most recently
        await fsp.utimes(path.join(ld, `${k}-x.mp4`), t, t);
      }
      await enforceCap(ld, 2600);
      const left = (await fsp.readdir(ld)).filter((n) => n.endsWith('.mp4')).map((n) => n[0]).sort().join('');
      const leftJson = (await fsp.readdir(ld)).filter((n) => n.endsWith('.json')).length;
      check(left === '14' && leftJson === 2, `LRU xoá đoạn lâu không dùng nhất trước (còn: ${left}, manifest: ${leftJson})`);

      const base = `http://127.0.0.1:${srv.port}`;
      await fsp.writeFile(path.join(pdir, 'project.json'), JSON.stringify(P));
      const j0 = await (await fetch(`${base}/api/projects/${P.id}/render`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ quality: 'preview' }) })).json();
      let job = j0;
      for (let i = 0; i < 300 && !['done', 'error', 'cancelled'].includes(job.status); i++) {
        await new Promise((res) => setTimeout(res, 200));
        job = await (await fetch(`${base}/api/jobs/${j0.id}`)).json();
      }
      const pj = JSON.parse(await fsp.readFile(path.join(pdir, 'project.json'), 'utf8'));
      check(job.status === 'done' && job.result?.preview && fs.existsSync(path.join(pdir, 'preview', job.result.file)) && !(pj.exports || []).length && job.log.some((l) => /tái sử dụng/.test(l)),
        `job "Xem nhanh" (HTTP): ${job.status}, file ở preview/, không thêm vào danh sách xuất, log: "${(job.log || []).slice(-1)[0] || job.error}"`);
      const pf = path.join(pdir, 'preview', job.result?.file || 'x');
      if (fs.existsSync(pf)) {
        const pr = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate', '-of', 'csv=p=0', pf]).stdout.toString().trim();
        const even = (v) => Math.floor(Math.round(v * 0.33) / 2) * 2;
        check(pr === `${even(W)},${even(H)},12/1`, `Xem nhanh: 1/3 độ phân giải, 12 fps (${pr})`);
      }
      const j1 = await (await fetch(`${base}/api/projects/${P.id}/render`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ quality: 'preview' }) })).json();
      job = j1;
      for (let i = 0; i < 300 && !['done', 'error', 'cancelled'].includes(job.status); i++) {
        await new Promise((res) => setTimeout(res, 200));
        job = await (await fetch(`${base}/api/jobs/${j1.id}`)).json();
      }
      check(job.status === 'done' && job.result.cache.reused === job.result.cache.segments && (await fsp.readdir(path.join(pdir, 'preview'))).filter((n) => n.endsWith('.mp4')).length === 1,
        `Xem nhanh lần 2 dùng lại toàn bộ cache (${job.result?.cache?.reused}/${job.result?.cache?.segments}), chỉ giữ bản xem nhanh mới nhất`);
      const before = await (await fetch(`${base}/api/projects/${P.id}/cache`)).json();
      const cl = await (await fetch(`${base}/api/projects/${P.id}/cache`, { method: 'DELETE' })).json();
      check(before.segments > 0 && cl.ok && cl.segments === 0 && cl.bytes === 0 && cl.freed === before.bytes && !fs.existsSync(cdir),
        `DELETE /api/projects/:id/cache xoá ${before.segments} đoạn (${(before.bytes / 1024).toFixed(0)} KB)`);
      const bq = await fetch(`${base}/api/projects/${P.id}/render`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ quality: 'ultra' }) });
      check(bq.status === 400, 'quality lạ → 400');
    }
    info(`test-render-cache tổng ${((Date.now() - t00) / 1000).toFixed(1)}s`);
    return failed ? 1 : 0;
  } finally {
    if (browser) await browser.close().catch(() => {});
    srv.stop?.();
    await fsp.rm(DD, { recursive: true, force: true }).catch(() => {});
  }
}

main().then((code) => process.exit(code), (e) => { bad(`test-render-cache lỗi: ${e.stack || e.message}`); process.exit(2); });
