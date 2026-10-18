// QA metrics + director guard tests (part of `npm run check`).
//
//   node scripts/test-qa.js
//
// 1. Detection — the deliberately broken fixture shots in test/qa/shots/ (black, blank,
//    text outside the safe area, > 500 ms/frame, runtime throw) plus one healthy shot are
//    rendered through the SAME path the AI director uses (server/render.js inspectProject →
//    window.__inspect → server/qa.js qaIssues), in the pinned Chromium on a temp server.
//    Every broken shot must raise its expected issue (100%); the healthy shot raises none.
// 2. Director guard (mock, no API call) — the Anthropic client is stubbed via
//    setAnthropicClient: a shot whose final round still throws must keep its previous
//    working code and get `needsReview`; QA issues must reach the director's feedback.
// 3. needsReview persistence — normalize/clear rules in server/store.js.
//
// Each fixture file starts with `// expect: <code>` (code from QA_CODES, or `none`).
// Exit code: 0 pass, 1 fail, 2 setup error. Non-Linux: skipped locally, FAIL on CI (like golden).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ROOT, pinnedChrome, usePinnedChrome, startTempServer } from './lib/test-env.js';

const CI = !!process.env.CI;
const GH = !!process.env.GITHUB_ACTIONS;
let failed = false;
const ok = (m) => console.log(`PASS  ${m}`);
const bad = (m) => { console.log(`FAIL  ${m}`); failed = true; if (GH) console.log(`::error::${m}`); };
const warn = (m) => { console.log(`WARN  ${m}`); if (GH) console.log(`::warning::${m}`); };
const info = (m) => console.log(`      ${m}`);
const check = (name, fn) => {
  try { fn(); ok(name); } catch (e) { bad(`${name} — ${e.message}`); }
};

function loadFixtures() {
  const dir = path.join(ROOT, 'test/qa/shots');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort().map((f, i) => {
    const code = fs.readFileSync(path.join(dir, f), 'utf8');
    const expect = (code.match(/^\/\/ expect: (\S+)/m) || [])[1];
    if (!expect) throw new Error(`${f}: thiếu dòng "// expect: <code>"`);
    return { file: f, expect, shot: { id: `qa${i}`, name: f.replace(/\.js$/, ''), duration: 3, transition: { type: 'cut' }, code, notes: '', fields: {} } };
  });
}

/** A realistic style (warm grade, vignette, grain): pixel stats must still see a flat frame. */
function qaProject(shots, id = 'pqa') {
  return {
    id, name: 'QA fixtures', width: 1920, height: 1080, fps: 30, brief: '',
    style: { grade: 'warm', vignette: 0.35, grain: 0.05, bloom: 0.25, letterbox: 0, palette: { primary: '#f08a12', accent: '#f5b54a', text: '#ffffff' } },
    assets: [], shots, voice: [], music: null, exports: [],
    // Brand Kit snapshot (#8): same colors as the palette above (pixels unchanged) + a banned phrase
    brand: { id: 'bqa', version: 1, locked: true, kit: {
      name: 'QA kit', palette: [{ role: 'primary', color: '#f08a12' }, { role: 'accent', color: '#f5b54a' }, { role: 'text', color: '#ffffff' }],
      fonts: { heading: 'sans', body: 'sans' }, fontFiles: [], bannedPhrases: ['cam kết 100%'], requiredPhrases: [],
    } },
  };
}

async function detection() {
  const { inspectProject } = await import('../server/render.js');
  const { qaIssues, QA_CODES } = await import('../server/qa.js');
  const fx = loadFixtures();
  const project = qaProject(fx.map((f) => f.shot));
  const insp = await inspectProject(project, { framesPerShot: 3 });
  if (insp.errors?._page) { bad(`inspect lỗi trang: ${insp.errors._page}`); return; }
  const issues = qaIssues(project, insp);
  let hit = 0, broken = 0;
  for (const f of fx) {
    const got = (issues[f.shot.id] || []).map((x) => x.code);
    const sm = insp.metrics?.[f.shot.id]?.samples || [];
    info(`${f.file}: ${sm.map((m) => `t=${m.t.toFixed(1)} sáng ${m.mean.toFixed(1)} σ${m.std.toFixed(1)} ${m.ms == null ? '?' : Math.round(m.ms)}ms chữ ${m.text.length}`).join(' | ')}`);
    if (f.expect === 'none') {
      if (got.length) bad(`${f.file}: shot lành bị báo lỗi: ${(issues[f.shot.id] || []).map((x) => x.msg).join(' | ')}`);
      else ok(`${f.file}: shot lành không bị báo lỗi`);
      continue;
    }
    if (!QA_CODES.includes(f.expect)) { bad(`${f.file}: expect "${f.expect}" không có trong QA_CODES`); continue; }
    broken++;
    if (got.includes(f.expect)) {
      hit++;
      ok(`${f.file}: phát hiện ${f.expect} — ${(issues[f.shot.id] || []).find((x) => x.code === f.expect).msg}`);
      const extra = got.filter((c) => c !== f.expect);
      if (extra.length) info(`(kèm: ${extra.join(', ')})`);
    } else bad(`${f.file}: KHÔNG phát hiện ${f.expect} (nhận: ${got.join(', ') || 'không có'})`);
  }
  const covered = new Set(fx.map((f) => f.expect));
  for (const c of QA_CODES) if (!covered.has(c)) bad(`thiếu fixture cho loại lỗi ${c}`);
  const pct = broken ? Math.round((hit / broken) * 100) : 0;
  info(`phát hiện ${hit}/${broken} shot lỗi (${pct}%)`);
  // one-line CI annotation, readable from the PR without opening logs
  if (GH) {
    const healthy = fx.filter((f) => f.expect === 'none').map((f) => `${f.file} ${(issues[f.shot.id] || []).length} lỗi`).join(', ');
    console.log(`::notice title=test-qa::phát hiện ${hit}/${broken} shot cố ý lỗi (${pct}%) · ${healthy}`);
  }
  assert.ok(typeof insp.sheet === 'string' && insp.sheet.length > 1000, 'contact sheet vẫn được trả về');
}

