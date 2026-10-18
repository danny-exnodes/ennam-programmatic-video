// Test offline vòng duyệt của đạo diễn (#5b): approve_cut + patch_shots — không gọi API thật,
// không cần Chromium (client Anthropic và bước render thử đều được thay bằng stub).
// usage: node scripts/test-director-review.js
//   a. vòng 0 ép submit_cut; vòng duyệt tool_choice {type:'any'}
//   b. approve_cut → dự án giữ y nguyên kết quả vòng 0, output token vòng duyệt nhỏ
//   c. patch_shots chỉ đổi shot được nhắm; shot khác giữ code byte-by-byte; id lạ bị bỏ qua; xoá/chèn
//   d. tools + system + user turn mở đầu giống hệt từng byte giữa mọi lượt (cache-safe)
//   e. patch gây lỗi runtime ở vòng cuối → guard giữ code cũ + needsReview
//   f. "Nhờ đạo diễn" một shot: tools [submit_shot, approve_cut]; approve giữ shot
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dir-review-'));
process.env.ANTHROPIC_API_KEY ||= 'test-offline-not-a-real-key';

const { runDirector, setAnthropicClient, setInspector, systemPrompt } = await import('../server/director.js');
const { defaultProject } = await import('../server/store.js');

let passed = 0;
const ok = (name) => { passed++; console.log('PASS ', name); };

// Output token giả lập ≈ độ dài JSON input / 4 (đủ để so tỉ lệ approve/patch với nộp cả bản dựng).
const tokensOf = (input) => Math.ceil(JSON.stringify(input).length / 4);
function stub(replies) {
  const requests = [];
  setAnthropicClient({
    messages: {
      stream(params) {
        const i = requests.length;
        requests.push(structuredClone(params));
        const rep = replies[Math.min(i, replies.length - 1)];
        const msg = {
          content: [{ type: 'tool_use', id: 'tu' + i, name: rep.name, input: rep.input }],
          usage: { input_tokens: 100, output_tokens: tokensOf(rep.input), cache_read_input_tokens: i ? 9000 : 0, cache_creation_input_tokens: i ? 0 : 9000 },
        };
        return { on() { return this; }, finalMessage: async () => msg };
      },
    },
  });
  return requests;
}

// Render thử giả: shot có "BOOM" trong code → lỗi runtime; còn lại chạy được, có contact sheet.
const inspected = [];
setInspector(async (p) => {
  inspected.push(p.shots.map((s) => s.code));
  const errors = {};
  for (const s of p.shots) if (s.code.includes('BOOM')) errors[s.id] = 'Lỗi khi chạy: BOOM is not defined';
  return { errors, metrics: {}, sheet: 'A'.repeat(2000), width: p.width, height: p.height };
});

const body = (tag) => `s.background(['#2a4a6a', '#0a1622']);\n` + Array.from({ length: 12 }, (_, i) => `s.text(s.field('t${i}', '${tag} dòng ${i}', { label: 'Dòng ${i}' }), { x: s.W / 2, y: ${100 + i * 60}, size: 40, align: 'center', maxWidth: s.W * 0.8 });`).join('\n');
const A1 = body('A1'), B1 = body('B1'), C1 = body('C1'), B2 = body('B2');
const BOOM = body('B3') + '\nBOOM();';

const base = () => {
  const p = defaultProject({ name: 'Test review' });
  p.shots = [
    { id: 'sA', name: 'A', duration: 3, transition: { type: 'cut' }, code: 's.bg("#000")', notes: '', fields: { t0: 'giữ A' } },
    { id: 'sB', name: 'B', duration: 3, transition: { type: 'fade' }, code: 's.bg("#111")', notes: 'b', fields: { t1: 'giữ B' } },
    { id: 'sC', name: 'C', duration: 3, transition: { type: 'cut' }, code: 's.bg("#222")', notes: '', fields: {} },
  ];
  return p;
};
const CUT = { name: 'submit_cut', input: { summary: 'Bản dựng v1', shots: [
  { id: 'sA', name: 'A', duration: 3, transition: { type: 'cut' }, code: A1, notes: 'a' },
  { id: 'sB', name: 'B', duration: 3.5, transition: { type: 'fade', duration: 0.4 }, code: B1, notes: 'b' },
  { id: 'sC', name: 'C', duration: 3, transition: { type: 'cut' }, code: C1, notes: 'c' },
] } };
const lastUserText = (req) => req.messages.at(-1).content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');

// Kết quả vòng 0 tham chiếu: review=false + render thử sạch → chỉ 1 lượt.
stub([CUT]);
const round0 = await runDirector(base(), { brief: 'test', review: false });
assert.equal(round0.lastDirector.usage.rounds.length, 1);

