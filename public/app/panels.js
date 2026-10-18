// Left sidebar: tabs (Đạo diễn AI, Nhanh, Mẫu cảnh, Media, Lồng tiếng, Nhạc, Phong cách) + project list.
import { h, fmt, toast, modal, slider } from './ui.js';
import { state, on, emit, update, duration, shotStarts, trackJob, retryJob, setProject, selectShot, saveNow } from './state.js';
import { api, fileUrl, exportUrl, previewUrl } from './api.js';
import { engine } from './player.js';
import { MATERIALS, GRADES, ICON_NAMES } from '/engine/engine.js';
import { whoLabel, refreshBudgetBanner } from './account.js';
import { kitPicker, kitSwatches, showBrandKits, ROLE_LABEL } from './brands.js';

const panel = document.getElementById('panel');

export function renderPanel() {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab && state.view === 'editor'));
  if (state.view === 'projects') return renderProjects();
  if (!state.project) return panel.replaceChildren();
  const fn = { director, quick, scenes, media, voice, music, style }[state.tab] || director;
  panel.replaceChildren(fn());
}

// ---------------------------------------------------------------- projects
async function renderProjects() {
  const [list, kits] = await Promise.all([api.projects(), api.brands().catch(() => [])]);
  const picker = kitPicker(kits);
  const name = h('input', { placeholder: 'Tên dự án mới, VD: Lumi C+ TVC 20s' });
  const aspect = h('select', {},
    h('option', { value: '1920x1080' }, '16:9 · 1920×1080 (YouTube, màn LED)'),
    h('option', { value: '1080x1920' }, '9:16 · 1080×1920 (TikTok, Reels)'),
    h('option', { value: '1080x1080' }, '1:1 · 1080×1080 (Feed)'),
    h('option', { value: '1080x1350' }, '4:5 · 1080×1350'));
  panel.replaceChildren(
    h('h3', {}, 'Dự án'),
    name, h('div', { style: { height: '8px' } }), aspect,
    picker.el,
    h('button', { class: 'ghost block', style: { marginTop: '6px' }, onclick: () => showBrandKits({ onChange: () => renderPanel() }) }, '🏷 Quản lý Brand Kit'),
    h('button', {
      class: 'primary block', style: { marginTop: '10px' }, id: 'btnCreateProject',
      onclick: async () => {
        const [w, hh] = aspect.value.split('x').map(Number);
        const p = await api.create({ name: name.value.trim() || 'Dự án mới', width: w, height: hh, brand: picker.value() });
        emit('open', p.id);
      },
    }, '+ Tạo dự án'),
    h('div', { class: 'section-title' }, `Tất cả (${list.length})`),
    h('div', { class: 'list projects' }, list.map((p) => h('div', { class: 'item', onclick: () => emit('open', p.id) },
      h('div', { class: 'grow' }, h('div', {}, p.name), h('div', { class: 'small muted' }, `${p.width}×${p.height} · ${fmt(p.duration)} · ${p.shots} shot${p.brand ? ` · 🏷 ${p.brand.name}${p.brand.locked ? ` (khoá v${p.brand.version})` : ''}` : ''} · ${new Date(p.updatedAt).toLocaleString('vi-VN')}`)),
      h('button', { class: 'icon', title: 'Nhân bản', onclick: (e) => { e.stopPropagation(); duplicateDialog(p, kits); } }, '⧉'),
      h('button', { class: 'icon', title: 'Xoá', onclick: async (e) => { e.stopPropagation(); if (confirm(`Xoá dự án "${p.name}"?`)) { await api.remove(p.id); renderPanel(); } } }, '🗑')))),
  );
}

/** Nhân bản dự án: chọn Brand Kit cho bản sao (mặc định giữ kit + trạng thái khoá của bản gốc). */
function duplicateDialog(p, kits) {
  const picker = kitPicker(kits, p.brand);
  const close = modal(`Nhân bản "${p.name}"`, h('div', { style: { maxWidth: '460px' } },
    picker.el,
    h('button', {
      class: 'primary', style: { marginTop: '14px' },
      onclick: async () => { await api.duplicate(p.id, { brand: picker.value() }); close(); renderPanel(); toast('Đã nhân bản dự án'); },
    }, '⧉ Nhân bản')));
}

// ---------------------------------------------------------------- director
// Brief có cấu trúc lưu trong project.brief (xem normalizeBrief trong server/store.js).
const MOODS = ['Sang trọng', 'Ấm áp', 'Tươi mới', 'Năng động', 'Tối giản', 'Hiện đại', 'Tự nhiên', 'Vui tươi', 'Cảm động', 'Lãng mạn', 'Mạnh mẽ', 'Chuyên nghiệp'];
const DURATIONS = [6, 10, 15, 20, 30, 45, 60];
const ASPECTS = [
  ['16:9', '16:9 · YouTube, LED', '1920x1080'],
  ['9:16', '9:16 · TikTok, Reels', '1080x1920'],
  ['1:1', '1:1 · Feed', '1080x1080'],
  ['4:5', '4:5 · Feed dọc', '1080x1350'],
];
const pendingAsk = new Map(); // project id → yêu cầu sửa đang gõ (không lưu, giữ qua lần vẽ lại panel)
const briefOpen = new Map(); // project id → khung brief đang mở/đóng

/** Sửa một trường brief: lưu qua luồng autosave (server tự snapshot "brief" theo phiên sửa). */
function setBrief(key, value) {
  update((pp) => {
    const b = { ...(pp.brief && typeof pp.brief === 'object' ? pp.brief : {}) };
    const empty = value == null || value === '' || (Array.isArray(value) && !value.length);
    if (empty) delete b[key]; else b[key] = value;
    pp.brief = b;
  }, { structural: false });
}

