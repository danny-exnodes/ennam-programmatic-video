// Central editor state + autosave.
import { api } from './api.js';

const listeners = new Map();
export const state = {
  config: { director: false, tts: false, voices: [], templates: [] },
  project: null,
  selectedShot: null, // shot id
  time: 0,
  playing: false,
  tab: 'director',
  view: 'editor', // 'editor' | 'projects'
  jobs: [], // active jobs for this project
  saving: false,
  dirty: false,
};

export function on(evt, fn) {
  if (!listeners.has(evt)) listeners.set(evt, new Set());
  listeners.get(evt).add(fn);
}
export function emit(evt, data) {
  (listeners.get(evt) || []).forEach((fn) => fn(data));
}

export function duration() {
  return state.project ? state.project.shots.reduce((s, x) => s + x.duration, 0) : 0;
}
export function shotStarts() {
  let t = 0;
  return state.project.shots.map((s) => {
    const r = { shot: s, start: t, end: t + s.duration };
    t += s.duration;
    return r;
  });
}
export function selected() {
  return state.project?.shots.find((s) => s.id === state.selectedShot) || null;
}

let saveTimer;
/** Mutate the project, re-render everything, debounce-save to server. */
export function update(fn, { save = true, structural = true } = {}) {
  fn(state.project);
  state.dirty = true;
  emit('project', { structural });
  if (save) {
    clearTimeout(saveTimer);
    emit('save', 'pending');
    saveTimer = setTimeout(saveNow, 700);
  }
}

export async function saveNow(opts) {
  clearTimeout(saveTimer);
  if (!state.project) return;
  state.saving = true;
  emit('save', 'saving');
  try {
    const p = await api.save(state.project, opts);
    // keep server-owned fields fresh (exports)
    state.project.exports = p.exports;
    state.dirty = false;
    emit('save', 'saved');
  } catch (e) {
    emit('save', 'error:' + e.message);
  } finally {
    state.saving = false;
  }
}

/** Replace whole project (after server-side operations). */
export function setProject(p, { keepSelection = true } = {}) {
  const prevSel = state.selectedShot;
  state.project = p;
  if (!keepSelection || !p.shots.some((s) => s.id === prevSel)) state.selectedShot = p.shots[0]?.id || null;
  state.time = Math.min(state.time, Math.max(0, duration() - 0.001));
  emit('project', { structural: true, replaced: true });
}

export function seek(t) {
  state.time = Math.max(0, Math.min(duration() - 1e-3, t));
  emit('time', state.time);
}

export function selectShot(id, { seekTo = true } = {}) {
  state.selectedShot = id;
  if (seekTo) {
    const it = shotStarts().find((x) => x.shot.id === id);
    if (it && (state.time < it.start || state.time >= it.end)) seek(it.start + 0.001);
  }
  emit('select', id);
}

export const JOB_TERMINAL = new Set(['done', 'error', 'cancelled', 'interrupted']);

function putJob(job) {
  state.jobs = state.jobs.some((j) => j.id === job.id) ? state.jobs.map((j) => (j.id === job.id ? job : j)) : [...state.jobs, job];
  emit('jobs');
}

/** Follow a job via SSE (/api/jobs/:id/events); falls back to polling if SSE fails. */
function followSSE(job) {
  return new Promise((resolve) => {
    if (typeof EventSource === 'undefined') return resolve(null);
    let last = job, finished = false;
    const es = new EventSource(api.jobEventsUrl(job.id));
    es.addEventListener('job', (e) => {
      try { last = JSON.parse(e.data); } catch { return; }
      putJob(last);
      if (JOB_TERMINAL.has(last.status)) { finished = true; es.close(); resolve(last); }
    });
    es.onerror = () => {
      if (finished) return;
      es.close();
      resolve(null); // → polling fallback
    };
  });
}

/** Track a server job until it finishes (SSE, fallback poll); emits 'jobs' updates. */
export async function trackJob(job, onDone) {
  putJob(job);
  if (!JOB_TERMINAL.has(job.status)) {
    const viaSSE = await followSSE(job);
    if (viaSSE) job = viaSSE;
    else {
      for (;;) {
        await new Promise((r) => setTimeout(r, job.kind === 'render' ? 1000 : 1500));
        try {
          job = await api.job(job.id);
        } catch {
          continue;
        }
        putJob(job);
        if (JOB_TERMINAL.has(job.status)) break;
      }
    }
  }
  setTimeout(() => {
    state.jobs = state.jobs.filter((j) => j.id !== job.id);
    emit('jobs');
  }, job.status === 'done' ? 4000 : 15000);
  onDone && onDone(job);
  return job;
}

/** "Chạy lại" an interrupted/failed job: the server re-creates it from kind + params. */
export async function retryJob(old) {
  const job = await api.retry(old.id);
  state.jobs = state.jobs.filter((j) => j.id !== old.id);
  trackJob(job, (j) => emit('jobdone', j));
  return job;
}
