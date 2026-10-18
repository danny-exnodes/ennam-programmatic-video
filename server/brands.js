// Brand Kit dùng chung giữa các dự án (issue #8). Mỗi kit là một thư mục:
//   DATA_DIR/brands/<id>/brand.json   — dữ liệu kit (xem normalizeKit)
//   DATA_DIR/brands/<id>/files/*      — logo PNG, font, nhạc nhận diện (tên file bất biến `<newId>.<ext>`:
//                                       upload mới = file mới, nên snapshot cũ vẫn trỏ đúng nội dung)
// Mọi thay đổi kit tăng `version`. Dự án lưu `project.brand = { id, version, locked, kit }` — `kit` là
// snapshot dữ liệu kit tại version đó, file của kit được chép vào assets/ của dự án với tiền tố
// `brand-` (không nằm trong project.assets). locked → giữ snapshot; không khoá → mở dự án
// (GET /api/projects/:id, job render/đạo diễn) tự cập nhật lên version mới nhất (syncProjectBrand).
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import { DATA_DIR, newId, projectDir } from './store.js';

export const BRANDS_DIR = path.join(DATA_DIR, 'brands');
export const COLOR_ROLES = ['primary', 'accent', 'text', 'secondary', 'background'];
export const REQUIRED_ROLES = ['primary', 'accent', 'text'];
export const BUILTIN_FONTS = ['sans', 'serif'];
export const KIT_GRADES = ['', 'none', 'warm', 'golden', 'cinematic', 'clean', 'cool', 'luxe', 'film', 'mono'];
export const FONT_EXT = ['.ttf', '.otf', '.woff', '.woff2'];
const HEX = /^#[0-9a-f]{6}$/i;
const PHRASES_MAX = 30;
const PHRASE_LEN = 160;

const httpErr = (status, msg) => Object.assign(new Error(msg), { status });

export function brandDir(id) {
  if (!/^[a-z0-9_-]+$/i.test(String(id || ''))) throw httpErr(400, 'bad id');
  return path.join(BRANDS_DIR, id);
}
export const brandFilesDir = (id) => path.join(brandDir(id), 'files');

/** CSS font-family của font upload: duy nhất theo id file (bất biến) → không đụng font hệ thống/kit khác. */
export const fontFamily = (fontId) => `ek-${fontId}`;

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function phrases(list) {
  if (typeof list === 'string') list = list.split('\n');
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const x of list) {
    const v = str(x, PHRASE_LEN);
    if (!v || seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    out.push(v);
    if (out.length >= PHRASES_MAX) break;
  }
  return out;
}

/**
 * Chuẩn hoá phần người dùng sửa được của kit (PUT / tạo). Ném 400 khi bảng màu sai.
 *   name            string ≤ 80
 *   palette         [{ role, color }] 3–5 màu, role thuộc COLOR_ROLES, không trùng, BẮT BUỘC có primary/accent/text
 *   fonts           { heading, body } — 'sans' | 'serif' (font có sẵn) hoặc id của một font trong fontFiles
 *   grade           grade mặc định ('' = không áp)
 *   voiceId         id giọng TTS ('' = mặc định server)
 *   requiredPhrases / bannedPhrases  string[] ≤ 30 (mỗi câu ≤ 160 ký tự, bỏ trùng không phân biệt hoa thường)
 *   outro           { text ≤ 200 } | null
 * logo / fontFiles / music do các route upload quản lý (giữ nguyên từ `prev`).
 */
export function normalizeKitInput(b = {}, prev = {}) {
  const out = {};
  out.name = str(b.name ?? prev.name, 80) || 'Brand kit';
  const pal = Array.isArray(b.palette) ? b.palette : prev.palette || [];
  const roles = new Set();
  out.palette = [];
  for (const c of pal) {
    const role = String(c?.role || '');
    const color = String(c?.color || '').toLowerCase();
    if (!COLOR_ROLES.includes(role)) throw httpErr(400, `Vai trò màu không hợp lệ: "${role}"`);
    if (!HEX.test(color)) throw httpErr(400, `Màu không hợp lệ: "${c?.color}" (dạng #rrggbb)`);
    if (roles.has(role)) throw httpErr(400, `Trùng vai trò màu "${role}"`);
    roles.add(role);
    out.palette.push({ role, color });
  }
  if (out.palette.length < 3 || out.palette.length > 5) throw httpErr(400, 'Bảng màu cần 3–5 màu');
  for (const r of REQUIRED_ROLES) if (!roles.has(r)) throw httpErr(400, `Bảng màu thiếu vai trò "${r}"`);
  out.fontFiles = prev.fontFiles || [];
  const fontOk = (v) => BUILTIN_FONTS.includes(v) || out.fontFiles.some((f) => f.id === v);
  const fonts = { ...(prev.fonts || {}), ...(b.fonts || {}) };
  out.fonts = { heading: fontOk(fonts.heading) ? fonts.heading : 'sans', body: fontOk(fonts.body) ? fonts.body : 'sans' };
  const grade = b.grade !== undefined ? b.grade : prev.grade;
  out.grade = KIT_GRADES.includes(grade) ? grade : '';
  out.voiceId = str(b.voiceId !== undefined ? b.voiceId : prev.voiceId, 120);
  out.requiredPhrases = phrases(b.requiredPhrases !== undefined ? b.requiredPhrases : prev.requiredPhrases);
  out.bannedPhrases = phrases(b.bannedPhrases !== undefined ? b.bannedPhrases : prev.bannedPhrases);
  const outro = b.outro !== undefined ? b.outro : prev.outro;
  const outroText = str(typeof outro === 'string' ? outro : outro?.text, 200);
  out.outro = outroText ? { text: outroText } : null;
  out.logo = prev.logo || null;
  out.music = prev.music || null;
  return out;
}

