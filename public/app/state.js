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

/** Poll a server job until done; emits 'job' updates. */
export async function trackJob(job, onDone) {
  state.jobs = [...state.jobs.filter((j) => j.id !== job.id), job];
  emit('jobs');
  for (;;) {
    await new Promise((r) => setTimeout(r, job.kind === 'render' ? 1000 : 1500));
    try {
      job = await api.job(job.id);
    } catch {
      continue;
    }
    state.jobs = state.jobs.map((j) => (j.id === job.id ? job : j));
    emit('jobs');
    if (job.status === 'done' || job.status === 'error') break;
  }
  setTimeout(() => {
    state.jobs = state.jobs.filter((j) => j.id !== job.id);
    emit('jobs');
  }, job.status === 'error' ? 15000 : 4000);
  onDone && onDone(job);
  return job;
}