/**
 * Migrate một lần: brief cũ chỉ nằm trong sessionStorage['brief:'+id] → project.brief.notes
 * (brief trống thì thay, có rồi thì nối thêm nếu chưa có). Khoá sessionStorage chỉ bị xoá
 * sau khi lưu lên server thành công (lỗi lưu → lần mở sau thử lại, không mất brief).
 */
export async function migrateLegacyBrief(p) {
  const key = 'brief:' + p.id;
  let old = null;
  try { old = sessionStorage.getItem(key); } catch { return false; }
  if (old == null) return false;
  const text = old.trim();
  const b = p.brief && typeof p.brief === 'object' ? p.brief : {};
  const notes = (b.notes || '').trim();
  if (text && !notes.includes(text)) {
    update((pp) => { pp.brief = { ...b, notes: notes ? `${notes}\n\n${text}` : text }; }, { structural: false });
    await saveNow();
    if (state.dirty) return false;
  }
  try { sessionStorage.removeItem(key); } catch { /* ignore */ }
  return true;
}

function briefForm(p) {
  const b = p.brief && typeof p.brief === 'object' ? p.brief : {};
  const text = (key, attrs) => {
    const el = h(attrs.rows ? 'textarea' : 'input', { ...attrs, value: b[key] || '', 'data-brief': key });
    el.oninput = () => setBrief(key, el.value);
    return el;
  };
  // cảm xúc: chip chọn nhiều (danh sách cố định + tự nhập)
  const moodBox = h('div', { class: 'chips' });
  const moods = () => (Array.isArray(p.brief?.moods) ? p.brief.moods : []);
  const has = (m) => moods().some((x) => x.toLowerCase() === m.toLowerCase());
  const toggleMood = (m) => {
    setBrief('moods', has(m) ? moods().filter((x) => x.toLowerCase() !== m.toLowerCase()) : [...moods(), m].slice(0, 8));
    fillMoods();
  };
  const moodInput = h('input', { placeholder: 'Cảm xúc khác… (Enter để thêm)', maxLength: 40, class: 'chip-input' });
  moodInput.onkeydown = (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const v = moodInput.value.trim();
    if (v && !has(v)) toggleMood(v);
    moodInput.value = '';
  };
  function fillMoods() {
    const custom = moods().filter((m) => !MOODS.some((x) => x.toLowerCase() === m.toLowerCase()));
    moodBox.replaceChildren(...[...MOODS, ...custom].map((m) => h('button', {
      type: 'button', class: 'chip' + (has(m) ? ' on' : ''), 'aria-pressed': has(m) ? 'true' : 'false', onclick: () => toggleMood(m),
    }, m)));
  }
  fillMoods();
  const dur = h('select', { 'data-brief': 'duration', onchange: (e) => setBrief('duration', e.target.value ? Number(e.target.value) : null) },
    h('option', { value: '' }, '— Thời lượng —'),
    DURATIONS.map((d) => h('option', { value: d, selected: b.duration === d }, `${d} giây`)),
    b.duration && !DURATIONS.includes(b.duration) ? h('option', { value: b.duration, selected: true }, `${b.duration} giây`) : null);
  const frameKey = `${p.width}x${p.height}`;
  const aspectHint = h('div', { class: 'small muted', style: { marginTop: '4px' } });
  const fillHint = () => {
    const a = ASPECTS.find((x) => x[0] === p.brief?.aspect);
    aspectHint.textContent = a && a[2] !== frameKey ? `Khung dự án đang là ${p.width}×${p.height} — đổi ở tab Phong cách nếu cần.` : '';
  };
  const aspect = h('select', { 'data-brief': 'aspect', onchange: (e) => { setBrief('aspect', e.target.value || null); fillHint(); } },
    h('option', { value: '' }, '— Kênh / tỉ lệ khung —'),
    ASPECTS.map(([v, label]) => h('option', { value: v, selected: b.aspect === v }, label)));
  fillHint();
  return h('div', { class: 'brief-form' },
    h('label', {}, 'Sản phẩm / sự kiện'), text('subject', { placeholder: 'VD: Serum Lumi C+ 15% Vitamin C', maxLength: 200 }),
    h('label', {}, 'Thông điệp chính'), text('message', { placeholder: 'VD: Da sáng sau 14 ngày, dịu nhẹ cho da nhạy cảm', maxLength: 500 }),
    h('label', {}, 'Cảm xúc'), moodBox, moodInput,
    h('div', { class: 'row' },
      h('div', {}, h('label', {}, 'Thời lượng'), dur),
      h('div', {}, h('label', {}, 'Kênh / tỉ lệ'), aspect)),
    aspectHint,
    h('label', {}, 'Kêu gọi hành động (CTA)'), text('cta', { placeholder: 'VD: Đặt hàng ngay – giảm 20%', maxLength: 120 }),
    h('label', {}, 'Ghi chú tự do'), text('notes', { rows: 4, placeholder: 'Ý tưởng, cảnh muốn có, điều cần tránh… VD: cận cảnh giọt serum rơi, nhấn 3 lợi ích.', maxLength: 4000 }),
  );
}

function briefDetails(p) {
  const d = h('details', { class: 'brief', open: briefOpen.get(p.id) ?? !p.shots.length },
    h('summary', {}, 'Brief', h('span', { class: 'small muted' }, ' · lưu cùng dự án')), briefForm(p));
  d.addEventListener('toggle', () => briefOpen.set(p.id, d.open));
  return d;
}