// ---- director guard with a stubbed Anthropic client ----
const GOOD_A = "s.background(['#2a4a6a', '#0a1622']);\ns.text('Bản chạy được', { x: s.W / 2, y: s.H / 2, size: 90, align: 'center', anim: 'none' });";
const GOOD_B = "s.background(['#5a3a1a', '#140a04']);\ns.text('Shot B', { x: s.W / 2, y: s.H / 2, size: 90, align: 'center', anim: 'none' });";
const BROKEN_A = "s.background('#223');\nconst x = undefined;\ns.text(x.label, {});";
const BROKEN_C = "s.background('#232');\nnull.boom();";

function stubClient(replies) {
  const requests = [];
  return {
    requests,
    client: {
      messages: {
        stream(params) {
          const i = requests.length;
          requests.push(structuredClone(params));
          const input = replies[Math.min(i, replies.length - 1)];
          const msg = { content: [{ type: 'tool_use', id: 'tu' + i, name: params.tool_choice.name, input }], usage: { input_tokens: 10, output_tokens: 20 } };
          return { on() { return this; }, finalMessage: async () => msg };
        },
      },
    },
  };
}

const userText = (req) => {
  const last = req.messages.at(-1);
  return (Array.isArray(last.content) ? last.content : []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
};

async function directorGuard() {
  process.env.ANTHROPIC_API_KEY ||= 'test-offline-not-a-real-key';
  const { runDirector, setAnthropicClient, guardFailedShots } = await import('../server/director.js');
  const base = qaProject([
    { id: 'sA', name: 'A', duration: 2, transition: { type: 'cut' }, code: GOOD_A, notes: '', fields: { k: 'v' } },
    { id: 'sB', name: 'B', duration: 2, transition: { type: 'cut' }, code: GOOD_B, notes: '', fields: {} },
  ], 'pguard');

  // Scenario 1 (review=true, 3 rounds): round 1 fine → contact-sheet review → director breaks A
  // and adds a broken new shot C → still broken in the final round.
  {
    const broken = { summary: 'sửa', shots: [{ id: 'sA', name: 'A', duration: 2.5, code: BROKEN_A }, { id: 'sB', name: 'B', duration: 2, code: GOOD_B }, { name: 'C', duration: 2, code: BROKEN_C }] };
    const st = stubClient([{ summary: 'v1', shots: [{ id: 'sA', name: 'A', duration: 2, code: GOOD_A }, { id: 'sB', name: 'B', duration: 2, code: GOOD_B }] }, broken, broken]);
    setAnthropicClient(st.client);
    const logs = [];
    const next = await runDirector(base, { brief: 'test guard', review: true, log: (l) => logs.push(l) });
    check('guard: đạo diễn được gọi 3 lượt (dựng, duyệt sheet, sửa lỗi)', () => assert.equal(st.requests.length, 3));
    check('guard: vòng sửa lỗi nhận mô tả lỗi runtime', () => assert.match(userText(st.requests[2]), /Render thử báo lỗi:[\s\S]*Shot "A"[\s\S]*Lỗi khi chạy/));
    const A = next.shots.find((s) => s.id === 'sA');
    const B = next.shots.find((s) => s.id === 'sB');
    const C = next.shots.find((s) => s.name === 'C');
    check('guard: shot lỗi runtime ở vòng cuối KHÔNG ghi đè code đang chạy được', () => {
      assert.equal(A.code, GOOD_A);
      assert.equal(A.duration, 2);
      assert.deepEqual(A.fields, { k: 'v' });
    });
    check('guard: shot giữ code cũ được gắn needsReview { reason, at }', () => {
      assert.ok(A.needsReview && typeof A.needsReview.reason === 'string' && A.needsReview.reason.includes('Lỗi khi chạy'));
      assert.ok(!Number.isNaN(Date.parse(A.needsReview.at)));
    });
    check('guard: shot lành không bị gắn cờ', () => { assert.equal(B.code, GOOD_B); assert.equal(B.needsReview, undefined); });
    check('guard: shot mới chưa từng chạy được vẫn giữ nhưng gắn cờ', () => { assert.ok(C && C.code === BROKEN_C && C.needsReview?.reason.includes('chưa có bản chạy được')); });
    check('guard: log job ghi việc giữ code cũ', () => assert.ok(logs.some((l) => l.includes('giữ code cũ chạy được'))));
  }

  // Scenario 2 (review=false): a black shot is reported to the director as a QA issue (text),
  // the fix is accepted, nothing gets flagged.
  {
    const st = stubClient([
      { summary: 'v1', shots: [{ id: 'sA', name: 'A', duration: 2, code: "s.background('#000');" }, { id: 'sB', name: 'B', duration: 2, code: GOOD_B }] },
      { summary: 'v2', shots: [{ id: 'sA', name: 'A', duration: 2, code: GOOD_A }, { id: 'sB', name: 'B', duration: 2, code: GOOD_B }] },
    ]);
    setAnthropicClient(st.client);
    const next = await runDirector(base, { brief: 'test qa feedback', review: false, log: () => {} });
    check('qa feedback: khung đen được gửi cho đạo diễn dạng text', () => {
      assert.equal(st.requests.length, 2);
      assert.match(userText(st.requests[1]), /Số liệu QA[\s\S]*Shot "A" \(id sA\): khung đen/);
    });
    check('qa feedback: bản sửa được nhận, không gắn cờ', () => { assert.equal(next.shots[0].code, GOOD_A); assert.ok(next.shots.every((s) => !s.needsReview)); });
  }
  setAnthropicClient(null);

  // Pure guard: missing-asset warnings are not runtime failures.
  check('guard: cảnh báo thiếu chất liệu không bị coi là lỗi runtime', () => {
    const p = structuredClone(base);
    const kept = guardFailedShots(p, { sA: 'Không tìm thấy chất liệu "x"' }, { byId: new Map(), byName: new Map() });
    assert.equal(kept.length, 0);
    assert.equal(p.shots[0].needsReview, undefined);
  });
}

async function storeRules() {
  const { normalizeProject, clearStaleReview, saveProject, loadProject } = await import('../server/store.js');
  const p = qaProject([
    { id: 's1', name: 'a', duration: 2, code: 'x', fields: {}, needsReview: { reason: 'lỗi', at: '2026-10-17T00:00:00Z' } },
    { id: 's2', name: 'b', duration: 2, code: 'y', fields: {}, needsReview: { reason: '' } },
    { id: 's3', name: 'c', duration: 2, code: 'z', fields: {}, needsReview: 'bad' },
  ], 'pstore');
  normalizeProject(p);
  check('store: needsReview hợp lệ được giữ, sai dạng bị bỏ', () => {
    assert.deepEqual(p.shots[0].needsReview, { reason: 'lỗi', at: '2026-10-17T00:00:00Z' });
    assert.equal('needsReview' in p.shots[1], false);
    assert.equal('needsReview' in p.shots[2], false);
  });
  await saveProject(p);
  const back = await loadProject('pstore');
  check('store: needsReview được lưu và đọc lại', () => assert.deepEqual(back.shots[0].needsReview, p.shots[0].needsReview));
  const edited = structuredClone(back.shots);
  const same = structuredClone(back.shots);
  edited[0].code = 'x2';
  clearStaleReview(back.shots, edited);
  clearStaleReview(back.shots, same);
  check('store: sửa code của shot → cờ needsReview tự bỏ; không sửa → giữ', () => {
    assert.equal(edited[0].needsReview, undefined);
    assert.ok(same[0].needsReview);
  });
}

async function main() {
  const t0 = Date.now();
  const exe = await pinnedChrome({ onWarn: warn });
  if (!exe) {
    const m = `test-qa cần Linux x64 (Chromium cố định từ @sparticuz/chromium); nền tảng ${process.platform}-${process.arch} — bỏ qua`;
    if (CI) { bad(m); return 1; }
    warn(m + ' (đặt CHROME_PATH để chạy thử)');
    return 0;
  }
  usePinnedChrome(exe);
  const DD = await fsp.mkdtemp(path.join(os.tmpdir(), 'qa-'));
  process.env.DATA_DIR = DD; // store.js (imported below) and the temp server share it
  const srv = await startTempServer(DD);
  let browser = null;
  try {
    if (srv.error) { bad(srv.error); console.log(srv.log()); return 2; }
    const { getBrowser } = await import('../server/render.js');
    browser = await getBrowser();
    info(`Chromium ${browser.version()}`);
    await detection();
    await directorGuard();
    await storeRules();
    info(`test-qa tổng ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    if (GH) console.log(`::notice title=test-qa::${failed ? 'FAIL' : 'PASS'} · guard đạo diễn + needsReview · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return failed ? 1 : 0;
  } finally {
    if (browser) await browser.close().catch(() => {});
    srv.stop?.();
    await fsp.rm(DD, { recursive: true, force: true }).catch(() => {});
  }
}

main().then((code) => process.exit(code), (e) => { bad(`test-qa lỗi: ${e.stack || e.message}`); process.exit(2); });
