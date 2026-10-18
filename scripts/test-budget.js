// Test hạn mức chi phí AI theo người (issue #34) — offline, không gọi API, không cần Chromium/ffmpeg.
// usage: node scripts/test-budget.js
// Phần 1 (thuần, không server):
//   - quy đổi usage → USD đúng bảng giá config/pricing.json: 5 bộ usage mẫu (có cache read/creation,
//     cả bậc giá theo độ dài prompt của Haiku 5.5) khớp số tính tay, sai số ≤ 0.0001 USD
//   - model lạ → giá model đạo diễn + cảnh báo
//   - đổi bảng giá (DATA_DIR/pricing.json) không làm đổi USD của các dòng đã ghi; dòng mới mang pricingVersion mới
//   - ranh giới tháng UTC+7: 2026-11-30T17:30Z → tháng 12; file usage cũ đặt tên theo tháng UTC vẫn đọc đúng
// Phần 2 (server thật là process con, DATA_DIR tạm, JOBS_TEST_KINDS=1, kind giả test-director có usage):
//   - chưa cấu hình gì → không ai bị chặn, không tạo budgets.json; nhóm "Chung" (usage không gắn người)
//   - admin đặt hạn mức theo vai trò / ghi đè theo người / nhóm "Chung"; còn nguyên sau restart
//   - ≥ 80% → /api/account/usage warn: true; ≥ 100% → 402 + "Đã hết hạn mức tháng — liên hệ admin",
//     không job nào được xếp hàng (test route, route đạo diễn, "Chạy lại"); job đang chạy vẫn hoàn tất
//   - admin "Nới hạn mức" → tạo job được ngay; budget-log.jsonl ghi ai / khi nào / bao nhiêu / lý do
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.TEST_BUDGET_PORT || 5398);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-test-'));
process.env.DATA_DIR = DATA; // before importing server modules (store.js reads it at load)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, server = null;
const ok = (name) => { passed++; console.log('PASS ', name); };
const near = (a, b, what) => assert.ok(Math.abs(a - b) <= 0.0001, `${what}: ${a} ≠ ${b} (sai số > 0.0001 USD)`);

const { costOf, usdOf, loadPricing } = await import('../server/pricing.js');
const usage = await import('../server/usage.js');

