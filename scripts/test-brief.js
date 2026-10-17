// Test brief có cấu trúc (issue #9) — offline, không gọi API thật, không cần Chromium.
// usage: node scripts/test-brief.js
//   1. normalizeBrief: bỏ khoá lạ, trim/cắt độ dài, brief chuỗi cũ → { notes }, chip trùng
//   2. runDirector (client stub): user turn có khối BRIEF JSON gọn (trường trống bị bỏ), đặt
//      trước NHIỆM VỤ; system/tools không đổi; số lượt gọi API không đổi so với không có brief
//   3. server thật (process con): PUT đổi brief → snapshot "brief" gộp theo phiên; khôi phục
//      lịch sử → brief cũ; route đạo diễn nhận brief object (lưu vào dự án) và chuỗi (tương thích)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-test-'));
process.env.ANTHROPIC_API_KEY ||= 'test-offline-not-a-real-key';

const { runDirector, setAnthropicClient, systemPrompt, BRIEF_HEADER } = await import('../server/director.js');
const store = await import('../server/store.js');
const { defaultProject, normalizeBrief, normalizeProject, compactBrief, briefEqual } = store;

let passed = 0;
const ok = (name) => { passed++; console.log('PASS ', name); };

// ---- 1. normalizeBrief ----
assert.deepEqual(normalizeBrief('  Video 20s serum  '), { notes: 'Video 20s serum' });
assert.deepEqual(normalizeBrief(''), {});
assert.deepEqual(normalizeBrief(null), {});
assert.deepEqual(normalizeBrief([1, 2]), {});
const raw = {
  subject: '  Serum Lumi C+ ', message: '', moods: ['Sang trọng', ' sang trọng ', '', 42, 'Ấm áp'],
  duration: '20', aspect: '9:16', cta: 'x'.repeat(300), notes: '   ', evil: '<script>', __proto__x: 1,
};
const n = normalizeBrief(raw);
assert.deepEqual(Object.keys(n), ['subject', 'moods', 'duration', 'aspect', 'cta']);
assert.equal(n.subject, 'Serum Lumi C+');
assert.deepEqual(n.moods, ['Sang trọng', 'Ấm áp']);
assert.equal(n.duration, 20);
assert.equal(n.cta.length, 120);
assert.deepEqual(normalizeBrief({ duration: 1, aspect: '21:9' }), {});
assert.deepEqual(normalizeBrief({ duration: 999 }), {});
assert.deepEqual(normalizeBrief({ duration: '' }), {});
assert.equal(normalizeBrief({ moods: Array.from({ length: 20 }, (_, i) => 'm' + i) }).moods.length, 8);
assert.equal(normalizeProject({ brief: 'cũ', shots: [] }).brief.notes, 'cũ');
assert.deepEqual(defaultProject({}).brief, {});
assert.ok(briefEqual('abc', { notes: ' abc ' }));
assert.equal(compactBrief({ subject: '', notes: '' }), '');
ok('normalizeBrief: bỏ khoá lạ/trường trống, trim + cắt, chuỗi cũ → notes');

// ---- 2. runDirector nhận brief cấu trúc ----
const requests = [];
setAnthropicClient({
  messages: {
    stream(params) {
      const i = requests.length;
      requests.push(structuredClone(params));
      const msg = {
        content: [{ type: 'tool_use', id: 'tu' + i, name: params.tool_choice.name, input: { summary: 's' + i, shots: [{ name: 'A', duration: 3, code: 'this is (not valid js' }] } }],
        usage: { input_tokens: 10, output_tokens: 5 },
      };
      return { on() { return this; }, finalMessage: async () => msg };
    },
  },
});
const base = () => {
  const p = defaultProject({ name: 'Test brief' });
  p.shots = [{ id: 's1', name: 'Mở', duration: 3, transition: { type: 'cut' }, code: 's.bg("#000")', notes: '' }];
  return p;
};
const userBlocks = (r) => r.messages[0].content.filter((b) => b.type === 'text').map((b) => b.text);

// a) không có brief → baseline số lượt + không có khối BRIEF
const p0 = base();
await runDirector(p0, { request: 'cắt nhanh hơn', review: false });
const baseline = requests.splice(0);
assert.ok(!userBlocks(baseline[0]).some((t) => t.startsWith('BRIEF')), 'brief trống → không gửi khối BRIEF');

