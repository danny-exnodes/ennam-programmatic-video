// Tiny in-memory job queue for long tasks (render, AI director).
// Renders run one at a time (CPU-heavy); director jobs run concurrently.
import { newId } from './store.js';

const jobs = new Map();
const renderQueue = [];
let rendering = false;

export function createJob(kind, projectId, fn, { serial = false } = {}) {
  const job = {
    id: newId('j'), kind, projectId, status: 'queued', progress: 0, message: 'Đang chờ',
    log: [], result: null, error: null, createdAt: Date.now(), controller: new AbortController(),
  };
  jobs.set(job.id, job);
  const runIt = async () => {
    job.status = 'running';
    job.message = 'Đang chạy';
    try {
      job.result = await fn({
        signal: job.controller.signal,
        progress: (k, msg) => { job.progress = k; if (msg) job.message = msg; },
        log: (line) => { job.log.push(line); if (job.log.length > 200) job.log.shift(); job.message = line; },
      });
      job.status = 'done';
      job.progress = 1;
    } catch (e) {
      job.status = 'error';
      job.error = e.message || String(e);
      console.error(`[job ${job.kind}]`, e);
    }
  };
  if (serial) {
    renderQueue.push(runIt);
    pump();
  } else runIt();
  // GC old jobs
  for (const [id, j] of jobs) if (Date.now() - j.createdAt > 6 * 3600e3) jobs.delete(id);
  return job;
}

async function pump() {
  if (rendering) return;
  rendering = true;
  while (renderQueue.length) {
    const next = renderQueue.shift();
    await next();
  }
  rendering = false;
}

export function getJob(id) {
  return jobs.get(id);
}

export function publicJob(j) {
  if (!j) return null;
  const { controller, ...rest } = j;
  return rest;
}

export function listJobs(projectId) {
  return [...jobs.values()].filter((j) => !projectId || j.projectId === projectId).map(publicJob);
}

export function cancelJob(id) {
  const j = jobs.get(id);
  if (j) j.controller.abort();
  return !!j;
}