function director() {
  const p = state.project;
  const ask = h('textarea', { placeholder: 'Muốn sửa gì lần này? VD: cắt nhanh theo nhạc, màu ấm hơn, thêm shot giá', style: { minHeight: '80px' }, value: pendingAsk.get(p.id) || '' });
  ask.oninput = () => pendingAsk.set(p.id, ask.value);
  const btn = h('button', {
    class: 'primary block',
    disabled: !state.config.director,
    onclick: async () => {
      try {
        btn.disabled = true;
        await saveNow();
        const job = await api.director(p.id, { brief: p.brief || {}, request: p.shots.length ? ask.value : '' });
        trackJob(job, (j) => {
          btn.disabled = false;
          refreshBudgetBanner(); // #34: usage grew — banner at ≥ 80 %
          if (j.status === 'done') {
            pendingAsk.delete(p.id);
            setProject(j.result.project, { keepSelection: false });
            toast('🎬 ' + (j.result.project.lastDirector?.summary || 'Đạo diễn đã dựng xong'), { ms: 8000 });
          } else toast('Đạo diễn lỗi: ' + j.error, { error: true, ms: 10000 });
        });
      } catch (e) {
        btn.disabled = false;
        toast(e.message, { error: true });
        refreshBudgetBanner(); // 402 "Đã hết hạn mức tháng — liên hệ admin" → show the banner too
      }
    },
  }, p.shots.length ? '🎬 Nhờ đạo diễn sửa' : '🎬 Nhờ đạo diễn dựng');
  const voices = (p.voice || []).length;
  const exportsList = (p.exports || []);
  return h('div', {},
    h('div', { class: 'back' }, h('button', { class: 'ghost', onclick: () => { state.view = 'projects'; renderPanel(); } }, '← Dự án'), h('strong', {}, p.name)),
    h('div', { class: 'meta' }, `${p.width}×${p.height} · ${fmt(duration())} · ${p.shots.length} shot · ${voices} câu thoại${p.music ? ' · 🎵' : ''}`),
    briefDetails(p),
    p.shots.length ? [h('label', {}, 'Yêu cầu sửa lần này'), ask] : null,
    h('div', { style: { height: '10px' } }), btn,
    h('p', { class: 'small muted' }, state.config.director
      ? `Đạo diễn: ${state.config.model}. Đạo diễn xem ảnh chất liệu, viết code từng shot, render thử, tự duyệt contact sheet rồi sửa.`
      : 'Server chưa có ANTHROPIC_API_KEY — dùng tab Nhanh / Mẫu cảnh, hoặc sửa code shot trực tiếp.'),
    usageLine(p.lastDirector?.usage),
    jobsBox(),
    h('div', { class: 'row' },
      h('button', { onclick: contactSheet }, '🗂 Contact sheet'),
      h('button', { onclick: () => emit('preview'), title: 'Video nháp 12 fps, 1/3 độ phân giải, không motion blur — xem nhịp và bố cục, không lưu vào danh sách bản xuất' }, '⚡ Xem nhanh'),
      h('button', { class: 'primary', onclick: () => emit('export') }, '⬇ Xuất MP4')),
    cacheLine(p),
    exportsList.length ? h('div', { class: 'section-title' }, 'Đã xuất') : null,
    h('div', { class: 'list' }, exportsList.slice(0, 8).map((e) => h('div', { class: 'item' },
      h('button', { class: 'icon', onclick: () => playExport(e.file) }, '▶'),
      h('div', { class: 'grow', title: e.file }, e.file),
      h('a', { href: exportUrl(p, e.file, true), title: 'Tải về' }, h('button', { class: 'icon' }, '⬇'))))),
    storyboard(),
  );
}

// Cache đoạn render (#29): dung lượng + nút "Xoá cache". Xuất lại chỉ render các đoạn đã đổi.
function cacheLine(p) {
  const el = h('p', { class: 'small muted', id: 'cacheLine' });
  const mb = (b) => (b / 1048576).toFixed(b < 10485760 ? 1 : 0);
  const fill = (st) => el.replaceChildren(
    `Cache render: ${st.segments} đoạn · ${mb(st.bytes)} MB${st.maxBytes ? ` / ${mb(st.maxBytes)} MB` : ' (tắt)'} `,
    st.segments ? h('a', {
      href: '#', title: 'Xoá các đoạn video đã render sẵn của dự án này (lần xuất sau render lại toàn bộ)',
      onclick: async (e) => {
        e.preventDefault();
        if (!confirm('Xoá cache render của dự án này?')) return;
        try { const r = await api.clearCache(p.id); toast(`Đã xoá cache (${mb(r.freed)} MB)`); fill(r); } catch (err) { toast(err.message, { error: true }); }
      },
    }, 'Xoá cache') : null);
  el.refresh = () => api.cacheStats(p.id).then(fill).catch(() => {});
  el.refresh();
  return el;
}
const seenRenderJobs = new Set();
on('jobs', () => {
  const done = state.jobs.filter((j) => j.kind === 'render' && j.status === 'done' && !seenRenderJobs.has(j.id));
  if (!done.length) return;
  done.forEach((j) => seenRenderJobs.add(j.id));
  document.getElementById('cacheLine')?.refresh?.();
});

// Tóm tắt token của lần chạy đạo diễn gần nhất (project.lastDirector.usage).
function usageLine(u) {
  const t = u?.total;
  if (!t) return null;
  const n = (k) => (Number(t[k]) || 0).toLocaleString('vi-VN');
  const rounds = (u.rounds || []).length;
  return h('p', { class: 'small muted', title: 'Token của lần chạy đạo diễn gần nhất' },
    `Token lần trước${rounds ? ` (${rounds} lượt)` : ''}: vào ${n('input_tokens')} · ra ${n('output_tokens')} · đọc cache ${n('cache_read_input_tokens')} · ghi cache ${n('cache_creation_input_tokens')}`);
}

