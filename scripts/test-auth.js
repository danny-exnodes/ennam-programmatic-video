// Test tài khoản riêng (issue #25: server/auth.js) — không cần trình duyệt/ffmpeg/API.
// usage: node scripts/test-auth.js
// Chạy server thật như process con (DATA_DIR tạm, APP_PASSWORD giả, AUTH_CACHE_MS=1000,
// JOBS_TEST_KINDS=1) và kiểm tra:
//   - chưa có user + APP_PASSWORD → Basic Auth cũ + banner "create-admin"; trang login công khai
//   - có user (tạo bằng CLI `scripts/user-add.js --password-stdin`) → 401 khi không có phiên/token,
//     trang HTML chuyển về /login.html, /review/* không bị chặn; đăng nhập, cookie HttpOnly/SameSite/Secure
//   - APP_PASSWORD còn vào được trong 30 ngày (header X-Auth-Warning + banner + log cảnh báo),
//     bị từ chối sau 30 ngày (sửa firstUserAt trong users.json)
//   - admin tạo/khoá/mở/đặt lại mật khẩu; token cá nhân chỉ lưu SHA-256, thu hồi được
//   - khoá user → phiên + token bị từ chối (qua API: ngay; sửa users.json ngoài: ≤ AUTH_CACHE_MS), người khác không ảnh hưởng
//   - job + snapshot Lịch sử có userId (dữ liệu cũ → null / "không rõ"); usage theo người theo tháng
//   - rate limit đăng nhập 10 lần sai / 15 phút / IP
//   - log server không chứa mật khẩu, token hay id phiên
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.TEST_AUTH_PORT || 5397);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-test-'));
const USERS = path.join(DATA, 'users.json');
const CACHE_MS = 1000;
const APP_PW = 'legacy-shared-pw-' + crypto.randomBytes(4).toString('hex');
const ADMIN_PW = 'admin-pw-' + crypto.randomBytes(6).toString('hex');
const MEMBER_PW = 'member-pw-' + crypto.randomBytes(6).toString('hex');
const RESET_PW = 'reset-pw-' + crypto.randomBytes(6).toString('hex');
const secrets = [APP_PW, ADMIN_PW, MEMBER_PW, RESET_PW]; // must never appear in the server log
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let server = null, passed = 0, failedLogins = 0; // failed logins count toward the per-IP limit
const ok = (name) => { passed++; console.log('PASS ', name); };

async function start() {
  const child = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, APP_PASSWORD: APP_PW, AUTH_CACHE_MS: String(CACHE_MS), JOBS_TEST_KINDS: '1', ANTHROPIC_API_KEY: '', COOKIE_SECURE: '', TRUST_PROXY: '', EMS_TOKEN: '' },
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

const basic = (pw, user = 'team') => 'Basic ' + Buffer.from(`${user}:${pw}`).toString('base64');
/** fetch with optional { cookie, token, basic, body, headers } → { status, headers, data } */
async function call(method, url, { cookie, token, auth, body, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (cookie) h.cookie = cookie;
  if (token) h.authorization = `Bearer ${token}`;
  if (auth) h.authorization = auth;
  if (body !== undefined && !raw) h['content-type'] = 'application/json';
  if (raw) h['content-type'] = 'application/json';
  const r = await fetch(BASE + url, { method, headers: h, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined), redirect: 'manual' });
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  return { status: r.status, headers: r.headers, data };
}
async function login(username, password, headers = {}) {
  const r = await call('POST', '/api/auth/login', { body: { username, password }, headers });
  const sc = r.headers.get('set-cookie') || '';
  const m = /ems_session=([^;]+)/.exec(sc);
  if (r.status === 401) failedLogins++;
  return { ...r, setCookie: sc, sid: m?.[1], cookie: m ? `ems_session=${m[1]}` : null };
}
const readUsers = () => JSON.parse(fs.readFileSync(USERS, 'utf8'));
const writeUsers = (db) => fs.writeFileSync(USERS, JSON.stringify(db, null, 2));
async function waitFor(fn, ms, what) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('hết giờ chờ ' + what);
    await sleep(50);
  }
}

