// Job kinds known to the queue (server/jobs.js). A job stores only kind + params,
// so each kind must be able to (re)start from params alone — this is what makes
// "Chạy lại" possible after a restart.
import * as store from './store.js';
import { registerKind } from './jobs.js';
import { renderProject } from './render.js';
import { runDirector } from './director.js';

/**
 * Shared start of every render-like job: read the project NOW (not at enqueue
 * time) so edits made while the job was queued are included, and record which
 * version was used (`job.projectUpdatedAt`).
 */
export async function loadForRender(projectId, ctx) {
  const p = await store.loadProject(projectId);
  if (!p.shots.length) throw new Error('Dự án chưa có shot nào');
  ctx.set({ projectUpdatedAt: p.updatedAt || null });
  ctx.log(`Dùng dự án lúc ${p.updatedAt || '?'}`);
  return p;
}

async function saveExport(projectId, exp) {
  const fresh = await store.loadProject(projectId);
  fresh.exports = [exp, ...(fresh.exports || [])].slice(0, 50);
  await store.saveProject(fresh);
}

const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); rej(new Error('Đã huỷ')); }, { once: true });
});

export function registerDefaultKinds() {
  registerKind('director', {
    lane: 'director',
    run: async ({ brief = '', shotId = null, review = true }, ctx) => {
      const p = await store.loadProject(ctx.job.projectId);
      const next = await runDirector(p, { brief, shotId, review, log: ctx.log, progress: ctx.progress, signal: ctx.signal });
      await store.saveProject(next, { snapshot: true, reason: shotId ? 'ai-shot' : 'ai-director' });
      return { project: next };
    },
  });

  registerKind('render', {
    lane: 'render',
    run: async ({ quality = 'standard' }, ctx) => {
      const p = await loadForRender(ctx.job.projectId, ctx);
      const exp = await renderProject(p, { quality, onProgress: ctx.progress, signal: ctx.signal });
      await saveExport(p.id, exp);
      return exp;
    },
  });

  // Fake kinds for scripts/test-jobs.js (no Chromium/ffmpeg/API). Only when JOBS_TEST_KINDS=1.
  if (process.env.JOBS_TEST_KINDS === '1') {
    // director-like: same lane/limit as 'director'; `steps` × `stepMs`
    registerKind('test-director', {
      lane: 'director',
      run: async ({ steps = 3, stepMs = 200 }, ctx) => {
        for (let i = 1; i <= steps; i++) {
          await sleep(stepMs, ctx.signal);
          ctx.log(`bước ${i}/${steps}`);
          ctx.progress(i / steps, `bước ${i}/${steps}`);
        }
        return { steps };
      },
    });
    // render-like: same lane and same load-at-start path as 'render', no ffmpeg
    registerKind('test-render', {
      lane: 'render',
      run: async ({ ms = 100 }, ctx) => {
        const p = await loadForRender(ctx.job.projectId, ctx);
        await sleep(ms, ctx.signal);
        ctx.progress(1, 'Xong');
        return { file: 'fake.mp4', updatedAt: p.updatedAt, shots: p.shots.map((s) => ({ id: s.id, duration: s.duration, fields: s.fields })) };
      },
    });
  }
}
