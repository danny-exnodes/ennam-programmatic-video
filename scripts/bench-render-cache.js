// Benchmark of the per-segment render cache + "Xem nhanh" (#29). Dev script, not in CI
// (renders full-HD video: minutes on a small machine).
//
//   node scripts/bench-render-cache.js [--quality standard] [--duration 20]
//
// Self-contained: temporary DATA_DIR + server, seeds the "Lumi C+" demo (scripts/seed-demo.js:
// product-ad recipe, 5 shots) and appends a 6th shot so the cut lasts --duration seconds.
// Measures (wall clock, RENDER_WORKERS as configured):
//   1. full export, empty cache
//   2. re-export after changing ONE field of one shot (cache warm) → speed-up (target ≥ 3×)
//   3. re-export with nothing changed
//   4. "Xem nhanh" (quality preview), empty cache → share of (1) (target ≤ 25%)
// Prints a markdown table (paste into the PR).
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pinnedChrome, usePinnedChrome, startTempServer, ROOT } from './lib/test-env.js';

const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const QUALITY = arg('--quality', 'standard');
const DURATION = Number(arg('--duration', 20));

const exe = await pinnedChrome({ onWarn: (m) => console.log('WARN ', m) });
if (exe) usePinnedChrome(exe);
const DD = await fsp.mkdtemp(path.join(os.tmpdir(), 'rcbench-'));
process.env.DATA_DIR = DD;
const srv = await startTempServer(DD);
if (srv.error) { console.error(srv.error, srv.log()); process.exit(2); }
try {
  const seed = spawnSync(process.execPath, [path.join(ROOT, 'scripts/seed-demo.js')], { cwd: DD, env: process.env, encoding: 'utf8' });
  const id = /Demo project: (\S+)/.exec(seed.stdout || '')?.[1];
  if (!id) throw new Error('seed-demo lỗi: ' + seed.stderr + seed.stdout);
  const store = await import('../server/store.js');
  const { renderProject, getBrowser } = await import('../server/render.js');
  const { clearCache } = await import('../server/render-cache.js');
  let p = await store.loadProject(id);
  const used = p.shots.reduce((s, x) => s + x.duration, 0);
  const extra = structuredClone(p.shots[1]);
  extra.id = 'sbench6'; extra.name = extra.name + ' (2)';
  extra.duration = Math.max(1.5, +(DURATION - used).toFixed(2));
  p.shots.push(extra);
  await store.saveProject(p);
  p = await store.loadProject(id);
  const dur = p.shots.reduce((s, x) => s + x.duration, 0);
  // the shot whose field we edit: first shot from index 2 that declares a field
  const ei = p.shots.findIndex((s, i) => i >= 2 && /s\.field\("([^"]+)"/.test(s.code));
  const key = /s\.field\("([^"]+)"/.exec(p.shots[ei].code)[1];
  console.log(`Dự án ${id}: ${p.shots.length} shot · ${dur}s · ${p.width}×${p.height}@${p.fps} · quality ${QUALITY} · RENDER_WORKERS=${process.env.RENDER_WORKERS || `auto (${os.cpus().length} CPU)`}`);
  console.log(`Sửa field "${key}" của shot ${ei + 1} (${p.shots[ei].name})`);
  await getBrowser(); // browser launch not counted

  const time = async (label, proj, quality = QUALITY) => {
    const t0 = Date.now();
    const r = await renderProject(proj, { quality });
    const s = (Date.now() - t0) / 1000;
    console.log(`  ${label}: ${s.toFixed(1)}s · tái sử dụng ${r.cache.reused}/${r.cache.segments} đoạn (${r.cache.reusedFrames}/${r.cache.frames} khung)`);
    return { s, r };
  };
  const full = await time('1. xuất đầy đủ (cache trống)', p);
  p.shots[ei].fields = { ...(p.shots[ei].fields || {}), [key]: 'Bản sửa cho khách' };
  const edit = await time('2. sửa 1 field rồi xuất lại', p);
  const same = await time('3. xuất lại, không đổi gì', p);
  await clearCache(id);
  const prev = await time('4. Xem nhanh (cache trống)', p, 'preview');
  const prevStd = await time('   (đối chứng: xuất đầy đủ sau khi xoá cache)', p);
  await clearCache(id);
  const pct = (prev.s / Math.min(full.s, prevStd.s)) * 100;
  console.log('\n| Phép đo | Thời gian | Đoạn tái sử dụng | So với xuất đầy đủ |');
  console.log('|---|---|---|---|');
  console.log(`| Xuất ${QUALITY} đầy đủ, cache trống (${p.shots.length} shot, ${dur}s, ${full.r.cache.frames} khung) | ${full.s.toFixed(1)} s | 0/${full.r.cache.segments} | 1× |`);
  console.log(`| Sửa 1 field ở shot ${ei + 1} rồi xuất lại | ${edit.s.toFixed(1)} s | ${edit.r.cache.reused}/${edit.r.cache.segments} | **${(full.s / edit.s).toFixed(1)}× nhanh hơn** (mục tiêu ≥ 3×) |`);
  console.log(`| Xuất lại không đổi gì | ${same.s.toFixed(1)} s | ${same.r.cache.reused}/${same.r.cache.segments} | ${(full.s / same.s).toFixed(1)}× |`);
  console.log(`| Xem nhanh, cache trống (12 fps, 1/3 res, không motion blur) | ${prev.s.toFixed(1)} s | 0/${prev.r.cache.segments} | **${pct.toFixed(1)}%** (mục tiêu ≤ 25%) |`);
  const okAll = full.s / edit.s >= 3 && pct <= 25;
  console.log(`\n${okAll ? 'PASS' : 'FAIL'}  ≥ 3× khi sửa 1 field: ${(full.s / edit.s).toFixed(1)}× · Xem nhanh ≤ 25%: ${pct.toFixed(1)}%`);
  await (await getBrowser()).close();
  process.exitCode = okAll ? 0 : 1;
} finally {
  srv.stop?.();
  await fsp.rm(DD, { recursive: true, force: true }).catch(() => {});
}
