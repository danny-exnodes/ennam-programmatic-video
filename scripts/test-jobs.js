// Test hàng đợi job bền vững (server/jobs.js) — không cần trình duyệt/ffmpeg/API.
// usage: node scripts/test-jobs.js
// Chạy server thật như process con (DATA_DIR tạm, JOBS_TEST_KINDS=1 bật các kind giả
// `test-director` / `test-render`, DIRECTOR_CONCURRENCY=2) và kiểm tra:
//   1. lưu trạng thái + restart → interrupted (giữ log), dọn job cũ > 6 h, "Chạy lại"
//   2. giới hạn đạo diễn song song = 2 với 5 job, FIFO
//   3. huỷ job queued → không bao giờ chạy
//   4. render đọc project lúc BẮT ĐẦU chạy (không phải lúc enqueue)
//   5. SSE đẩy tiến độ < 1 s, đóng stream khi job xong, heartbeat
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.TEST_JOBS_PORT || 5398);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-test-'));
const JOBS_DIR = path.join(DATA, 'jobs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let server = null, passed = 0;
let t0 = 0, hb = null, hbRaw = '';
const ok = (name) => { passed++; console.log('PASS ', name); };

async function start() {
  const child = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, JOBS_TEST_KINDS: '1', DIRECTOR_CONCURRENCY: '2', ANTHROPIC_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  child.output = () => out;
  for (let i = 0; i < 60; i++) {
    if (child.exitCode != null) throw new Error('server thoát sớm:\n' + out);
    try { if ((await fetch(BASE + '/api/jobs')).ok) return (server = child); } catch { /* not yet */ }
    await sleep(250);
  }
  throw new Error('server không khởi động:\n' + out);
}
async function stop(signal = 'SIGKILL') {
  if (!server || server.exitCode != null) return;
  const s = server;
  const exited = new Promise((r) => s.once('exit', r));
  s.kill(signal);
  await exited;
  server = null;
}

async function api(method, url, body) {
  const r = await fetch(BASE + url, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json();
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${data.error}`);
  return data;
}
const enqueue = (kind, params, projectId = 'ptest') => api('POST', '/api/test/jobs', { kind, projectId, params });
const job = (id) => api('GET', `/api/jobs/${id}`);
async function waitFor(fn, ms = 10000, what = 'điều kiện') {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('hết giờ chờ ' + what);
    await sleep(50);
  }
}
const waitStatus = (id, st, ms) => waitFor(async () => { const j = await job(id); return (Array.isArray(st) ? st : [st]).includes(j.status) && j; }, ms, `${id} → ${st}`);

/** Read an SSE stream with fetch; calls onEvent({event, data, at}) and onRaw(text). */
function sse(url, { onEvent = () => {}, onRaw = () => {} } = {}) {
  const ctrl = new AbortController();
  const done = (async () => {
    const r = await fetch(BASE + url, { signal: ctrl.signal });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /^text\/event-stream/);
    assert.match(r.headers.get('cache-control'), /no-cache/);
    assert.equal(r.headers.get('x-accel-buffering'), 'no');
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of r.body) {
      const text = dec.decode(chunk, { stream: true });
      onRaw(text);
      buf += text;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = { event: 'message', data: '', at: Date.now() };
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) ev.event = line.slice(7);
          else if (line.startsWith('data: ')) ev.data += line.slice(6);
        }
        if (ev.data) { ev.data = JSON.parse(ev.data); onEvent(ev); }
      }
    }
    return 'closed';
  })().catch((e) => (e.name === 'AbortError' ? 'aborted' : Promise.reject(e)));
  done.catch(() => {}); // awaited where it matters; avoid unhandled rejection on server kill
  return { done, close: () => ctrl.abort() };
}

try {
  // a finished job older than 6 h must be cleaned from disk on startup
  fs.mkdirSync(JOBS_DIR, { recursive: true });
  const old = Date.now() - 7 * 3600e3;
  fs.writeFileSync(path.join(JOBS_DIR, 'jold000000.json'), JSON.stringify({ id: 'jold000000', kind: 'render', projectId: 'ptest', status: 'done', log: [], createdAt: old, finishedAt: old }));
  await start();

  // ---- 6 h cleanup ----
  assert.equal(fs.existsSync(path.join(JOBS_DIR, 'jold000000.json')), false, 'job cũ > 6 h phải bị xoá khỏi đĩa');
  assert.equal((await fetch(BASE + '/api/jobs/jold000000')).status, 404);
  ok('dọn job đã xong > 6 h (đĩa + bộ nhớ) khi khởi động');

  // ---- 5. SSE progress latency ----
  {
    const j = await enqueue('test-director', { steps: 5, stepMs: 250 });
    const events = [];
    const s = sse(`/api/jobs/${j.id}/events`, { onEvent: (e) => events.push(e) });
    assert.equal(await s.done, 'closed', 'stream phải tự đóng khi job xong');
    const prog = events.filter((e) => e.event === 'job' && e.data.status === 'running' && e.data.progress > 0);
    assert.ok(prog.length >= 4, `cần nhận nhiều sự kiện tiến độ (có ${prog.length})`);
    const lat = prog.map((e) => e.at - e.data.updatedAt);
    assert.ok(Math.max(...lat) < 1000, `độ trễ SSE ${Math.max(...lat)} ms`);
    assert.equal(events.at(-1).data.status, 'done');
    // project stream: snapshot + live job events
    const pev = [];
    const ps = sse('/api/projects/psse/jobs/events', { onEvent: (e) => pev.push(e) });
    await waitFor(() => pev.length >= 1, 3000, 'snapshot');
    assert.equal(pev[0].event, 'jobs');
    const j2 = await enqueue('test-director', { steps: 2, stepMs: 100 }, 'psse');
    await waitFor(() => pev.some((e) => e.event === 'job' && e.data.id === j2.id && e.data.status === 'done'), 5000, 'project SSE done');
    ps.close();
    // finished job: one snapshot then close
    const fin = [];
    assert.equal(await sse(`/api/jobs/${j.id}/events`, { onEvent: (e) => fin.push(e) }).done, 'closed');
    assert.equal(fin.length, 1);
    ok(`SSE: ${prog.length} sự kiện tiến độ, trễ tối đa ${Math.max(...lat)} ms, đóng khi xong; stream theo dự án`);
  }

  // ---- 2. concurrency limit 2 with 5 director-like jobs ----
  {
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push((await enqueue('test-director', { steps: 3, stepMs: 300 }, 'pconc')).id);
    const snap = (await api('GET', '/api/jobs?project=pconc'));
    const count = (st) => snap.filter((j) => j.status === st).length;
    assert.equal(count('running'), 2, 'đúng 2 job running');
    assert.equal(count('queued'), 3, 'đúng 3 job queued');
    let maxRunning = 0;
    await waitFor(async () => {
      const l = await api('GET', '/api/jobs?project=pconc');
      maxRunning = Math.max(maxRunning, l.filter((j) => j.status === 'running').length);
      return l.every((j) => j.status === 'done');
    }, 15000, '5 job xong');
    const all = await Promise.all(ids.map(job));
    // overlap check from timestamps
    for (const a of all) {
      const atStart = all.filter((b) => b.startedAt <= a.startedAt && a.startedAt < b.finishedAt).length;
      assert.ok(atStart <= 2, `${atStart} job chạy cùng lúc khi ${a.id} bắt đầu`);
    }
    assert.ok(maxRunning <= 2, `quan sát được ${maxRunning} job running`);
    const starts = all.map((j) => j.startedAt);
    assert.deepEqual([...starts].sort((x, y) => x - y), starts, 'FIFO theo thứ tự enqueue');
    ok('DIRECTOR_CONCURRENCY=2: 2 running + 3 queued, tối đa 2 chạy cùng lúc, FIFO, tự chạy tiếp');
  }

  // ---- 3. cancel a queued job ----
  {
    const a = await enqueue('test-director', { steps: 20, stepMs: 100 }, 'pcancel');
    const b = await enqueue('test-director', { steps: 20, stepMs: 100 }, 'pcancel');
    const c = await enqueue('test-director', { steps: 1, stepMs: 10 }, 'pcancel');
    assert.equal((await job(c.id)).status, 'queued');
    assert.deepEqual(await api('POST', `/api/jobs/${c.id}/cancel`), { ok: true });
    assert.equal((await job(c.id)).status, 'cancelled');
    await api('POST', `/api/jobs/${a.id}/cancel`);
    await api('POST', `/api/jobs/${b.id}/cancel`);
    await waitStatus(a.id, 'cancelled', 3000);
    await waitStatus(b.id, 'cancelled', 3000);
    await sleep(300);
    const cc = await job(c.id);
    assert.equal(cc.status, 'cancelled');
    assert.equal(cc.startedAt, null, 'job đã huỷ khi chờ không được chạy');
    await sleep(1200); // throttle window
    const disk = JSON.parse(fs.readFileSync(path.join(JOBS_DIR, `${c.id}.json`), 'utf8'));
    assert.equal(disk.status, 'cancelled');
    ok('huỷ job queued: không bao giờ chạy, trạng thái lưu xuống đĩa; huỷ được job running');
  }

  // ---- 4. render reads the project when it starts ----
  {
    const p = await api('POST', '/api/projects', { name: 'Test render' });
    p.shots = [{ id: 'sh1', name: 'A', duration: 2, code: 's.clear("#000")', fields: { title: 'cũ' } }];
    const saved = await api('PUT', `/api/projects/${p.id}`, p);
    const blocker = await enqueue('test-render', { ms: 1200 }, p.id); // occupies the serial render lane
    const r = await enqueue('test-render', { ms: 50 }, p.id);
    await waitStatus(blocker.id, 'running', 3000);
    assert.equal((await job(r.id)).status, 'queued');
    saved.shots[0].fields.title = 'mới';
    saved.shots.push({ id: 'sh2', name: 'B', duration: 1, code: '', fields: {} });
    const edited = await api('PUT', `/api/projects/${p.id}`, saved);
    const done = await waitStatus(r.id, 'done', 5000);
    assert.equal(done.result.shots[0].fields.title, 'mới', 'render phải dùng field đã sửa khi job còn xếp hàng');
    assert.equal(done.result.shots.length, 2, 'render phải thấy shot mới');
    assert.equal(done.projectUpdatedAt, edited.updatedAt, 'job ghi lại updatedAt của project đã dùng');
    const bd = await job(blocker.id);
    assert.ok(bd.finishedAt <= done.startedAt, 'render chạy tuần tự');
    ok('render đọc lại project lúc bắt đầu (field + shot sửa khi đang chờ), ghi projectUpdatedAt, tuần tự');
  }

  // ---- 1. persistence + restart → interrupted + retry ----
  {
    const long = await enqueue('test-director', { steps: 200, stepMs: 100 }, 'prestart');
    const fill = await enqueue('test-director', { steps: 200, stepMs: 100 }, 'prestart');
    const queued = await enqueue('test-director', { steps: 1, stepMs: 10 }, 'prestart');
    await waitFor(async () => (await job(long.id)).log.length >= 5, 5000, 'log');
    await sleep(1300); // > throttle → progress/log persisted
    const before = await job(long.id);
    const onDisk = JSON.parse(fs.readFileSync(path.join(JOBS_DIR, `${long.id}.json`), 'utf8'));
    assert.equal(onDisk.status, 'running');
    assert.ok(onDisk.log.length >= 5 && onDisk.log.length >= before.log.length - 12, 'log được lưu (throttle ~1 s)');
    assert.equal(fs.readdirSync(JOBS_DIR).filter((f) => f.endsWith('.tmp')).length, 0, 'không còn file tmp');
    await stop('SIGKILL');
    await start();
    // heartbeat: an idle project stream must get `: ping` after ~15 s (checked at the end)
    t0 = Date.now();
    hb = sse('/api/projects/pidle/jobs/events', { onRaw: (t) => (hbRaw += t) });
    const a = await job(long.id);
    assert.equal(a.status, 'interrupted');
    assert.ok(a.log.length >= onDisk.log.length, 'giữ log cũ');
    assert.deepEqual(a.log.slice(0, onDisk.log.length), onDisk.log);
    assert.equal(a.kind, 'test-director');
    assert.deepEqual(a.params, { steps: 200, stepMs: 100 });
    assert.equal((await job(fill.id)).status, 'interrupted');
    assert.equal((await job(queued.id)).status, 'interrupted', 'job queued cũng thành interrupted');
    const re = await api('POST', `/api/jobs/${long.id}/retry`);
    assert.notEqual(re.id, long.id);
    assert.equal(re.retryOf, long.id);
    assert.deepEqual(re.params, a.params);
    await waitStatus(re.id, 'running', 3000);
    await api('POST', `/api/jobs/${re.id}/cancel`);
    await waitStatus(re.id, 'cancelled', 3000);
    const rq = await api('POST', `/api/jobs/${queued.id}/retry`);
    await waitStatus(rq.id, 'done', 3000);
    ok('kill -9 + restart: running/queued → interrupted, giữ log + kind + params; "Chạy lại" tạo job mới chạy được');
  }

  // ---- heartbeat ----
  {
    const wait = 15500 - (Date.now() - t0);
    if (wait > 0) await sleep(wait);
    await waitFor(() => hbRaw.includes(': ping'), 2000, 'heartbeat');
    hb.close();
    ok('SSE heartbeat `: ping` ~15 s');
  }
  console.log(`\nRESULT PASS (${passed} nhóm kiểm tra)`);
} catch (e) {
  console.error('FAIL ', e.stack || e.message);
  if (server) console.error('--- server log ---\n' + server.output().slice(-3000));
  process.exitCode = 1;
} finally {
  hb?.close();
  await stop('SIGKILL');
  fs.rmSync(DATA, { recursive: true, force: true });
}
