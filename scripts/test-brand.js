// Brand Kit tests (issue #8; part of `npm run check`).
//
//   node scripts/test-brand.js
//
// Server child process (temp DATA_DIR, behind APP_PASSWORD auth) + pinned Chromium:
//   1. routes behind auth (401 without credentials) — /api/brands and kit files
//   2. CRUD + duplicate, validation (3–5 colors, primary/accent/text required), version +1 on every change
//   3. font upload: empty "nguồn/giấy phép" → warning font_license; filled in → no warning; bad extension → 400
//   4. project created with a kit: unlocked follows the latest kit on open, locked keeps its snapshot;
//      the client cannot overwrite project.brand through PUT; unlocking moves to the latest version
//   5. headless render (render page = MP4 frame path): s.palette from the kit, a { brandColor: 'accent' }
//      field default from the kit, the kit logo as s.brand.logo — checked pixel by pixel; no kit → old colors
//   6. uploaded font (OFL Playfair Display woff2 from @fontsource) really used in headless render:
//      text with font 'heading' must differ from the fallback rendering and match the same font loaded by CSS
//   7. offline director (stub client): BRAND KIT block in the USER turn, system prompt unchanged;
//      QA banned_phrase (whole word, field values, voice lines)
// Exit code: 0 pass, 1 fail, 2 setup error. Non-Linux: render parts skipped locally, FAIL on CI.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { ROOT, pinnedChrome, usePinnedChrome, startTempServer } from './lib/test-env.js';

const CI = !!process.env.CI;
const GH = !!process.env.GITHUB_ACTIONS;
let failed = false;
const ok = (m) => console.log(`PASS  ${m}`);
const bad = (m) => { console.log(`FAIL  ${m}`); failed = true; if (GH) console.log(`::error::${m}`); };
const warn = (m) => { console.log(`WARN  ${m}`); if (GH) console.log(`::warning::${m}`); };
const info = (m) => console.log(`      ${m}`);
async function step(name, fn) {
  try { const r = await fn(); ok(name + (typeof r === 'string' ? ` — ${r}` : '')); } catch (e) { bad(`${name} — ${e.stack || e.message}`); }
}

const PW = 'brand-test-' + Math.random().toString(36).slice(2, 10);
const DD = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-test-'));
process.env.DATA_DIR = DD; // store.js (director test below) and the temp server share it
process.env.APP_PASSWORD = PW; // render.js renderAuthHeaders() → Basic auth for the render page
process.env.ANTHROPIC_API_KEY ||= 'test-offline-not-a-real-key';
const AUTH = { authorization: 'Basic ' + Buffer.from(`team:${PW}`).toString('base64') };
const FONT_FILE = path.join(ROOT, 'node_modules/@fontsource/playfair-display/files/playfair-display-latin-700-normal.woff2');

let BASE = '';
async function call(method, url, body, { auth = true, form = null } = {}) {
  const headers = { ...(auth ? AUTH : {}) };
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(BASE + url, { method, headers, body: payload });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, data: ct.includes('json') ? await r.json() : await r.text() };
}
async function json(method, url, body, opts) {
  const r = await call(method, url, body, opts);
  if (r.status !== 200) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
}
function fileForm(file, name, extra = {}) {
  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(file)]), name);
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  return fd;
}

const PAL = [{ role: 'primary', color: '#12a4d9' }, { role: 'accent', color: '#e0115f' }, { role: 'text', color: '#fafafa' }];
const NEUTRAL_STYLE = { grade: 'none', vignette: 0, grain: 0, bloom: 0, letterbox: 0, palette: { primary: '#f08a12', accent: '#f5b54a', text: '#ffffff' } };
const shot = (id, code, duration = 1) => ({ id, name: id, duration, transition: { type: 'cut' }, code, notes: '', fields: {} });