function jobsBox() {
  const box = h('div', { id: 'jobsBox' });
  fillJobs(box);
  return box;
}
const JOB_STATUS = { error: '❌ lỗi', done: '✅ xong', cancelled: '⏹ đã huỷ', interrupted: '⚠️ gián đoạn', queued: '⏳ đang chờ' };
function fillJobs(box) {
  box.replaceChildren(...state.jobs.map((j) => h('div', { class: 'job' },
    h('div', { class: 'row' },
      h('strong', {}, j.kind === 'render' ? (j.params?.quality === 'preview' ? '⚡ Xem nhanh' : '⬇ Xuất video') : '🎬 Đạo diễn'),
      whoLabel(j.userName),
      h('span', { class: 'small muted', style: { textAlign: 'right' } }, JOB_STATUS[j.status] || Math.round(j.progress * 100) + '%')),
    h('div', { class: 'bar' }, h('div', { style: { width: Math.round(j.progress * 100) + '%' } })),
    h('div', { class: 'log' }, j.status === 'interrupted' ? [j.error, ...(j.log || []).slice(-6)].join('\n') : j.error && j.status !== 'done' ? j.error : j.message),
    j.status === 'running' || j.status === 'queued' ? h('button', { class: 'ghost', style: { marginTop: '6px', padding: '3px 8px' }, onclick: () => api.cancel(j.id) }, 'Huỷ') : null,
    j.status === 'interrupted' ? h('button', {
      class: 'primary', style: { marginTop: '6px', padding: '3px 8px' },
      onclick: (e) => { e.target.disabled = true; retryJob(j).catch((err) => { e.target.disabled = false; toast(err.message, { error: true }); }); },
    }, '↻ Chạy lại') : null)));
}
on('jobs', () => {
  const box = document.getElementById('jobsBox');
  if (box) fillJobs(box);
});

function storyboard() {
  const p = state.project;
  const d = h('details', {}, h('summary', {}, 'Storyboard'));
  d.addEventListener('toggle', () => {
    if (!d.open || d.dataset.built) return;
    d.dataset.built = '1';
    shotStarts().forEach((it, i) => {
      const c = h('canvas', { width: 320, height: Math.round(320 * p.height / p.width) });
      thumb(c, i, it.shot.duration * 0.6);
      d.append(h('div', { class: 'sb-shot', onclick: () => selectShot(it.shot.id) }, c,
        h('div', {}, h('div', { class: 'n' }, `${i + 1} · ${it.shot.name}`), h('div', { class: 'small muted' }, `${it.shot.duration.toFixed(1)}s · ${it.shot.notes || ''}`))));
    });
  });
  return d;
}

function thumb(canvas, shotIndex, t) {
  const big = document.createElement('canvas');
  big.width = engine.out.width; big.height = engine.out.height;
  engine.renderShotFrame(big.getContext('2d'), shotIndex, t);
  canvas.getContext('2d').drawImage(big, 0, 0, canvas.width, canvas.height);
}

function contactSheet() {
  const p = state.project;
  const n = 4, tw = 360, th = Math.round(tw * p.height / p.width), lab = 26;
  const sheet = h('canvas', { width: tw * n, height: (th + lab) * p.shots.length });
  const c = sheet.getContext('2d');
  c.fillStyle = '#111';
  c.fillRect(0, 0, sheet.width, sheet.height);
  const big = document.createElement('canvas');
  big.width = engine.out.width; big.height = engine.out.height;
  p.shots.forEach((sh, i) => {
    for (let j = 0; j < n; j++) {
      const t = sh.duration * (j + 0.5) / n;
      engine.renderShotFrame(big.getContext('2d'), i, t);
      c.drawImage(big, j * tw, i * (th + lab) + lab, tw, th);
      c.fillStyle = '#ccc';
      c.font = '600 14px "Be Vietnam Pro"';
      c.fillText(`${i + 1} · ${sh.name} · ${t.toFixed(1)}s`, j * tw + 6, i * (th + lab) + 18);
    }
  });
  const url = sheet.toDataURL('image/jpeg', 0.9);
  modal('Contact sheet', h('div', {}, h('img', { src: url }), h('a', { href: url, download: `${p.name}-contact-sheet.jpg` }, h('button', { style: { marginTop: '10px' } }, '⬇ Tải ảnh'))));
}

/** "Xem nhanh" result: plays in the editor, not part of the exports list (only the latest is kept). */
export function playPreview(j) {
  const p = state.project;
  const c = j.result?.cache;
  modal('⚡ Xem nhanh', h('div', {},
    h('video', { src: previewUrl(p, j.result.file), controls: true, autoplay: true, style: { width: '100%' } }),
    h('p', { class: 'small muted' }, `12 fps · 1/3 độ phân giải · không motion blur${c ? ` · tái sử dụng ${c.reused}/${c.segments} đoạn · ${c.totalSec}s` : ''}. Bản nháp để duyệt nhịp và bố cục — không lưu vào danh sách bản xuất.`)));
}

export function playExport(file) {
  const p = state.project;
  modal(file, h('div', {},
    h('video', { src: exportUrl(p, file), controls: true, autoplay: true }),
    h('div', { class: 'row', style: { marginTop: '10px' } },
      h('a', { href: exportUrl(p, file, true), class: 'shrink' }, h('button', {}, '⬇ Tải về')),
      h('button', { class: 'shrink', onclick: async () => { if (confirm('Xoá bản xuất này?')) { const np = await api.deleteExport(p.id, file); state.project.exports = np.exports; document.getElementById('modal').hidden = true; renderPanel(); } } }, '🗑 Xoá'))));
}

