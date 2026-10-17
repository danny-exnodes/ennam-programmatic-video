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

  const fieldsBox = h('div');
  renderFields(fieldsBox, p, sh);

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
      update(() => { sh.code = code.value; }, { structural: false });
      renderFields(fieldsBox, p, sh); // declarations come from code
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

  root.replaceChildren(...[
    h('div', { class: 'insp-title' }, `SHOT ${idx + 1} · ${it.start.toFixed(1)}–${it.end.toFixed(1)}s`),
    h('label', {}, 'Tên'), name,
    h('div', { class: 'row' },
      h('div', {}, h('label', {}, 'Số giây'), dur),
      h('div', {}, h('label', {}, 'Chuyển cảnh vào'), trans)),
    h('div', { class: 'row', style: { marginTop: '8px' } },
      h('button', { class: 'primary shrink', onclick: apply }, 'Áp dụng'),
      h('div', { class: 'row' }, h('span', { class: 'small muted shrink' }, 'dài'), tdur)),
    sh.notes ? h('div', { class: 'notes' }, '🎬 ', sh.notes) : null,
    fieldsBox,
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

// ---------------- "Nội dung": form generated from s.field() declarations ----------------
const HEX6 = /^#[0-9a-f]{6}$/i;
const HEX3 = /^#[0-9a-f]{3}$/i;
const toHex6 = (v) => (HEX6.test(v) ? v : HEX3.test(v) ? '#' + [...v.slice(1)].map((c) => c + c).join('') : null);

/**
 * Editable values of a shot (engine.fieldsOf). Editing writes shot.fields[key] in client
 * state and redraws the preview locally (no server call); the normal debounced autosave
 * persists it. "Về mặc định" deletes the key so the code default applies again.
 */
function renderFields(box, p, sh) {
  const decls = engine.fieldsOf(sh.id);
  if (!decls.length) return box.replaceChildren();
  const set = (key, v) => update(() => {
    sh.fields = sh.fields || {};
    if (v === undefined) delete sh.fields[key];
    else sh.fields[key] = v;
  }, { structural: false });
  const media = p.assets.filter((a) => a.type === 'image' || a.type === 'video');

  const rows = decls.map((d) => {
    const has = () => Object.prototype.hasOwnProperty.call(sh.fields || {}, d.key);
    const cur = has() ? sh.fields[d.key] : d.default;
    const reset = h('button', {
      class: 'ghost shrink small', title: 'Bỏ giá trị đã sửa, dùng lại giá trị trong code', disabled: !has(),
      style: { padding: '2px 8px' },
      onclick: () => { set(d.key, undefined); renderFields(box, p, sh); },
    }, 'Về mặc định');
    const changed = (v) => { set(d.key, v); reset.disabled = false; };
    let ctl;
    if (d.type === 'color') {
      const hex = h('input', { value: String(cur ?? ''), placeholder: String(d.default ?? ''), spellcheck: false });
      const pick = h('input', { type: 'color', class: 'shrink', value: toHex6(String(cur)) || '#000000', style: { width: '44px', padding: '2px', height: '36px' } });
      pick.addEventListener('input', () => { hex.value = pick.value; changed(pick.value); });
      hex.addEventListener('input', () => {
        const v = hex.value.trim();
        if (!v) return;
        if (toHex6(v)) pick.value = toHex6(v);
        changed(v);
      });
      ctl = h('div', { class: 'row' }, pick, hex);
    } else if (d.type === 'number') {
      ctl = h('input', { type: 'number', step: 'any', value: cur ?? '', placeholder: String(d.default ?? '') });
      ctl.addEventListener('input', () => {
        const n = ctl.value === '' ? NaN : Number(ctl.value);
        if (Number.isFinite(n)) changed(n);
      });
    } else if (d.type === 'image') {
      const names = media.map((a) => a.name);
      const opts = media.map((a) => h('option', { value: a.name, selected: a.name === cur }, (a.type === 'video' ? '🎬 ' : '🖼 ') + a.name));
      if (cur && !names.includes(String(cur))) opts.unshift(h('option', { value: String(cur), selected: true }, `${cur} (không có trong Chất liệu)`));
      if (!cur) opts.unshift(h('option', { value: '', selected: true }, '— chọn chất liệu —'));
      ctl = h('select', {}, opts);
      ctl.addEventListener('change', () => ctl.value && changed(ctl.value));
    } else {
      const long = !(d.maxLength > 0 && d.maxLength <= 80) || String(cur ?? '').includes('\n');
      ctl = h(long ? 'textarea' : 'input', {
        value: String(cur ?? ''), placeholder: String(d.default ?? ''), spellcheck: false,
        maxLength: d.maxLength > 0 ? d.maxLength : null,
        style: long ? { minHeight: '56px' } : null,
      });
      ctl.addEventListener('input', () => changed(ctl.value));
      ctl.addEventListener('keydown', (e) => e.stopPropagation());
    }
    ctl.dataset.field = d.key;
    return h('div', { class: 'field' },
      h('div', { class: 'row', style: { margin: '12px 0 6px' } },
        h('label', { style: { margin: 0 }, title: d.key }, d.label || d.key,
          d.type === 'text' && d.maxLength > 0 ? h('span', { class: 'small' }, `  · tối đa ${d.maxLength} ký tự`) : null),
        reset),
      ctl);
  });
  box.replaceChildren(
    h('div', { class: 'section-title' }, 'Nội dung'),
    h('div', { class: 'small muted' }, 'Sửa chữ, màu, ảnh của shot — xem trước cập nhật ngay, không tốn lượt AI.'),
    ...rows,
  );
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

