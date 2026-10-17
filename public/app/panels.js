// Left sidebar: tabs (Đạo diễn AI, Nhanh, Mẫu cảnh, Media, Lồng tiếng, Nhạc, Phong cách) + project list.
import { h, fmt, toast, modal, slider } from './ui.js';
import { state, on, emit, update, duration, shotStarts, trackJob, retryJob, setProject, selectShot, saveNow } from './state.js';
import { api, fileUrl, exportUrl } from './api.js';
import { engine } from './player.js';
import { MATERIALS, GRADES, ICON_NAMES } from '/engine/engine.js';
import { whoLabel } from './account.js';

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
  const list = await api.projects();
  const name = h('input', { placeholder: 'Tên dự án mới, VD: Lumi C+ TVC 20s' });
  const aspect = h('select', {},
    h('option', { value: '1920x1080' }, '16:9 · 1920×1080 (YouTube, màn LED)'),
    h('option', { value: '1080x1920' }, '9:16 · 1080×1920 (TikTok, Reels)'),
    h('option', { value: '1080x1080' }, '1:1 · 1080×1080 (Feed)'),
    h('option', { value: '1080x1350' }, '4:5 · 1080×1350'));
  panel.replaceChildren(
    h('h3', {}, 'Dự án'),
    name, h('div', { style: { height: '8px' } }), aspect,
    h('button', {
      class: 'primary block', style: { marginTop: '10px' },
      onclick: async () => {
        const [w, hh] = aspect.value.split('x').map(Number);
        const p = await api.create({ name: name.value.trim() || 'Dự án mới', width: w, height: hh });
        emit('open', p.id);
      },
    }, '+ Tạo dự án'),
    h('div', { class: 'section-title' }, `Tất cả (${list.length})`),
    h('div', { class: 'list projects' }, list.map((p) => h('div', { class: 'item', onclick: () => emit('open', p.id) },
      h('div', { class: 'grow' }, h('div', {}, p.name), h('div', { class: 'small muted' }, `${p.width}×${p.height} · ${fmt(p.duration)} · ${p.shots} shot · ${new Date(p.updatedAt).toLocaleString('vi-VN')}`)),
      h('button', { class: 'icon', title: 'Nhân bản', onclick: async (e) => { e.stopPropagation(); await api.duplicate(p.id); renderPanel(); } }, '⧉'),
      h('button', { class: 'icon', title: 'Xoá', onclick: async (e) => { e.stopPropagation(); if (confirm(`Xoá dự án "${p.name}"?`)) { await api.remove(p.id); renderPanel(); } } }, '🗑')))),
  );
}

// ---------------------------------------------------------------- director
function director() {
  const p = state.project;
  const brief = h('textarea', { placeholder: p.shots.length ? 'Muốn sửa gì? VD: cắt nhanh theo nhạc, màu ấm hơn, thêm shot giá' : 'Mô tả video: sản phẩm, thông điệp, cảm xúc, thời lượng, CTA…\nVD: Video 20s cho serum Lumi C+ 15% Vitamin C, cảm giác sang trọng ấm, cận cảnh giọt serum rơi, nhấn 3 lợi ích, kết bằng CTA đặt hàng.', style: { minHeight: '120px' } });
  brief.value = sessionStorage.getItem('brief:' + p.id) || '';
  brief.oninput = () => sessionStorage.setItem('brief:' + p.id, brief.value);
  const btn = h('button', {
    class: 'primary block',
    disabled: !state.config.director,
    onclick: async () => {
      try {
        btn.disabled = true;
        await saveNow();
        const job = await api.director(p.id, { brief: brief.value });
        trackJob(job, (j) => {
          btn.disabled = false;
          if (j.status === 'done') {
            setProject(j.result.project, { keepSelection: false });
            toast('🎬 ' + (j.result.project.lastDirector?.summary || 'Đạo diễn đã dựng xong'), { ms: 8000 });
          } else toast('Đạo diễn lỗi: ' + j.error, { error: true, ms: 10000 });
        });
      } catch (e) {
        btn.disabled = false;
        toast(e.message, { error: true });
      }
    },
  }, p.shots.length ? '🎬 Nhờ đạo diễn sửa' : '🎬 Nhờ đạo diễn dựng');
  const voices = (p.voice || []).length;
  const exportsList = (p.exports || []);
  return h('div', {},
    h('div', { class: 'back' }, h('button', { class: 'ghost', onclick: () => { state.view = 'projects'; renderPanel(); } }, '← Dự án'), h('strong', {}, p.name)),
    h('div', { class: 'meta' }, `${p.width}×${p.height} · ${fmt(duration())} · ${p.shots.length} shot · ${voices} câu thoại${p.music ? ' · 🎵' : ''}`),
    h('label', {}, 'Brief / yêu cầu sửa'), brief,
    h('div', { style: { height: '10px' } }), btn,
    h('p', { class: 'small muted' }, state.config.director
      ? `Đạo diễn: ${state.config.model}. Đạo diễn xem ảnh chất liệu, viết code từng shot, render thử, tự duyệt contact sheet rồi sửa.`
      : 'Server chưa có ANTHROPIC_API_KEY — dùng tab Nhanh / Mẫu cảnh, hoặc sửa code shot trực tiếp.'),
    usageLine(p.lastDirector?.usage),
    jobsBox(),
    h('div', { class: 'row' },
      h('button', { onclick: contactSheet }, '🗂 Contact sheet'),
      h('button', { class: 'primary', onclick: () => emit('export') }, '⬇ Xuất MP4')),
    exportsList.length ? h('div', { class: 'section-title' }, 'Đã xuất') : null,
    h('div', { class: 'list' }, exportsList.slice(0, 8).map((e) => h('div', { class: 'item' },
      h('button', { class: 'icon', onclick: () => playExport(e.file) }, '▶'),
      h('div', { class: 'grow', title: e.file }, e.file),
      h('a', { href: exportUrl(p, e.file, true), title: 'Tải về' }, h('button', { class: 'icon' }, '⬇'))))),
    storyboard(),
  );
}

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
      h('strong', {}, j.kind === 'render' ? '⬇ Xuất video' : '🎬 Đạo diễn'),
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