async function api(state) {
  const K = state;
  await step('route kit nằm sau đăng nhập (401 khi không có thông tin đăng nhập)', async () => {
    assert.equal((await call('GET', '/api/brands', undefined, { auth: false })).status, 401);
    assert.equal((await call('POST', '/api/brands', { name: 'x' }, { auth: false })).status, 401);
    assert.equal((await call('GET', '/brands/bxxxx/files/a.png', undefined, { auth: false })).status, 401);
    assert.equal((await call('GET', '/api/brands')).status, 200);
  });

  await step('CRUD + nhân bản kit, kiểm tra bảng màu, version +1 mỗi lần đổi', async () => {
    assert.equal((await call('POST', '/api/brands', { name: 'x', palette: PAL.slice(0, 2) })).status, 400, '2 màu → 400');
    assert.equal((await call('POST', '/api/brands', { name: 'x', palette: [PAL[0], PAL[2], { role: 'secondary', color: '#111111' }] })).status, 400, 'thiếu accent → 400');
    assert.equal((await call('POST', '/api/brands', { name: 'x', palette: [...PAL, { role: 'accent', color: '#000000' }] })).status, 400, 'trùng vai trò → 400');
    assert.equal((await call('POST', '/api/brands', { name: 'x', palette: [{ ...PAL[0], color: 'red' }, PAL[1], PAL[2]] })).status, 400, 'màu sai định dạng → 400');
    const k = await json('POST', '/api/brands', {
      name: 'Lumi', palette: PAL, grade: 'clean', voiceId: 'nova', requiredPhrases: ['Lumi C+ — Sáng từ bên trong', ' '], bannedPhrases: 'rẻ nhất\ncam kết 100%\nRẺ NHẤT', outro: 'lumi.vn',
    });
    assert.equal(k.version, 1);
    assert.deepEqual(k.bannedPhrases, ['rẻ nhất', 'cam kết 100%'], 'chuỗi nhiều dòng → mảng, bỏ trùng');
    assert.deepEqual(k.requiredPhrases, ['Lumi C+ — Sáng từ bên trong']);
    assert.deepEqual(k.outro, { text: 'lumi.vn' });
    const k2 = await json('PUT', `/api/brands/${k.id}`, { name: 'Lumi Cosmetics' });
    assert.equal(k2.version, 2);
    assert.equal(k2.name, 'Lumi Cosmetics');
    assert.deepEqual(k2.palette, PAL, 'PUT một phần giữ các trường khác');
    assert.ok((await json('GET', '/api/brands')).some((x) => x.id === k.id));
    const dup = await json('POST', `/api/brands/${k.id}/duplicate`);
    assert.notEqual(dup.id, k.id);
    assert.equal(dup.version, 1);
    assert.equal(dup.name, 'Lumi Cosmetics (bản sao)');
    await json('DELETE', `/api/brands/${dup.id}`);
    assert.equal((await call('GET', `/api/brands/${dup.id}`)).status, 404);
    K.kit = k2;
    return `kit ${k.id} v${k2.version}`;
  });

  await step('logo PNG: lưu trong kit, phục vụ sau đăng nhập, version +1', async () => {
    const logo = path.join(DD, 'logo.png');
    await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } }).png().toFile(logo);
    const k = await json('POST', `/api/brands/${K.kit.id}/logo`, undefined, { form: fileForm(logo, 'logo.png') });
    assert.equal(k.version, K.kit.version + 1);
    assert.equal(k.logo.width, 64);
    assert.equal((await call('GET', `/brands/${k.id}/files/${k.logo.file}`)).status, 200);
    K.kit = k;
  });

  await step('font: thiếu nguồn/giấy phép → cảnh báo font_license; ghi giấy phép → hết cảnh báo; sai đuôi → 400', async () => {
    const bogus = path.join(DD, 'x.txt');
    fs.writeFileSync(bogus, 'not a font');
    assert.equal((await call('POST', `/api/brands/${K.kit.id}/fonts`, undefined, { form: fileForm(bogus, 'x.txt') })).status, 400);
    const k = await json('POST', `/api/brands/${K.kit.id}/fonts`, undefined, { form: fileForm(FONT_FILE, 'PlayfairDisplay-Bold.woff2', { name: 'Playfair Bold', license: '', role: 'heading' }) });
    assert.equal(k.fontFiles.length, 1);
    assert.equal(k.fonts.heading, k.fontFiles[0].id, 'role heading gán luôn');
    assert.deepEqual(k.warnings.map((w) => w.code), ['font_license']);
    const k2 = await json('PATCH', `/api/brands/${K.kit.id}/fonts/${k.fontFiles[0].id}`, { license: 'Google Fonts / @fontsource — SIL Open Font License 1.1' });
    assert.deepEqual(k2.warnings, []);
    assert.equal(k2.version, k.version + 1);
    K.kit = k2;
    return `v${k2.version}`;
  });

  await step('dự án: không khoá → theo kit mới nhất khi mở lại; khoá → giữ bản chụp; PUT không ghi đè brand; bỏ khoá → mới nhất', async () => {
    const A = await json('POST', '/api/projects', { name: 'Theo kit', brand: { id: K.kit.id, locked: false } });
    const B = await json('POST', '/api/projects', { name: 'Khoá kit', brand: { id: K.kit.id, locked: true } });
    assert.equal(A.brand.version, K.kit.version);
    assert.equal(A.style.grade, 'clean', 'grade mặc định của kit áp khi gán');
    assert.ok(fs.existsSync(path.join(DD, 'projects', A.id, 'assets', A.brand.kit.logo.file)), 'logo chép vào assets/ của dự án');
    assert.ok(A.brand.kit.fontFiles[0].file.startsWith('brand-'));
    assert.ok(!A.assets.some((a) => a.file.startsWith('brand-')), 'file kit không lẫn vào chất liệu');
    const before = K.kit.version;
    K.kit = await json('PUT', `/api/brands/${K.kit.id}`, { palette: [{ role: 'primary', color: '#22cc44' }, PAL[1], PAL[2], { role: 'background', color: '#101820' }] });
    assert.equal(K.kit.version, before + 1);
    const A2 = await json('GET', `/api/projects/${A.id}`);
    const B2 = await json('GET', `/api/projects/${B.id}`);
    assert.equal(A2.brand.version, K.kit.version, 'không khoá → version mới nhất');
    assert.equal(A2.brand.kit.palette[0].color, '#22cc44');
    assert.equal(B2.brand.version, before, 'khoá → giữ version cũ');
    assert.equal(B2.brand.kit.palette[0].color, '#12a4d9');
    const saved = JSON.parse(fs.readFileSync(path.join(DD, 'projects', A.id, 'project.json'), 'utf8'));
    assert.equal(saved.brand.version, K.kit.version, 'bản cập nhật được lưu xuống đĩa');
    const put = await json('PUT', `/api/projects/${B.id}`, { ...B2, brand: null, name: 'Khoá kit (sửa)' });
    assert.equal(put.brand.version, before, 'client không xoá/ghi đè được project.brand qua PUT');
    const B3 = await json('PUT', `/api/projects/${B.id}/brand`, { id: K.kit.id, locked: false });
    assert.equal(B3.brand.version, K.kit.version);
    assert.equal(B3.brand.locked, false);
    const B4 = await json('PUT', `/api/projects/${B.id}/brand`, { id: K.kit.id, locked: true });
    assert.equal(B4.brand.locked, true);
    const dup = await json('POST', `/api/projects/${B.id}/duplicate`, { brand: null });
    assert.equal(dup.brand, null, 'nhân bản bỏ kit');
    const dup2 = await json('POST', `/api/projects/${A.id}/duplicate`);
    assert.equal(dup2.brand.id, K.kit.id, 'nhân bản mặc định giữ kit');
    const list = await json('GET', '/api/projects');
    assert.equal(list.find((p) => p.id === A.id).brand.name, 'Lumi Cosmetics');
    return `A v${A2.brand.version} · B khoá v${B2.brand.version}`;
  });
}

