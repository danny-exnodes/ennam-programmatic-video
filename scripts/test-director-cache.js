// Offline test cho prompt caching + usage của đạo diễn (không gọi API thật).
// usage: node scripts/test-director-cache.js
// Thay client Anthropic bằng stub, chạy runDirector 2 vòng (stub luôn trả code
// lỗi cú pháp nên không cần Chromium), rồi kiểm tra body request từng vòng.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dir-cache-'));
process.env.ANTHROPIC_API_KEY ||= 'test-offline-not-a-real-key';

const { runDirector, setAnthropicClient, buildRequest, systemPrompt, addUsage, emptyUsage } = await import('../server/director.js');
const { defaultProject } = await import('../server/store.js');

const FAKE_USAGE = [
  { input_tokens: 1200, output_tokens: 3000, cache_read_input_tokens: 0, cache_creation_input_tokens: 9000 },
  { input_tokens: 800, output_tokens: 2500, cache_read_input_tokens: 9000, cache_creation_input_tokens: null },
];

const requests = [];
setAnthropicClient({
  messages: {
    stream(params) {
      const i = requests.length;
      requests.push(structuredClone(params)); // chụp lại lúc gửi (messages bị push thêm sau đó)
      const msg = {
        content: [{ type: 'tool_use', id: 'tu' + i, name: params.tool_choice.name, input: { summary: 'tóm tắt ' + i, shots: [{ name: 'A', duration: 3, code: 'this is (not valid js' }] } }],
        usage: FAKE_USAGE[i],
      };
      return { on() { return this; }, finalMessage: async () => msg };
    },
  },
});

let passed = 0;
const ok = (name) => { passed++; console.log('PASS ', name); };

// ---- 1. runDirector với cache (mặc định) ----
const project = defaultProject({ name: 'Test cache' });
project.shots = [{ id: 's1', name: 'Mở', duration: 3, transition: { type: 'cut' }, code: 's.bg("#000")', notes: '' }];
const logs = [];
const next = await runDirector(project, { brief: 'Video 15s test', review: false, log: (l) => logs.push(l) });

assert.equal(requests.length, 2, 'phải gọi đúng 2 lượt');
ok('runDirector gọi 2 lượt');

const [r1, r2] = requests;
for (const [i, r] of [r1, r2].entries()) {
  assert.ok(Array.isArray(r.system), `vòng ${i + 1}: system là mảng`);
  assert.equal(r.system.length, 1);
  assert.equal(r.system[0].type, 'text');
  assert.equal(r.system[0].text, systemPrompt(), 'nội dung system không đổi');
  assert.deepEqual(r.system[0].cache_control, { type: 'ephemeral' }, `vòng ${i + 1}: cache_control ở khối system`);
  const first = r.messages[0].content;
  assert.deepEqual(first.at(-1).cache_control, { type: 'ephemeral' }, `vòng ${i + 1}: breakpoint ở khối cuối user turn mở đầu`);
  assert.equal(first.filter((b) => b.cache_control).length, 1, 'chỉ 1 breakpoint trong turn mở đầu');
  const bps = r.system.filter((b) => b.cache_control).length + r.messages.flatMap((m) => Array.isArray(m.content) ? m.content : []).filter((b) => b.cache_control).length;
  assert.equal(bps, 2, `vòng ${i + 1}: tổng 2 breakpoint`);
}
ok('cache_control ở system + khối cuối turn mở đầu (cả 2 vòng)');

assert.deepEqual(r2.system, r1.system);
assert.deepEqual(r2.tools, r1.tools);
assert.deepEqual(r2.tool_choice, r1.tool_choice);
assert.equal(r2.model, r1.model);
assert.deepEqual(r2.messages[0], r1.messages[0], 'turn mở đầu giống hệt giữa 2 vòng');
assert.equal(r1.messages.length, 1);
assert.equal(r2.messages.length, 3);
assert.equal(r2.messages[1].role, 'assistant');
assert.equal(r2.messages[2].content[0].type, 'tool_result');
ok('prefix (tools, system, turn mở đầu) giống hệt giữa vòng 1 và vòng 2');

// Nội dung prompt không đổi: bỏ cache_control thì text khối trùng bản không cache
const firstNoCc = r1.messages[0].content.map(({ cache_control, ...b }) => b);
assert.ok(firstNoCc.at(-1).text.startsWith('NHIỆM VỤ: '));
ok('thứ tự khối turn mở đầu giữ nguyên (khối cuối là NHIỆM VỤ)');

// ---- 2. usage ----
const u = next.lastDirector.usage;
assert.ok(u && u.total && Array.isArray(u.rounds));
assert.deepEqual(Object.keys(u.total).sort(), ['cache_creation_input_tokens', 'cache_read_input_tokens', 'input_tokens', 'output_tokens']);
assert.deepEqual(u.total, { input_tokens: 2000, output_tokens: 5500, cache_read_input_tokens: 9000, cache_creation_input_tokens: 9000 });
assert.equal(u.rounds.length, 2);
assert.deepEqual(u.rounds[1], { input_tokens: 800, output_tokens: 2500, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0 });
ok('lastDirector.usage cộng dồn đúng 4 trường (null → 0)');

assert.ok(logs.some((l) => l.startsWith('Token lượt 1: vào 1200 · ra 3000 · đọc cache 0 · ghi cache 9000')), 'log lượt 1');
assert.ok(logs.some((l) => l.startsWith('Token lượt 2: vào 800 ')), 'log lượt 2');
assert.ok(logs.some((l) => l.startsWith('Token cả lần chạy (2 lượt): vào 2000 · ra 5500')), 'log tổng');
ok('log job có dòng token mỗi lượt + tổng');

const acc = emptyUsage();
addUsage(acc, { input_tokens: 5, output_tokens: 1 });
addUsage(acc, { input_tokens: 7, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4, inference_geo: 'us' });
assert.deepEqual(acc.total, { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 });
ok('addUsage bỏ qua trường lạ, thiếu trường → 0');

// ---- 3. tắt cache ----
const msgs = [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }];
const off = buildRequest(msgs, { name: 'submit_cut', input_schema: { type: 'object' } }, { cache: false });
assert.equal(JSON.stringify(off).includes('cache_control'), false, 'cache:false không có cache_control');
assert.equal(off.system[0].text, r1.system[0].text);
const on = buildRequest(msgs, { name: 'submit_cut', input_schema: { type: 'object' } });
assert.equal(msgs[0].content[1].cache_control, undefined, 'buildRequest không sửa messages gốc');
assert.deepEqual(on.messages[0].content[1].cache_control, { type: 'ephemeral' });
ok('cache:false bỏ hết breakpoint; buildRequest không mutate messages');

// ---- 4. memo systemPrompt ----
assert.equal(systemPrompt(), systemPrompt());
ok('systemPrompt() ghi nhớ (cùng chuỗi)');

fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
console.log(`\n${passed} nhóm kiểm tra PASS`);