// ---------------------------------------------------------------- quick
// "Theo mùa" filter shared by the Nhanh and Mẫu cảnh tabs: 'all' | 'base' | 'seasonal'.
let seasonFilter = 'all';
function seasonChips(onChange) {
  const opts = [['all', 'Tất cả'], ['base', 'Cơ bản'], ['seasonal', 'Theo mùa']];
  return h('div', { class: 'chips' }, opts.map(([v, label]) => h('button', {
    class: 'chip' + (seasonFilter === v ? ' active' : ''),
    onclick: () => { seasonFilter = v; onChange(); },
  }, label)));
}
/** Màu mặc định trên form theo mùa: màu "accent" của Brand Kit (field dùng brandColor) hoặc mặc định của bộ mẫu. */
function seasonColorDefault(season, key) {
  const kitAccent = key === 'accent' && state.project?.brand?.kit?.palette?.find((c) => c.role === 'accent')?.color;
  return kitAccent || season?.defaults?.[key] || '#d9b45f';
}
const seasonName = (id) => (state.config.seasons || []).find((x) => x.id === id)?.name || id;

function quick() {
  const p = state.project;
  const all = state.config.templates;
  const list = all.filter((t) => seasonFilter === 'all' || (seasonFilter === 'seasonal' ? t.season : !t.season));
  const groups = [[null, list.filter((t) => !t.season)], ...[...new Set(list.filter((t) => t.season).map((t) => t.season))].map((id) => [id, list.filter((t) => t.season === id)])];
  const tpl = h('select', {}, groups.filter(([, g]) => g.length).map(([id, g]) => h('optgroup', { label: id ? `Theo mùa · ${seasonName(id)}` : 'Cơ bản' },
    g.map((t) => h('option', { value: t.id }, t.name)))));
  const desc = h('div', { class: 'small muted', style: { marginTop: '6px' } });
  const box = h('div');
  const headline = h('input', { placeholder: 'Tiêu đề chính (để trống = mặc định)' });
  const mat = h('select', {}, Object.entries(MATERIALS).map(([k, m]) => h('option', { value: k }, m.label)));
  const feats = [0, 1, 2].map((i) => {
    const icon = h('select', {}, ICON_NAMES.map((n) => h('option', { value: n, selected: n === ['drop', 'sun', 'shield'][i] }, n)));
    const label = h('input', { value: ['Thẩm thấu', 'Sáng da', 'Dịu nhẹ'][i] });
    return { icon, label, row: h('div', { class: 'row', style: { marginBottom: '6px' } }, h('div', { style: { flex: '0 0 96px' } }, icon), label) };
  });
  const cta = h('input', { value: 'Mua ngay' });
  const baseForm = h('div', {},
    h('label', {}, 'Tiêu đề'), headline,
    h('label', {}, 'Chất liệu chất lỏng'), mat,
    h('label', {}, '3 lợi ích (icon + nhãn)'), feats.map((f) => f.row),
    h('label', {}, 'Nút CTA'), cta);
  // Seasonal recipes: one form for the shared fields (company, date, venue…) → shot.fields of every shot.
  const seasonInputs = {};
  const seasonForm = (season) => {
    const s = (state.config.seasons || []).find((x) => x.id === season);
    if (!s) return h('div');
    return h('div', {}, h('p', { class: 'small muted' }, 'Điền thông tin khách — để trống giữ chữ mẫu. Sau khi dựng, sửa từng shot ở tab Nội dung (Inspector).'),
      s.fields.map((f) => {
        const inp = f.type === 'color'
          ? h('input', { type: 'color', value: seasonColorDefault(s, f.key) })
          : h('input', { placeholder: s.defaults[f.key] || '', maxLength: f.maxLength || 60 });
        seasonInputs[f.key] = inp;
        return [h('label', {}, f.label), inp];
      }));
  };
  const cur = () => all.find((t) => t.id === tpl.value);
  const sync = () => {
    const t = cur();
    desc.textContent = t ? `${t.desc}${t.aspect ? ` · ${t.aspect}` : ''}` : '';
    for (const k of Object.keys(seasonInputs)) delete seasonInputs[k];
    box.replaceChildren(t?.season ? seasonForm(t.season) : baseForm);
  };
  tpl.onchange = sync;
  sync();
  return h('div', {},
    h('h3', {}, 'Dựng nhanh từ mẫu'),
    h('p', { class: 'small muted' }, 'Không cần AI. Tự gán chất liệu theo tên (hero/bottle = sản phẩm, splash/orange = thành phần, còn lại làm nền). Sau đó có thể nhờ đạo diễn tinh chỉnh.'),
    seasonChips(renderPanel),
    h('label', {}, 'Công thức'), list.length ? tpl : h('p', { class: 'small muted' }, 'Chưa có công thức trong nhóm này.'), desc,
    box,
    h('button', {
      class: 'primary block', style: { marginTop: '14px' }, disabled: !list.length,
      onclick: async () => {
        if (p.shots.length && !confirm('Thay toàn bộ shot hiện tại bằng mẫu? (có lưu lịch sử để khôi phục)')) return;
        await saveNow();
        const t = cur();
        const body = t?.season
          ? { template: t.id, fields: Object.fromEntries(Object.entries(seasonInputs).map(([k, el]) => [k, el.type === 'color' && el.value === seasonColorDefault(state.config.seasons.find((x) => x.id === t.season), k) ? '' : el.value])) }
          : {
            template: tpl.value, headline: headline.value || undefined, material: mat.value, cta: cta.value,
            features: feats.map((f) => ({ icon: f.icon.value, label: f.label.value })),
          };
        const np = await api.template(p.id, body);
        setProject(np, { keepSelection: false });
        toast('Đã dựng ' + np.shots.length + ' shot từ mẫu');
      },
    }, '✨ Dựng ngay'),
  );
}