// ---------------------------------------------------------------- headless render
async function pixels(b64) {
  const { data, info: im } = await sharp(Buffer.from(b64, 'base64')).raw().toBuffer({ resolveWithObject: true });
  return { data, w: im.width, h: im.height, ch: im.channels };
}
const at = (img, fx, fy) => {
  const x = Math.round(fx * (img.w - 1)), y = Math.round(fy * (img.h - 1));
  const o = (y * img.w + x) * img.ch;
  return [img.data[o], img.data[o + 1], img.data[o + 2]];
};
const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const near = (a, b, tol = 3) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
const fmtRgb = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
/** Share of pixels whose max channel difference exceeds `thr`. */
function diffRatio(a, b, thr = 40) {
  let n = 0;
  for (let i = 0; i < a.data.length; i += a.ch) if (Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2])) > thr) n++;
  return n / (a.w * a.h);
}

async function renderFrames(projectId, times, { override, scale = 0.25 } = {}) {
  const { openRenderPage } = await import('../server/render.js');
  const pg = await openRenderPage(projectId, { override, scale });
  try {
    const out = [];
    for (const t of times) out.push(await pixels(await pg.page.evaluate(([tt]) => window.__frame(tt, 1, 'png'), [t])));
    return out;
  } finally {
    await pg.close();
  }
}

