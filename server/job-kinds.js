// Job kinds known to the queue (server/jobs.js). A job stores only kind + params,
// so each kind must be able to (re)start from params alone — this is what makes
// "Chạy lại" possible after a restart.
import * as store from './store.js';
import { syncProjectBrand } from './brands.js';
import { registerKind } from './jobs.js';
import { renderProject } from './render.js';
import { runDirector } from './director.js';
import { recordUsage } from './usage.js';

/** Load a project; one that follows its Brand Kit (not locked) is moved to the kit's latest version (#8). */
export async function loadWithBrand(projectId) {
  const p = await store.loadProject(projectId);
  if (await syncProjectBrand(p)) await store.saveProject(p);
  return p;
}

/**
 * Shared start of every render-like job: read the project NOW (not at enqueue
 * time) so edits made while the job was queued are included, and record which
 * version was used (`job.projectUpdatedAt`).
 */
export async function loadForRender(projectId, ctx) {
  const p = await loadWithBrand(projectId);
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

/** Usage per user (#25): persisted on the job (`job.usage`) + one line in DATA_DIR/usage/<YYYY-MM>.jsonl. */
async function recordDirectorUsage(ctx, total) {
  if (!total) return;
  ctx.set({ usage: total });
  await recordUsage({ userId: ctx.job.userId, projectId: ctx.job.projectId, jobId: ctx.job.id, usage: total })
    .catch((e) => console.error('[usage] ghi log usage lỗi:', e.message));
}

const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); rej(new Error('Đã huỷ')); }, { once: true });
});

export function registerDefaultKinds() {
  registerKind('director', {
    lane: 'director',
    // params: { request, shotId, review } — old jobs may carry `brief` (string = legacy request);
    // the structured brief is read from the project itself (project.brief) when the job starts.
    run: async ({ brief = '', request, shotId = null, review = true }, ctx) => {
      const p = await loadWithBrand(ctx.job.projectId);
      const next = await runDirector(p, { brief, request, shotId, review, log: ctx.log, progress: ctx.progress, signal: ctx.signal });
      const userId = ctx.job.userId || null;
      if (next.lastDirector) {
        next.lastDirector.userId = userId;
        if (next.lastDirector.usage) next.lastDirector.usage.userId = userId;
      }
      await store.saveProject(next, { snapshot: true, reason: shotId ? 'ai-shot' : 'ai-director', userId });
      await recordDirectorUsage(ctx, next.lastDirector?.usage?.total);
      return { project: next };
    },
  });

  registerKind('render', {
    lane: 'render',
    // quality 'preview' = "Xem nhanh": written to <project>/preview/ (latest only), not to exports.
    // result.cache = { segments, reused, frames, reusedFrames, savedSec, … } (per-segment cache, #29)
    run: async ({ quality = 'standard' }, ctx) => {
      const p = await loadForRender(ctx.job.projectId, ctx);
      const exp = await renderProject(p, { quality, onProgress: ctx.progress, log: ctx.log, signal: ctx.signal });
      if (!exp.preview) await saveExport(p.id, exp);
      return exp;
    },
  });

  // Fake kinds for scripts/test-jobs.js (no Chromium/ffmpeg/API). Only when JOBS_TEST_KINDS=1.
  if (process.env.JOBS_TEST_KINDS === '1') {
    // director-like: same lane/limit as 'director'; `steps` × `stepMs`
    registerKind('test-director', {
      lane: 'director',
      run: async ({ steps = 3, stepMs = 200, usage = null }, ctx) => {
        for (let i = 1; i <= steps; i++) {
          await sleep(stepMs, ctx.signal);
          ctx.log(`bước ${i}/${steps}`);
          ctx.progress(i / steps, `bước ${i}/${steps}`);
        }
        // director-like usage record (scripts/test-auth.js checks per-user monthly aggregation)
        if (usage) await recordDirectorUsage(ctx, usage);
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