// ---------------------------------------------------------------- scenes
const SCENE_LIST = [
  ['hook', 'Mở đầu: vấn đề', 'Ảnh nền chậm, ánh sáng rò, câu hook'],
  ['splash', 'Giọt rơi – vương miện bắn', 'Mô phỏng giọt rơi, vương miện, tia Worthington, gợn sóng'],
  ['hero', 'Ra mắt sản phẩm', 'Sản phẩm rơi nảy, bóng tiếp xúc, phản chiếu, vệt sáng'],
  ['ingredient', 'Bùng nổ thành phần', 'Thành phần bay ra theo trọng lực, giọt bắn'],
  ['features', 'Ba lợi ích', 'Huy hiệu icon bật lò xo'],
  ['pour', 'Rót chất lỏng', 'Dòng chảy mỏng dần, va chạm, khúc xạ'],
  ['drip', 'Giọt từ ống nhỏ giọt', 'Giọt căng, thắt cổ, rơi theo chu kỳ'],
  ['cta', 'Kêu gọi hành động', 'Sản phẩm + tiêu đề + nút CTA'],
  ['kenburns', 'Ảnh chuyển động', 'Camera đẩy chậm, bụi, light leak, chú thích'],
];
function scenes() {
  const p = state.project;
  const mat = h('select', {}, Object.entries(MATERIALS).map(([k, m]) => h('option', { value: k }, m.label)));
  const card = ([id, name, desc]) => h('div', {
    class: 'card',
    onclick: async () => {
      await saveNow();
      const sel = p.shots.findIndex((s) => s.id === state.selectedShot);
      const np = await api.template(p.id, { scene: id, at: sel + 1, material: mat.value });
      const added = np.shots[sel + 1];
      setProject(np);
      if (added) selectShot(added.id);
      toast('Đã thêm cảnh: ' + name);
    },
  }, h('strong', {}, name), h('div', { class: 'muted' }, desc));
  const seasonal = state.config.seasonalScenes || [];
  const bySeason = [...new Set(seasonal.map((x) => x.season))];
  return h('div', {},
    h('h3', {}, 'Thêm cảnh mẫu'),
    h('p', { class: 'small muted' }, 'Chèn sau shot đang chọn. Mỗi cảnh là code thật — sửa được ở cột phải.'),
    seasonChips(renderPanel),
    seasonFilter !== 'seasonal' ? [
      h('label', {}, 'Chất liệu chất lỏng'), mat, h('div', { style: { height: '12px' } }),
      SCENE_LIST.map(card),
    ] : null,
    seasonFilter !== 'base' ? bySeason.map((id) => [
      h('div', { class: 'section-title' }, `Theo mùa · ${seasonName(id)}`),
      seasonal.filter((x) => x.season === id).map((x) => card([x.id, x.name, x.desc])),
    ]) : null,
  );
}

// ---------------------------------------------------------------- media
function media() {
  const p = state.project;
  const input = h('input', { type: 'file', multiple: true, accept: 'image/*,video/*,audio/*', style: { display: 'none' }, onchange: (e) => doUpload([...e.target.files]) });
  const drop = h('div', { class: 'drop', onclick: () => input.click() }, '⬆ Kéo thả hoặc bấm để tải ảnh, video, nhạc', h('div', { class: 'small', style: { marginTop: '6px' } }, 'PNG nền trong suốt cho sản phẩm sẽ có bóng & phản chiếu đẹp nhất'));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); doUpload([...e.dataTransfer.files]); });
  async function doUpload(files) {
    if (!files.length) return;
    toast(`Đang tải ${files.length} tệp…`);
    try {
      const r = await api.upload(p.id, files);
      setProject(r.project);
      toast(`Đã thêm ${r.added.length} chất liệu`);
    } catch (e) { toast(e.message, { error: true }); }
  }
  return h('div', {},
    h('h3', {}, 'Chất liệu'),
    drop, input,
    h('p', { class: 'small muted' }, 'Tên chất liệu dùng trong code (s.image(\'hero\')). Mô tả giúp đạo diễn AI hiểu đúng vai trò.'),
    p.assets.filter((a) => a.role !== 'voice').map((a) => {
      const nm = h('input', { value: a.name, onchange: async (e) => setProject(await api.patchAsset(p.id, a.id, { name: e.target.value })) });
      const ds = h('input', { value: a.desc || '', placeholder: 'Mô tả: chai serum, nền gỗ…', onchange: async (e) => setProject(await api.patchAsset(p.id, a.id, { desc: e.target.value })) });
      return h('div', { class: 'asset-row' },
        h('div', { class: 'thumb' }, a.type === 'image' ? h('img', { src: fileUrl(p, a) }) : a.type === 'video' ? h('video', { src: fileUrl(p, a), muted: true }) : '🎵'),
        h('div', {}, nm, ds,
          h('div', { class: 'row small muted' },
            h('span', {}, `${a.type}${a.width ? ` · ${a.width}×${a.height}` : ''}${a.duration ? ` · ${a.duration.toFixed(1)}s` : ''}${a.hasAlpha ? ' · trong suốt' : ''}`),
            h('button', { class: 'icon shrink', onclick: async () => { if (confirm(`Xoá "${a.name}"?`)) setProject(await api.deleteAsset(p.id, a.id)); } }, '🗑'))));
    }),
  );
}