const COLOR_SHOTS = [
  shot('pal', 's.background(s.palette.primary);'),
  shot('fld', "const c = s.field('accent', '#00ff00', { type: 'color', label: 'Màu nhấn', brandColor: 'accent' });\ns.background(c);"),
  shot('logo', "s.background('#000000');\nif (s.brand.logo) s.image(s.brand.logo, { x: s.W / 2, y: s.H / 2, w: 400, h: 400, depth: 0 });"),
];

async function render(state) {
  const K = state;
  await step('render headless: s.palette + field brandColor + logo từ kit; không kit → màu cũ', async () => {
    const R = await json('POST', '/api/projects', { name: 'Render kit', brand: { id: K.kit.id, locked: false } });
    await json('PUT', `/api/projects/${R.id}`, { ...R, style: NEUTRAL_STYLE, shots: COLOR_SHOTS });
    const N = await json('POST', '/api/projects', { name: 'Không kit' });
    await json('PUT', `/api/projects/${N.id}`, { ...N, style: NEUTRAL_STYLE, shots: COLOR_SHOTS });
    // page loads the project itself (GET → follows the latest kit), like the editor
    const [p1, p2, p3] = await renderFrames(R.id, [0.5, 1.5, 2.5]);
    const kitPrimary = hexRgb(K.kit.palette.find((c) => c.role === 'primary').color);
    const kitAccent = hexRgb(K.kit.palette.find((c) => c.role === 'accent').color);
    assert.ok(near(at(p1, 0.5, 0.5), kitPrimary), `s.palette.primary = ${fmtRgb(at(p1, 0.5, 0.5))}, cần ${fmtRgb(kitPrimary)}`);
    assert.ok(near(at(p2, 0.5, 0.5), kitAccent), `field brandColor = ${fmtRgb(at(p2, 0.5, 0.5))}, cần ${fmtRgb(kitAccent)}`);
    assert.ok(near(at(p3, 0.5, 0.5), [255, 0, 0], 6), `logo kit ở giữa khung = ${fmtRgb(at(p3, 0.5, 0.5))}, cần #ff0000`);
    assert.ok(near(at(p3, 0.05, 0.05), [0, 0, 0]), 'ngoài logo vẫn là nền');
    const [n1, n2, n3] = await renderFrames(N.id, [0.5, 1.5, 2.5]);
    assert.ok(near(at(n1, 0.5, 0.5), hexRgb('#f08a12')), `không kit: palette cũ (${fmtRgb(at(n1, 0.5, 0.5))})`);
    assert.ok(near(at(n2, 0.5, 0.5), hexRgb('#00ff00')), `không kit: mặc định field trong code (${fmtRgb(at(n2, 0.5, 0.5))})`);
    assert.ok(near(at(n3, 0.5, 0.5), [0, 0, 0]), 'không kit: s.brand.logo = null');
    return `primary ${fmtRgb(at(p1, 0.5, 0.5))} · accent ${fmtRgb(at(p2, 0.5, 0.5))} · logo ${fmtRgb(at(p3, 0.5, 0.5))}`;
  });

  await step('font kit tải lên dùng thật trong render headless (đường khung MP4: override)', async () => {
    const textShot = (font) => shot('txt', `s.background('#000000');\ns.text('Brand Kit Fonts', { x: s.W / 2, y: s.H * 0.6, size: 220, weight: 700, font: '${font}', align: 'center', anim: 'none', shadow: false, color: '#ffffff' });`);
    const F = await json('POST', '/api/projects', { name: 'Font kit', brand: { id: K.kit.id, locked: true } });
    await json('PUT', `/api/projects/${F.id}`, { ...F, style: NEUTRAL_STYLE, shots: [textShot('heading')] });
    const proj = await json('GET', `/api/projects/${F.id}`); // the object renderProject() passes as override
    assert.ok(proj.brand.kit.fontFiles.length && proj.brand.kit.fonts.heading === proj.brand.kit.fontFiles[0].id);
    const [withKit] = await renderFrames(F.id, [0.5], { override: proj, scale: 0.5 });
    const [fallback] = await renderFrames(F.id, [0.5], { override: { ...proj, brand: null }, scale: 0.5 });
    const [cssFont] = await renderFrames(F.id, [0.5], { override: { ...proj, brand: null, shots: [textShot('serif')] }, scale: 0.5 });
    const dFallback = diffRatio(withKit, fallback);
    const dCss = diffRatio(withKit, cssFont);
    const lit = (img) => { let n = 0; for (let i = 0; i < img.data.length; i += img.ch) if (img.data[i] > 128) n++; return n / (img.w * img.h); };
    info(`chữ sáng: kit ${(lit(withKit) * 100).toFixed(2)}% · fallback ${(lit(fallback) * 100).toFixed(2)}% · lệch kit↔fallback ${(dFallback * 100).toFixed(2)}% · kit↔Playfair CSS ${(dCss * 100).toFixed(3)}%`);
    assert.ok(lit(withKit) > 0.01, 'có chữ được vẽ');
    assert.ok(dFallback > 0.01, `font kit phải khác font fallback (lệch ${(dFallback * 100).toFixed(2)}%)`);
    assert.ok(dCss < 0.002, `font kit phải trùng chính font đó nạp qua CSS (lệch ${(dCss * 100).toFixed(3)}%)`);
    return `lệch fallback ${(dFallback * 100).toFixed(1)}%, lệch cùng font ${(dCss * 100).toFixed(3)}%`;
  });
}

