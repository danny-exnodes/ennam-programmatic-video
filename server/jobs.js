// Durable job queue for long tasks (render, AI director).
//
// - A job is plain data (kind + params + status/progress/log/result). The work
//   itself is a registered *kind* (`registerKind`), so a job can be re-created
//   from its stored params ("Chạy lại") after a restart.
// - State is persisted to DATA_DIR/jobs/<id>.json (atomic tmp + rename).
//   Status changes are written immediately, progress/log writes are throttled
//   (~1 s). On startup (`initJobs`) jobs left `running`/`queued` become
//   `interrupted`, keeping their log.
// - Lanes limit concurrency: `render` runs one job at a time (CPU-heavy),
//   `director` runs at most DIRECTOR_CONCURRENCY (default 2). Excess jobs wait
//   FIFO in their lane.
// - Every change is published on `jobEvents` ('update', job) for SSE.
// - Finished jobs older than 6 h are dropped from memory and disk.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { DATA_DIR, newId } from './store.js';

export const JOBS_DIR = path.join(DATA_DIR, 'jobs');
export const TERMINAL = new Set(['done', 'error', 'cancelled', 'interrupted']);
const MAX_AGE = 6 * 3600e3;
const PERSIST_THROTTLE = 1000;
const LOG_MAX = 200;

const intEnv = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 1 ? Math.floor(Number(v)) : d);
export const DIRECTOR_CONCURRENCY = intEnv(process.env.DIRECTOR_CONCURRENCY, 2);

const jobs = new Map(); // id -> plain job data (what is persisted / served)
const internals = new Map(); // id -> { controller, timer, writing }
const kinds = new Map(); // kind -> { lane, run }
const lanes = {
  render: { limit: 1, running: 0, queue: [] },
  director: { limit: DIRECTOR_CONCURRENCY, running: 0, queue: [] },
};
export const jobEvents = new EventEmitter();
jobEvents.setMaxListeners(0);

/**
 * Register a job kind. run(params, ctx) → result, where
 * ctx = { job, signal, progress(k, msg), log(line), set(patch) }.
 * lane: 'render' | 'director' | undefined (unlimited).
 * paid: true when the kind calls a paid model — server/budget.js `checkBudget` blocks NEW
 * jobs of such kinds once the caller's monthly budget is used up (#34).
 */
export function registerKind(kind, { lane, run, paid = false }) {
  kinds.set(kind, { lane, run, paid: !!paid });
}
export const hasKind = (kind) => kinds.has(kind);
export const isPaidKind = (kind) => !!kinds.get(kind)?.paid;

// ---------- persistence ----------
const fileOf = (id) => path.join(JOBS_DIR, `${id}.json`);

function writeNow(job) {
  const it = internals.get(job.id) || {};
  if (it.timer) { clearTimeout(it.timer); it.timer = null; }
  const data = JSON.stringify(job);
  // serialize writes per job so an older snapshot never lands after a newer one
  it.writing = (it.writing || Promise.resolve()).then(async () => {
    const tmp = `${fileOf(job.id)}.${process.pid}.tmp`;
    await fsp.mkdir(JOBS_DIR, { recursive: true });
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, fileOf(job.id));
  }).catch((e) => console.error(`[job ${job.id}] persist`, e.message));
  internals.set(job.id, it);
  return it.writing;
}

function writeSoon(job) {
  const it = internals.get(job.id) || {};
  internals.set(job.id, it);
  if (!it.timer) it.timer = setTimeout(() => { it.timer = null; if (jobs.has(job.id)) writeNow(job); }, PERSIST_THROTTLE);
}

/** Wait for pending writes (tests / graceful paths). */
export async function flushJobs() {
  for (const j of jobs.values()) writeNow(j);
  await Promise.all([...internals.values()].map((it) => it.writing));
}

function changed(job, { persist = 'soon' } = {}) {
  job.updatedAt = Date.now();
  if (persist === 'now') writeNow(job); else writeSoon(job);
  jobEvents.emit('update', job);
}

