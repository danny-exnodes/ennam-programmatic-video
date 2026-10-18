// AI director: Claude reads the brief, LOOKS at the uploaded materials
// (vision), and writes/edits shot code against the engine API. Then it
// verifies its own work: every shot is rendered headlessly, runtime errors
// are fed back for repair, and a contact sheet of real rendered frames is
// shown back to Claude for a visual critique + revision pass.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { projectDir, newId, normalizeBrief, compactBrief } from './store.js';
import { thumbBase64, videoStillBase64 } from './media.js';
import { inspectProject } from './render.js';
import { qaIssues, describeQa, metricsLine, isRuntimeFailure } from './qa.js';
import { SCENES } from './templates.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DIRECTOR_MODEL = process.env.DIRECTOR_MODEL || 'claude-opus-5-5';
const MAX_TOKENS = Number(process.env.DIRECTOR_MAX_TOKENS || 32000);
// Prompt caching (mặc định bật). DIRECTOR_PROMPT_CACHE=0 tắt breakpoint — dùng để đo đối chứng.
const CACHE_DEFAULT = process.env.DIRECTOR_PROMPT_CACHE !== '0';
const EPHEMERAL = Object.freeze({ type: 'ephemeral' });

export function directorAvailable() {
  return !!process.env.ANTHROPIC_API_KEY;
}

let client = null;
function anthropic() {
  if (!client) client = new Anthropic();
  return client;
}
/** Test hook: thay client Anthropic (ví dụ bằng stub) — truyền null để về mặc định. */
export function setAnthropicClient(c) {
  client = c;
}

// Test hook: thay bước render thử headless (mặc định inspectProject qua Chromium) — null để về mặc định.
let inspectFn = inspectProject;
export function setInspector(fn) {
  inspectFn = fn || inspectProject;
}

const SHOT_API_PATH = path.join(ROOT, 'docs/SHOT_API.md');
function shotApiDoc() {
  return fs.readFileSync(SHOT_API_PATH, 'utf8');
}

const SHOT_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Giữ nguyên id nếu sửa shot có sẵn; bỏ trống nếu là shot mới' },
    name: { type: 'string' },
    duration: { type: 'number', description: 'giây, 1.5–8' },
    transition: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['cut', 'fade', 'dissolve', 'flash', 'push', 'zoom', 'whip', 'blur', 'wipe', 'rise'] },
        duration: { type: 'number' },
      },
      required: ['type'],
    },
    code: { type: 'string', description: 'Thân hàm JS nhận `s` (xem SHOT API). Không import, không async.' },
    notes: { type: 'string', description: 'Ý đồ đạo diễn ngắn gọn cho shot (tiếng Việt)' },
  },
  required: ['name', 'duration', 'code'],
};

const CUT_TOOL = {
  name: 'submit_cut',
  description: 'Nộp bản dựng hoàn chỉnh của video (toàn bộ danh sách shot theo thứ tự).',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'Tóm tắt thay đổi cho team marketing (tiếng Việt, 1–3 câu)' },
      shots: { type: 'array', items: SHOT_SCHEMA },
      voice: {
        type: 'array',
        description: 'Câu lồng tiếng (tuỳ chọn). Bỏ qua trường này để giữ nguyên lồng tiếng hiện tại.',
        items: { type: 'object', properties: { text: { type: 'string' }, start: { type: 'number' }, duration: { type: 'number' } }, required: ['text', 'start'] },
      },
      style: {
        type: 'object',
        description: 'Tuỳ chọn: grade (none|warm|golden|cinematic|clean|cool|luxe|film|mono), vignette 0–1, grain 0–0.2, bloom 0–1, palette {primary, accent, text}',
      },
    },
    required: ['summary', 'shots'],
  },
};

const SHOT_TOOL = {
  name: 'submit_shot',
  description: 'Nộp phiên bản mới của MỘT shot.',
  input_schema: { type: 'object', properties: { summary: { type: 'string' }, shot: SHOT_SCHEMA }, required: ['summary', 'shot'] },
};