// ---------------------------------------------------------------- director + QA (offline)
async function offline() {
  const { runDirector, setAnthropicClient, setInspector, systemPrompt, BRAND_HEADER, BRIEF_HEADER } = await import('../server/director.js');
  const { qaIssues } = await import('../server/qa.js');
  const { defaultProject } = await import('../server/store.js');
  const kit = {
    name: 'Lumi QA', palette: [{ role: 'primary', color: '#12a4d9' }, { role: 'accent', color: '#e0115f' }, { role: 'text', color: '#fafafa' }],
    fonts: { heading: 'serif', body: 'sans' }, fontFiles: [], logo: { file: 'brand-l1.png' },
    requiredPhrases: ['Sáng từ bên trong'], bannedPhrases: ['rẻ nhất', 'cam kết 100%'], outro: { text: 'lumi.vn' },
  };
  await step('đạo diễn: khối BRAND KIT trong USER turn (trước BRIEF/NHIỆM VỤ), system prompt không đổi', async () => {
    const requests = [];
    setAnthropicClient({
      messages: {
        stream(params) {
          requests.push(structuredClone(params));
          const msg = { content: [{ type: 'tool_use', id: 'tu' + requests.length, name: params.tool_choice.name, input: { summary: 's', shots: [{ name: 'A', duration: 3, code: "s.background('#000');" }] } }], usage: { input_tokens: 1, output_tokens: 1 } };
          return { on() { return this; }, finalMessage: async () => msg };
        },
      },
    });
    setInspector(async () => ({ errors: {}, metrics: {}, sheet: null }));
    const base = () => { const p = defaultProject({ name: 'Brand dir' }); p.brief = { subject: 'Serum' }; return p; };
    const p0 = base();
    await runDirector(p0, { request: 'dựng', review: false });
    const p1 = base();
    p1.brand = { id: 'bq', version: 3, locked: false, kit };
    await runDirector(p1, { request: 'dựng', review: false });
    setAnthropicClient(null);
    setInspector(null);
    const texts = (r) => r.messages[0].content.filter((b) => b.type === 'text').map((b) => b.text);
    assert.ok(!texts(requests[0]).some((t) => t.startsWith('BRAND KIT')), 'không kit → không có khối BRAND KIT');
    const t1 = texts(requests[1]);
    const bi = t1.findIndex((t) => t.startsWith('BRAND KIT'));
    assert.ok(bi >= 0, 'có khối BRAND KIT');
    assert.ok(t1[bi].startsWith(BRAND_HEADER + '\n'));
    const j = JSON.parse(t1[bi].split('\n')[1]);
    assert.deepEqual(j.colors, { primary: '#12a4d9', accent: '#e0115f', text: '#fafafa' });
    assert.deepEqual(j.bannedPhrases, kit.bannedPhrases);
    assert.deepEqual(j.requiredPhrases, kit.requiredPhrases);
    assert.equal(j.logo, 'brand-logo');
    assert.equal(j.outro, 'lumi.vn');
    assert.ok(t1[bi + 1].startsWith(BRIEF_HEADER) && t1[bi + 2].startsWith('NHIỆM VỤ'), 'thứ tự: BRAND KIT → BRIEF → NHIỆM VỤ');
    for (const r of requests) assert.equal(r.system[0].text, systemPrompt(), 'system prompt giống hệt (cache)');
    assert.ok(!requests[1].system[0].text.includes('Lumi QA') && !requests[1].system[0].text.includes('rẻ nhất'), 'kit không lọt vào system');
    assert.deepEqual(requests[1].tools, requests[0].tools, 'tool schema không đổi');
  });

  await step('QA banned_phrase: code/mặc định field, giá trị field, lồng tiếng; khớp nguyên từ; không kit → không báo', async () => {
    const p = {
      width: 1920, height: 1080, voice: [{ text: 'Giá rẻ nhất thị trường', start: 2.5 }],
      shots: [
        shot('a', "const h = s.field('headline', 'Trắng da cam kết 100%', { label: 'Tiêu đề' });"),
        shot('b', "const h = s.field('headline', 'Sáng từ bên trong', { label: 'Tiêu đề' });", 1),
        shot('c', "s.text('Làn da trẻ nhất', { x: 100, y: 100, maxWidth: 800 });", 1),
      ],
      brand: { id: 'bq', version: 1, locked: true, kit },
    };
    p.shots[1].fields = { headline: 'Giá RẺ NHẤT' };
    const q = qaIssues(p, { metrics: {}, errors: {} });
    assert.ok(q.a?.some((x) => x.code === 'banned_phrase' && x.msg.includes('cam kết 100%')), 'mặc định field trong code');
    assert.ok(q.b?.some((x) => x.code === 'banned_phrase' && x.msg.includes('field "headline"')), 'giá trị field (không phân biệt hoa thường)');
    assert.ok(q.c?.some((x) => x.code === 'banned_phrase' && x.msg.includes('lồng tiếng')), 'câu lồng tiếng bắt đầu trong shot c');
    assert.ok(!q.c.some((x) => x.msg.includes('trẻ nhất')), '"trẻ nhất" không khớp "rẻ nhất" (nguyên từ)');
    assert.deepEqual(qaIssues({ ...p, brand: null }, { metrics: {}, errors: {} }), {}, 'không kit → không báo');
  });
}

async function main() {
  const t0 = Date.now();
  const exe = await pinnedChrome({ onWarn: warn });
  const srv = await startTempServer(DD, { env: { APP_PASSWORD: PW } });
  let browser = null;
  try {
    if (srv.error) { bad(srv.error); console.log(srv.log()); return 2; }
    BASE = `http://127.0.0.1:${srv.port}`;
    const state = {};
    await api(state);
    if (!exe) {
      const m = `test-brand cần Linux x64 (Chromium cố định) cho phần render; nền tảng ${process.platform}-${process.arch} — bỏ qua`;
      if (CI) bad(m); else warn(m);
    } else if (state.kit) {
      usePinnedChrome(exe);
      const { getBrowser } = await import('../server/render.js');
      browser = await getBrowser();
      await render(state);
    }
    await offline();
    info(`test-brand tổng ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    if (failed) console.log(srv.log().split('\n').slice(-20).join('\n'));
    return failed ? 1 : 0;
  } finally {
    if (browser) await browser.close().catch(() => {});
    srv.stop?.();
    await fsp.rm(DD, { recursive: true, force: true }).catch(() => {});
  }
}

main().then((code) => process.exit(code), (e) => { bad(`test-brand lỗi: ${e.stack || e.message}`); process.exit(2); });