// ---------------------------------------------------------------- voice
function voice() {
  const p = state.project;
  p.voice = p.voice || [];
  const voiceSel = state.config.voices.length ? state.config.voices : null;
  return h('div', {},
    h('h3', {}, 'Lồng tiếng'),
    h('p', { class: 'small muted' }, state.config.tts ? 'Viết câu thoại rồi bấm 🔊 để tạo giọng đọc AI, hoặc tải file thu âm.' : 'Chưa cấu hình TTS trên server — tải file thu âm cho từng câu (mp3/wav/m4a).'),
    p.voice.map((v) => {
      const txt = h('textarea', { value: v.text, onchange: (e) => update(() => { v.text = e.target.value; }) });
      const start = h('input', { type: 'number', step: 0.1, value: v.start, title: 'Bắt đầu (s)', onchange: (e) => update(() => { v.start = Math.max(0, Number(e.target.value)); }) });
      const dur = h('input', { type: 'number', step: 0.1, value: v.duration, title: 'Độ dài (s)', onchange: (e) => update(() => { v.duration = Math.max(0.3, Number(e.target.value)); }) });
      const vsel = voiceSel ? h('select', { onchange: (e) => update(() => { v.voiceId = e.target.value; }, { structural: false }) }, voiceSel.map((o) => h('option', { value: o.id, selected: v.voiceId === o.id }, o.name))) : null;
      const file = h('input', {
        type: 'file', accept: 'audio/*', style: { display: 'none' },
        onchange: async (e) => {
          const f = e.target.files[0];
          if (!f) return;
          const r = await api.upload(p.id, [f], { role: 'voice' });
          const a = r.added[0];
          r.project.voice = r.project.voice.map((x) => (x.id === v.id ? { ...x, assetId: a.id, duration: Math.max(0.5, Math.round(a.duration * 10) / 10) } : x));
          setProject(r.project);
          await saveNow();
        },
      });
      return h('div', { class: 'voice-line', id: 'vl-' + v.id },
        txt,
        h('div', { class: 'row', style: { marginTop: '6px' } }, h('span', { class: 'small muted shrink' }, 'từ'), start, h('span', { class: 'small muted shrink' }, 'dài'), dur),
        vsel ? h('div', { style: { marginTop: '6px' } }, vsel) : null,
        h('div', { class: 'row', style: { marginTop: '6px' } },
          state.config.tts ? h('button', {
            onclick: async (e) => {
              e.target.disabled = true;
              try { await saveNow(); setProject(await api.tts(p.id, v.id, v.voiceId)); toast('Đã tạo giọng đọc'); } catch (er) { toast(er.message, { error: true }); }
              e.target.disabled = false;
            },
          }, '🔊 Tạo giọng') : null,
          h('button', { onclick: () => file.click() }, '⬆ Thu âm'), file,
          h('button', { class: 'shrink', onclick: () => update((pp) => { pp.voice = pp.voice.filter((x) => x !== v); }) }, '🗑')),
        h('div', { class: 'small muted', style: { marginTop: '4px' } }, v.assetId ? '✅ có audio' : '⚠ chưa có audio'));
    }),
    h('button', { class: 'block', onclick: () => import('./timeline.js').then((m) => m.addVoiceLine()) }, '+ Câu thoại tại đầu phát'),
  );
}
on('focusVoice', (id) => setTimeout(() => document.getElementById('vl-' + id)?.scrollIntoView({ behavior: 'smooth' }), 50));

// ---------------------------------------------------------------- music
function music() {
  const p = state.project;
  const tracks = p.assets.filter((a) => a.type === 'audio' && a.role !== 'voice');
  const input = h('input', {
    type: 'file', accept: 'audio/*', style: { display: 'none' },
    onchange: async (e) => {
      const r = await api.upload(p.id, [...e.target.files], { role: 'music' });
      setProject(r.project);
    },
  });
  const m = p.music || {};
  return h('div', {},
    h('h3', {}, 'Nhạc nền'),
    h('button', { class: 'block', onclick: () => input.click() }, '⬆ Tải nhạc lên'), input,
    h('label', {}, 'Bài đang dùng'),
    h('select', {
      onchange: (e) => update((pp) => {
        pp.music = e.target.value ? { volume: 0.3, fadeIn: 0.5, fadeOut: 1.5, offset: 0, ...(pp.music || {}), assetId: e.target.value } : null;
      }),
    }, h('option', { value: '' }, '— Không nhạc —'), tracks.map((a) => h('option', { value: a.id, selected: m.assetId === a.id }, `${a.original || a.name} (${(a.duration || 0).toFixed(0)}s)`))),
    p.music ? [
      slider('Âm lượng', m.volume ?? 0.3, { fmt: (v) => Math.round(v * 100) + '%', onInput: (v) => update((pp) => { pp.music.volume = v; }, { structural: false }) }),
      slider('Bắt đầu từ giây', m.offset ?? 0, { min: 0, max: 120, step: 0.5, fmt: (v) => v + 's', onInput: (v) => update((pp) => { pp.music.offset = v; }, { structural: false }) }),
      slider('Fade in', m.fadeIn ?? 0.5, { min: 0, max: 5, step: 0.1, fmt: (v) => v + 's', onInput: (v) => update((pp) => { pp.music.fadeIn = v; }, { structural: false }) }),
      slider('Fade out', m.fadeOut ?? 1.5, { min: 0, max: 5, step: 0.1, fmt: (v) => v + 's', onInput: (v) => update((pp) => { pp.music.fadeOut = v; }, { structural: false }) }),
    ] : null,
    h('p', { class: 'small muted' }, 'Mẹo: nhờ đạo diễn "cắt theo nhịp nhạc 120 BPM" để khớp độ dài shot với phách.'),
  );
}