// ---- Tool cho vòng duyệt (#5b) ----
const APPROVE_TOOL = {
  name: 'approve_cut',
  description: 'Chỉ dùng ở vòng duyệt: duyệt bản hiện tại Y NGUYÊN, không viết lại gì. Dùng khi contact sheet/số liệu đã đạt.',
  input_schema: {
    type: 'object',
    properties: { notes: { type: 'string', description: 'Nhận xét rất ngắn (tiếng Việt, ≤ 1 câu), tuỳ chọn' } },
  },
};

const PATCH_SHOT_SCHEMA = {
  type: 'object',
  description: 'Chỉ gửi id và các trường THAY ĐỔI; trường bỏ qua giữ nguyên.',
  properties: {
    id: { type: 'string', description: 'id shot hiện có (bắt buộc)' },
    name: SHOT_SCHEMA.properties.name,
    duration: SHOT_SCHEMA.properties.duration,
    transition: SHOT_SCHEMA.properties.transition,
    code: { type: 'string', description: 'Thân hàm mới HOÀN CHỈNH của shot (thay toàn bộ code cũ). Bỏ qua nếu code không đổi.' },
    notes: SHOT_SCHEMA.properties.notes,
  },
  required: ['id'],
};

const PATCH_TOOL = {
  name: 'patch_shots',
  description: 'Chỉ dùng ở vòng duyệt: sửa MỘT SỐ shot theo id (chỉ các trường thay đổi), tuỳ chọn xoá/chèn shot. Shot không nhắc tới giữ nguyên byte-by-byte.',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'Tóm tắt thay đổi (tiếng Việt, 1 câu)' },
      shots: { type: 'array', items: PATCH_SHOT_SCHEMA },
      remove: { type: 'array', items: { type: 'string' }, description: 'id các shot cần xoá' },
      insert: {
        type: 'array',
        description: 'Shot mới cần chèn',
        items: {
          type: 'object',
          properties: {
            after: { type: 'string', description: 'Chèn sau shot có id này; chuỗi rỗng = đầu video; bỏ qua = cuối video' },
            shot: SHOT_SCHEMA,
          },
          required: ['shot'],
        },
      },
      voice: CUT_TOOL.input_schema.properties.voice,
      style: CUT_TOOL.input_schema.properties.style,
    },
    required: ['summary'],
  },
};

// Mảng tools GIỐNG HỆT trong mọi request của một lần chạy (tools nằm đầu cache prefix) —
// mỗi vòng chỉ đổi tool_choice.
const CUT_TOOLS = Object.freeze([CUT_TOOL, APPROVE_TOOL, PATCH_TOOL]);
const SHOT_TOOLS = Object.freeze([SHOT_TOOL, APPROVE_TOOL]);
/** Danh sách tool cố định cho một lần chạy: cả bản dựng hoặc một shot ("Nhờ đạo diễn"). */
export function toolsFor(shotId) {
  return shotId ? SHOT_TOOLS : CUT_TOOLS;
}
/** Vòng 0: ép nộp bản đầy đủ. Vòng duyệt: đạo diễn chọn 1 tool (không gọi song song). */
export const REVIEW_TOOL_CHOICE = Object.freeze({ type: 'any', disable_parallel_tool_use: true });

// systemPrompt() chỉ phụ thuộc SHOT_API.md (+ SCENES cố định) → ghi nhớ theo mtime.
let promptMemo = { mtime: -1, text: '' };
export function systemPrompt() {
  const mtime = fs.statSync(SHOT_API_PATH).mtimeMs;
  if (promptMemo.mtime !== mtime) promptMemo = { mtime, text: buildSystemPrompt() };
  return promptMemo.text;
}