try {
  // legacy data from before #25: a recent job without userId
  fs.mkdirSync(path.join(DATA, 'jobs'), { recursive: true });
  const now = Date.now();
  fs.writeFileSync(path.join(DATA, 'jobs', 'jlegacy000.json'), JSON.stringify({ id: 'jlegacy000', kind: 'render', projectId: 'pold', status: 'done', progress: 1, log: [], params: {}, createdAt: now - 60e3, finishedAt: now - 30e3, updatedAt: now - 30e3 }));
  await start();

  // ---- legacy mode: no users + APP_PASSWORD ----
  {
    const r = await call('GET', '/api/projects');
    assert.equal(r.status, 401);
    assert.match(r.headers.get('www-authenticate') || '', /^Basic/);
    assert.equal((await call('GET', '/api/projects', { auth: basic(APP_PW, 'ai-cung-duoc') })).status, 200);
    assert.equal((await call('GET', '/api/projects', { auth: basic('sai') })).status, 401);
    const st = await call('GET', '/api/auth/status', { auth: basic(APP_PW) });
    assert.equal(st.data.mode, 'legacy');
    assert.equal(st.data.banner, 'create-admin');
    assert.equal((await call('GET', '/login.html')).status, 200, 'trang login công khai');
    assert.equal((await call('GET', '/login.js')).status, 200);
    ok('chưa có tài khoản + APP_PASSWORD: Basic Auth cũ (user bất kỳ), banner "Hãy tạo tài khoản admin", trang login công khai');
  }

  // ---- first admin via CLI ----
  let admin;
  {
    const cli = spawnSync(process.execPath, ['scripts/user-add.js', 'danny', '--admin', '--name', 'Danny Trần', '--password-stdin'], {
      input: ADMIN_PW + '\n', env: { ...process.env, DATA_DIR: DATA }, encoding: 'utf8',
    });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /Đã tạo tài khoản danny \(admin/);
    assert.ok(!cli.stdout.includes(ADMIN_PW) && !cli.stderr.includes(ADMIN_PW), 'CLI không in mật khẩu');
    const dup = spawnSync(process.execPath, ['scripts/user-add.js', 'danny', '--password-stdin'], { input: 'whatever-123\n', env: { ...process.env, DATA_DIR: DATA }, encoding: 'utf8' });
    assert.notEqual(dup.status, 0, 'trùng tên đăng nhập phải lỗi');
    const db = readUsers();
    assert.equal(db.users.length, 1);
    assert.ok(db.firstUserAt, 'users.json lưu mốc tạo user đầu tiên');
    assert.match(db.users[0].passwordHash, /^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]{24}\$/);
    assert.ok(!fs.readFileSync(USERS, 'utf8').includes(ADMIN_PW));
    await sleep(CACHE_MS + 200); // server picks the new users.json up within the cache window
    ok('CLI user:add --password-stdin tạo admin (scrypt N=2^15,r=8,p=1, salt 16 byte), ghi firstUserAt, từ chối trùng tên');
  }

  // ---- accounts mode: 401 / redirect / public paths ----
  {
    const r = await call('GET', '/api/projects');
    assert.equal(r.status, 401);
    assert.equal(r.headers.get('www-authenticate'), null, 'không bật hộp thoại Basic của trình duyệt');
    assert.equal(r.data.login, '/login.html');
    const page = await call('GET', '/', { headers: { accept: 'text/html' } });
    assert.equal(page.status, 302);
    assert.equal(page.headers.get('location'), '/login.html?next=%2F');
    assert.equal((await call('GET', '/engine/engine.js')).status, 401);
    assert.equal((await call('GET', '/files/pold/assets/a.png')).status, 401);
    assert.equal((await call('GET', '/api/projects', { token: 'ems_khongcothat' })).status, 401);
    assert.equal((await call('GET', '/api/projects', { headers: { 'x-ems-internal': 'doan-bua' } })).status, 401);
    assert.equal((await call('GET', '/login.html')).status, 200);
    assert.notEqual((await call('GET', '/review/abc')).status, 401, '/review/* nằm ngoài auth (#10)');
    ok('đã có user: /api/* → 401 (không phiên/token), trang HTML → /login.html, engine/files bị chặn, /review/* + trang login công khai');
  }

  // ---- login + cookie flags ----
  {
    const bad = await login('danny', 'sai-mat-khau');
    assert.equal(bad.status, 401);
    assert.equal(bad.sid, undefined);
    const unknown = await login('khong-ton-tai', 'sai-mat-khau');
    assert.equal(unknown.status, 401);
    assert.equal(unknown.data.error, bad.data.error, 'không lộ user có tồn tại hay không');
    admin = await login('Danny', ADMIN_PW);
    assert.equal(admin.status, 200);
    assert.equal(admin.data.user.role, 'admin');
    assert.match(admin.setCookie, /HttpOnly/);
    assert.match(admin.setCookie, /SameSite=Lax/);
    assert.match(admin.setCookie, /Max-Age=1209600/);
    assert.doesNotMatch(admin.setCookie, /Secure/);
    assert.equal(Buffer.from(admin.sid, 'base64url').length, 32, 'id phiên 256-bit');
    const sessFiles = fs.readdirSync(path.join(DATA, 'sessions'));
    assert.ok(sessFiles.length >= 1);
    assert.ok(!sessFiles.some((f) => f.includes(admin.sid)), 'tên file phiên là SHA-256, không phải id');
    const st = await call('GET', '/api/auth/status', { cookie: admin.cookie });
    assert.equal(st.data.user.username, 'danny');
    assert.equal(st.data.via, 'session');
    assert.equal((await call('GET', '/api/projects', { cookie: admin.cookie })).status, 200);
    const https = await login('danny', ADMIN_PW, { 'x-forwarded-proto': 'https' });
    assert.match(https.setCookie, /; Secure/, 'Secure khi request qua HTTPS (X-Forwarded-Proto)');
    const out = await call('POST', '/api/auth/logout', { cookie: https.cookie });
    assert.equal(out.status, 200);
    assert.equal((await call('GET', '/api/projects', { cookie: https.cookie })).status, 401, 'đăng xuất huỷ phiên');
    ok('đăng nhập (không phân biệt hoa thường), cookie HttpOnly + SameSite=Lax + 14 ngày, Secure theo HTTPS, id 256-bit, đăng xuất');
  }

  // ---- APP_PASSWORD during the transition ----
  {
    const r = await call('GET', '/api/projects', { auth: basic(APP_PW) });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-auth-warning'), 'app-password-deprecated');
    const st = await call('GET', '/api/auth/status', { auth: basic(APP_PW) });
    assert.equal(st.data.banner, 'app-password');
    assert.equal(st.data.via, 'app-password');
    assert.ok(Date.parse(st.data.transitionEndsAt) - Date.parse(readUsers().firstUserAt) === 30 * 24 * 3600e3);
    assert.equal((await call('GET', '/api/auth/status', { cookie: admin.cookie })).data.banner, 'app-password', 'admin thấy banner chuyển tiếp');
    assert.equal((await call('GET', '/legacy-login', { auth: basic(APP_PW) })).status, 302);
    assert.equal((await call('GET', '/api/admin/users', { auth: basic(APP_PW) })).status, 403, 'mật khẩu chung không có quyền admin');
    await waitFor(() => /CẢNH BÁO: có request dùng APP_PASSWORD/.test(server.output()), 2000, 'log cảnh báo');
    ok('chuyển tiếp: APP_PASSWORD vẫn vào được + X-Auth-Warning + banner + cảnh báo trong log; hạn = firstUserAt + 30 ngày');
  }

  // ---- admin: create member, roles, tokens ----
  let member, memberId, rawToken, tokenId;
  {
    const c = await call('POST', '/api/admin/users', { cookie: admin.cookie, body: { username: 'lananh', name: 'Lan Anh', password: MEMBER_PW, role: 'member' } });
    assert.equal(c.status, 200, JSON.stringify(c.data));
    memberId = c.data.id;
    assert.equal(c.data.passwordHash, undefined, 'API không trả hash');
    assert.equal((await call('POST', '/api/admin/users', { cookie: admin.cookie, body: { username: 'ngan', password: 'ngan' } })).status, 400, 'mật khẩu < 8 ký tự');
    assert.equal((await call('POST', '/api/admin/users', { cookie: admin.cookie, body: { username: 'lananh', password: MEMBER_PW } })).status, 409);
    member = await login('lananh', MEMBER_PW);
    assert.equal(member.status, 200);
    assert.equal((await call('GET', '/api/admin/users', { cookie: member.cookie })).status, 403, 'member không vào được quản trị');
    const t = await call('POST', '/api/account/tokens', { cookie: member.cookie, body: { name: 'script' } });
    assert.equal(t.status, 200);
    rawToken = t.data.token;
    tokenId = t.data.id;
    assert.match(rawToken, /^ems_[A-Za-z0-9_-]{43}$/);
    const list = await call('GET', '/api/account/tokens', { cookie: member.cookie });
    assert.equal(list.data.length, 1);
    assert.equal(list.data[0].token, undefined, 'danh sách không trả lại token');
    const me = await call('GET', '/api/auth/status', { token: rawToken });
    assert.equal(me.data.user.username, 'lananh');
    assert.equal(me.data.via, 'token');
    const usersRaw = fs.readFileSync(USERS, 'utf8');
    assert.ok(!usersRaw.includes(rawToken), 'users.json không chứa token gốc');
    assert.ok(!usersRaw.includes(rawToken.slice(12)), 'users.json không chứa phần bí mật của token');
    assert.ok(usersRaw.includes(crypto.createHash('sha256').update(rawToken).digest('hex')), 'lưu SHA-256');
    assert.ok(!usersRaw.includes(MEMBER_PW));
    // revoke
    const t2 = await call('POST', '/api/account/tokens', { cookie: member.cookie, body: { name: 'tạm' } });
    assert.equal((await call('GET', '/api/projects', { token: t2.data.token })).status, 200);
    assert.equal((await call('DELETE', `/api/account/tokens/${t2.data.id}`, { cookie: member.cookie })).status, 200);
    assert.equal((await call('GET', '/api/projects', { token: t2.data.token })).status, 401, 'token đã thu hồi bị từ chối');
    ok('admin tạo member (API không trả hash), member bị chặn khỏi quản trị; token ems_ chỉ hiện 1 lần, chỉ lưu SHA-256, thu hồi được');
  }

  // ---- userId on jobs + usage per user per month ----
  {
    const usage = { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 5000, cache_creation_input_tokens: 800 };
    const j = await call('POST', '/api/test/jobs', { token: rawToken, body: { kind: 'test-director', projectId: 'pauth', params: { steps: 1, stepMs: 20, usage } } });
    assert.equal(j.status, 200);
    assert.equal(j.data.userId, memberId);
    assert.equal(j.data.userName, 'Lan Anh');
    const done = await waitFor(async () => { const r = await call('GET', `/api/jobs/${j.data.id}`, { cookie: admin.cookie }); return r.data.status === 'done' && r.data; }, 5000, 'job xong');
    assert.deepEqual(done.usage, usage, 'usage lưu trên job');
    await sleep(100);
    const onDisk = JSON.parse(fs.readFileSync(path.join(DATA, 'jobs', `${j.data.id}.json`), 'utf8'));
    assert.equal(onDisk.userId, memberId);
    assert.deepEqual(onDisk.usage, usage);
    const month = new Date().toISOString().slice(0, 7);
    const lines = fs.readFileSync(path.join(DATA, 'usage', `${month}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 1);
    assert.deepEqual(Object.keys(lines[0]).sort(), ['at', 'jobId', 'projectId', 'usage', 'userId']);
    assert.equal(lines[0].userId, memberId);
    // a second run by the admin, and a legacy line without userId
    const j2 = await call('POST', '/api/test/jobs', { cookie: admin.cookie, body: { kind: 'test-director', projectId: 'pauth', params: { steps: 1, stepMs: 20, usage: { input_tokens: 10, output_tokens: 5 } } } });
    await waitFor(async () => (await call('GET', `/api/jobs/${j2.data.id}`, { cookie: admin.cookie })).data.status === 'done', 5000, 'job 2');
    fs.appendFileSync(path.join(DATA, 'usage', `${month}.jsonl`), JSON.stringify({ at: new Date().toISOString(), userId: null, projectId: 'pold', jobId: 'jold', usage: { input_tokens: 7, output_tokens: 1 } }) + '\n');
    const u = await call('GET', `/api/admin/usage?month=${month}`, { cookie: admin.cookie });
    assert.equal(u.status, 200);
    const row = u.data.rows.find((r) => r.userId === memberId);
    assert.equal(row.name, 'Lan Anh');
    assert.equal(row.jobs, 1);
    assert.equal(row.total.input_tokens, 1200);
    assert.equal(row.total.cache_read_input_tokens, 5000);
    assert.equal(u.data.rows.find((r) => r.userId === admin.data.user.id).total.input_tokens, 10);
    assert.equal(u.data.rows.find((r) => r.userId === null).total.input_tokens, 7, 'usage cũ không có userId → nhóm "không rõ"');
    assert.ok(u.data.months.includes(month));
    assert.equal((await call('GET', '/api/admin/usage', { cookie: member.cookie })).status, 403);
    const mine = await call('GET', '/api/account/usage', { cookie: member.cookie });
    assert.equal(mine.data.total.output_tokens, 340);
    // legacy job → userId null, userName null (UI shows "không rõ")
    const jobs = await call('GET', '/api/jobs', { cookie: admin.cookie });
    const legacy = jobs.data.find((x) => x.id === 'jlegacy000');
    assert.ok(legacy, 'job cũ vẫn được liệt kê');
    assert.equal(legacy.userId ?? null, null);
    assert.equal(legacy.userName, null);
    // retry records who retried
    const re = await call('POST', `/api/jobs/${j.data.id}/retry`, { cookie: admin.cookie });
    assert.equal(re.data.userId, admin.data.user.id);
    ok('job mới có userId + userName (cả "Chạy lại"); usage lưu trên job + usage/<YYYY-MM>.jsonl; admin xem usage theo người/tháng; dữ liệu cũ → "không rõ"');
  }

  // ---- userId on history snapshots ----
  {
    const p = (await call('POST', '/api/projects', { cookie: member.cookie, body: { name: 'Auth history' } })).data;
    const hist = path.join(DATA, 'projects', p.id, 'history');
    // legacy snapshot (plain copy of project.json, no meta)
    fs.writeFileSync(path.join(hist, '2026-01-01T00-00-00-000Z__save.json'), JSON.stringify({ ...p, name: 'cũ' }, null, 2));
    p.shots = [{ id: 'sh1', name: 'A', duration: 2, code: 's.clear("#000")' }];
    assert.equal((await call('PUT', `/api/projects/${p.id}?snapshot=1&reason=save`, { cookie: member.cookie, body: p })).status, 200);
    const list = (await call('GET', `/api/projects/${p.id}/history`, { cookie: admin.cookie })).data;
    assert.equal(list.length, 2);
    assert.equal(list[0].userId, memberId);
    assert.equal(list[0].userName, 'Lan Anh');
    assert.match(list[0].file, /^\d{4}-\d\d-\d\dT[\d-]+Z__save\.json$/, 'tên file giữ nguyên dạng cũ');
    assert.equal(list[1].userId, null, 'snapshot cũ → không rõ');
    assert.equal(list[1].userName, null);
    const snap = JSON.parse(fs.readFileSync(path.join(hist, list[0].file), 'utf8'));
    assert.equal(Object.keys(snap)[0], 'meta');
    assert.equal(snap.meta.userId, memberId);
    const restored = await call('POST', `/api/projects/${p.id}/history/${list[0].file}/restore`, { cookie: admin.cookie });
    assert.equal(restored.status, 200);
    assert.equal(restored.data.meta, undefined, 'khôi phục không mang meta vào dự án');
    const after = (await call('GET', `/api/projects/${p.id}/history`, { cookie: admin.cookie })).data;
    assert.equal(after[0].reason, 'before-restore');
    assert.equal(after[0].userId, admin.data.user.id);
    ok('snapshot Lịch sử có meta.userId (tên file giữ nguyên), snapshot cũ → "không rõ", khôi phục bỏ meta');
  }

  // ---- disable / enable / reset password ----
  {
    const other = await login('danny', ADMIN_PW);
    const dis = await call('PATCH', `/api/admin/users/${memberId}`, { cookie: admin.cookie, body: { status: 'disabled' } });
    assert.equal(dis.status, 200);
    assert.equal((await call('GET', '/api/projects', { cookie: member.cookie })).status, 401, 'phiên của user bị khoá bị từ chối');
    assert.equal((await call('GET', '/api/projects', { token: rawToken })).status, 401, 'token của user bị khoá bị từ chối');
    assert.equal((await login('lananh', MEMBER_PW)).status, 401, 'user bị khoá không đăng nhập được');
    assert.equal((await call('GET', '/api/projects', { cookie: other.cookie })).status, 200, 'người khác không ảnh hưởng');
    assert.equal((await call('PATCH', `/api/admin/users/${admin.data.user.id}`, { cookie: admin.cookie, body: { status: 'disabled' } })).status, 400, 'không tự khoá');
    await call('PATCH', `/api/admin/users/${memberId}`, { cookie: admin.cookie, body: { status: 'active' } });
    assert.equal((await call('GET', '/api/projects', { token: rawToken })).status, 200, 'mở khoá → token dùng lại được');
    assert.equal((await call('GET', '/api/projects', { cookie: member.cookie })).status, 401, 'phiên cũ đã bị xoá khi khoá');
    // disable by editing users.json directly (another process) → rejected within the cache window
    member = await login('lananh', MEMBER_PW);
    assert.equal((await call('GET', '/api/projects', { cookie: member.cookie })).status, 200);
    const db = readUsers();
    db.users.find((u) => u.id === memberId).status = 'disabled';
    writeUsers(db);
    const t0 = Date.now();
    await waitFor(async () => (await call('GET', '/api/projects', { token: rawToken })).status === 401, CACHE_MS + 1500, 'token bị từ chối sau khi sửa users.json');
    const took = Date.now() - t0;
    assert.equal((await call('GET', '/api/projects', { cookie: member.cookie })).status, 401);
    assert.equal((await call('GET', '/api/projects', { cookie: other.cookie })).status, 200);
    assert.ok(took <= CACHE_MS + 1000, `bị từ chối sau ${took} ms`);
    db.users.find((u) => u.id === memberId).status = 'active';
    writeUsers(db);
    await sleep(CACHE_MS + 100);
    // reset password: old session out, new password works, old one does not
    member = await login('lananh', MEMBER_PW);
    assert.equal((await call('POST', `/api/admin/users/${memberId}/password`, { cookie: admin.cookie, body: { password: RESET_PW } })).status, 200);
    assert.equal((await call('GET', '/api/projects', { cookie: member.cookie })).status, 401, 'đặt lại mật khẩu → đăng xuất phiên cũ');
    assert.equal((await login('lananh', MEMBER_PW)).status, 401);
    member = await login('lananh', RESET_PW);
    assert.equal(member.status, 200);
    ok(`khoá user: phiên + token bị từ chối ngay (API) / sau ${took} ms khi sửa users.json (cache ${CACHE_MS} ms), người khác không ảnh hưởng; mở khoá; đặt lại mật khẩu`);
  }

  // ---- after the 30-day window APP_PASSWORD is rejected ----
  {
    const db = readUsers();
    db.firstUserAt = new Date(Date.now() - 31 * 24 * 3600e3).toISOString();
    writeUsers(db);
    await sleep(CACHE_MS + 200);
    const r = await call('GET', '/api/projects', { auth: basic(APP_PW) });
    assert.equal(r.status, 401, 'APP_PASSWORD bị từ chối sau 30 ngày');
    assert.equal(r.headers.get('x-auth-warning'), null);
    assert.equal((await call('GET', '/legacy-login', { auth: basic(APP_PW) })).status, 410);
    const st = await call('GET', '/api/auth/status', { cookie: admin.cookie });
    assert.equal(st.data.banner, null);
    assert.equal(st.data.transitionEndsAt, null);
    assert.equal((await call('GET', '/api/projects', { cookie: admin.cookie })).status, 200);
    ok('sau 30 ngày (firstUserAt lùi 31 ngày): APP_PASSWORD → 401, /legacy-login → 410, tài khoản vẫn vào bình thường');
  }

  // ---- malformed login body: password must not be echoed/logged ----
  {
    const r = await call('POST', '/api/auth/login', { raw: `{"username":"danny","password":"${RESET_PW}"` });
    assert.equal(r.status, 400);
    assert.ok(!JSON.stringify(r.data).includes(RESET_PW));
  }

  // ---- login rate limit 10 / 15 min / IP (last: it blocks this IP) ----
  {
    assert.ok(failedLogins < 10, `đã sai ${failedLogins} lần trước đó`);
    for (let n = 0; failedLogins < 10; n++) assert.equal((await login('danny', 'sai-' + n)).status, 401);
    const blocked = await login('danny', ADMIN_PW);
    assert.equal(blocked.status, 429, 'lần thứ 11 bị chặn kể cả đúng mật khẩu');
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    assert.equal(blocked.sid, undefined);
    assert.equal((await call('GET', '/api/projects', { cookie: admin.cookie })).status, 200, 'phiên đang có không bị ảnh hưởng');
    ok('rate limit đăng nhập: 10 lần sai/15 phút/IP → 429 + Retry-After');
  }

  // ---- no secrets in the server log ----
  {
    await sleep(200);
    const log = server.output();
    for (const s of secrets) assert.ok(!log.includes(s), 'log chứa mật khẩu');
    assert.ok(!log.includes(rawToken) && !log.includes(rawToken.slice(12)), 'log chứa token');
    assert.ok(!log.includes(admin.sid) && !log.includes(member.sid), 'log chứa id phiên');
    assert.match(log, /đăng nhập thất bại/);
    ok('log server không chứa mật khẩu (kể cả body JSON lỗi), token hay id phiên');
  }

  console.log(`\nRESULT PASS (${passed} nhóm kiểm tra)`);
} catch (e) {
  console.error('FAIL ', e.stack || e.message);
  if (server) console.error('--- server log ---\n' + server.output().slice(-4000));
  process.exitCode = 1;
} finally {
  await stop();
  fs.rmSync(DATA, { recursive: true, force: true });
}
