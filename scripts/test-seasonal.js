// Seasonal template QA (part of `npm run check`; issue #24).
//
//   node scripts/test-seasonal.js
//
// Every season-tagged recipe (server/templates/seasonal/*.js) is built WITHOUT any Claude
// call (buildFromTemplate) at 16:9 and 9:16, then rendered through the same inspect path the
// AI director uses (server/render.js inspectProject → window.__inspect → server/qa.js
// qaIssues) in the pinned Chromium on a temp server. Must raise no issue (runtime throw,
// black, blank, text outside the 6% safe area, slow). Static checks: every s.text-style call
// has maxWidth, form values prefill shot.fields, the director system prompt does not
// contain seasonal scenes (prompt cache stays stable). Tết (24b): year/can-chi field, NFC text,
// and the longest form values still pass QA at both aspects. Khai trương / Kỷ niệm (24c): same
// long-content run, colour fields follow the Brand Kit (brandColor) in every bundle.
// Exit code: 0 pass, 1 fail, 2 setup error. Non-Linux: skipped locally, FAIL on CI (like golden).
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pinnedChrome, usePinnedChrome, startTempServer } from './lib/test-env.js';

const CI = !!process.env.CI;
const GH = !!process.env.GITHUB_ACTIONS;
const FRAMES = Number(process.env.SEASONAL_FRAMES || 6);
let failed = false;
const ok = (m) => console.log(`PASS  ${m}`);
const bad = (m) => { console.log(`FAIL  ${m}`); failed = true; if (GH) console.log(`::error::${m}`); };
const warn = (m) => { console.log(`WARN  ${m}`); if (GH) console.log(`::warning::${m}`); };
const info = (m) => console.log(`      ${m}`);
const check = (name, fn) => { try { fn(); ok(name); } catch (e) { bad(`${name} — ${e.message}`); } };

const blank = (id, width, height) => ({
  id, name: id, width, height, fps: 30, brief: '',
  style: { grade: 'none', vignette: 0.35, grain: 0.05, bloom: 0.25, letterbox: 0, palette: { primary: '#f08a12', accent: '#f5b54a', text: '#ffffff' } },
  assets: [], shots: [], voice: [], music: null, exports: [],
});