function buildSystemPrompt() {
  const examples = ['splash', 'hero', 'features'].map((k) => {
    const sc = SCENES[k];
    return `### Ví dụ: ${sc.name}\n\`\`\`js\n${sc.code({ product: 'hero', bg: 'bg', ingredient: 'splash', features: [{ icon: 'drop', label: 'Thẩm thấu' }, { icon: 'sun', label: 'Sáng da' }] }).trim()}\n\`\`\``;
  }).join('\n\n');
  return `Bạn là đạo diễn hình ảnh kiêm motion designer cho team marketing của một agency Việt Nam.
Bạn dựng video quảng cáo bằng CODE: mỗi shot là thân một hàm JavaScript chạy mỗi khung hình trên canvas 2D, dùng API \`s\` mô tả bên dưới.

MỤC TIÊU CHẤT LƯỢNG — chuyển động phải trông như quay thật:
- Vật lý thật: dùng s.physics.drop / s.spring / s.fx.* (đã mô phỏng trọng lực, đàn hồi, lực cản, sức căng bề mặt) thay vì tween tuyến tính. Vật rơi phải tăng tốc, va chạm phải nảy/lún, chất lỏng dùng s.fx.liquidCrown / pour / drip với material đúng loại.
- Chất liệu: chọn material khớp với ảnh (serum, water, milk, honey, oil, gel, cream, juice, coffee, wine) hoặc tự định nghĩa { base, color, core, edge }. Màu chất lỏng nên lấy theo ảnh sản phẩm.
- Ánh sáng nhất quán: hướng sáng của giọt (light) khớp với ảnh nền; thêm rays/bokeh/dust/sheen tiết chế để tạo chiều sâu.
- Camera: luôn có chuyển động camera nhẹ (đẩy chậm, thị sai theo depth, rung tay rất nhỏ). Không zoom quá 1.2.
- Nhịp dựng: 2.5–5s mỗi shot, có điểm nhấn hành động trong 1s đầu, chữ xuất hiện sau hành động chính. Tổng thời lượng theo brief (mặc định 15–25s).
- Chữ tiếng Việt có dấu, ngắn, đúng chính tả; nằm trong vùng an toàn (cách mép ≥ 6%); dùng *dấu sao* để tô màu nhấn.
- Mọi chữ hiển thị (tiêu đề, nhãn, giá, CTA, tên thương hiệu) phải lấy từ s.field(key, mặc định, { label, maxLength }) với label tiếng Việt, khai báo ở đầu thân shot (ngoài mọi if theo thời gian), không viết chuỗi cứng trong s.text/s.badge; s.text cho chữ đó luôn có maxWidth. Khi sửa shot có sẵn, giữ nguyên key của field.
- Chỉ dùng tên chất liệu có trong danh sách. Kiểm tra bằng s.has(name) nếu không chắc.
- Code phải tất định (không Math.random, không Date) — dùng s.rand(seed), s.noise.
- Hiệu năng: tránh vòng lặp > 2000 lần mỗi khung, không tạo canvas mới mỗi khung.

${shotApiDoc()}

${examples}

Luôn trả lời bằng cách gọi tool. Lượt đầu nộp bản đầy đủ (submit_cut / submit_shot). Các vòng duyệt sau đó: đã tốt → approve_cut (không viết lại); chỉ vài shot cần sửa → patch_shots chỉ với các shot đó và chỉ các trường thay đổi (giữ id); tái cấu trúc lớn mới dùng submit_cut. summary viết tiếng Việt.`;
}

async function assetBlocks(project) {
  const blocks = [];
  const list = [];
  let imgs = 0;
  for (const a of project.assets) {
    const file = path.join(projectDir(project.id), 'assets', a.file);
    list.push(`- "${a.name}" (${a.type}${a.width ? `, ${a.width}×${a.height}` : ''}${a.duration ? `, ${a.duration.toFixed(1)}s` : ''}${a.hasAlpha ? ', nền trong suốt' : ''}, vai trò: ${a.role || 'material'})${a.desc ? ' — ' + a.desc : ''}`);
    if (imgs >= 10 || !fs.existsSync(file)) continue;
    try {
      let b64 = null;
      if (a.type === 'image') b64 = await thumbBase64(file);
      else if (a.type === 'video') b64 = await videoStillBase64(file, Math.min(1, (a.duration || 1) / 2));
      if (b64) {
        blocks.push({ type: 'text', text: `Chất liệu "${a.name}":` });
        blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } });
        imgs++;
      }
    } catch { /* skip */ }
  }
  return { blocks, list: list.join('\n') || '(chưa có chất liệu — dùng nền gradient và hiệu ứng thuần code)' };
}