/** Cảnh báo của kit: font upload thiếu nguồn/giấy phép (bắt buộc theo #8). */
export function kitWarnings(kit) {
  return (kit?.fontFiles || []).filter((f) => !String(f.license || '').trim()).map((f) => ({
    code: 'font_license', fontId: f.id,
    msg: `Font "${f.name || f.original}" chưa ghi nguồn/giấy phép — cần ghi rõ trước khi dùng cho khách`,
  }));
}

const withWarnings = (kit) => ({ ...kit, warnings: kitWarnings(kit) });

export async function loadKit(id) {
  try {
    return JSON.parse(await fs.readFile(path.join(brandDir(id), 'brand.json'), 'utf8'));
  } catch (e) {
    if (e.status) throw e;
    throw httpErr(404, 'Không tìm thấy brand kit');
  }
}

async function writeKit(kit) {
  await fs.mkdir(brandFilesDir(kit.id), { recursive: true });
  const f = path.join(brandDir(kit.id), 'brand.json');
  await fs.writeFile(f + '.tmp', JSON.stringify(kit, null, 2));
  await fs.rename(f + '.tmp', f);
  return kit;
}

// Thay đổi cùng một kit chạy tuần tự (hai upload đồng thời không ghi đè nhau / không trùng version).
const locks = new Map();
function serial(id, fn) {
  const run = (locks.get(id) || Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => {});
  locks.set(id, tail);
  tail.then(() => { if (locks.get(id) === tail) locks.delete(id); });
  return run;
}

/** Lưu thay đổi: version + 1, updatedAt mới. `mutate(kit)` sửa tại chỗ. */
function bump(id, mutate) {
  return serial(id, async () => {
    const kit = await loadKit(id);
    await mutate(kit);
    kit.version = (kit.version || 0) + 1;
    kit.updatedAt = new Date().toISOString();
    await writeKit(kit);
    return withWarnings(kit);
  });
}

export async function listKits() {
  await fs.mkdir(BRANDS_DIR, { recursive: true });
  const out = [];
  for (const id of await fs.readdir(BRANDS_DIR)) {
    try { out.push(withWarnings(await loadKit(id))); } catch { /* bỏ qua kit hỏng */ }
  }
  return out.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

export async function getKit(id) {
  return withWarnings(await loadKit(id));
}

export async function createKit(body = {}) {
  const now = new Date().toISOString();
  const data = normalizeKitInput({
    palette: [{ role: 'primary', color: '#f08a12' }, { role: 'accent', color: '#f5b54a' }, { role: 'text', color: '#ffffff' }],
    ...body,
  }, {});
  const kit = { id: newId('b'), ...data, version: 1, createdAt: now, updatedAt: now };
  await writeKit(kit);
  return withWarnings(kit);
}

export async function updateKit(id, body = {}) {
  return bump(id, (kit) => Object.assign(kit, normalizeKitInput(body, kit)));
}

export async function deleteKit(id) {
  await loadKit(id);
  await fs.rm(brandDir(id), { recursive: true, force: true });
}

export async function duplicateKit(id) {
  const src = await loadKit(id);
  const now = new Date().toISOString();
  const kit = { ...structuredClone(src), id: newId('b'), name: `${src.name} (bản sao)`, version: 1, createdAt: now, updatedAt: now };
  await fs.mkdir(brandFilesDir(kit.id), { recursive: true });
  await fs.cp(brandFilesDir(src.id), brandFilesDir(kit.id), { recursive: true }).catch(() => {});
  await writeKit(kit);
  return withWarnings(kit);
}

async function moveIn(tmpPath, dst) {
  await fs.rename(tmpPath, dst).catch(async () => { await fs.copyFile(tmpPath, dst); await fs.rm(tmpPath, { force: true }); });
}

/** Logo: ảnh bất kỳ → PNG (giữ nền trong suốt), cạnh dài ≤ 2048. */
export async function setLogo(id, upload) {
  const sharp = (await import('sharp')).default;
  return bump(id, async (kit) => {
    const file = `${newId('l')}.png`;
    const dst = path.join(brandFilesDir(id), file);
    await fs.mkdir(brandFilesDir(id), { recursive: true });
    const info = await sharp(upload.path).rotate().resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true }).png().toFile(dst);
    await fs.rm(upload.path, { force: true });
    kit.logo = { file, width: info.width, height: info.height, original: upload.original };
  });
}