// b) brief cấu trúc trong project (có trường trống)
const p1 = base();
p1.brief = { subject: 'Serum Lumi C+', message: '', moods: ['Sang trọng', 'Ấm áp'], duration: 20, aspect: '', cta: 'Đặt hàng ngay', notes: '' };
const out1 = await runDirector(p1, { request: 'cắt nhanh hơn', review: false });
const withBrief = requests.splice(0);
assert.equal(withBrief.length, baseline.length, 'số lượt gọi API không đổi khi có brief');
const expectJson = '{"subject":"Serum Lumi C+","moods":["Sang trọng","Ấm áp"],"duration":20,"cta":"Đặt hàng ngay"}';
for (const r of withBrief) {
  const texts = userBlocks(r);
  const bi = texts.findIndex((t) => t.startsWith('BRIEF'));
  assert.ok(bi >= 0, 'có khối BRIEF trong user turn mở đầu');
  assert.equal(texts[bi], `${BRIEF_HEADER}\n${expectJson}`, 'brief là JSON gọn, đúng thứ tự trường');
  const json = JSON.parse(texts[bi].split('\n')[1]);
  for (const k of ['message', 'aspect', 'notes']) assert.ok(!(k in json), `trường trống "${k}" bị bỏ`);
  assert.ok(texts.at(-1).startsWith('NHIỆM VỤ: ') && texts.at(-1).includes('cắt nhanh hơn'), 'NHIỆM VỤ vẫn là khối cuối, chứa yêu cầu');
  assert.equal(bi, texts.length - 2, 'BRIEF ngay trước NHIỆM VỤ');
  assert.equal(r.system[0].text, systemPrompt(), 'system prompt (cache) không đổi');
  assert.ok(!r.system[0].text.includes('Serum Lumi C+'), 'brief không lọt vào system');
  assert.deepEqual(r.tools, baseline[0].tools, 'tool schema không đổi');
  assert.deepEqual(r.messages[0].content.at(-1).cache_control, { type: 'ephemeral' }, 'breakpoint vẫn ở khối cuối turn mở đầu');
}
assert.deepEqual(withBrief[1].messages[0], withBrief[0].messages[0], 'turn mở đầu giống hệt giữa các vòng (cache)');
assert.deepEqual(normalizeBrief(out1.brief), normalizeBrief(p1.brief), 'đạo diễn không ghi đè brief của dự án');
assert.equal(out1.lastDirector.brief, 'cắt nhanh hơn');
ok('đạo diễn nhận brief JSON gọn trong user turn, bỏ trường trống, không thêm lượt gọi, cache prefix ổn định');

// c) tương thích: brief chuỗi (yêu cầu cũ) + dự án mới không shot
const p2 = defaultProject({ name: 'Mới' });
p2.brief = { subject: 'Bánh trung thu' };
await runDirector(p2, { brief: 'Video 15s', review: false });
const legacy = requests.splice(0);
const t2 = userBlocks(legacy[0]);
assert.equal(t2.at(-1), 'NHIỆM VỤ: Dựng video mới từ brief: Video 15s');
assert.ok(t2.includes(`${BRIEF_HEADER}\n{"subject":"Bánh trung thu"}`));
const p3 = defaultProject({ name: 'Mới 2' });
p3.brief = { notes: 'cận cảnh bánh' };
await runDirector(p3, { review: false });
assert.equal(userBlocks(requests.splice(0)[0]).at(-1), 'NHIỆM VỤ: Dựng video mới từ brief: theo BRIEF ở trên');
ok('tương thích brief chuỗi; dựng mới không yêu cầu → theo BRIEF');