function projectForPrompt(p) {
  return JSON.stringify({
    name: p.name, width: p.width, height: p.height, fps: p.fps, style: p.style,
    shots: p.shots.map((s) => ({ id: s.id, name: s.name, duration: s.duration, transition: s.transition, notes: s.notes, code: s.code })),
    voice: p.voice.map((v) => ({ text: v.text, start: v.start, duration: v.duration })),
    music: p.music ? { volume: p.music.volume } : null,
  }, null, 1);
}

/** Tiêu đề khối brief trong user turn (khoá JSON tiếng Anh, giải nghĩa tiếng Việt). */
export const BRIEF_HEADER = 'BRIEF (JSON gọn, trường trống đã bỏ — subject: sản phẩm/sự kiện, message: thông điệp chính, moods: cảm xúc, duration: thời lượng mong muốn (giây), aspect: kênh/tỉ lệ khung, cta: kêu gọi hành động, notes: ghi chú tự do):';

export const USAGE_FIELDS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];

/** Lấy 4 trường token từ msg.usage (null → 0). */
export function pickUsage(u = {}) {
  const o = {};
  for (const k of USAGE_FIELDS) o[k] = Number(u?.[k]) || 0;
  return o;
}

/** Cộng dồn usage của một lượt gọi vào { total, rounds }. */
export function addUsage(acc, u) {
  const one = pickUsage(u);
  for (const k of USAGE_FIELDS) acc.total[k] += one[k];
  acc.rounds.push(one);
  return one;
}

export function emptyUsage() {
  return { total: pickUsage({}), rounds: [] };
}

export function usageLine(u) {
  return `vào ${u.input_tokens} · ra ${u.output_tokens} · đọc cache ${u.cache_read_input_tokens} · ghi cache ${u.cache_creation_input_tokens}`;
}

/**
 * Dựng body request. Thứ tự cache prefix của API: tools → system → messages.
 * Breakpoint 1: khối system. Breakpoint 2: khối cuối của user turn mở đầu
 * (chất liệu + JSON dự án + nhiệm vụ) — các vòng sau đọc lại prefix này từ cache.
 * Không sửa `messages` gốc: bản sao nông của turn đầu mang cache_control.
 */
export function buildRequest(messages, tools, { cache = CACHE_DEFAULT, toolChoice } = {}) {
  const list = Array.isArray(tools) ? tools : [tools];
  const system = [{ type: 'text', text: systemPrompt(), ...(cache ? { cache_control: EPHEMERAL } : {}) }];
  let msgs = messages;
  if (cache && messages.length && Array.isArray(messages[0].content) && messages[0].content.length) {
    const first = messages[0];
    const content = first.content.slice();
    content[content.length - 1] = { ...content[content.length - 1], cache_control: EPHEMERAL };
    msgs = [{ ...first, content }, ...messages.slice(1)];
  }
  return {
    model: DIRECTOR_MODEL,
    max_tokens: MAX_TOKENS,
    system,
    tools: list.slice(),
    tool_choice: toolChoice || { type: 'tool', name: list[0].name },
    messages: msgs,
  };
}

async function callTool(messages, tools, { signal, log, cache, toolChoice }) {
  const stream = anthropic().messages.stream(buildRequest(messages, tools, { cache, toolChoice }), { signal });
  let chars = 0, lastTick = 0;
  stream.on('inputJson', (delta) => {
    chars += delta.length;
    if (chars - lastTick > 1500) {
      lastTick = chars;
      log && log(`Đạo diễn đang viết… (${Math.round(chars / 1000)}k ký tự)`);
    }
  });
  const msg = await stream.finalMessage();
  const use = msg.content.find((c) => c.type === 'tool_use');
  if (!use) throw new Error('Đạo diễn không trả về kết quả hợp lệ');
  return { name: use.name, input: use.input || {}, message: msg, toolUseId: use.id, usage: msg.usage };
}

function applyCut(project, input) {
  const p = structuredClone(project);
  const old = new Map(p.shots.map((s) => [s.id, s]));
  p.shots = (input.shots || []).map((s) => {
    const prev = s.id ? old.get(s.id) : null;
    const shot = newShot(s);
    if (prev) shot.id = s.id;
    // keep the user's field values for shots the director kept (same id)
    shot.fields = prev?.fields || {};
    // needsReview survives only while the code is unchanged
    if (prev?.needsReview && prev.code === shot.code) shot.needsReview = prev.needsReview;
    return shot;
  });
  applyVoiceStyle(p, input);
  return p;
}

