// Right panel: properties of the selected shot, per-shot AI director, code.
import { h, toast } from './ui.js';
import { state, on, emit, update, selected, shotStarts, trackJob, setProject } from './state.js';
import { api, fileUrl } from './api.js';
import { engine } from './player.js';
import { TRANSITIONS, lintShotCode } from '/engine/engine.js';

const root = document.getElementById('inspector');

export function renderInspector() {
  const p = state.project;
  const sh = selected();
  if (!p) return root.replaceChildren();
  if (!sh) {
    root.replaceChildren(
      h('div', { class: 'insp-title' }, 'CHƯA CÓ SHOT'),
      h('p', { class: 'muted' }, 'Dùng tab "Đạo diễn AI", "Nhanh" hoặc "Mẫu cảnh" để tạo shot đầu tiên.'),
      assetsGrid(p),
    );
    return;
  }
  const idx = p.shots.indexOf(sh);
  const it = shotStarts()[idx];
  const name = h('input', { value: sh.name });
  const dur = h('input', { type: 'number', step: 0.1, min: 0.5, value: sh.duration });
  const trans = h('select', {}, Object.entries(TRANSITIONS).map(([k, v]) => h('option', { value: k, selected: (sh.transition?.type || 'cut') === k }, v)));
  const tdur = h('input', { type: 'number', step: 0.1, min: 0.1, max: 2, value: sh.transition?.duration ?? 0.5, title: 'Độ dài chuyển cảnh (giây)' });
  const apply = () => update(() => {
    sh.name = name.value.trim() || sh.name;
    sh.duration = Math.max(0.5, Number(dur.value) || sh.duration);
    sh.transition = { type: trans.value, duration: Math.max(0.1, Number(tdur.value) || 0.5) };
  });

  const ask = h('textarea', { placeholder: 'VD: shot này kịch tính hơn, camera đẩy chậm hơn, sản phẩm to hơn' });
  const askBtn = h('button', {
    disabled: !state.config.director,
    title: state.config.director ? '' : 'Server chưa cấu hình ANTHROPIC_API_KEY',
    onclick: async () => {
      try {
        askBtn.disabled = true;
        const job = await api.director(p.id, { brief: ask.value, shotId: sh.id });
        toast('Đạo diễn đang sửa shot…');
        trackJob(job, (j) => {
          askBtn.disabled = false;
          if (j.status === 'done') {
            setProject(j.result.project);
            toast('Đã cập nhật shot: ' + (j.result.project.lastDirector?.summary || ''), { ms: 6000 });
          } else toast('Lỗi: ' + j.error, { error: true, ms: 8000 });
        });
      } catch (e) {
        askBtn.disabled = false;
        toast(e.message, { error: true });
      }
    },
  }, '🎬 Nhờ đạo diễn');

  const code = h('textarea', { class: 'code', spellcheck: false, value: sh.code });
  const errBox = h('div');
  const showErr = () => {
    const syn = lintShotCode(code.value);
    const rt = engine.errors.get(sh.id);
    const msg = syn ? 'Lỗi cú pháp: ' + syn : rt;
    errBox.replaceChildren(msg ? h('div', { class: 'err' }, msg) : '');
  };
  let codeTimer;
  code.addEventListener('input', () => {
    clearTimeout(codeTimer);
    codeTimer = setTimeout(() => {
      if (lintShotCode(code.value)) return showErr();
      update(() => {
        // editing the code clears the director's needsReview flag (server does the same on save)
        if (sh.code !== code.value && sh.needsReview) { delete sh.needsReview; reviewBox.remove(); }
        sh.code = code.value;
      }, { structural: false });
      setTimeout(showErr, 80);
    }, 450);
  });
  code.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const s = code.selectionStart;
      code.setRangeText('  ', s, code.selectionEnd, 'end');
    }
    e.stopPropagation();
  });
  setTimeout(showErr, 120);
  const reviewBox = sh.needsReview
    ? h('div', { class: 'err review-note', title: sh.needsReview.at || '' }, '⚠ Cần xem lại: ', sh.needsReview.reason, ' Sửa code để bỏ cờ.')
    : h('div');

  root.replaceChildren(...[
    h('div', { class: 'insp-title' }, `SHOT ${idx + 1} · ${it.start.toFixed(1)}–${it.end.toFixed(1)}s`),
    h('label', {}, 'Tên'), name,
    h('div', { class: 'row' },
      h('div', {}, h('label', {}, 'Số giây'), dur),
      h('div', {}, h('label', {}, 'Chuyển cảnh vào'), trans)),
    h('div', { class: 'row', style: { marginTop: '8px' } },
      h('button', { class: 'primary shrink', onclick: apply }, 'Áp dụng'),
      h('div', { class: 'row' }, h('span', { class: 'small muted shrink' }, 'dài'), tdur)),
    reviewBox,
    sh.notes ? h('div', { class: 'notes' }, '🎬 ', sh.notes) : null,
    h('label', {}, 'Nội dung chuyển động trong shot là code — nhờ đạo diễn:'),
    ask,
    h('div', { class: 'row', style: { marginTop: '8px' } }, h('div', { class: 'shrink' }, askBtn)),
    h('div', { class: 'section-title' }, 'Code chuyển động'),
    code, errBox,
    h('div', { class: 'small muted', style: { marginTop: '6px' } }, 'Sửa trực tiếp — xem trước cập nhật ngay. Tài liệu API: docs/SHOT_API.md'),
    h('div', { class: 'row', style: { marginTop: '10px' } },
      h('button', { onclick: () => moveShot(idx, -1), disabled: idx === 0 }, '↑ Lên'),
      h('button', { onclick: () => moveShot(idx, 1), disabled: idx === p.shots.length - 1 }, '↓ Xuống'),
      h('button', { onclick: () => dupShot(idx) }, '⧉ Nhân bản'),
      h('button', { onclick: () => delShot(idx) }, '🗑')),
    assetsGrid(p),
  ].filter(Boolean));
}