/** Every `s.text(…)` / `gold(…)` / `caps(…)` call with its full argument list (paren matching). */
function textCalls(code) {
  const out = [];
  for (const m of code.matchAll(/(?:s\.text|\bgold|\bcaps)\(/g)) {
    let depth = 0, i = m.index + m[0].length - 1;
    for (; i < code.length; i++) { if (code[i] === '(') depth++; else if (code[i] === ')' && --depth === 0) break; }
    out.push(code.slice(m.index, i + 1));
  }
  return out;
}

async function statics(T) {
  const seasonal = T.TEMPLATES.filter((t) => t.season);
  check(`có công thức theo mùa (${seasonal.map((t) => t.id).join(', ')})`, () => {
    for (const s of T.SEASONS) assert.ok(seasonal.filter((t) => t.season === s.id).length >= 3, `${s.id} < 3 công thức`);
  });
  check('mọi lệnh chữ trong cảnh theo mùa có maxWidth', () => {
    for (const [k, sc] of Object.entries(T.SEASONAL_SCENES)) {
      const code = sc.code({});
      for (const call of textCalls(code)) {
        if (/^(s\.text|gold|caps)\((String\()?str\b/.test(call)) continue; // helper definitions
        const shared = (call.match(/\}, ([A-Z]{2})\)\)$/) || [])[1]; // Object.assign({...}, TS): shared options
        const sharedOk = shared && new RegExp(`const ${shared} = \\{[^\\n]*maxWidth`).test(code);
        assert.ok(/maxWidth/.test(call) || sharedOk, `${k}: thiếu maxWidth — ${call.slice(0, 70)}`);
      }
      assert.ok(!/Math\.random|Date\.now|new Date|performance\.now/.test(code), `${k}: không tất định`);
    }
  });
  check('form theo mùa điền sẵn shot.fields, ô trống giữ mặc định', () => {
    const p = T.buildFromTemplate(blank('x', 1920, 1080), { template: seasonal[0].id, fields: { company: '  Công ty TNHH Hoa Sen ', venue: '' } });
    assert.ok(p.shots.length > 0);
    for (const s of p.shots) { assert.equal(s.fields.company, 'Công ty TNHH Hoa Sen'); assert.equal('venue' in s.fields, false); }
  });
  // Tết (24b): năm/can chi là trường sửa được, mặc định Tết 2027 = Xuân Đinh Mùi; chữ tiếng Việt dạng NFC.
  check('Tết: mặc định "Xuân Đinh Mùi 2027", trường year/accent/red có trong mọi cảnh, đổi năm qua form', () => {
    const tet = T.SEASONS.find((x) => x.id === 'tet');
    assert.ok(tet, 'thiếu bộ tet');
    assert.equal(tet.defaults.year, 'Xuân Đinh Mùi 2027');
    for (const v of Object.values(tet.defaults)) assert.equal(v, v.normalize('NFC'), `chưa NFC: ${v}`);
    for (const [k, sc] of Object.entries(T.SEASONAL_SCENES).filter(([, v]) => v.season === 'tet')) {
      const code = sc.code({});
      for (const key of ['accent', 'red']) assert.ok(code.includes(`s.field('${key}'`), `${k}: thiếu trường ${key}`);
      assert.equal(code, code.normalize('NFC'), `${k}: chuỗi chưa NFC`);
    }
    const p = T.buildFromTemplate(blank('y', 1080, 1920), { template: 'tet-led', fields: { year: 'Xuân Mậu Thân 2028' } });
    assert.ok(p.shots.every((x) => x.fields.year === 'Xuân Mậu Thân 2028'));
    assert.ok(p.shots.some((x) => /s\.field\("year"/.test(x.code)));
  });
  // Khai trương / Kỷ niệm (24c): mặc định đúng dấu, 3 màu là field, màu nhấn/nền theo Brand Kit, số năm qua form.
  check('Khai trương: "Khai Trương Hồng Phát", trường accent/base/ribbon trong mọi cảnh, số năm qua form', () => {
    const op = T.SEASONS.find((x) => x.id === 'opening');
    assert.ok(op, 'thiếu bộ opening');
    assert.equal(op.name, 'Khai trương / Kỷ niệm');
    assert.equal(op.defaults.title, 'Khai Trương Hồng Phát');
    for (const v of Object.values(op.defaults)) assert.equal(v, v.normalize('NFC'), `chưa NFC: ${v}`);
    for (const [k, sc] of Object.entries(T.SEASONAL_SCENES).filter(([, v]) => v.season === 'opening')) {
      const code = sc.code({});
      for (const key of ['accent', 'base', 'ribbon']) assert.ok(code.includes(`s.field('${key}'`), `${k}: thiếu trường ${key}`);
      assert.ok(/s\.field\('base', "[^"]+", \{ type: 'color', label: '[^']+', brandColor: 'primary' \}\)/.test(code), `${k}: màu nền chưa theo Brand Kit`);
      assert.equal(code, code.normalize('NFC'), `${k}: chuỗi chưa NFC`);
    }
    assert.ok(Object.values(T.SEASONAL_SCENES).some((v) => v.season === 'opening' && v.code({}).includes('Trân trọng kính mời')));
    const p = T.buildFromTemplate(blank('z', 1080, 1920), { template: 'opening-anniversary', fields: { years: '25' } });
    assert.ok(p.shots.every((x) => x.fields.years === '25'));
    assert.ok(p.shots.some((x) => /s\.field\("years"/.test(x.code)));
  });
  check('màu nhấn của mọi bộ theo mùa dùng brandColor (Brand Kit), logo mặc định s.brand.logo', () => {
    for (const [k, sc] of Object.entries(T.SEASONAL_SCENES)) {
      const code = sc.code({});
      const m = code.match(/s\.field\('accent', [^\n]*\);/);
      assert.ok(m, `${k}: thiếu field accent`);
      assert.ok(m[0].includes("brandColor: 'accent'"), `${k}: accent thiếu brandColor`);
      const lg = code.match(/s\.field\('logo', [^\n]*\);/);
      if (lg) assert.ok(lg[0].includes('s.brand.logo'), `${k}: logo chưa mặc định theo Brand Kit`);
    }
    for (const se of T.SEASONS) assert.equal(se.fields.find((f) => f.key === 'accent')?.brandColor, 'accent', `${se.id}: form accent thiếu brandColor`);
  });
  const { systemPrompt } = await import('../server/director.js');
  check('system prompt đạo diễn không chứa cảnh theo mùa (cache ổn định)', () => {
    const sp = systemPrompt();
    for (const sc of Object.values(T.SEASONAL_SCENES)) assert.ok(!sp.includes(sc.name), `có "${sc.name}"`);
  });
}

async function render(T) {
  const { inspectProject } = await import('../server/render.js');
  const { qaIssues, describeQa, metricsLine } = await import('../server/qa.js');
  const recipes = T.TEMPLATES.filter((t) => t.season);
  const rows = [];
  for (const [w, h, label] of [[1920, 1080, '16:9'], [1080, 1920, '9:16']]) {
    for (const r of recipes) {
      const t0 = Date.now();
      const p = T.buildFromTemplate(blank(`p${r.id.replace(/\W/g, '')}${w}`, w, h), { template: r.id });
      const insp = await inspectProject(p, { framesPerShot: FRAMES, thumbWidth: 320 });
      if (insp.errors?._page) { bad(`${r.id} ${label}: lỗi trang ${insp.errors._page}`); continue; }
      const issues = qaIssues(p, insp);
      const n = Object.values(issues).flat().length;
      const ms = Object.values(insp.metrics).flatMap((m) => m.samples.map((x) => x.ms)).filter(Number.isFinite);
      const texts = Object.values(insp.metrics).flatMap((m) => m.samples.flatMap((x) => x.text)).length;
      rows.push({ id: r.id, label, max: Math.max(...ms) });
      if (n) bad(`${r.id} ${label}: ${n} lỗi QA\n${describeQa(p, issues)}`);
      else ok(`${r.id} ${label}: ${p.shots.length} shot × ${FRAMES} khung, ${texts} khối chữ trong vùng an toàn, không đen/trống/lỗi · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      info(metricsLine(p, insp));
    }
  }
  // Tết + Khai trương: nội dung dài nhất form cho phép vẫn không tràn vùng an toàn (chữ tự co/xuống dòng).
  const LONG = {
    tet: { company: 'Tổng Công ty Cổ phần Đầu tư Phát triển Thịnh An', title: 'Lễ Khai xuân & Gặp mặt đầu năm', year: 'Xuân Đinh Mùi 2027',
      wish: 'An Khang · Thịnh Vượng · Vạn Sự Như Ý', date: 'Thứ Năm, 11.02.2027 (Mùng 6 Tết) · 08:30 – 11:00',
      venue: 'Trung tâm Hội nghị Quốc gia, Phạm Hùng, Nam Từ Liêm, Hà Nội (Sảnh A)' },
    opening: { company: 'Tổng Công ty Cổ phần Đầu tư Phát triển Thịnh An', title: 'Khai Trương Chi Nhánh Mới Thủ Đức', subtitle: 'Trung tâm Trải nghiệm Thịnh An – CN Thủ Đức',
      date: 'Chủ Nhật, 15.11.2026 · 08:30 – 11:30', venue: 'Tầng trệt Vincom Mega Mall, 161 Xa Lộ Hà Nội, Thảo Điền, Thủ Đức, TP.HCM', years: '125',
      offer: 'Ưu đãi khai trương: giảm 30% và tặng quà cho 100 khách đầu tiên' },
  };
  for (const [w, h, label] of [[1920, 1080, '16:9'], [1080, 1920, '9:16']]) {
    for (const r of recipes.filter((x) => LONG[x.season])) {
      const p = T.buildFromTemplate(blank(`L${r.id.replace(/\W/g, '')}${w}`, w, h), { template: r.id, fields: LONG[r.season] });
      const insp = await inspectProject(p, { framesPerShot: 4, thumbWidth: 320 });
      if (insp.errors?._page) { bad(`${r.id} ${label} (chữ dài): lỗi trang ${insp.errors._page}`); continue; }
      const issues = qaIssues(p, insp), n = Object.values(issues).flat().length;
      if (n) bad(`${r.id} ${label} (chữ dài): ${n} lỗi QA\n${describeQa(p, issues)}`);
      else ok(`${r.id} ${label}: nội dung dài vẫn trong vùng an toàn, 0 lỗi QA`);
    }
  }
  return rows;
}

async function main() {
  const t0 = Date.now();
  const T = await import('../server/templates.js');
  const exe = await pinnedChrome({ onWarn: warn });
  if (!exe) {
    const m = `test-seasonal cần Linux x64 (Chromium cố định); nền tảng ${process.platform}-${process.arch} — bỏ qua phần render`;
    await statics(T);
    if (CI) { bad(m); return 1; }
    warn(m);
    return failed ? 1 : 0;
  }
  usePinnedChrome(exe);
  const DD = await fsp.mkdtemp(path.join(os.tmpdir(), 'seasonal-'));
  process.env.DATA_DIR = DD;
  const srv = await startTempServer(DD);
  let browser = null;
  try {
    if (srv.error) { bad(srv.error); console.log(srv.log()); return 2; }
    await statics(T);
    const { getBrowser } = await import('../server/render.js');
    browser = await getBrowser();
    const rows = await render(T);
    const worst = rows.reduce((a, r) => (r.max > a.max ? r : a), { max: 0 });
    info(`khung chậm nhất (inspect scale 0.5): ${Math.round(worst.max)} ms (${worst.id} ${worst.label})`);
    info(`test-seasonal tổng ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    if (GH) console.log(`::notice title=test-seasonal::${failed ? 'FAIL' : 'PASS'} · ${rows.length} dự án (16:9 + 9:16) · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return failed ? 1 : 0;
  } finally {
    if (browser) await browser.close().catch(() => {});
    srv.stop?.();
    await fsp.rm(DD, { recursive: true, force: true }).catch(() => {});
  }
}

main().then((code) => process.exit(code), (e) => { bad(`test-seasonal lỗi: ${e.stack || e.message}`); process.exit(2); });