function applyVoiceStyle(p, input) {
  if (Array.isArray(input.voice)) {
    const oldVoice = new Map(p.voice.map((v) => [v.text.trim(), v]));
    p.voice = input.voice.map((v) => {
      const prev = oldVoice.get(String(v.text).trim());
      return { id: prev?.id || newId('v'), text: v.text, start: Number(v.start) || 0, duration: Number(v.duration) || prev?.duration || 2.5, assetId: prev?.assetId || null, voiceId: prev?.voiceId };
    });
  }
  if (input.style && typeof input.style === 'object') {
    p.style = { ...p.style, ...input.style, palette: { ...(p.style.palette || {}), ...(input.style.palette || {}) } };
  }
}

const clampDur = (d, fallback) => Math.max(0.8, Math.min(12, Number(d) || fallback));

function newShot(s) {
  return {
    id: newId('s'),
    name: s.name || 'Shot',
    duration: clampDur(s.duration, 3),
    transition: s.transition || { type: 'cut' },
    code: String(s.code || ''),
    notes: s.notes || '',
    fields: {},
  };
}

/**
 * patch_shots: áp lên bản hiện tại (`base` = kết quả vòng trước). Chỉ các trường gửi lên của
 * shot có id đã biết được đổi; id lạ bị bỏ qua (ghi log). Shot giữ nguyên object (fields của
 * người dùng, needsReview khi code không đổi). Không bao giờ để bản dựng rỗng.
 */
export function applyPatch(base, input = {}, log = () => {}) {
  const p = structuredClone(base);
  const byId = new Map(p.shots.map((s) => [s.id, s]));
  for (const ch of Array.isArray(input.shots) ? input.shots : []) {
    const sh = ch && byId.get(ch.id);
    if (!sh) { log(`patch_shots: bỏ qua shot id lạ "${ch?.id}"`); continue; }
    if (typeof ch.name === 'string' && ch.name.trim()) sh.name = ch.name;
    if (ch.duration != null) sh.duration = clampDur(ch.duration, sh.duration);
    if (ch.transition && typeof ch.transition === 'object' && ch.transition.type) sh.transition = ch.transition;
    if (typeof ch.notes === 'string') sh.notes = ch.notes;
    if (typeof ch.code === 'string' && ch.code.trim() && ch.code !== sh.code) {
      sh.code = ch.code;
      delete sh.needsReview; // needsReview chỉ sống khi code không đổi
    }
  }
  if (Array.isArray(input.remove) && input.remove.length) {
    const rm = new Set();
    for (const id of input.remove) {
      if (byId.has(id)) rm.add(id); else log(`patch_shots: bỏ qua xoá shot id lạ "${id}"`);
    }
    const kept = p.shots.filter((s) => !rm.has(s.id));
    if (kept.length || (Array.isArray(input.insert) && input.insert.length)) p.shots = kept;
    else log('patch_shots: bỏ qua lệnh xoá vì sẽ làm bản dựng rỗng');
  }
  for (const ins of Array.isArray(input.insert) ? input.insert : []) {
    if (!ins || !ins.shot || typeof ins.shot !== 'object') continue;
    const shot = newShot(ins.shot);
    if (ins.after === '') { p.shots.unshift(shot); continue; }
    const at = ins.after == null ? -1 : p.shots.findIndex((s) => s.id === ins.after);
    if (ins.after != null && at < 0) log(`patch_shots: không thấy shot "${ins.after}" để chèn sau — chèn cuối`);
    if (at < 0) p.shots.push(shot); else p.shots.splice(at + 1, 0, shot);
  }
  applyVoiceStyle(p, input);
  return p;
}

function applyShot(project, shotId, input) {
  const p = structuredClone(project);
  const i = p.shots.findIndex((s) => s.id === shotId);
  const s = input.shot || {};
  if (i < 0) throw new Error('Không tìm thấy shot');
  p.shots[i] = {
    ...p.shots[i],
    name: s.name || p.shots[i].name,
    duration: Math.max(0.8, Math.min(12, Number(s.duration) || p.shots[i].duration)),
    transition: s.transition || p.shots[i].transition,
    code: String(s.code || p.shots[i].code),
    notes: s.notes ?? p.shots[i].notes,
  };
  if (p.shots[i].code !== project.shots[i].code) delete p.shots[i].needsReview;
  return p;
}