/** Load persisted jobs; unfinished ones become `interrupted`. Call once at startup. */
export function initJobs() {
  fs.mkdirSync(JOBS_DIR, { recursive: true });
  for (const f of fs.readdirSync(JOBS_DIR)) {
    const full = path.join(JOBS_DIR, f);
    if (f.endsWith('.tmp')) { fs.rmSync(full, { force: true }); continue; }
    if (!f.endsWith('.json')) continue;
    let j;
    try { j = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { fs.rmSync(full, { force: true }); continue; }
    if (!j?.id || `${j.id}.json` !== f) continue;
    if (!TERMINAL.has(j.status)) {
      const was = j.status;
      j.status = 'interrupted';
      j.error = 'Server khởi động lại khi job đang ' + (was === 'running' ? 'chạy' : 'chờ') + ' — bấm "Chạy lại"';
      j.message = 'Bị gián đoạn';
      j.log = [...(j.log || []), `[${new Date().toISOString()}] bị gián đoạn (server khởi động lại khi đang ${was})`].slice(-LOG_MAX);
      j.finishedAt = Date.now();
      j.updatedAt = Date.now();
      const tmp = `${full}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(j));
      fs.renameSync(tmp, full);
    }
    jobs.set(j.id, j);
  }
  gc();
}

// ---------- scheduling ----------
function laneOf(job) {
  return lanes[kinds.get(job.kind)?.lane] || null;
}

function pump(lane) {
  while (lane.running < lane.limit && lane.queue.length) {
    const id = lane.queue.shift();
    const job = jobs.get(id);
    if (!job || job.status !== 'queued') continue;
    lane.running++;
    runJob(job).finally(() => { lane.running--; pump(lane); });
  }
}

async function runJob(job) {
  const kind = kinds.get(job.kind);
  const it = internals.get(job.id);
  job.status = 'running';
  job.message = 'Đang chạy';
  job.startedAt = Date.now();
  changed(job, { persist: 'now' });
  try {
    if (!kind) throw new Error(`Không có loại job "${job.kind}"`);
    const result = await kind.run(job.params || {}, {
      job,
      signal: it.controller.signal,
      progress: (k, msg) => { job.progress = k; if (msg) job.message = msg; changed(job); },
      log: (line) => { job.log.push(line); if (job.log.length > LOG_MAX) job.log.shift(); job.message = line; changed(job); },
      set: (patch) => { Object.assign(job, patch); changed(job); },
    });
    job.result = result ?? null;
    job.status = 'done';
    job.progress = 1;
  } catch (e) {
    if (it.controller.signal.aborted) {
      job.status = 'cancelled';
      job.error = 'Đã huỷ';
    } else {
      job.status = 'error';
      job.error = e.message || String(e);
      console.error(`[job ${job.kind}]`, e);
    }
  }
  job.finishedAt = Date.now();
  changed(job, { persist: 'now' });
}

/**
 * Create and enqueue a job of a registered kind.
 * extra: fields stored on the job (e.g. { retryOf, userId }). `userId` (null = unknown/legacy)
 * is who created the job (issue #25).
 */
export function createJob(kind, projectId, params = {}, extra = {}) {
  if (!kinds.has(kind)) throw Object.assign(new Error(`Không có loại job "${kind}"`), { status: 400 });
  const now = Date.now();
  const job = {
    id: newId('j'), kind, projectId, params, status: 'queued', progress: 0, message: 'Đang chờ',
    log: [], result: null, error: null, createdAt: now, startedAt: null, finishedAt: null, updatedAt: now,
    userId: null,
    ...extra,
  };
  jobs.set(job.id, job);
  internals.set(job.id, { controller: new AbortController(), timer: null, writing: null });
  changed(job, { persist: 'now' });
  const lane = laneOf(job);
  if (lane) { lane.queue.push(job.id); pump(lane); }
  else runJob(job);
  gc();
  return job;
}

/** Re-create a finished/interrupted job from its stored kind + params. extra: e.g. { userId } of who retried. */
export function retryJob(id, extra = {}) {
  const old = jobs.get(id);
  if (!old) return null;
  if (!TERMINAL.has(old.status)) throw Object.assign(new Error('Job vẫn đang chạy/chờ'), { status: 409 });
  return createJob(old.kind, old.projectId, structuredClone(old.params || {}), { retryOf: old.id, ...extra });
}

export function getJob(id) {
  return jobs.get(id);
}

/** API shape: plain job data (backward compatible: id, kind, projectId, status, progress, message, log, result, error, createdAt). */
export function publicJob(j) {
  return j ? { ...j } : null;
}

export function listJobs(projectId) {
  return [...jobs.values()].filter((j) => !projectId || j.projectId === projectId).map(publicJob);
}

/** Cancel: a queued job is removed and never runs; a running job is aborted. */
export function cancelJob(id) {
  const j = jobs.get(id);
  if (!j) return false;
  if (j.status === 'queued') {
    const lane = laneOf(j);
    if (lane) lane.queue = lane.queue.filter((x) => x !== id);
    j.status = 'cancelled';
    j.error = 'Đã huỷ';
    j.message = 'Đã huỷ khi đang chờ';
    j.finishedAt = Date.now();
    changed(j, { persist: 'now' });
  } else if (j.status === 'running') {
    internals.get(id)?.controller.abort();
  }
  return true;
}

function gc() {
  const now = Date.now();
  for (const [id, j] of jobs) {
    if (!TERMINAL.has(j.status) || now - (j.finishedAt || j.createdAt) <= MAX_AGE) continue;
    jobs.delete(id);
    const it = internals.get(id);
    if (it?.timer) clearTimeout(it.timer);
    internals.delete(id);
    Promise.resolve(it?.writing).then(() => fsp.rm(fileOf(id), { force: true })).catch(() => {});
  }
}
setInterval(gc, 10 * 60e3).unref();