function moveShot(i, d) {
  update((p) => {
    const [s] = p.shots.splice(i, 1);
    p.shots.splice(i + d, 0, s);
  });
}
function dupShot(i) {
  update((p) => {
    const c = structuredClone(p.shots[i]);
    c.id = 's' + Math.random().toString(16).slice(2, 12);
    c.name += ' (2)';
    p.shots.splice(i + 1, 0, c);
  });
}
function delShot(i) {
  if (!confirm('Xoá shot này?')) return;
  update((p) => {
    p.shots.splice(i, 1);
    state.selectedShot = p.shots[Math.min(i, p.shots.length - 1)]?.id || null;
  });
}

function assetsGrid(p) {
  const visual = p.assets.filter((a) => a.type !== 'audio' || a.role === 'music');
  return h('div', {},
    h('div', { class: 'section-title' }, `Chất liệu (${visual.length})`),
    h('div', { class: 'assets' }, visual.map((a) => h('div', {
      class: 'asset' + (a.type === 'audio' ? ' audio' : ''),
      title: `${a.name} — bấm để chép tên dùng trong code`,
      onclick: () => {
        navigator.clipboard?.writeText(`'${a.name}'`);
        toast(`Đã chép '${a.name}' — dùng trong code: s.image('${a.name}', {...})`);
      },
    },
    a.type === 'image' ? h('img', { src: fileUrl(p, a), loading: 'lazy' }) : a.type === 'video' ? h('video', { src: fileUrl(p, a), muted: true }) : '🎵',
    h('div', { class: 'cap' }, (a.type === 'video' ? '🎬 ' : a.type === 'audio' ? '' : '🖼 ') + a.name)))),
    h('button', { class: 'ghost', style: { marginTop: '8px', width: '100%' }, onclick: () => emit('tab', 'media') }, '+ Thêm chất liệu'),
  );
}

on('select', renderInspector);