// ---- 3. server thật: snapshot "brief", khôi phục, route đạo diễn ----
const PORT = Number(process.env.TEST_BRIEF_PORT || 5397);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const child = spawn(process.execPath, ['server/index.js'], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: process.env.DATA_DIR, ANTHROPIC_API_KEY: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', (d) => (log += d));
child.stderr.on('data', (d) => (log += d));
try {
  for (let i = 0; ; i++) {
    if (child.exitCode != null || i > 60) throw new Error('server không khởi động:\n' + log);
    try { if ((await fetch(BASE + '/api/projects')).ok) break; } catch { /* not yet */ }
    await sleep(250);
  }
  const api = async (method, url, body) => {
    const r = await fetch(BASE + url, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    const data = await r.json();
    if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${data.error}`);
    return data;
  };
  let p = await api('POST', '/api/projects', { name: 'Brief HTTP' });
  assert.deepEqual(p.brief, {});
  p = await api('PUT', `/api/projects/${p.id}`, { ...p, brief: { subject: ' Serum ', foo: 1, moods: ['Tươi mới'] } });
  assert.deepEqual(p.brief, { subject: 'Serum', moods: ['Tươi mới'] }, 'PUT chuẩn hoá brief');
  let hist = await api('GET', `/api/projects/${p.id}/history`);
  assert.deepEqual(hist.map((x) => x.reason), ['brief'], 'sửa brief → snapshot "brief"');
  p = await api('PUT', `/api/projects/${p.id}`, { ...p, brief: { ...p.brief, cta: 'Mua ngay' } });
  p = await api('PUT', `/api/projects/${p.id}`, { ...p, name: 'Đổi tên' });
  hist = await api('GET', `/api/projects/${p.id}/history`);
  assert.equal(hist.length, 1, 'gõ liên tục trong một phiên không tạo thêm snapshot; lưu không đổi brief không snapshot');
  assert.equal(store.historyStampMs(hist[0].at) > 0, true);
  // dự án mở từ "máy khác" = GET lại từ server
  assert.deepEqual((await api('GET', `/api/projects/${p.id}`)).brief, { subject: 'Serum', moods: ['Tươi mới'], cta: 'Mua ngay' });
  // khôi phục snapshot "brief" → brief trước khi sửa (trống)
  p = await api('POST', `/api/projects/${p.id}/history/${encodeURIComponent(hist[0].file)}/restore`);
  assert.deepEqual(p.brief, {}, 'khôi phục → brief cũ');
  hist = await api('GET', `/api/projects/${p.id}/history`);
  assert.equal(hist[0].reason, 'before-restore');
  const back = await api('POST', `/api/projects/${p.id}/history/${encodeURIComponent(hist[0].file)}/restore`);
  assert.equal(back.brief.cta, 'Mua ngay', 'khôi phục bản trước-khi-khôi-phục → brief mới quay lại');
  // gộp theo phiên: hết khoảng cách → snapshot mới
  assert.equal(await store.shouldSnapshotBrief(p.id, store.BRIEF_SNAPSHOT_GAP_MS, Date.now()), true, 'snapshot mới nhất không phải "brief" → snapshot');
  // route đạo diễn: brief object được lưu (snapshot "brief"), chuỗi vẫn nhận
  const j1 = await api('POST', `/api/projects/${p.id}/director`, { brief: { subject: 'Từ route', bad: 1 }, request: 'nhanh hơn' });
  assert.equal(j1.kind, 'director');
  const saved = await api('GET', `/api/projects/${p.id}`);
  assert.deepEqual(saved.brief, { subject: 'Từ route' }, 'route lưu brief object vào dự án');
  hist = await api('GET', `/api/projects/${p.id}/history`);
  assert.equal(hist[0].reason, 'brief');
  const j2 = await api('POST', `/api/projects/${p.id}/director`, { brief: 'chuỗi cũ' });
  assert.equal(j2.kind, 'director');
  assert.deepEqual((await api('GET', `/api/projects/${p.id}`)).brief, { subject: 'Từ route' }, 'brief chuỗi không ghi đè brief cấu trúc');
  ok('server: snapshot "brief" theo phiên, khôi phục được, route đạo diễn nhận object + chuỗi');
  // shouldSnapshotBrief: trong khoảng cách → false, sau → true
  const now = store.historyStampMs(hist[0].at);
  assert.equal(await store.shouldSnapshotBrief(p.id, 120000, now + 1000), false);
  assert.equal(await store.shouldSnapshotBrief(p.id, 120000, now + 121000), true);
  ok('shouldSnapshotBrief gộp theo khoảng cách thời gian');
} finally {
  child.kill('SIGKILL');
  await new Promise((r) => (child.exitCode != null ? r() : child.once('exit', r)));
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
}
console.log(`\n${passed} nhóm kiểm tra PASS`);