// =============================================================== phần 1: thuần
const pricing = loadPricing(null); // repo table only
{
  const P = pricing.models;
  for (const m of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1']) assert.ok(P[m], `bảng giá thiếu ${m}`);
  assert.ok(pricing.source && pricing.verifiedAt && pricing.version, 'pricing.json có source / verifiedAt / version');
  // Tính tay (USD/MTok): Opus 5.5 in 4 · out 20 · ghi cache 5' 5 · đọc cache 0.2
  //   1200×4 + 340×20 + 800×5 + 5000×0.2 = 4800 + 6800 + 4000 + 1000 = 16600 → 0.0166
  near(costOf(P['claude-opus-5-5'], { input_tokens: 1200, output_tokens: 340, cache_creation_input_tokens: 800, cache_read_input_tokens: 5000 }), 0.0166, 'Opus 5.5');
  // Sonnet 5.5 in 2 · out 10 · ghi 2.5 · đọc 0.1: 25000×2 + 4000×10 + 30000×2.5 + 120000×0.1 = 50000+40000+75000+12000 → 0.177
  near(costOf(P['claude-sonnet-5-5'], { input_tokens: 25000, output_tokens: 4000, cache_creation_input_tokens: 30000, cache_read_input_tokens: 120000 }), 0.177, 'Sonnet 5.5');
  // Haiku 5.5, prompt 90 000 ≤ 100 000 → giá thường in 0.1 · out 0.5 · ghi 0.125 · đọc 0.01:
  //   50000×0.1 + 2000×0.5 + 10000×0.125 + 30000×0.01 = 5000+1000+1250+300 → 0.00755
  const hShort = { input_tokens: 50000, output_tokens: 2000, cache_creation_input_tokens: 10000, cache_read_input_tokens: 30000 };
  near(costOf(P['claude-haiku-5-5'], hShort), 0.00755, 'Haiku 5.5 ≤ 100k');
  // Haiku 5.5, prompt 110 000 > 100 000 → giá prompt dài in 0.5 · out 2.5 · đọc 0.05:
  //   80000×0.5 + 1000×2.5 + 30000×0.05 = 40000+2500+1500 → 0.044
  const hLong = { input_tokens: 80000, output_tokens: 1000, cache_read_input_tokens: 30000 };
  near(costOf(P['claude-haiku-5-5'], hLong), 0.044, 'Haiku 5.5 > 100k');
  // Fable 5.1 in 10 · out 50 · ghi 12.5 · đọc 0.25: 3000×10 + 1500×50 + 4000×12.5 + 200000×0.25 = 30000+75000+50000+50000 → 0.205
  near(costOf(P['claude-fable-5-1'], { input_tokens: 3000, output_tokens: 1500, cache_creation_input_tokens: 4000, cache_read_input_tokens: 200000 }), 0.205, 'Fable 5.1');
  // nhiều lượt: mỗi request tính giá riêng (bậc giá theo prompt của từng request) = 0.00755 + 0.044
  const total = { input_tokens: 130000, output_tokens: 3000, cache_creation_input_tokens: 10000, cache_read_input_tokens: 60000 };
  near(usdOf(pricing, { model: 'claude-haiku-5-5', usage: total, rounds: [hShort, hLong], fallbackModel: 'claude-opus-5-5' }).usd, 0.05155, 'Haiku 5.5 theo từng lượt');
  // model lạ → giá model đạo diễn
  const warns = [];
  const ow = console.warn; console.warn = (m) => warns.push(String(m));
  const unk = usdOf(pricing, { model: 'claude-khong-co-9', usage: { input_tokens: 1200, output_tokens: 340, cache_creation_input_tokens: 800, cache_read_input_tokens: 5000 }, fallbackModel: 'claude-opus-5-5' });
  console.warn = ow;
  near(unk.usd, 0.0166, 'model lạ → giá Opus 5.5');
  assert.equal(unk.known, false);
  assert.ok(warns.some((w) => /claude-khong-co-9/.test(w)), 'model lạ phải log cảnh báo');
  ok('USD = bảng giá: 5 bộ usage mẫu (cache read/creation, bậc prompt > 100k của Haiku 5.5) khớp tính tay ≤ 0.0001; nhiều lượt tính từng request; model lạ → giá model đạo diễn + cảnh báo');
}

{
  // ranh giới tháng giờ Việt Nam
  assert.equal(usage.monthOf('2026-11-30T17:30:00Z'), '2026-12');
  assert.equal(usage.monthOf('2026-11-30T16:59:59Z'), '2026-11');
  assert.equal(usage.monthOf('2026-12-31T17:00:00Z'), '2027-01');
  assert.equal(usage.prevMonth('2027-01'), '2026-12');
  // file cũ (#25) đặt tên theo tháng UTC, dòng không có usd/model
  const dir = path.join(DATA, 'usage');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '2026-11.jsonl'), [
    { at: '2026-11-15T03:00:00.000Z', userId: 'uA', projectId: 'p', jobId: 'jl1', usage: { input_tokens: 1000, output_tokens: 0 } },
    { at: '2026-11-30T17:30:00.000Z', userId: 'uA', projectId: 'p', jobId: 'jl2', usage: { input_tokens: 2000, output_tokens: 100 } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  const nov = usage.monthUsage('2026-11').find((r) => r.userId === 'uA');
  const dec = usage.monthUsage('2026-12').find((r) => r.userId === 'uA');
  assert.equal(nov.jobs, 1);
  assert.equal(dec.jobs, 1, '2026-11-30T17:30Z thuộc tháng 12 giờ VN');
  assert.equal(dec.total.input_tokens, 2000);
  near(nov.usd, 0.004, 'dòng cũ không có usd → ước tính theo giá hiện tại');
  near(dec.usd, 0.01, 'dòng cũ tháng 12');
  assert.equal(dec.usdEstimated, true);
  assert.deepEqual((await usage.listMonths()).filter((m) => m.startsWith('2026-1')), ['2026-12', '2026-11']);
  // dòng mới ghi vào file theo tháng VN
  const line = await usage.recordUsage({ userId: 'uB', projectId: 'p', jobId: 'jn1', usage: { input_tokens: 1200, output_tokens: 340, cache_creation_input_tokens: 800, cache_read_input_tokens: 5000 }, model: 'claude-opus-5-5', at: '2026-11-30T17:30:00.000Z' });
  assert.ok(fs.existsSync(path.join(dir, '2026-12.jsonl')), 'dòng mới → file tháng VN');
  near(line.usd, 0.0166, 'usd lúc ghi');
  assert.equal(line.pricingVersion, pricing.version);
  ok('tháng theo UTC+7: 2026-11-30T17:30Z → tháng 12; file cũ đặt theo tháng UTC đọc lại đúng theo `at`; dòng cũ không usd → ước tính; dòng mới ghi usd + pricingVersion vào file tháng VN');

  // đổi bảng giá: dòng đã ghi giữ nguyên usd
  const before = usage.monthUsage('2026-12').find((r) => r.userId === 'uB').usd;
  await sleep(20);
  fs.writeFileSync(path.join(DATA, 'pricing.json'), JSON.stringify({ version: 'test-x2', models: { 'claude-opus-5-5': { input: 8, output: 40, cacheWrite5m: 10, cacheRead: 0.4 } } }));
  assert.equal(usage.monthUsage('2026-12').find((r) => r.userId === 'uB').usd, before, 'USD đã ghi không đổi khi đổi bảng giá');
  const l2 = await usage.recordUsage({ userId: 'uB', projectId: 'p', jobId: 'jn2', usage: { input_tokens: 1200, output_tokens: 340, cache_creation_input_tokens: 800, cache_read_input_tokens: 5000 }, model: 'claude-opus-5-5', at: '2026-12-02T00:00:00.000Z' });
  assert.equal(l2.pricingVersion, 'test-x2');
  near(l2.usd, 0.0332, 'dòng mới theo bảng giá mới');
  near(usage.monthUsage('2026-12').find((r) => r.userId === 'uB').usd, 0.0166 + 0.0332, 'tổng tháng');
  fs.rmSync(path.join(DATA, 'pricing.json'));
  fs.rmSync(dir, { recursive: true });
  ok('đổi bảng giá (DATA_DIR/pricing.json) không đổi USD của dòng đã ghi; dòng mới mang pricingVersion mới');
}

// =============================================================== phần 2: server con
async function start() {
  const child = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, APP_PASSWORD: '', AUTH_CACHE_MS: '500', JOBS_TEST_KINDS: '1', ANTHROPIC_API_KEY: '', COOKIE_SECURE: '', TRUST_PROXY: '', EMS_TOKEN: '', DIRECTOR_MODEL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  child.output = () => out;
  for (let i = 0; i < 60; i++) {
    if (child.exitCode != null) throw new Error('server thoát sớm:\n' + out);
    try { await fetch(BASE + '/login.html'); return (server = child); } catch { /* not yet */ }
    await sleep(250);
  }
  throw new Error('server không khởi động:\n' + out);
}
async function stop() {
  if (!server || server.exitCode != null) return;
  const s = server;
  const exited = new Promise((r) => s.once('exit', r));
  s.kill('SIGKILL');
  await exited;
}
async function call(method, url, { cookie, body } = {}) {
  const h = {};
  if (cookie) h.cookie = cookie;
  if (body !== undefined) h['content-type'] = 'application/json';
  const r = await fetch(BASE + url, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, data: ct.includes('json') ? await r.json() : await r.text() };
}
async function login(username, password) {
  const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
  const m = /ems_session=([^;]+)/.exec(r.headers.get('set-cookie') || '');
  assert.ok(m, `đăng nhập ${username}`);
  return { cookie: `ems_session=${m[1]}`, user: (await r.json()).user };
}
async function waitFor(fn, ms, what) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('hết giờ chờ ' + what);
    await sleep(40);
  }
}
const U1 = { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 5000, cache_creation_input_tokens: 800 }; // $0.0166 (Opus 5.5)
const job = (cookie, params) => call('POST', '/api/test/jobs', { cookie, body: { kind: 'test-director', projectId: 'pbudget', params: { steps: 1, stepMs: 20, ...params } } });
const waitDone = (cookie, id) => waitFor(async () => { const r = await call('GET', `/api/jobs/${id}`, { cookie }); return r.data.status === 'done' && r.data; }, 8000, `job ${id} xong`);
const BUDGETS = path.join(DATA, 'budgets.json');
const BLOCK_MSG = 'Đã hết hạn mức tháng — liên hệ admin';

