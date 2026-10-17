// AI director: Claude reads the brief, LOOKS at the uploaded materials
// (vision), and writes/edits shot code against the engine API. Then it
// verifies its own work: every shot is rendered headlessly, runtime errors
// are fed back for repair, and a contact sheet of real rendered frames is
// shown back to Claude for a visual critique + revision pass.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { projectDir, newId } from './store.js';
import { thumbBase64, videoStillBase64 } from './media.js';
import { inspectProject } from './render.js';
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
- Chỉ dùng tên chất liệu có trong danh sách. Kiểm tra bằng s.has(name) nếu không chắc.
- Code phải tất định (không Math.random, không Date) — dùng s.rand(seed), s.noise.
- Hiệu năng: tránh vòng lặp > 2000 lần mỗi khung, không tạo canvas mới mỗi khung.

${shotApiDoc()}

${examples}

Luôn trả lời bằng cách gọi tool được yêu cầu. summary viết tiếng Việt.`;
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
export function buildRequest(messages, tool, { cache = CACHE_DEFAULT } = {}) {
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
    tools: [tool],
    tool_choice: { type: 'tool', name: tool.name },
    messages: msgs,
  };
}

async function callTool(messages, tool, { signal, log, cache }) {
  const stream = anthropic().messages.stream(buildRequest(messages, tool, { cache }), { signal });
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
  return { input: use.input, message: msg, toolUseId: use.id, usage: msg.usage };
}

function applyCut(project, input) {
  const p = structuredClone(project);
  const old = new Map(p.shots.map((s) => [s.id, s]));
  p.shots = (input.shots || []).map((s) => ({
    id: s.id && old.has(s.id) ? s.id : newId('s'),
    name: s.name || 'Shot',
    duration: Math.max(0.8, Math.min(12, Number(s.duration) || 3)),
    transition: s.transition || { type: 'cut' },
    code: String(s.code || ''),
    notes: s.notes || '',
    // keep the user's field values for shots the director kept (same id)
    fields: (s.id && old.get(s.id)?.fields) || {},
  }));
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
  return p;
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
export async function runDirector(project, { brief, shotId, review = true, log = () => {}, progress = () => {}, signal, cache = CACHE_DEFAULT } = {}) {
  if (!directorAvailable()) throw new Error('Chưa cấu hình ANTHROPIC_API_KEY trên server. Dùng tab "Nhanh" hoặc "Mẫu cảnh" để dựng không cần AI.');
  progress(0.05, 'Đạo diễn đang xem chất liệu');
  const { blocks, list } = await assetBlocks(project);
  const tool = shotId ? SHOT_TOOL : CUT_TOOL;
  const target = shotId ? project.shots.find((s) => s.id === shotId) : null;
  const task = shotId
    ? `Chỉ sửa shot "${target?.name}" (id ${shotId}). Giữ nguyên các shot khác. Yêu cầu: ${brief || 'làm shot này đẹp và chân thực hơn'}`
    : project.shots.length
      ? `Sửa bản dựng hiện tại theo yêu cầu: ${brief || 'nâng chất lượng chuyển động và nhịp dựng'}. Giữ id các shot bạn giữ lại.`
      : `Dựng video mới từ brief: ${brief || project.brief || 'video quảng cáo sản phẩm 15–20 giây'}`;
  const messages = [{
    role: 'user',
    content: [
      { type: 'text', text: `DANH SÁCH CHẤT LIỆU:\n${list}` },
      ...blocks,
      { type: 'text', text: `DỰ ÁN HIỆN TẠI (JSON):\n${projectForPrompt(project)}` },
      { type: 'text', text: `NHIỆM VỤ: ${task}` },
    ],
  }];

  const usage = emptyUsage();
  const call = async () => {
    const res = await callTool(messages, tool, { signal, log, cache });
    const one = addUsage(usage, res.usage);
    log(`Token lượt ${usage.rounds.length}: ${usageLine(one)}`);
    return res;
  };

  progress(0.15, 'Đạo diễn đang viết kịch bản & code shot');
  let r = await call();
  let next = shotId ? applyShot(project, shotId, r.input) : applyCut(project, r.input);
  let summary = r.input.summary;

  // ---- verify: syntax + headless runtime + visual self-review ----
  const rounds = review ? 3 : 2;
  for (let round = 0; round < rounds; round++) {
    progress(0.5 + round * 0.15, round === 0 ? 'Kiểm tra bằng render thử' : 'Kiểm tra lại sau khi sửa');
    let errs = syntaxErrors(next);
    let sheet = null;
    if (!Object.keys(errs).length) {
      const insp = await inspectProject(next, { framesPerShot: 3 });
      errs = insp.errors || {};
      sheet = insp.sheet;
    }
    const hasErr = Object.keys(errs).length > 0;
    const lastRound = round === rounds - 1;
    if (!hasErr && (!review || round > 0 || !sheet)) break;
    if (lastRound) {
      if (hasErr) log('Vẫn còn lỗi sau khi sửa: ' + describeErrors(next, errs));
      break;
    }
    messages.push({ role: 'assistant', content: r.message.content });
    const feedback = [];
    if (hasErr) {
      log('Phát hiện lỗi, đạo diễn đang tự sửa');
      feedback.push({ type: 'text', text: `Render thử báo lỗi:\n${describeErrors(next, errs)}\nHãy sửa và nộp lại toàn bộ bằng tool.` });
    } else {
      log('Đạo diễn đang tự duyệt contact sheet');
      feedback.push({ type: 'text', text: 'Đây là contact sheet render thật từ code của bạn (mỗi hàng 1 shot, 3 thời điểm). Hãy tự duyệt như một đạo diễn khó tính: bố cục, độ chân thực của vật lý & chất liệu, chữ có bị che/tràn/sai dấu không, ánh sáng có nhất quán không, có khung nào trống/đen không. Nếu cần, sửa và nộp lại toàn bộ bằng tool; nếu đã tốt thì nộp lại y nguyên.' });
      feedback.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: sheet } });
    }
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: r.toolUseId, content: 'Đã nhận. Kết quả kiểm tra bên dưới.' }, ...feedback] });
    r = await call();
    next = shotId ? applyShot(project, shotId, r.input) : applyCut(project, r.input);
    summary = r.input.summary || summary;
  }
  log(`Token cả lần chạy (${usage.rounds.length} lượt): ${usageLine(usage.total)}`);
  next.lastDirector = { at: new Date().toISOString(), brief, summary, model: DIRECTOR_MODEL, usage };
  if (!shotId && brief) next.brief = brief;
  progress(1, summary);
  return next;
}