export function playExport(file) {
  const p = state.project;
  modal(file, h('div', {},
    h('video', { src: exportUrl(p, file), controls: true, autoplay: true }),
    h('div', { class: 'row', style: { marginTop: '10px' } },
      h('a', { href: exportUrl(p, file, true), class: 'shrink' }, h('button', {}, '⬇ Tải về')),
      h('button', { class: 'shrink', onclick: async () => { if (confirm('Xoá bản xuất này?')) { const np = await api.deleteExport(p.id, file); state.project.exports = np.exports; document.getElementById('modal').hidden = true; renderPanel(); } } }, '🗑 Xoá'))));
}

// ---------------------------------------------------------------- quick
function quick() {
  const p = state.project;
  const tpl = h('select', {}, state.config.templates.map((t) => h('option', { value: t.id }, t.name)));
  const desc = h('div', { class: 'small muted', style: { marginTop: '6px' } });
  const setDesc = () => (desc.textContent = state.config.templates.find((t) => t.id === tpl.value)?.desc || '');
  tpl.onchange = setDesc;
  setDesc();
  const headline = h('input', { placeholder: 'Tiêu đề chính (để trống = mặc định)' });
  const mat = h('select', {}, Object.entries(MATERIALS).map(([k, m]) => h('option', { value: k }, m.label)));
  const feats = [0, 1, 2].map((i) => {
    const icon = h('select', {}, ICON_NAMES.map((n) => h('option', { value: n, selected: n === ['drop', 'sun', 'shield'][i] }, n)));
    const label = h('input', { value: ['Thẩm thấu', 'Sáng da', 'Dịu nhẹ'][i] });
    return { icon, label, row: h('div', { class: 'row', style: { marginBottom: '6px' } }, h('div', { style: { flex: '0 0 96px' } }, icon), label) };
  });
  const cta = h('input', { value: 'Mua ngay' });
  return h('div', {},
    h('h3', {}, 'Dựng nhanh từ mẫu'),
    h('p', { class: 'small muted' }, 'Không cần AI. Tự gán chất liệu theo tên (hero/bottle = sản phẩm, splash/orange = thành phần, còn lại làm nền). Sau đó có thể nhờ đạo diễn tinh chỉnh.'),
    h('label', {}, 'Công thức'), tpl, desc,
    h('label', {}, 'Tiêu đề'), headline,
    h('label', {}, 'Chất liệu chất lỏng'), mat,
    h('label', {}, '3 lợi ích (icon + nhãn)'), feats.map((f) => f.row),
    h('label', {}, 'Nút CTA'), cta,
    h('button', {
      class: 'primary block', style: { marginTop: '14px' },
      onclick: async () => {
        if (p.shots.length && !confirm('Thay toàn bộ shot hiện tại bằng mẫu? (có lưu lịch sử để khôi phục)')) return;
        await saveNow();
        const np = await api.template(p.id, {
          template: tpl.value, headline: headline.value || undefined, material: mat.value, cta: cta.value,
          features: feats.map((f) => ({ icon: f.icon.value, label: f.label.value })),
        });
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
  return h('div', {},
    h('h3', {}, 'Thêm cảnh mẫu'),
    h('p', { class: 'small muted' }, 'Chèn sau shot đang chọn. Mỗi cảnh là code thật — sửa được ở cột phải.'),
    h('label', {}, 'Chất liệu chất lỏng'), mat, h('div', { style: { height: '12px' } }),
    SCENE_LIST.map(([id, name, desc]) => h('div', {
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
    }, h('strong', {}, name), h('div', { class: 'muted' }, desc))),
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
  return h('div', {},
    h('h3', {}, 'Phong cách'),
    h('label', {}, 'Chỉnh màu (grade)'),
    h('select', { onchange: (e) => update((pp) => { pp.style.grade = e.target.value; }, { structural: false }) },
      Object.entries(GRADES).map(([k, g]) => h('option', { value: k, selected: st.grade === k }, g.label))),
    slider('Vignette', st.vignette ?? 0.35, { onInput: (v) => update((pp) => { pp.style.vignette = v; }, { structural: false }) }),
    slider('Bloom / hào quang', st.bloom ?? 0.25, { onInput: (v) => update((pp) => { pp.style.bloom = v; }, { structural: false }) }),
    slider('Hạt phim', st.grain ?? 0.05, { max: 0.25, onInput: (v) => update((pp) => { pp.style.grain = v; }, { structural: false }) }),
    slider('Letterbox điện ảnh', st.letterbox ?? 0, { max: 0.15, onInput: (v) => update((pp) => { pp.style.letterbox = v; }, { structural: false }) }),
    h('label', {}, 'Bảng màu thương hiệu'),
    h('div', { class: 'swatches' }, color('primary', 'Chính'), color('accent', 'Nhấn'), color('text', 'Chữ')),
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

on('tab', (t) => {
  state.tab = t;
  state.view = 'editor';
  renderPanel();
});