// ---- a + b: approve_cut ----
{
  const req = stub([CUT, { name: 'approve_cut', input: { notes: 'Đạt.' } }]);
  const logs = [];
  const p = base();
  const before = JSON.stringify(p);
  const next = await runDirector(p, { brief: 'test', review: true, log: (l) => logs.push(l) });
  assert.equal(req.length, 2, 'dựng + 1 vòng duyệt');
  assert.deepEqual(req[0].tool_choice, { type: 'tool', name: 'submit_cut' }, 'vòng 0 ép submit_cut');
  assert.deepEqual(req[1].tool_choice, { type: 'any', disable_parallel_tool_use: true }, 'vòng duyệt cho chọn tool');
  assert.match(lastUserText(req[1]), /approve_cut[\s\S]*patch_shots/, 'prompt duyệt hướng dẫn approve_cut/patch_shots');
  assert.match(lastUserText(req[1]), /Shot hiện tại \(id: tên\): sA: A · sB: B · sC: C/, 'vòng duyệt liệt kê id hiện tại');
  ok('a. vòng 0 ép submit_cut, vòng duyệt tool_choice any + prompt mới');

  assert.equal(JSON.stringify(next.shots), JSON.stringify(round0.shots), 'approve → shots y nguyên kết quả vòng 0');
  assert.deepEqual(next.style, round0.style);
  assert.deepEqual(next.voice, round0.voice);
  assert.equal(JSON.stringify(p), before, 'không mutate dự án đầu vào');
  assert.equal(next.lastDirector.summary, 'Bản dựng v1', 'summary giữ của bản dựng');
  assert.deepEqual(next.lastDirector.tools, ['submit_cut', 'approve_cut']);
  assert.equal(inspected.at(-1).join('\n'), [A1, B1, C1].join('\n'));
  const [u0, u1] = next.lastDirector.usage.rounds;
  assert.ok(u1.output_tokens < 20 && u1.output_tokens <= u0.output_tokens * 0.4, `output vòng duyệt nhỏ (${u1.output_tokens} vs ${u0.output_tokens})`);
  assert.ok(logs.some((l) => l.startsWith('Đạo diễn duyệt bản hiện tại, không viết lại: Đạt.')));
  assert.ok(logs.some((l) => l.startsWith('Token lượt 2: ') && l.endsWith('(approve_cut)')));
  ok(`b. approve_cut: dự án = kết quả vòng 0, không viết lại (output ${u1.output_tokens} vs ${u0.output_tokens} token)`);
}

// ---- c: patch_shots ----
{
  const req = stub([CUT, { name: 'patch_shots', input: { summary: 'Sửa chữ shot B.', shots: [{ id: 'sB', code: B2 }] } }]);
  const next = await runDirector(base(), { brief: 'test', review: true });
  assert.equal(req.length, 2);
  const [A, B, C] = next.shots;
  assert.deepEqual(next.shots.map((s) => s.id), ['sA', 'sB', 'sC']);
  assert.equal(A.code, A1); assert.equal(C.code, C1);
  assert.equal(JSON.stringify(A), JSON.stringify(round0.shots[0]), 'shot A byte-identical');
  assert.equal(JSON.stringify(C), JSON.stringify(round0.shots[2]), 'shot C byte-identical');
  assert.equal(B.code, B2, 'shot B đổi code');
  assert.equal(B.duration, 3.5); assert.deepEqual(B.transition, { type: 'fade', duration: 0.4 }); assert.equal(B.notes, 'b');
  assert.deepEqual(B.fields, { t1: 'giữ B' }, 'fields người dùng giữ theo id');
  assert.equal(next.lastDirector.summary, 'Bản dựng v1 Sửa chữ shot B.');
  const [u0, u1] = next.lastDirector.usage.rounds;
  assert.ok(u1.output_tokens < u0.output_tokens * 0.4, `patch 1 shot nhỏ hơn nhiều so với cả bản dựng (${u1.output_tokens} vs ${u0.output_tokens})`);
  ok(`c. patch_shots chỉ đổi shot B, A/C giữ nguyên từng byte (output ${u1.output_tokens} vs ${u0.output_tokens})`);

  const logs = [];
  stub([CUT, { name: 'patch_shots', input: {
    summary: 'Cắt C, thêm N.',
    shots: [{ id: 'nope', code: 'x' }, { id: 'sA', duration: 2.5 }],
    remove: ['sC', 'ghost'],
    insert: [{ after: 'sA', shot: { name: 'N', duration: 2, code: C1 } }, { after: '', shot: { name: 'Mở', duration: 2, code: A1 } }],
  } }]);
  const n2 = await runDirector(base(), { brief: 'test', review: true, log: (l) => logs.push(l) });
  assert.deepEqual(n2.shots.map((s) => s.name), ['Mở', 'A', 'N', 'B']);
  assert.equal(n2.shots[1].duration, 2.5); assert.equal(n2.shots[1].code, A1);
  assert.ok(n2.shots[2].id && !['sA', 'sB', 'sC'].includes(n2.shots[2].id));
  assert.deepEqual(n2.shots[2].fields, {});
  assert.ok(logs.some((l) => l.includes('bỏ qua shot id lạ "nope"')), 'log id lạ');
  assert.ok(logs.some((l) => l.includes('bỏ qua xoá shot id lạ "ghost"')));
  ok('c. patch_shots: id lạ bị bỏ qua (có log), xoá + chèn theo vị trí, chỉ trường gửi lên bị đổi');
}