export async function removeLogo(id) {
  return bump(id, (kit) => { kit.logo = null; });
}

/**
 * Font upload (.ttf/.otf/.woff/.woff2). `license` = "nguồn/giấy phép" — bắt buộc ghi; để trống vẫn
 * lưu nhưng kit trả `warnings` (font_license) và server ghi cảnh báo vào log. `role` 'heading'|'body'
 * gán luôn font cho vai trò đó.
 */
export async function addFont(id, upload, { name = '', license = '', role = '' } = {}) {
  const ext = path.extname(upload.original || '').toLowerCase();
  if (!FONT_EXT.includes(ext)) {
    await fs.rm(upload.path, { force: true });
    throw httpErr(400, `Font phải là ${FONT_EXT.join(', ')}`);
  }
  return bump(id, async (kit) => {
    const fid = newId('f');
    const file = `${fid}${ext}`;
    await fs.mkdir(brandFilesDir(id), { recursive: true });
    await moveIn(upload.path, path.join(brandFilesDir(id), file));
    const entry = {
      id: fid, file, family: fontFamily(fid), original: upload.original,
      name: str(name, 80) || path.basename(upload.original || file, ext), license: str(license, 500),
    };
    kit.fontFiles = [...(kit.fontFiles || []), entry];
    kit.fonts = { heading: 'sans', body: 'sans', ...(kit.fonts || {}) };
    if (role === 'heading' || role === 'body') kit.fonts[role] = fid;
    if (!entry.license) console.warn(`[brand] kit ${id}: font "${entry.name}" chưa ghi nguồn/giấy phép`);
  });
}

export async function updateFont(id, fid, { name, license } = {}) {
  return bump(id, (kit) => {
    const f = (kit.fontFiles || []).find((x) => x.id === fid);
    if (!f) throw httpErr(404, 'Không có font');
    if (name != null) f.name = str(name, 80) || f.name;
    if (license != null) f.license = str(license, 500);
  });
}

export async function removeFont(id, fid) {
  return bump(id, (kit) => {
    kit.fontFiles = (kit.fontFiles || []).filter((x) => x.id !== fid);
    for (const r of ['heading', 'body']) if (kit.fonts?.[r] === fid) kit.fonts[r] = 'sans';
  });
}

export async function setMusic(id, upload, meta = {}) {
  return bump(id, async (kit) => {
    const ext = path.extname(upload.original || '').toLowerCase() || '.mp3';
    const file = `${newId('m')}${ext}`;
    await fs.mkdir(brandFilesDir(id), { recursive: true });
    await moveIn(upload.path, path.join(brandFilesDir(id), file));
    kit.music = { file, original: upload.original, duration: meta.duration || 0 };
  });
}

export async function removeMusic(id) {
  return bump(id, (kit) => { kit.music = null; });
}

// ---------------------------------------------------------------- dự án ↔ kit

/** Tên file của kit khi chép vào assets/ của dự án. */
export const projectFileOf = (file) => `brand-${file}`;
/** Tên chất liệu của logo kit trong engine (`s.image(s.brand.logo)`). */
export const LOGO_ASSET = 'brand-logo';

/** Snapshot dữ liệu kit lưu trong dự án (bỏ trường quản trị, tên file trỏ vào assets/ của dự án). */
function snapshotOf(kit) {
  const k = structuredClone(kit);
  delete k.warnings;
  delete k.createdAt;
  if (k.logo) k.logo = { ...k.logo, file: projectFileOf(k.logo.file) };
  if (k.music) k.music = { ...k.music, file: projectFileOf(k.music.file) };
  k.fontFiles = (k.fontFiles || []).map((f) => ({ ...f, file: projectFileOf(f.file) }));
  return k;
}

