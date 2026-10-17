// HTTP server for the internal motion studio.
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as store from './store.js';
import { kindOf, probe, normalizeImage } from './media.js';
import { initJobs, createJob, getJob, publicJob, listJobs, cancelJob, retryJob, hasKind, jobEvents, TERMINAL, DIRECTOR_CONCURRENCY } from './jobs.js';
import { registerDefaultKinds } from './job-kinds.js';
import { directorAvailable, DIRECTOR_MODEL } from './director.js';
import { synthesize, ttsAvailable, listVoices } from './tts.js';
import { TEMPLATES, buildFromTemplate } from './templates.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 5173);
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '20mb' }));

// --- optional shared-password auth for the internal deployment ---
if (process.env.APP_PASSWORD) {
  app.use((req, res, next) => {
    const h = req.headers.authorization || '';
    const [, b64] = h.split(' ');
    const [, pass] = Buffer.from(b64 || '', 'base64').toString().split(':');
    if (pass === process.env.APP_PASSWORD) return next();
    res.set('WWW-Authenticate', 'Basic realm="Ennam Studio"').status(401).send('Cần đăng nhập');
  });
}

// --- static ---
app.use('/engine', express.static(path.join(ROOT, 'engine'), { maxAge: 0 }));
app.use('/fonts/be-vietnam-pro', express.static(path.join(ROOT, 'node_modules/@fontsource/be-vietnam-pro'), { maxAge: '7d' }));
app.use('/fonts/playfair-display', express.static(path.join(ROOT, 'node_modules/@fontsource/playfair-display'), { maxAge: '7d' }));
app.use(express.static(path.join(ROOT, 'public'), { maxAge: 0 }));
app.get('/files/:id/:kind/:file', (req, res, next) => {
  try {
    if (!['assets', 'exports'].includes(req.params.kind)) return res.status(404).end();
    const f = path.join(store.projectDir(req.params.id), req.params.kind, path.basename(req.params.file));
    if (!fs.existsSync(f)) return res.status(404).end();
    if (req.query.download) res.attachment(path.basename(f));
    res.sendFile(f);
  } catch (e) { next(e); }
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

// --- config ---
app.get('/api/config', wrap(async (_req, res) => {
  res.json({
    director: directorAvailable(), model: DIRECTOR_MODEL,
    tts: ttsAvailable(), voices: ttsAvailable() ? await listVoices().catch(() => []) : [],
    templates: TEMPLATES.map(({ id, name, desc, aspect }) => ({ id, name, desc, aspect })),
  });
}));

// --- projects ---
app.get('/api/projects', wrap(async (_req, res) => res.json(await store.listProjects())));

app.post('/api/projects', wrap(async (req, res) => {
  const b = req.body || {};
  const p = store.defaultProject({ name: b.name, width: b.width, height: b.height, fps: b.fps, brief: b.brief });
  await store.ensureDirs(p.id);
  await store.saveProject(p);
  res.json(p);
}));

app.get('/api/projects/:id', wrap(async (req, res) => res.json(await store.loadProject(req.params.id))));

app.put('/api/projects/:id', wrap(async (req, res) => {
  const cur = await store.loadProject(req.params.id);
  const body = req.body;
  // server owns these fields
  const next = { ...cur, ...body, id: cur.id, assets: body.assets ?? cur.assets, exports: cur.exports, createdAt: cur.createdAt };
  validateProject(next);
  store.clearStaleReview(cur.shots, next.shots); // editing a flagged shot's code clears needsReview
  let snapshot = req.query.snapshot === '1', reason = req.query.reason || 'save';
  // brief edits get a "brief" snapshot (state before the edit), one per editing session
  if (!snapshot && !store.briefEqual(cur.brief, next.brief) && await store.shouldSnapshotBrief(cur.id)) {
    snapshot = true; reason = 'brief';
  }
  await store.saveProject(next, { snapshot, reason });
  res.json(next);
}));

app.delete('/api/projects/:id', wrap(async (req, res) => {
  await store.deleteProject(req.params.id);
  res.json({ ok: true });
}));

app.post('/api/projects/:id/duplicate', wrap(async (req, res) => {
  const src = await store.loadProject(req.params.id);
  const p = { ...structuredClone(src), id: store.newId('p'), name: src.name + ' (bản sao)', exports: [] };
  await store.ensureDirs(p.id);
  await fsp.cp(path.join(store.projectDir(src.id), 'assets'), path.join(store.projectDir(p.id), 'assets'), { recursive: true });
  await store.saveProject(p);
  res.json(p);
}));

app.get('/api/projects/:id/history', wrap(async (req, res) => res.json(await store.listHistory(req.params.id))));
app.post('/api/projects/:id/history/:file/restore', wrap(async (req, res) => {
  const cur = await store.loadProject(req.params.id);
  const old = await store.loadHistory(req.params.id, req.params.file);
  const next = { ...old, id: cur.id, assets: cur.assets, exports: cur.exports };
  await store.saveProject(next, { snapshot: true, reason: 'before-restore' });
  res.json(next);
}));

// --- templates ("Nhanh" + "Mẫu cảnh") ---
app.post('/api/projects/:id/template', wrap(async (req, res) => {
  const cur = await store.loadProject(req.params.id);
  const next = buildFromTemplate(cur, req.body || {});
  await store.saveProject(next, { snapshot: true, reason: 'template' });
  res.json(next);
}));

// --- assets ---
const upload = multer({ dest: path.join(store.DATA_DIR, 'tmp'), limits: { fileSize: 800 * 1024 * 1024 } });
app.post('/api/projects/:id/assets', upload.array('files', 30), wrap(async (req, res) => {
  const p = await store.loadProject(req.params.id);
  await store.ensureDirs(p.id);
  const taken = new Set(p.assets.map((a) => a.name));
  const added = [];
  for (const f of req.files || []) {
    const original = Buffer.from(f.originalname, 'latin1').toString('utf8');
    const kind = kindOf(f.mimetype, original);
    if (!kind) { await fsp.rm(f.path, { force: true }); continue; }
    const id = store.newId('a');
    const name = req.body.name && req.files.length === 1 ? req.body.name : store.assetNameFrom(original, taken);
    taken.add(name);
    let ext = path.extname(original).toLowerCase() || '.bin';
    let file = `${id}${ext}`;
    const dst = path.join(store.projectDir(p.id), 'assets', file);
    if (kind === 'image' && !/\.(gif|svg)$/.test(ext)) {
      const tmp = dst + '.n';
      await normalizeImage(f.path, tmp);
      const meta = await probe(tmp, 'image');
      file = `${id}${meta.hasAlpha ? '.png' : '.jpg'}`;
      await fsp.rename(tmp, path.join(store.projectDir(p.id), 'assets', file));
      await fsp.rm(f.path, { force: true });
    } else {
      await fsp.rename(f.path, dst).catch(async () => { await fsp.copyFile(f.path, dst); await fsp.rm(f.path, { force: true }); });
    }
    const meta = await probe(path.join(store.projectDir(p.id), 'assets', file), kind).catch(() => ({}));
    const asset = {
      id, name, type: kind, file, original, desc: req.body.desc || '',
      role: req.body.role || (kind === 'audio' ? 'music' : 'material'),
      ...meta, addedAt: new Date().toISOString(),
    };
    p.assets.push(asset);
    added.push(asset);
    if (kind === 'audio' && asset.role === 'music') {
      p.music = { assetId: asset.id, volume: p.music?.volume ?? 0.3, fadeIn: 0.5, fadeOut: 1.5, offset: 0 };
    }
  }
  await store.saveProject(p);
  res.json({ project: p, added });
}));

app.patch('/api/projects/:id/assets/:assetId', wrap(async (req, res) => {
  const p = await store.loadProject(req.params.id);
  const a = p.assets.find((x) => x.id === req.params.assetId);
  if (!a) return res.status(404).json({ error: 'Không có chất liệu' });
  const { name, desc, role } = req.body || {};
  if (name && name !== a.name) {
    const clean = store.assetNameFrom(name, new Set(p.assets.filter((x) => x !== a).map((x) => x.name)));
    // rename references in shot code: s.image('old' -> s.image('new'
    for (const sh of p.shots) sh.code = sh.code.split(`'${a.name}'`).join(`'${clean}'`).split(`"${a.name}"`).join(`"${clean}"`);
    a.name = clean;
  }
  if (desc != null) a.desc = desc;
  if (role) a.role = role;
  await store.saveProject(p);
  res.json(p);
}));

app.delete('/api/projects/:id/assets/:assetId', wrap(async (req, res) => {
  const p = await store.loadProject(req.params.id);
  const a = p.assets.find((x) => x.id === req.params.assetId);
  if (a) {
    p.assets = p.assets.filter((x) => x !== a);
    if (p.music?.assetId === a.id) p.music = null;
    for (const v of p.voice) if (v.assetId === a.id) v.assetId = null;
    await fsp.rm(path.join(store.projectDir(p.id), 'assets', a.file), { force: true });
    await store.saveProject(p);
  }
  res.json(p);
}));

// --- voice-over TTS ---
app.post('/api/projects/:id/voice/:lineId/tts', wrap(async (req, res) => {
  const p = await store.loadProject(req.params.id);
  const line = p.voice.find((v) => v.id === req.params.lineId);
  if (!line) return res.status(404).json({ error: 'Không có câu thoại' });
  const id = store.newId('a');
  const file = `${id}.mp3`;
  const out = path.join(store.projectDir(p.id), 'assets', file);
  await synthesize(line.text, out, { voice: req.body?.voice || line.voiceId });
  const meta = await probe(out, 'audio');
  const old = p.assets.find((a) => a.id === line.assetId && a.role === 'voice');
  if (old) {
    p.assets = p.assets.filter((a) => a !== old);
    await fsp.rm(path.join(store.projectDir(p.id), 'assets', old.file), { force: true });
  }
  p.assets.push({ id, name: `vo-${line.id}`, type: 'audio', file, role: 'voice', original: line.text.slice(0, 40), ...meta, addedAt: new Date().toISOString() });
  line.assetId = id;
  line.duration = Math.max(0.5, Math.round(meta.duration * 10) / 10);
  await store.saveProject(p);
  res.json(p);
}));

// --- AI director ---
// Jobs store kind + params only; the project is (re)read when the job starts (server/job-kinds.js).
// `brief`: structured object (saved into project.brief first, with a "brief" snapshot when it
// changed) or a plain string (legacy: the edit request). `request`: free-text edit request.
app.post('/api/projects/:id/director', wrap(async (req, res) => {
  const p = await store.loadProject(req.params.id);
  const { brief = '', request, shotId = null, review = true } = req.body || {};
  let ask = typeof request === 'string' ? request : '';
  if (typeof brief === 'string') ask = ask || brief;
  else if (brief && typeof brief === 'object' && !store.briefEqual(brief, p.brief)) {
    p.brief = store.normalizeBrief(brief);
    await store.saveProject(p, { snapshot: true, reason: 'brief' });
  }
  res.json(publicJob(createJob('director', p.id, { request: ask, shotId, review })));
}));

// --- render ---
app.post('/api/projects/:id/render', wrap(async (req, res) => {
  const p = await store.loadProject(req.params.id);
  if (!p.shots.length) return res.status(400).json({ error: 'Dự án chưa có shot nào' });
  const quality = req.body?.quality || 'standard';
  res.json(publicJob(createJob('render', p.id, { quality })));
}));

app.delete('/api/projects/:id/exports/:file', wrap(async (req, res) => {
  const p = await store.loadProject(req.params.id);
  const name = path.basename(req.params.file);
  p.exports = (p.exports || []).filter((e) => e.file !== name);
  await fsp.rm(path.join(store.projectDir(p.id), 'exports', name), { force: true });
  await store.saveProject(p);
  res.json(p);
}));

// --- jobs ---
app.get('/api/jobs', (req, res) => res.json(listJobs(req.query.project)));
app.get('/api/jobs/:id', (req, res) => {
  const j = getJob(req.params.id);
  if (!j) return res.status(404).json({ error: 'Không có job' });
  res.json(publicJob(j));
});
app.post('/api/jobs/:id/cancel', (req, res) => res.json({ ok: cancelJob(req.params.id) }));
// "Chạy lại": new job with the same kind + params (interrupted / error / cancelled jobs)
app.post('/api/jobs/:id/retry', (req, res) => {
  const j = retryJob(req.params.id);
  if (!j) return res.status(404).json({ error: 'Không có job' });
  res.json(publicJob(j));
});

// Server-Sent Events: `event: job` carries the full job JSON on every change.
const SSE_HEARTBEAT_MS = 15000;
function sseOpen(req, res) {
  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // nginx: don't buffer
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  const hb = setInterval(() => res.write(': ping\n\n'), SSE_HEARTBEAT_MS);
  const cleanups = [() => clearInterval(hb)];
  const close = () => { while (cleanups.length) cleanups.pop()(); };
  req.on('close', close);
  return {
    send: (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
    onClose: (fn) => cleanups.push(fn),
    end: () => { close(); res.end(); },
  };
}

app.get('/api/jobs/:id/events', (req, res) => {
  const j = getJob(req.params.id);
  if (!j) return res.status(404).json({ error: 'Không có job' });
  const sse = sseOpen(req, res);
  sse.send('job', publicJob(j));
  if (TERMINAL.has(j.status)) return sse.end();
  const on = (job) => {
    if (job.id !== j.id) return;
    sse.send('job', publicJob(job));
    if (TERMINAL.has(job.status)) sse.end();
  };
  jobEvents.on('update', on);
  sse.onClose(() => jobEvents.off('update', on));
});

app.get('/api/projects/:id/jobs/events', (req, res) => {
  store.projectDir(req.params.id); // validates id
  const sse = sseOpen(req, res);
  sse.send('jobs', listJobs(req.params.id));
  const on = (job) => { if (job.projectId === req.params.id) sse.send('job', publicJob(job)); };
  jobEvents.on('update', on);
  sse.onClose(() => jobEvents.off('update', on));
});

// Fake job kinds for scripts/test-jobs.js — only exposed when JOBS_TEST_KINDS=1.
if (process.env.JOBS_TEST_KINDS === '1') {
  app.post('/api/test/jobs', (req, res) => {
    const { kind, projectId = 'test', params = {} } = req.body || {};
    if (!/^test-/.test(kind || '') || !hasKind(kind)) return res.status(400).json({ error: 'kind không hợp lệ' });
    res.json(publicJob(createJob(kind, projectId, params)));
  });
}

// --- errors ---
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || String(err) });
});

function validateProject(p) {
  if (!Array.isArray(p.shots)) throw Object.assign(new Error('shots phải là mảng'), { status: 400 });
  for (const s of p.shots) {
    if (!s.id || typeof s.code !== 'string') throw Object.assign(new Error('shot thiếu id/code'), { status: 400 });
    s.duration = Math.max(0.2, Math.min(60, Number(s.duration) || 3));
  }
}

registerDefaultKinds();
initJobs();

app.listen(PORT, () => {
  console.log(`Ennam Motion Studio → http://localhost:${PORT}`);
  console.log(`  Đạo diễn AI: ${directorAvailable() ? DIRECTOR_MODEL : 'tắt (đặt ANTHROPIC_API_KEY)'} · TTS: ${ttsAvailable() ? 'bật' : 'tắt'} · Đạo diễn song song tối đa: ${DIRECTOR_CONCURRENCY}`);
});