// ---- d + e: patch gây lỗi runtime tới vòng cuối; prefix cache giống hệt mọi lượt ----
{
  const req = stub([CUT, { name: 'patch_shots', input: { summary: 'Thử hiệu ứng.', shots: [{ id: 'sB', code: BOOM }] } }, { name: 'patch_shots', input: { summary: 'Sửa lại.', shots: [{ id: 'sB', code: BOOM + '\n// v2' }] } }]);
  const logs = [];
  const next = await runDirector(base(), { brief: 'test', review: true, log: (l) => logs.push(l) });
  assert.equal(req.length, 3, 'dựng, duyệt sheet, sửa lỗi');
  const sig = (r) => JSON.stringify({ model: r.model, tools: r.tools, system: r.system, first: r.messages[0] });
  assert.equal(sig(req[1]), sig(req[0]), 'lượt 2: tools/system/turn mở đầu giống hệt lượt 1');
  assert.equal(sig(req[2]), sig(req[0]), 'lượt 3: tools/system/turn mở đầu giống hệt lượt 1');
  assert.deepEqual(req[0].tools.map((t) => t.name), ['submit_cut', 'approve_cut', 'patch_shots']);
  assert.equal(req[0].system[0].text, systemPrompt());
  assert.deepEqual(req.map((r) => r.tool_choice.type), ['tool', 'any', 'any'], 'chỉ tool_choice đổi giữa các vòng');
  assert.deepEqual(req[2].messages[0].content.at(-1).cache_control, { type: 'ephemeral' });
  ok('d. tools + system + user turn mở đầu giống hệt từng byte giữa 3 lượt (chỉ tool_choice đổi)');

  assert.match(lastUserText(req[2]), /Render thử báo lỗi:[\s\S]*Shot "B"[\s\S]*Lỗi khi chạy[\s\S]*patch_shots/);
  const [A, B, C] = next.shots;
  assert.equal(B.code, B1, 'shot lỗi runtime ở vòng cuối không ghi đè bản chạy được');
  assert.equal(B.duration, 3.5);
  assert.deepEqual(B.fields, { t1: 'giữ B' });
  assert.ok(B.needsReview?.reason.includes('Lỗi khi chạy'), 'gắn needsReview');
  assert.equal(A.code, A1); assert.equal(C.code, C1);
  assert.ok(!A.needsReview && !C.needsReview);
  assert.ok(logs.some((l) => l.includes('giữ code cũ chạy được')));
  ok('e. patch lỗi runtime ở vòng cuối → giữ code cũ + needsReview, shot khác không đổi');
}

// ---- f: "Nhờ đạo diễn" một shot ----
{
  const SHOT = { name: 'submit_shot', input: { summary: 'Shot B mới', shot: { id: 'sB', name: 'B', duration: 3, code: B2 } } };
  const req = stub([SHOT, { name: 'approve_cut', input: {} }]);
  const p = base();
  const next = await runDirector(p, { shotId: 'sB', request: 'đẹp hơn', review: true });
  assert.equal(req.length, 2);
  for (const r of req) assert.deepEqual(r.tools.map((t) => t.name), ['submit_shot', 'approve_cut']);
  assert.equal(JSON.stringify(req[1].tools), JSON.stringify(req[0].tools));
  assert.deepEqual(req[0].tool_choice, { type: 'tool', name: 'submit_shot' });
  assert.deepEqual(req[1].tool_choice, { type: 'any', disable_parallel_tool_use: true });
  assert.ok(!/patch_shots/.test(lastUserText(req[1])), 'một shot: không gợi ý patch_shots');
  assert.equal(next.shots[1].code, B2, 'approve giữ shot đã nộp');
  assert.deepEqual(next.shots[1].fields, { t1: 'giữ B' });
  assert.equal(next.shots[0].code, p.shots[0].code); assert.equal(next.shots[2].code, p.shots[2].code);
  assert.equal(next.lastDirector.summary, 'Shot B mới');
  ok('f. một shot: tools [submit_shot, approve_cut] cố định, approve giữ shot');
}

// ---- g: reviewTools=false (đối chứng cho director-bench --review) ----
{
  const req = stub([CUT, CUT]);
  await runDirector(base(), { brief: 'test', review: true, reviewTools: false });
  assert.equal(req.length, 2);
  assert.deepEqual(req.map((r) => r.tool_choice), [{ type: 'tool', name: 'submit_cut' }, { type: 'tool', name: 'submit_cut' }]);
  assert.equal(JSON.stringify(req[1].tools), JSON.stringify(req[0].tools));
  assert.match(lastUserText(req[1]), /nộp lại y nguyên/);
  ok('g. reviewTools=false: hành vi cũ (ép submit_cut mỗi vòng), tools vẫn cố định');
}

setInspector(null);
setAnthropicClient(null);
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
console.log(`\n${passed} nhóm kiểm tra PASS`);