/** Chép file của kit vào assets/ của dự án (bỏ qua file đã có — tên file bất biến). */
async function copyKitFiles(projectId, kit) {
  const dst = path.join(projectDir(projectId), 'assets');
  await fs.mkdir(dst, { recursive: true });
  const files = [kit.logo?.file, kit.music?.file, ...(kit.fontFiles || []).map((f) => f.file)].filter(Boolean);
  for (const f of files) {
    const to = path.join(dst, projectFileOf(f));
    if (fss.existsSync(to)) continue;
    await fs.copyFile(path.join(brandFilesDir(kit.id), f), to).catch((e) => console.warn(`[brand] không chép được ${f}: ${e.message}`));
  }
}

/** Xoá file `brand-*` không còn được snapshot hiện tại dùng (sau khi đổi version/kit). */
async function pruneKitFiles(p) {
  const keep = new Set();
  const k = p.brand?.kit;
  if (k) for (const f of [k.logo?.file, k.music?.file, ...(k.fontFiles || []).map((x) => x.file)]) if (f) keep.add(f);
  for (const a of p.assets || []) keep.add(a.file); // nhạc kit đã thành chất liệu thường của dự án
  const dir = path.join(projectDir(p.id), 'assets');
  let names = [];
  try { names = await fs.readdir(dir); } catch { return; }
  for (const n of names) if (n.startsWith('brand-') && !keep.has(n)) await fs.rm(path.join(dir, n), { force: true });
}

/**
 * Gán kit cho dự án (tạo / nhân bản / đổi kit ở tab Phong cách). `sel` = { id, locked } hoặc null (bỏ kit).
 * Lần gán đầu (khác kit cũ): áp grade mặc định của kit và — nếu dự án chưa có nhạc — thêm nhạc nhận diện
 * thành chất liệu nhạc của dự án. Trả về dự án đã sửa (chưa lưu).
 */
export async function applyKitToProject(p, sel) {
  if (!sel || !sel.id) {
    p.brand = null;
    await pruneKitFiles(p);
    return p;
  }
  const kit = await loadKit(sel.id);
  const changed = p.brand?.id !== kit.id;
  await copyKitFiles(p.id, kit);
  p.brand = { id: kit.id, version: kit.version, locked: !!sel.locked, kit: snapshotOf(kit) };
  if (changed) {
    if (kit.grade) p.style = { ...(p.style || {}), grade: kit.grade };
    if (kit.music && !p.music) {
      const file = projectFileOf(kit.music.file);
      const aid = newId('a');
      p.assets = [...(p.assets || []), {
        id: aid, name: 'brand-music', type: 'audio', file, original: kit.music.original || 'Nhạc nhận diện',
        desc: `Nhạc nhận diện của kit ${kit.name}`, role: 'music', duration: kit.music.duration || 0, addedAt: new Date().toISOString(),
      }];
      p.music = { assetId: aid, volume: 0.3, fadeIn: 0.5, fadeOut: 1.5, offset: 0 };
    }
  }
  await pruneKitFiles(p);
  return p;
}

/**
 * Dự án không khoá kit → cập nhật snapshot lên version mới nhất. Trả `true` nếu đã đổi (cần lưu).
 * Kit đã bị xoá → giữ snapshot cuối (dự án vẫn render được).
 */
export async function syncProjectBrand(p) {
  const b = p?.brand;
  if (!b || !b.id || b.locked) return false;
  let kit;
  try { kit = await loadKit(b.id); } catch { return false; }
  if (kit.version === b.version && b.kit) return false;
  await copyKitFiles(p.id, kit);
  p.brand = { ...b, version: kit.version, kit: snapshotOf(kit) };
  await pruneKitFiles(p);
  return true;
}

/**
 * Tóm tắt kit cho đạo diễn (JSON một dòng, chỉ trường có giá trị) — '' nếu dự án không có kit.
 * Đi trong USER turn (như brief), không đụng system prompt.
 */
export function compactKit(p) {
  const k = p?.brand?.kit;
  if (!k) return '';
  const colors = Object.fromEntries((k.palette || []).map((c) => [c.role, c.color]));
  const fontName = (v) => (v === 'serif' ? 'Playfair Display (serif)' : v === 'sans' || !v ? 'Be Vietnam Pro (sans)' : (k.fontFiles || []).find((f) => f.id === v)?.name || v);
  const o = { name: k.name, colors, fonts: { heading: fontName(k.fonts?.heading), body: fontName(k.fonts?.body) } };
  if (k.logo) o.logo = LOGO_ASSET;
  if (k.requiredPhrases?.length) o.requiredPhrases = k.requiredPhrases;
  if (k.bannedPhrases?.length) o.bannedPhrases = k.bannedPhrases;
  if (k.outro?.text) o.outro = k.outro.text;
  return JSON.stringify(o);
}