try {
  await start();

  // ---- chưa cấu hình gì (chế độ mở, không tài khoản): hành vi như cũ ----
  {
    const b = await call('GET', '/api/budget');
    assert.equal(b.status, 200);
    assert.equal(b.data.limit, null);
    assert.equal(b.data.warn, false);
    assert.equal(b.data.blocked, false);
    for (let i = 0; i < 3; i++) {
      const j = await job(undefined, { usage: { input_tokens: 100000 } }); // $0.40 mỗi lần
      assert.equal(j.status, 200, 'không cấu hình → không chặn');
      await waitDone(undefined, j.data.id);
    }
    assert.ok(!fs.existsSync(BUDGETS), 'không tự tạo budgets.json');
    const month = usage.monthOf();
    const lines = fs.readFileSync(path.join(DATA, 'usage', `${month}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 3);
    assert.equal(lines[0].userId, null);
    near(lines[0].usd, 0.4, 'usd trên dòng usage');
    assert.equal(lines[0].model, 'claude-opus-5-5');
    ok('chưa cấu hình gì: không ai bị chặn, không tạo budgets.json; dòng usage có usd + model + pricingVersion');

    // nhóm "Chung" (usage không gắn người) với hạn mức riêng — sửa file ngoài, có hiệu lực ngay
    fs.writeFileSync(BUDGETS, JSON.stringify({ roles: {}, users: {}, shared: 1 })); // đã dùng $1.20 ≥ $1
    const blocked = await job(undefined, { usage: U1 });
    assert.equal(blocked.status, 402);
    assert.equal(blocked.data.error, BLOCK_MSG);
    assert.equal(blocked.data.budget.userId, null);
    fs.writeFileSync(BUDGETS, JSON.stringify({ roles: {}, users: {}, shared: 1.5 })); // 80 % ≤ 1.2/1.5 < 100 %
    const st = await call('GET', '/api/budget');
    assert.equal(st.data.warn, true);
    assert.equal(st.data.blocked, false);
    assert.equal(st.data.pct, 80);
    fs.rmSync(BUDGETS);
    assert.equal((await call('GET', '/api/budget')).data.limit, null);
    ok('nhóm "Chung": usage không gắn người tính chung, hạn mức shared chặn 402 / cảnh báo 80 %; đổi file có hiệu lực ngay');
  }

  // ---- tài khoản: admin + member ----
  const ADMIN_PW = 'admin-pw-' + crypto.randomBytes(5).toString('hex');
  const MEMBER_PW = 'member-pw-' + crypto.randomBytes(5).toString('hex');
  for (const [u, pw, extra] of [['danny', ADMIN_PW, ['--admin', '--name', 'Danny']], ['lan', MEMBER_PW, ['--name', 'Lan Anh']]]) {
    const cli = spawnSync(process.execPath, ['scripts/user-add.js', u, ...extra, '--password-stdin'], { input: pw + '\n', env: { ...process.env, DATA_DIR: DATA }, encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
  }
  await sleep(700);
  const admin = await login('danny', ADMIN_PW);
  const member = await login('lan', MEMBER_PW);
  const memberId = member.user.id;

  // ---- admin đặt hạn mức theo vai trò; member < 80 % → không cảnh báo ----
  let memberJobs = [];
  {
    assert.equal((await call('PUT', '/api/admin/budgets', { cookie: member.cookie, body: { roles: { member: 1 } } })).status, 403);
    assert.equal((await call('PUT', '/api/admin/budgets', { cookie: admin.cookie, body: { roles: { member: -1 } } })).status, 400);
    const put = await call('PUT', '/api/admin/budgets', { cookie: admin.cookie, body: { roles: { member: 0.05, admin: null }, shared: 2 } });
    assert.equal(put.status, 200);
    assert.equal(put.data.config.roles.member, 0.05);
    const u0 = await call('GET', '/api/account/usage', { cookie: member.cookie });
    assert.equal(u0.data.warn, false);
    assert.equal(u0.data.budget.limit, 0.05);
    assert.equal(u0.data.budget.source, 'role');
    const a = await job(member.cookie, { usage: { input_tokens: 10500 } }); // $0.042 = 84 %
    assert.equal(a.status, 200);
    memberJobs.push(a.data.id);
    await waitDone(member.cookie, a.data.id);
    const u1 = await call('GET', '/api/account/usage', { cookie: member.cookie });
    near(u1.data.usd, 0.042, 'usd của member');
    assert.equal(u1.data.warn, true, '≥ 80 % → warn');
    assert.equal(u1.data.budget.warn, true);
    assert.equal(u1.data.budget.blocked, false);
    assert.equal(u1.data.budget.pct, 84);
    ok('admin đặt hạn mức theo vai trò (member chặn 403, số âm 400); < 80 % → warn false; 84 % → /api/account/usage warn: true, budget.pct 84');
  }

  // ---- ≥ 100 %: job mới bị từ chối, job đang chạy vẫn xong ----
  {
    const proj = (await call('POST', '/api/projects', { cookie: member.cookie, body: { name: 'Budget' } })).data;
    const long = await job(member.cookie, { steps: 4, stepMs: 400, usage: U1 }); // bắt đầu trước khi chạm ngưỡng
    assert.equal(long.status, 200);
    const quick = await job(member.cookie, { usage: U1 });
    assert.equal(quick.status, 200);
    await waitDone(member.cookie, quick.data.id); // 0.042 + 0.0166 = 0.0586 ≥ 0.05
    const before = (await call('GET', '/api/jobs', { cookie: admin.cookie })).data.length;
    const r1 = await job(member.cookie, { usage: U1 });
    assert.equal(r1.status, 402);
    assert.equal(r1.data.error, BLOCK_MSG);
    assert.equal(r1.data.code, 'budget_exceeded');
    const r2 = await call('POST', `/api/projects/${proj.id}/director`, { cookie: member.cookie, body: { request: 'thêm shot' } });
    assert.equal(r2.status, 402, 'route đạo diễn thật cũng bị chặn');
    assert.equal(r2.data.error, BLOCK_MSG);
    const r3 = await call('POST', `/api/jobs/${quick.data.id}/retry`, { cookie: member.cookie });
    assert.equal(r3.status, 402, '"Chạy lại" job trả phí cũng bị chặn');
    assert.equal((await call('GET', '/api/jobs', { cookie: admin.cookie })).data.length, before, 'không job nào được xếp hàng');
    const st = (await call('GET', '/api/account/usage', { cookie: member.cookie })).data;
    assert.equal(st.budget.blocked, true);
    assert.equal(st.warn, true);
    // admin (vai trò admin: không giới hạn) không bị ảnh hưởng
    const ad = await job(admin.cookie, { usage: U1 });
    assert.equal(ad.status, 200);
    await waitDone(admin.cookie, ad.data.id);
    const done = await waitDone(member.cookie, long.data.id);
    near(done.usageUsd, 0.0166, 'job đang chạy vẫn hoàn tất và ghi usage');
    near((await call('GET', '/api/account/usage', { cookie: member.cookie })).data.usd, 0.0752, 'chấp nhận vượt nhẹ do job cuối');
    assert.ok(server.output().includes('[budget] chặn job'), 'log khi chặn');
    ok('≥ 100 %: tạo job (test, đạo diễn, "Chạy lại") → 402 "Đã hết hạn mức tháng — liên hệ admin", không job nào xếp hàng; job chạy trước khi chạm ngưỡng vẫn hoàn tất; admin không giới hạn không bị ảnh hưởng');
  }

  // ---- Nới hạn mức ----
  {
    assert.equal((await call('POST', '/api/admin/budgets/raise', { cookie: member.cookie, body: { userId: memberId, amount: 1, reason: 'x' } })).status, 403);
    assert.equal((await call('POST', '/api/admin/budgets/raise', { cookie: admin.cookie, body: { userId: memberId, amount: 0.05 } })).status, 400, 'thiếu lý do');
    assert.equal((await call('POST', '/api/admin/budgets/raise', { cookie: admin.cookie, body: { userId: memberId, amount: 0, reason: 'x' } })).status, 400, 'số ≤ 0');
    const r = await call('POST', '/api/admin/budgets/raise', { cookie: admin.cookie, body: { userId: memberId, amount: 0.05, reason: 'Chiến dịch Tết gấp' } });
    assert.equal(r.status, 200);
    assert.equal(r.data.budget.limit, 0.1);
    assert.equal(r.data.budget.raised, 0.05);
    assert.equal(r.data.budget.blocked, false);
    const j = await job(member.cookie, { usage: { input_tokens: 10 } });
    assert.equal(j.status, 200, 'tạo job được ngay sau khi nới, không restart');
    await waitDone(member.cookie, j.data.id);
    const log = fs.readFileSync(path.join(DATA, 'budget-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(log.length, 1);
    assert.equal(log[0].by, admin.user.id);
    assert.equal(log[0].byName, 'Danny');
    assert.equal(log[0].userId, memberId);
    assert.equal(log[0].amount, 0.05);
    assert.equal(log[0].reason, 'Chiến dịch Tết gấp');
    assert.equal(log[0].month, usage.monthOf());
    assert.ok(Date.now() - Date.parse(log[0].at) < 60e3);
    const g = await call('GET', '/api/admin/budgets', { cookie: admin.cookie });
    assert.equal(g.data.raises[0].reason, 'Chiến dịch Tết gấp');
    ok('admin "Nới hạn mức" (member 403, thiếu lý do / số ≤ 0 → 400) → member tạo job được ngay; budget-log.jsonl ghi ai / khi nào / bao nhiêu / lý do / tháng');
  }

  // ---- bảng usage admin: USD + % hạn mức, tháng theo UTC+7, dữ liệu cũ ----
  {
    fs.writeFileSync(path.join(DATA, 'usage', '2026-11.jsonl'), JSON.stringify({ at: '2026-11-30T17:30:00.000Z', userId: memberId, projectId: 'p', jobId: 'jold', usage: { input_tokens: 2000, output_tokens: 100 } }) + '\n');
    const dec = await call('GET', '/api/admin/usage?month=2026-12', { cookie: admin.cookie });
    assert.equal(dec.data.rows.find((r) => r.userId === memberId).jobs, 1, 'dòng cũ 2026-11-30T17:30Z → tháng 12');
    near(dec.data.rows.find((r) => r.userId === memberId).usd, 0.01, 'dòng cũ không usd → ước tính');
    assert.equal((await call('GET', '/api/admin/usage?month=2026-11', { cookie: admin.cookie })).data.rows.length, 0);
    assert.ok(dec.data.months.includes('2026-12'));
    const cur = await call('GET', '/api/admin/usage', { cookie: admin.cookie });
    const row = cur.data.rows.find((r) => r.userId === memberId);
    near(row.usd, 0.07524, 'USD tháng này của member');
    assert.equal(row.budget.limit, 0.1);
    assert.ok(Math.abs(row.budget.pct - 75.2) < 0.11, `pct ${row.budget.pct}`);
    assert.equal(row.name, 'Lan Anh');
    const shared = cur.data.rows.find((r) => r.userId === null);
    near(shared.usd, 1.2, 'nhóm "Chung"');
    assert.equal(shared.budget.limit, 2);
    assert.equal(shared.budget.pct, 60);
    assert.equal(cur.data.rows.find((r) => r.userId === admin.user.id).budget.limit, null);
    assert.ok(cur.data.pricing.version && cur.data.pricing.source);
    ok('admin usage: cột USD + % hạn mức theo người + nhóm "Chung"; tháng theo UTC+7 (dòng cũ 2026-11-30T17:30Z → 2026-12); dòng cũ không usd vẫn tính');
  }

  // ---- restart: cấu hình + nới còn nguyên; ghi đè theo người ----
  {
    await stop();
    await start();
    const admin2 = await login('danny', ADMIN_PW);
    const member2 = await login('lan', MEMBER_PW);
    const g = await call('GET', '/api/admin/budgets', { cookie: admin2.cookie });
    assert.equal(g.data.config.roles.member, 0.05);
    assert.equal(g.data.config.shared, 2);
    assert.equal((await call('GET', '/api/account/usage', { cookie: member2.cookie })).data.budget.limit, 0.1, 'nới hạn mức còn sau restart');
    // ghi đè theo người: 0.07 (+0.05 nới) → 0.12; null = không giới hạn; 'role' = bỏ ghi đè
    await call('PUT', '/api/admin/budgets', { cookie: admin2.cookie, body: { users: { [memberId]: 0.07 } } });
    let b = (await call('GET', '/api/account/usage', { cookie: member2.cookie })).data.budget;
    assert.equal(b.source, 'user');
    assert.equal(b.limit, 0.12);
    await call('PUT', '/api/admin/budgets', { cookie: admin2.cookie, body: { users: { [memberId]: 0.01 } } });
    assert.equal((await job(member2.cookie, { usage: U1 })).status, 402, 'ghi đè thấp → chặn');
    await call('PUT', '/api/admin/budgets', { cookie: admin2.cookie, body: { users: { [memberId]: null } } });
    b = (await call('GET', '/api/account/usage', { cookie: member2.cookie })).data.budget;
    assert.equal(b.limit, null, 'ghi đè null = không giới hạn dù vai trò có mặc định');
    assert.equal(b.warn, false);
    assert.equal((await job(member2.cookie, { usage: { input_tokens: 1 } })).status, 200);
    await call('PUT', '/api/admin/budgets', { cookie: admin2.cookie, body: { users: { [memberId]: 'role' } } });
    assert.equal((await call('GET', '/api/account/usage', { cookie: member2.cookie })).data.budget.source, 'role');
    assert.equal((await call('PUT', '/api/admin/budgets', { cookie: admin2.cookie, body: { users: { ukhongco: 1 } } })).status, 400);
    ok('restart: hạn mức vai trò / "Chung" / lần nới còn nguyên; ghi đè theo người (số, null = không giới hạn, "role" = theo vai trò) có hiệu lực ngay');
  }

  // ---- model lạ ở runtime: giá model đạo diễn + cảnh báo ----
  {
    const a3 = await login('danny', ADMIN_PW);
    const j = await job(a3.cookie, { usage: U1, model: 'claude-khong-co-9' });
    const d = await waitDone(a3.cookie, j.data.id);
    near(d.usageUsd, 0.0166, 'model lạ → giá Opus 5.5');
    await waitFor(() => server.output().includes('không có giá cho model "claude-khong-co-9"'), 2000, 'cảnh báo model lạ');
    ok('model lạ khi chạy → tính theo giá model đạo diễn (claude-opus-5-5) + log cảnh báo');
  }

  console.log(`\n${passed} nhóm kiểm tra PASS`);
} catch (e) {
  console.error('FAIL ', e.stack || e);
  if (server) console.error('--- server log ---\n' + server.output().slice(-4000));
  process.exitCode = 1;
} finally {
  await stop();
  fs.rmSync(DATA, { recursive: true, force: true });
}