/**
 * Final-round guard: a shot that still fails at runtime (throw / syntax error) must never
 * overwrite a version that ran. Restore its last working code (from an earlier round, or the
 * project as it was before the director ran) and flag it `needsReview`; a brand-new shot with
 * no working version keeps its code but is flagged too. Mutates and returns `p`.
 */
export function guardFailedShots(p, errs, lastGood, at = new Date().toISOString()) {
  const restored = [];
  for (let i = 0; i < p.shots.length; i++) {
    const sh = p.shots[i];
    const err = errs[sh.id];
    if (!err || !isRuntimeFailure(err)) continue;
    const first = String(err).split('\n').find(isRuntimeFailure) || String(err);
    const good = lastGood.byId.get(sh.id) || lastGood.byName.get(sh.name);
    if (good) {
      p.shots[i] = { ...sh, code: good.code, duration: good.duration, transition: good.transition, name: good.name, notes: good.notes ?? sh.notes };
      p.shots[i].needsReview = { reason: `Đạo diễn chưa sửa được lỗi runtime ở vòng cuối (${first}); đã giữ code cũ chạy được.`, at };
    } else {
      sh.needsReview = { reason: `Shot mới vẫn lỗi runtime sau vòng cuối (${first}); chưa có bản chạy được để giữ lại.`, at };
    }
    restored.push({ id: sh.id, name: sh.name, kept: !!good });
  }
  return restored;
}

/** Remember shots that ran without a runtime failure, by id and by name. */
function rememberGood(lastGood, p, errs) {
  for (const sh of p.shots) {
    if (errs[sh.id] && isRuntimeFailure(errs[sh.id])) continue;
    lastGood.byId.set(sh.id, sh);
    lastGood.byName.set(sh.name, sh);
  }
}

function syntaxErrors(p) {
  const errs = {};
  for (const s of p.shots) {
    try {
      // eslint-disable-next-line no-new-func
      new Function('s', '"use strict";\n' + s.code);
    } catch (e) {
      errs[s.id] = 'Lỗi cú pháp: ' + e.message;
    }
  }
  return errs;
}

function describeErrors(p, errs) {
  return Object.entries(errs).map(([id, e]) => {
    const s = p.shots.find((x) => x.id === id);
    return `- Shot "${s ? s.name : id}" (id ${id}): ${e}`;
  }).join('\n');
}

/**
 * Run the director. Returns the updated project (not yet saved).
 * shotId: limit the edit to one shot ("Nhờ đạo diễn" in the inspector).
 */
