// File-based project store. One folder per project:
//   data/projects/<id>/project.json   — the editable timeline (shots are code)
//   data/projects/<id>/assets/*       — uploaded materials (images, video, audio)
//   data/projects/<id>/exports/*.mp4  — rendered videos
//   data/projects/<id>/history/*.json — snapshots before each AI edit / save
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const PROJ = path.join(DATA_DIR, 'projects');

export const newId = (p = '') => p + crypto.randomBytes(5).toString('hex');

export function projectDir(id) {
  if (!/^[a-z0-9_-]+$/i.test(id)) throw Object.assign(new Error('bad id'), { status: 400 });
  return path.join(PROJ, id);
}

export async function ensureDirs(id) {
  const d = projectDir(id);
  await fs.mkdir(path.join(d, 'assets'), { recursive: true });
  await fs.mkdir(path.join(d, 'exports'), { recursive: true });
  await fs.mkdir(path.join(d, 'history'), { recursive: true });
  return d;
}

export function defaultProject(o = {}) {
  return {
    id: o.id || newId('p'),
    name: o.name || 'Dự án mới',
    width: o.width || 1920,
    height: o.height || 1080,
    fps: o.fps || 30,
    brief: o.brief || '',
    style: {
      grade: 'warm', vignette: 0.35, grain: 0.05, bloom: 0.25, letterbox: 0,
      palette: { primary: '#f08a12', accent: '#f5b54a', text: '#ffffff' },
      ...(o.style || {}),
    },
    assets: [],
    shots: o.shots || [],
    voice: [],
    music: null,
    exports: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Editable shot values (`s.field(key, default)` in shot code) live in `shot.fields`:
 * a flat { key: string | number } object, default {}. Non-primitive values are dropped.
 */
export function normalizeFields(fields) {
  const out = {};
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return out;
  for (const [k, v] of Object.entries(fields)) {
    if (k && (typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)))) out[k] = v;
  }
  return out;
}

/**
 * `shot.needsReview = { reason, at }`: set by the AI director when its final round still
 * failed at runtime for this shot and the previous working code was kept (see director.js).
 * Anything malformed is dropped (returns undefined).
 */
export function normalizeNeedsReview(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const reason = typeof v.reason === 'string' ? v.reason.slice(0, 2000) : '';
  if (!reason) return undefined;
  return { reason, at: typeof v.at === 'string' ? v.at : '' };
}

/** The needsReview flag clears as soon as the shot's code is edited (compared with `prevShots`). */
export function clearStaleReview(prevShots, shots) {
  const prev = new Map((prevShots || []).map((s) => [s.id, s]));
  for (const s of shots || []) {
    if (s?.needsReview && prev.has(s.id) && prev.get(s.id).code !== s.code) delete s.needsReview;
  }
  return shots;
}

export function normalizeProject(p) {
  if (Array.isArray(p?.shots)) {
    for (const s of p.shots) {
      if (!s || typeof s !== 'object') continue;
      s.fields = normalizeFields(s.fields);
      const nr = normalizeNeedsReview(s.needsReview);
      if (nr) s.needsReview = nr; else delete s.needsReview;
    }
  }
  return p;
}

export async function listProjects() {
  await fs.mkdir(PROJ, { recursive: true });
  const ids = await fs.readdir(PROJ);
  const out = [];
  for (const id of ids) {
    try {
      const p = JSON.parse(await fs.readFile(path.join(PROJ, id, 'project.json'), 'utf8'));
      out.push({
        id: p.id, name: p.name, updatedAt: p.updatedAt, width: p.width, height: p.height,
        duration: p.shots.reduce((s, x) => s + x.duration, 0), shots: p.shots.length,
        thumb: p.assets.find((a) => a.type === 'image')?.file || null,
      });
    } catch { /* skip broken */ }
  }
  return out.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

export async function loadProject(id) {
  const f = path.join(projectDir(id), 'project.json');
  try {
    return normalizeProject(JSON.parse(await fs.readFile(f, 'utf8')));
  } catch {
    throw Object.assign(new Error('Không tìm thấy dự án'), { status: 404 });
  }
}

export async function saveProject(p, { snapshot = false, reason = '' } = {}) {
  await ensureDirs(p.id);
  const f = path.join(projectDir(p.id), 'project.json');
  if (snapshot && fss.existsSync(f)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const slug = (reason || 'save').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30);
    await fs.copyFile(f, path.join(projectDir(p.id), 'history', `${stamp}__${slug}.json`));
    // keep last 40 snapshots
    const hist = (await fs.readdir(path.join(projectDir(p.id), 'history'))).sort();
    for (const old of hist.slice(0, Math.max(0, hist.length - 40))) {
      await fs.rm(path.join(projectDir(p.id), 'history', old)).catch(() => {});
    }
  }
  normalizeProject(p);
  p.updatedAt = new Date().toISOString();
  const tmp = f + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(p, null, 2));
  await fs.rename(tmp, f);
  return p;
}

export async function listHistory(id) {
  const dir = path.join(projectDir(id), 'history');
  try {
    const files = (await fs.readdir(dir)).sort().reverse();
    return files.map((f) => {
      const [stamp, reason] = f.replace('.json', '').split('__');
      return { file: f, reason, at: stamp };
    });
  } catch {
    return [];
  }
}

export async function loadHistory(id, file) {
  if (!/^[\w.-]+\.json$/.test(file)) throw Object.assign(new Error('bad file'), { status: 400 });
  return normalizeProject(JSON.parse(await fs.readFile(path.join(projectDir(id), 'history', file), 'utf8')));
}

export async function deleteProject(id) {
  await fs.rm(projectDir(id), { recursive: true, force: true });
}

/** Turn "IMG 0651 (1).JPG" into a code-friendly asset name: "img-0651-1" */
export function assetNameFrom(filename, taken) {
  let base = filename.replace(/\.[^.]+$/, '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd');
  base = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'asset';
  let name = base, i = 2;
  while (taken.has(name)) name = `${base}-${i++}`;
  return name;
}
