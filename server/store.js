// File-based project store. One folder per project:
//   data/projects/<id>/project.json   — the editable timeline (shots are code)
//   data/projects/<id>/assets/*       — uploaded materials (images, video, audio)
//   data/projects/<id>/exports/*.mp4  — rendered videos
//   data/projects/<id>/history/*.json — snapshots before each AI edit / save
//                                       (`meta: { userId, reason, at }` first: who made the change)
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
    brief: normalizeBrief(o.brief),
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

/**
 * `project.brief` — brief có cấu trúc, lưu cùng dự án (issue #9). Chỉ giữ trường có giá trị:
 *   subject  string ≤ 200   sản phẩm / sự kiện
 *   message  string ≤ 500   thông điệp chính
 *   moods    string[] ≤ 8   cảm xúc (mỗi mục ≤ 40 ký tự, bỏ trùng không phân biệt hoa thường)
 *   duration number 3–180   thời lượng mong muốn (giây, làm tròn)
 *   aspect   '16:9' | '9:16' | '1:1' | '4:5'   kênh / tỉ lệ khung
 *   cta      string ≤ 120   kêu gọi hành động
 *   notes    string ≤ 4000  ghi chú tự do
 * Khoá lạ bị bỏ, chuỗi được trim + cắt độ dài. Brief cũ dạng chuỗi → `{ notes }`.
 */
export const BRIEF_ASPECTS = ['16:9', '9:16', '1:1', '4:5'];
const BRIEF_TEXT = { subject: 200, message: 500, cta: 120, notes: 4000 };
export function normalizeBrief(b) {
  if (typeof b === 'string') b = { notes: b };
  const out = {};
  if (!b || typeof b !== 'object' || Array.isArray(b)) return out;
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const subject = str(b.subject, BRIEF_TEXT.subject);
  if (subject) out.subject = subject;
  const message = str(b.message, BRIEF_TEXT.message);
  if (message) out.message = message;
  if (Array.isArray(b.moods)) {
    const seen = new Set();
    const moods = [];
    for (const m of b.moods) {
      const v = str(m, 40);
      if (!v || seen.has(v.toLowerCase())) continue;
      seen.add(v.toLowerCase());
      moods.push(v);
      if (moods.length >= 8) break;
    }
    if (moods.length) out.moods = moods;
  }
  const d = Math.round(Number(b.duration));
  if (b.duration !== '' && b.duration != null && Number.isFinite(d) && d >= 3 && d <= 180) out.duration = d;
  if (BRIEF_ASPECTS.includes(b.aspect)) out.aspect = b.aspect;
  const cta = str(b.cta, BRIEF_TEXT.cta);
  if (cta) out.cta = cta;
  const notes = str(b.notes, BRIEF_TEXT.notes);
  if (notes) out.notes = notes;
  return out;
}

export function briefEqual(a, b) {
  return JSON.stringify(normalizeBrief(a)) === JSON.stringify(normalizeBrief(b));
}

/** Brief gọn cho đạo diễn: JSON một dòng, trường trống đã bỏ; '' nếu brief trống. */
export function compactBrief(b) {
  const n = normalizeBrief(b);
  return Object.keys(n).length ? JSON.stringify(n) : '';
}

export function normalizeProject(p) {
  if (p && typeof p === 'object') p.brief = normalizeBrief(p.brief);
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

/**
 * Save project.json. With `snapshot`, the previous version is first copied to history/
 * (file name unchanged: `<stamp>__<reason>.json`) with `meta: { userId, reason, at }`
 * written as the first key — userId of whoever triggered the change (null = unknown).
 */
export async function saveProject(p, { snapshot = false, reason = '', userId = null } = {}) {
  await ensureDirs(p.id);
  const f = path.join(projectDir(p.id), 'project.json');
  if (snapshot && fss.existsSync(f)) {
    const now = new Date().toISOString();
    const stamp = now.replace(/[:.]/g, '-');
    const slug = (reason || 'save').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30);
    const prev = JSON.parse(await fs.readFile(f, 'utf8'));
    delete prev.meta;
    const snap = { meta: { userId: userId || null, reason: slug, at: now }, ...prev };
    await fs.writeFile(path.join(projectDir(p.id), 'history', `${stamp}__${slug}.json`), JSON.stringify(snap, null, 2));
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
    return Promise.all(files.map(async (f) => {
      const [stamp, reason] = f.replace('.json', '').split('__');
      return { file: f, reason, at: stamp, userId: await historyUserId(path.join(dir, f)) };
    }));
  } catch {
    return [];
  }
}

/** `meta.userId` of a snapshot without parsing the whole file (meta is written first). Legacy → null. */
async function historyUserId(file) {
  let fh;
  try {
    fh = await fs.open(file, 'r');
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(512), 0, 512, 0);
    const head = buffer.subarray(0, bytesRead).toString('utf8');
    const m = /^\{\s*"meta":\s*\{[^{}]*?"userId":\s*"([^"]+)"/.exec(head);
    return m ? m[1] : null;
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

/** "2026-10-17T08-30-00-123Z" (tên file lịch sử) → ms epoch; NaN nếu sai định dạng. */
export function historyStampMs(stamp) {
  const m = /^(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z$/.exec(stamp || '');
  return m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) : NaN;
}

/**
 * Sửa brief tạo snapshot "brief" (bản trước khi sửa), gộp theo phiên: không tạo thêm nếu
 * snapshot mới nhất đã là "brief" và cách đây < gapMs (gõ liên tục không làm đầy lịch sử).
 */
export const BRIEF_SNAPSHOT_GAP_MS = 2 * 60 * 1000;
export async function shouldSnapshotBrief(id, gapMs = BRIEF_SNAPSHOT_GAP_MS, now = Date.now()) {
  const [last] = await listHistory(id);
  if (!last || last.reason !== 'brief') return true;
  const at = historyStampMs(last.at);
  return !(now - at < gapMs);
}

export async function loadHistory(id, file) {
  if (!/^[\w.-]+\.json$/.test(file)) throw Object.assign(new Error('bad file'), { status: 400 });
  const p = JSON.parse(await fs.readFile(path.join(projectDir(id), 'history', file), 'utf8'));
  delete p.meta; // snapshot metadata is not part of the project
  return normalizeProject(p);
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