// ---------------------------------------------------------------- style
function style() {
  const p = state.project;
  const st = p.style;
  const pal = st.palette || {};
  const color = (key, label) => h('div', {}, h('div', { class: 'small muted', style: { marginBottom: '4px' } }, label),
    h('input', { type: 'color', value: pal[key] || '#ffffff', oninput: (e) => update((pp) => { pp.style.palette = { ...pp.style.palette, [key]: e.target.value }; }, { structural: false }) }));
  const kit = p.brand?.kit;
  return h('div', {},
    h('h3', {}, 'Phong cách'),
    brandBox(p),
    h('label', {}, 'Chỉnh màu (grade)'),
    h('select', { onchange: (e) => update((pp) => { pp.style.grade = e.target.value; }, { structural: false }) },
      Object.entries(GRADES).map(([k, g]) => h('option', { value: k, selected: st.grade === k }, g.label))),
    slider('Vignette', st.vignette ?? 0.35, { onInput: (v) => update((pp) => { pp.style.vignette = v; }, { structural: false }) }),
    slider('Bloom / hào quang', st.bloom ?? 0.25, { onInput: (v) => update((pp) => { pp.style.bloom = v; }, { structural: false }) }),
    slider('Hạt phim', st.grain ?? 0.05, { max: 0.25, onInput: (v) => update((pp) => { pp.style.grain = v; }, { structural: false }) }),
    slider('Letterbox điện ảnh', st.letterbox ?? 0, { max: 0.15, onInput: (v) => update((pp) => { pp.style.letterbox = v; }, { structural: false }) }),
    h('label', {}, 'Bảng màu thương hiệu'),
    kit
      ? h('div', {}, h('div', { class: 'kit-roles' }, kit.palette.map((c) => h('div', {}, h('i', { style: { background: c.color } }), h('span', { class: 'small' }, `${ROLE_LABEL[c.role] || c.role} ${c.color}`)))),
        h('p', { class: 'small muted' }, 'Màu lấy từ Brand Kit (s.palette). Sửa ở màn hình Brand Kit.'))
      : h('div', { class: 'swatches' }, color('primary', 'Chính'), color('accent', 'Nhấn'), color('text', 'Chữ')),
    h('label', {}, 'Khung hình'),
    h('div', { class: 'row' },
      h('select', {
        onchange: (e) => {
          const [w, hh] = e.target.value.split('x').map(Number);
          update((pp) => { pp.width = w; pp.height = hh; });
        },
      }, ['1920x1080', '1080x1920', '1080x1080', '1080x1350', '3840x2160'].map((v) => h('option', { value: v, selected: `${p.width}x${p.height}` === v }, v.replace('x', '×')))),
      h('select', { onchange: (e) => update((pp) => { pp.fps = Number(e.target.value); }, { structural: false }) },
        [24, 25, 30, 50, 60].map((f) => h('option', { value: f, selected: p.fps === f }, f + ' fps')))),
    h('p', { class: 'small muted' }, 'Đổi khung hình xong, nhờ đạo diễn "bố cục lại cho dọc 9:16" để chữ và sản phẩm nằm đúng vùng an toàn.'),
  );
}

/** Brand Kit đang dùng (tab Phong cách): đổi kit, khoá / bỏ khoá phiên bản, mở màn hình quản lý. */
function brandBox(p) {
  const box = h('div', { class: 'brand-box' }, h('div', { class: 'small muted' }, 'Đang tải Brand Kit…'));
  api.brands().then((kits) => {
    const b = p.brand;
    const live = b && kits.find((k) => k.id === b.id);
    const sel = h('select', { id: 'styleKit' }, h('option', { value: '' }, '— Không dùng Brand Kit —'),
      kits.map((k) => h('option', { value: k.id, selected: b?.id === k.id }, `${k.name} · v${k.version}`)),
      b && !live ? h('option', { value: b.id, selected: true }, `${b.kit.name} (kit đã xoá — giữ bản chụp)`) : null);
    const apply = async (next) => {
      await saveNow();
      setProject(await api.setProjectBrand(p.id, next));
      toast(next.id ? 'Đã áp Brand Kit' : 'Đã bỏ Brand Kit');
    };
    sel.onchange = () => apply(sel.value ? { id: sel.value, locked: !!b?.locked } : { id: null });
    const lock = h('input', { type: 'checkbox', checked: !!b?.locked, disabled: !b, style: { width: 'auto' }, onchange: (e) => apply({ id: b.id, locked: e.target.checked }) });
    const stale = b && live && b.locked && live.version > b.version;
    box.replaceChildren(
      h('label', {}, 'Brand Kit'),
      h('div', { class: 'row' }, sel, h('button', { class: 'shrink', title: 'Quản lý Brand Kit', onclick: () => showBrandKits({ onChange: reloadBrand }) }, '🏷')),
      b ? h('div', { class: 'kit-summary' },
        b.kit.logo ? h('img', { src: `/files/${p.id}/assets/${encodeURIComponent(b.kit.logo.file)}`, alt: 'logo' }) : null,
        h('div', {}, h('strong', {}, b.kit.name), h('span', { class: 'small muted' }, ` · phiên bản ${b.version}`), h('div', {}, kitSwatches(b.kit, 14)))) : null,
      b ? h('label', { class: 'check' }, lock, ` Khoá phiên bản kit${stale ? ` (kit đã có v${live.version})` : ''}`) : null,
    );
  }).catch((e) => box.replaceChildren(h('div', { class: 'small muted' }, 'Không tải được Brand Kit: ' + e.message)));
  return box;
}

/** Sau khi sửa kit: dự án đang mở (không khoá) lấy lại để dùng phiên bản mới nhất. */
export async function reloadBrand() {
  const p = state.project;
  if (!p?.brand || p.brand.locked) return;
  await saveNow();
  setProject(await api.get(p.id));
}

on('tab', (t) => {
  state.tab = t;
  state.view = 'editor';
  renderPanel();
});