export async function runDirector(project, { brief, request, shotId, review = true, reviewTools = true, log = () => {}, progress = () => {}, signal, cache = CACHE_DEFAULT } = {}) {
  if (!directorAvailable()) throw new Error('Chưa cấu hình ANTHROPIC_API_KEY trên server. Dùng tab "Nhanh" hoặc "Mẫu cảnh" để dựng không cần AI.');
  progress(0.05, 'Đạo diễn đang xem chất liệu');
  const { blocks, list } = await assetBlocks(project);
  // Cùng một mảng tools cho mọi lượt (cache-safe); vòng 0 ép tool nộp bản đầy đủ, vòng duyệt
  // cho chọn (approve_cut / patch_shots / nộp lại). reviewTools=false: hành vi cũ (ép nộp lại
  // đầy đủ mỗi vòng) — chỉ để đo đối chứng trong scripts/director-bench.js --review.
  const tools = toolsFor(shotId);
  const fullTool = tools[0].name;
  const forced = { type: 'tool', name: fullTool };
  const target = shotId ? project.shots.find((s) => s.id === shotId) : null;
  // `brief` string = legacy edit request; `brief` object = structured brief overriding project.brief.
  const legacy = typeof brief === 'string' ? brief.trim() : '';
  const ask = (typeof request === 'string' && request.trim()) || legacy;
  const structured = normalizeBrief(brief && typeof brief === 'object' ? brief : project.brief);
  const briefJson = compactBrief(structured);
  const task = shotId
    ? `Chỉ sửa shot "${target?.name}" (id ${shotId}). Giữ nguyên các shot khác. Yêu cầu: ${ask || 'làm shot này đẹp và chân thực hơn'}`
    : project.shots.length
      ? `Sửa bản dựng hiện tại theo yêu cầu: ${ask || (briefJson ? 'bám sát BRIEF và nâng chất lượng chuyển động, nhịp dựng' : 'nâng chất lượng chuyển động và nhịp dựng')}. Giữ id các shot bạn giữ lại.`
      : `Dựng video mới từ brief: ${ask || (briefJson ? 'theo BRIEF ở trên' : 'video quảng cáo sản phẩm 15–20 giây')}`;
  // Brief đi trong user turn (không đụng system prompt/tool schema → cache prefix giữ ổn định).
  const messages = [{
    role: 'user',
    content: [
      { type: 'text', text: `DANH SÁCH CHẤT LIỆU:\n${list}` },
      ...blocks,
      { type: 'text', text: `DỰ ÁN HIỆN TẠI (JSON):\n${projectForPrompt(project)}` },
      ...(briefJson ? [{ type: 'text', text: `${BRIEF_HEADER}\n${briefJson}` }] : []),
      { type: 'text', text: `NHIỆM VỤ: ${task}` },
    ],
  }];

  const usage = emptyUsage();
  const toolsUsed = [];
  const call = async (toolChoice) => {
    const res = await callTool(messages, tools, { signal, log, cache, toolChoice });
    const one = addUsage(usage, res.usage);
    toolsUsed.push(res.name || fullTool);
    log(`Token lượt ${usage.rounds.length}: ${usageLine(one)} (${res.name || fullTool})`);
    return res;
  };
  // Áp kết quả một lượt: approve giữ nguyên `cur`; patch áp lên `cur`; nộp đầy đủ như cũ.
  let summary = '';
  const apply = (res, cur) => {
    if (res.name === APPROVE_TOOL.name) {
      log(`Đạo diễn duyệt bản hiện tại, không viết lại${res.input.notes ? ': ' + res.input.notes : ''}`);
      return cur === project ? structuredClone(cur) : cur;
    }
    if (res.name === PATCH_TOOL.name && !shotId) {
      const n = (res.input.shots?.length || 0) + (res.input.remove?.length || 0) + (res.input.insert?.length || 0);
      log(`Đạo diễn sửa cục bộ ${n} mục (patch_shots)`);
      if (res.input.summary) summary = summary ? `${summary} ${res.input.summary}` : res.input.summary;
      return applyPatch(cur, res.input, log);
    }
    summary = res.input.summary || summary;
    return shotId ? applyShot(project, shotId, res.input) : applyCut(project, res.input);
  };

  progress(0.15, 'Đạo diễn đang viết kịch bản & code shot');
  let r = await call(forced);
  let next = apply(r, project);

  // ---- verify: syntax + headless runtime + QA metrics + visual self-review ----
  // Shots that ran without a runtime failure, newest first wins (seeded with the project as it was).
  const lastGood = { byId: new Map(), byName: new Map() };
  rememberGood(lastGood, project, {});
  const rounds = review ? 3 : 2;
  for (let round = 0; round < rounds; round++) {
    progress(0.5 + round * 0.15, round === 0 ? 'Kiểm tra bằng render thử' : 'Kiểm tra lại sau khi sửa');
    let errs = syntaxErrors(next);
    let sheet = null;
    let qa = {};
    if (!Object.keys(errs).length) {
      const insp = await inspectFn(next, { framesPerShot: 3 });
      errs = insp.errors || {};
      sheet = insp.sheet;
      // runtime throws are already in errs → QA list keeps the measurable problems only
      qa = qaIssues(next, insp);
      for (const id of Object.keys(qa)) {
        qa[id] = qa[id].filter((x) => x.code !== 'throw');
        if (!qa[id].length) delete qa[id];
      }
      const ml = metricsLine(next, insp);
      if (ml) log('Số liệu render thử: ' + ml);
    }
    rememberGood(lastGood, next, errs);
    const hasErr = Object.keys(errs).length > 0;
    const hasQa = Object.keys(qa).length > 0;
    const lastRound = round === rounds - 1;
    if (!hasErr && !hasQa && (!review || round > 0 || !sheet)) break;
    if (lastRound) {
      if (hasErr) log('Vẫn còn lỗi sau khi sửa: ' + describeErrors(next, errs));
      if (hasQa) log('QA vẫn còn vấn đề:\n' + describeQa(next, qa));
      const kept = guardFailedShots(next, errs, lastGood);
      for (const k of kept) log(k.kept ? `Shot "${k.name}" vẫn lỗi runtime — giữ code cũ chạy được, gắn cờ cần xem lại` : `Shot "${k.name}" vẫn lỗi runtime và chưa có bản chạy được — gắn cờ cần xem lại`);
      break;
    }
    messages.push({ role: 'assistant', content: r.message.content });
    const feedback = [];
    if (hasErr || hasQa) {
      log(hasErr ? 'Phát hiện lỗi, đạo diễn đang tự sửa' : 'Số liệu QA phát hiện vấn đề, đạo diễn đang tự sửa');
      const parts = [];
      if (hasErr) parts.push(`Render thử báo lỗi:\n${describeErrors(next, errs)}`);
      if (hasQa) parts.push(`Số liệu QA (đo trên render thử, 3 thời điểm mỗi shot):\n${describeQa(next, qa)}`);
      feedback.push({ type: 'text', text: `${parts.join('\n\n')}\n${!reviewTools ? 'Hãy sửa và nộp lại toàn bộ bằng tool.' : shotId ? `Hãy sửa và nộp lại shot bằng ${fullTool}.` : 'Sửa bằng patch_shots chỉ với các shot có vấn đề (giữ id, chỉ gửi trường thay đổi); chỉ dùng submit_cut nếu cần dựng lại lớn.'}` });
      if (review && sheet && !hasErr) feedback.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: sheet } });
    } else {
      log('Đạo diễn đang tự duyệt contact sheet');
      feedback.push({ type: 'text', text: 'Đây là contact sheet render thật từ code của bạn (mỗi hàng 1 shot, 3 thời điểm). Hãy tự duyệt như một đạo diễn khó tính: bố cục, độ chân thực của vật lý & chất liệu, chữ có bị che/tràn/sai dấu không, ánh sáng có nhất quán không, có khung nào trống/đen không. ' + (!reviewTools ? 'Nếu cần, sửa và nộp lại toàn bộ bằng tool; nếu đã tốt thì nộp lại y nguyên.' : shotId ? `Nếu đã tốt, gọi approve_cut (không viết lại); nếu cần sửa, nộp lại shot bằng ${fullTool}.` : 'Nếu tất cả đã tốt, gọi approve_cut (không viết lại gì). Nếu chỉ vài shot cần sửa, gọi patch_shots chỉ với các shot đó và chỉ các trường thay đổi. Chỉ dùng submit_cut khi cần tái cấu trúc lớn.') });
      feedback.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: sheet } });
    }
    // id hiện tại (shot mới tạo ở vòng trước chưa có trong JSON dự án ở turn mở đầu) — cho patch_shots
    if (reviewTools && !shotId) feedback.push({ type: 'text', text: `Shot hiện tại (id: tên): ${next.shots.map((x) => `${x.id}: ${x.name}`).join(' · ')}` });
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: r.toolUseId, content: 'Đã nhận. Kết quả kiểm tra bên dưới.' }, ...feedback] });
    r = await call(reviewTools ? REVIEW_TOOL_CHOICE : forced);
    next = apply(r, next);
  }
  log(`Token cả lần chạy (${usage.rounds.length} lượt): ${usageLine(usage.total)}`);
  next.lastDirector = { at: new Date().toISOString(), brief: ask, summary, model: DIRECTOR_MODEL, usage, tools: toolsUsed };
  // structured override → keep it with the project; legacy string on an empty brief → notes
  if (!shotId && brief && typeof brief === 'object') next.brief = structured;
  else if (!shotId && legacy && !briefJson) next.brief = normalizeBrief({ notes: legacy });
  progress(1, summary);
  return next;
}
