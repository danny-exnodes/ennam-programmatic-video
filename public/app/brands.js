// Brand Kit (issue #8): màn hình quản lý kit dùng chung (tạo / sửa / nhân bản / xoá) + bộ chọn kit
// cho tạo / nhân bản dự án và tab Phong cách. Dữ liệu kit: server/brands.js.
import { h, toast, modal } from './ui.js';
import { state } from './state.js';
import { api, brandFileUrl } from './api.js';
import { GRADES, loadBrandFonts } from '/engine/engine.js';

export const ROLE_LABEL = { primary: 'Chính', accent: 'Nhấn', text: 'Chữ', secondary: 'Phụ', background: 'Nền' };
const ROLES = Object.keys(ROLE_LABEL);
const BUILTIN = { sans: 'Be Vietnam Pro (có sẵn)', serif: 'Playfair Display (có sẵn)' };
const CSS_BUILTIN = { sans: '"Be Vietnam Pro", sans-serif', serif: '"Playfair Display", serif' };

/** Ô màu nhỏ của kit (theo thứ tự trong bảng màu). */
export function kitSwatches(kit, size = 18) {
  return h('span', { class: 'kit-sw' }, (kit?.palette || []).map((c) => h('i', {
    title: `${ROLE_LABEL[c.role] || c.role} ${c.color}`,
    style: { background: c.color, width: size + 'px', height: size + 'px' },
  })));
}

/** Font CSS cho xem trước trong màn hình kit (font upload nạp qua FontFace từ file của kit). */
function fontCss(kit, v) {
  if (BUILTIN[v] || !v) return CSS_BUILTIN[v || 'sans'];
  const f = (kit.fontFiles || []).find((x) => x.id === v);
  return f ? `"${f.family}", ${CSS_BUILTIN.sans}` : CSS_BUILTIN.sans;
}

/**
 * Bộ chọn kit cho tạo / nhân bản dự án: { el, value() → { id, locked } | null }.
 * `current` = project.brand (để chọn sẵn kit + trạng thái khoá).
 */
export function kitPicker(kits, current = null) {
  const sel = h('select', {},
    h('option', { value: '' }, '— Không dùng Brand Kit —'),
    kits.map((k) => h('option', { value: k.id, selected: current?.id === k.id }, `${k.name} · v${k.version}`)));
  const lock = h('input', { type: 'checkbox', checked: !!current?.locked, style: { width: 'auto' } });
  const sw = h('span');
  const sync = () => sw.replaceChildren(kitSwatches(kits.find((k) => k.id === sel.value)));
  sel.onchange = sync;
  sync();
  return {
    el: h('div', { class: 'kit-picker' },
      h('label', {}, 'Brand Kit'), h('div', { class: 'row' }, sel, h('span', { class: 'shrink' }, sw)),
      h('label', { class: 'check', title: 'Khoá: giữ nguyên phiên bản kit hiện tại. Không khoá: mở dự án là dùng kit mới nhất.' }, lock, ' Khoá phiên bản kit (không tự cập nhật khi kit đổi)')),
    value: () => (sel.value ? { id: sel.value, locked: lock.checked } : null),
  };
}

// ---------------------------------------------------------------- màn hình quản lý
export async function showBrandKits({ onChange } = {}) {
  const body = h('div', { class: 'kits' });
  const close = modal('Brand Kit', body);
  const changed = () => onChange && onChange();
  async function fill() {
    const kits = await api.brands();
    body.replaceChildren(
      h('p', { class: 'small muted' }, 'Kit dùng chung giữa các dự án: logo, 3–5 màu, font, grade mặc định, giọng đọc, nhạc nhận diện, câu chữ bắt buộc/cấm, outro. Chọn kit khi tạo / nhân bản dự án hoặc ở tab Phong cách. Mỗi lần sửa kit tăng phiên bản; dự án không khoá kit tự dùng phiên bản mới nhất khi mở lại.'),
      h('div', { class: 'row', style: { margin: '10px 0 14px' } },
        h('button', {
          class: 'primary shrink', id: 'btnNewKit',
          onclick: async () => { const k = await api.createBrand({ name: 'Kit mới' }); changed(); editKit(k); },
        }, '+ Tạo kit')),
      kits.length ? h('div', { class: 'kit-grid' }, kits.map((k) => h('div', { class: 'kit-card', 'data-kit': k.id },
        h('div', { class: 'kit-logo' }, k.logo ? h('img', { src: brandFileUrl(k.id, k.logo.file), alt: 'logo' }) : h('span', { class: 'muted' }, 'Chưa có logo')),
        h('div', { class: 'kit-info' },
          h('strong', {}, k.name), h('span', { class: 'small muted' }, ` · phiên bản ${k.version}`),
          h('div', { style: { margin: '6px 0' } }, kitSwatches(k)),
          h('div', { class: 'small muted' }, `${(k.fontFiles || []).length} font tải lên · ${k.requiredPhrases.length} câu bắt buộc · ${k.bannedPhrases.length} câu cấm${k.music ? ' · 🎵' : ''}`),
          k.warnings?.length ? h('div', { class: 'small warn' }, '⚠ ' + k.warnings.map((w) => w.msg).join(' · ')) : null),
        h('div', { class: 'kit-actions' },
          h('button', { onclick: () => editKit(k) }, 'Sửa'),
          h('button', { onclick: async () => { await api.duplicateBrand(k.id); changed(); fill(); toast('Đã nhân bản kit'); } }, 'Nhân bản'),
          h('button', {
            class: 'ghost',
            onclick: async () => {
              if (!confirm(`Xoá kit "${k.name}"? Dự án đang dùng kit vẫn giữ bản chụp phiên bản cuối.`)) return;
              await api.deleteBrand(k.id); changed(); fill();
            },
          }, '🗑')))))
        : h('p', { class: 'muted' }, 'Chưa có kit nào.'),
    );
  }

  function editKit(kit) {
    let d = structuredClone(kit);
    const form = h('div', { class: 'kit-edit' });
    const editable = () => ({
      name: d.name, palette: d.palette, fonts: d.fonts, grade: d.grade, voiceId: d.voiceId,
      requiredPhrases: d.requiredPhrases, bannedPhrases: d.bannedPhrases, outro: d.outro?.text || '',
    });
    // upload / xoá file: server tăng version → lấy kit mới, giữ các trường đang sửa chưa lưu
    const afterFile = (k, { takeFonts = false } = {}) => {
      const keep = editable();
      d = { ...k, ...keep, outro: keep.outro ? { text: keep.outro } : null, fonts: takeFonts ? k.fonts : keep.fonts };
      changed();
      draw();
    };
    const fileInput = (accept, onFile) => {
      const inp = h('input', { type: 'file', accept, style: { display: 'none' }, onchange: (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) onFile(f); } });
      return inp;
    };
    function draw() {
      loadBrandFonts(d, (f) => brandFileUrl(d.id, f.file)).then((added) => added && draw());
      const fontOpts = (v) => [...Object.entries(BUILTIN).map(([id, n]) => h('option', { value: id, selected: v === id }, n)),
        ...(d.fontFiles || []).map((f) => h('option', { value: f.id, selected: v === f.id }, `${f.name} (tải lên)`))];
      const logoIn = fileInput('image/*', async (f) => { try { afterFile(await api.uploadBrand(d.id, 'logo', f)); } catch (e) { toast(e.message, { error: true }); } });
      const musicIn = fileInput('audio/*', async (f) => { try { afterFile(await api.uploadBrand(d.id, 'music', f)); } catch (e) { toast(e.message, { error: true }); } });
      const fName = h('input', { placeholder: 'Tên font (VD: Montserrat Bold)' });
      const fLicense = h('input', { placeholder: 'Nguồn / giấy phép (bắt buộc), VD: Google Fonts — SIL OFL 1.1', id: 'fontLicense' });
      const fRole = h('select', {}, h('option', { value: '' }, 'Chưa gán vai trò'), h('option', { value: 'heading' }, 'Dùng cho tiêu đề'), h('option', { value: 'body' }, 'Dùng cho nội dung'));
      const fontIn = fileInput('.ttf,.otf,.woff,.woff2', async (f) => {
        if (!fLicense.value.trim() && !confirm('Chưa ghi nguồn/giấy phép font. Font khách cung cấp có rủi ro bản quyền — vẫn tải lên và ghi sau?')) return;
        try {
          const k = await api.uploadBrand(d.id, 'fonts', f, { name: fName.value, license: fLicense.value, role: fRole.value });
          afterFile(k, { takeFonts: true });
          if (k.warnings?.length) toast('⚠ ' + k.warnings[0].msg, { error: true, ms: 6000 });
        } catch (e) { toast(e.message, { error: true }); }
      });
      const palRows = d.palette.map((c, i) => {
        const hex = h('input', { value: c.color, spellcheck: false, onchange: (e) => { c.color = e.target.value.trim(); draw(); } });
        return h('div', { class: 'row', style: { marginBottom: '6px' } },
          h('select', { style: { flex: '0 0 130px' }, onchange: (e) => { c.role = e.target.value; } }, ROLES.map((r) => h('option', { value: r, selected: c.role === r }, `${ROLE_LABEL[r]} (${r})`))),
          h('input', { type: 'color', class: 'shrink', value: c.color, style: { width: '52px', height: '36px', padding: '2px' }, oninput: (e) => { c.color = e.target.value; hex.value = c.color; } }),
          hex,
          h('button', { class: 'shrink ghost', title: 'Bỏ màu', disabled: d.palette.length <= 3, onclick: () => { d.palette.splice(i, 1); draw(); } }, '✕'));
      });
      const phrasesArea = (key, ph) => h('textarea', { rows: 4, placeholder: ph, value: (d[key] || []).join('\n'), oninput: (e) => { d[key] = e.target.value.split('\n'); } });
      form.replaceChildren(
        h('div', { class: 'row', style: { marginBottom: '6px' } },
          h('button', { class: 'shrink ghost', onclick: fill }, '← Danh sách kit'),
          h('span', { class: 'small muted' }, `phiên bản ${d.version}`)),
        h('div', { class: 'kit-cols' },
          h('div', {},
            h('label', {}, 'Tên kit'), h('input', { value: d.name, id: 'kitName', oninput: (e) => { d.name = e.target.value; } }),
            h('label', {}, 'Logo (PNG nền trong suốt)'),
            h('div', { class: 'row' },
              h('div', { class: 'kit-logo shrink' }, d.logo ? h('img', { src: brandFileUrl(d.id, d.logo.file), alt: 'logo' }) : h('span', { class: 'muted small' }, 'Chưa có')),
              h('button', { onclick: () => logoIn.click() }, d.logo ? 'Thay logo' : '⬆ Tải logo'), logoIn,
              d.logo ? h('button', { class: 'ghost shrink', onclick: async () => afterFile(await api.deleteBrandPart(d.id, 'logo')) }, 'Bỏ') : null),
            h('label', {}, 'Bảng màu (3–5 màu, bắt buộc có Chính / Nhấn / Chữ)'),
            palRows,
            d.palette.length < 5 ? h('button', {
              class: 'ghost', onclick: () => { const free = ROLES.find((r) => !d.palette.some((c) => c.role === r)) || 'secondary'; d.palette.push({ role: free, color: '#888888' }); draw(); },
            }, '+ Thêm màu') : null,
            h('label', {}, 'Grade mặc định (áp khi gán kit cho dự án)'),
            h('select', { onchange: (e) => { d.grade = e.target.value; } }, h('option', { value: '' }, '— Không đổi —'),
              Object.entries(GRADES).map(([k, g]) => h('option', { value: k, selected: d.grade === k }, g.label))),
            h('label', {}, 'Giọng đọc TTS (voice id)'),
            h('input', { value: d.voiceId || '', list: 'kitVoices', placeholder: 'Để trống = giọng mặc định của server', oninput: (e) => { d.voiceId = e.target.value; } }),
            h('datalist', { id: 'kitVoices' }, (state.config.voices || []).map((v) => h('option', { value: v.id }, v.name))),
            h('label', {}, 'Nhạc nhận diện (thêm vào dự án chưa có nhạc khi gán kit)'),
            h('div', { class: 'row' },
              h('span', { class: 'small muted' }, d.music ? `🎵 ${d.music.original || d.music.file}` : 'Chưa có'),
              h('button', { class: 'shrink', onclick: () => musicIn.click() }, d.music ? 'Thay' : '⬆ Tải nhạc'), musicIn,
              d.music ? h('button', { class: 'ghost shrink', onclick: async () => afterFile(await api.deleteBrandPart(d.id, 'music')) }, 'Bỏ') : null)),
          h('div', {},
            h('label', {}, 'Font tiêu đề'),
            h('select', { id: 'kitHeading', onchange: (e) => { d.fonts = { ...d.fonts, heading: e.target.value }; draw(); } }, fontOpts(d.fonts?.heading)),
            h('div', { class: 'font-sample', style: { fontFamily: fontCss(d, d.fonts?.heading), fontWeight: 700 } }, 'Sáng mịn, tươi tắn — Aa 2026'),
            h('label', {}, 'Font nội dung'),
            h('select', { id: 'kitBody', onchange: (e) => { d.fonts = { ...d.fonts, body: e.target.value }; draw(); } }, fontOpts(d.fonts?.body)),
            h('div', { class: 'font-sample', style: { fontFamily: fontCss(d, d.fonts?.body) } }, 'Thông điệp chính của thương hiệu — Aa 0123'),
            h('label', {}, 'Font đã tải lên'),
            (d.fontFiles || []).length ? h('div', { class: 'list' }, d.fontFiles.map((f) => h('div', { class: 'item' + (f.license ? '' : ' warn-item') },
              h('div', { class: 'grow' }, h('div', { style: { fontFamily: fontCss(d, f.id) } }, f.name),
                h('input', {
                  value: f.license || '', placeholder: '⚠ Nguồn / giấy phép (bắt buộc)', class: 'license',
                  onchange: async (e) => afterFile(await api.patchBrandFont(d.id, f.id, { license: e.target.value })),
                })),
              h('button', { class: 'ghost', title: 'Xoá font', onclick: async () => afterFile(await api.deleteBrandPart(d.id, `fonts/${f.id}`), { takeFonts: true }) }, '🗑'))))
              : h('p', { class: 'small muted' }, 'Chưa có. Font có sẵn: Be Vietnam Pro, Playfair Display.'),
            h('div', { class: 'upload-font' }, fName, fLicense, h('div', { class: 'row' }, fRole, h('button', { class: 'shrink', onclick: () => fontIn.click() }, '⬆ Tải font (.ttf .otf .woff2)')), fontIn),
            h('label', {}, 'Câu chữ bắt buộc (mỗi dòng một câu)'), phrasesArea('requiredPhrases', 'VD: Lumi C+ — Sáng từ bên trong'),
            h('label', {}, 'Câu chữ cấm (mỗi dòng một câu)'), phrasesArea('bannedPhrases', 'VD: rẻ nhất\ncam kết 100%'),
            h('label', {}, 'Outro (tuỳ chọn — câu kết thương hiệu)'),
            h('input', { value: d.outro?.text || '', placeholder: 'VD: Lumi C+ · lumi.vn', oninput: (e) => { d.outro = e.target.value ? { text: e.target.value } : null; } }))),
        h('div', { class: 'row', style: { marginTop: '14px' } },
          h('button', {
            class: 'primary shrink', id: 'btnSaveKit',
            onclick: async () => {
              try {
                const k = await api.updateBrand(d.id, editable());
                d = structuredClone(k);
                changed();
                toast(`Đã lưu kit "${k.name}" · phiên bản ${k.version}`);
                draw();
              } catch (e) { toast(e.message, { error: true }); }
            },
          }, 'Lưu kit'),
          h('span', { class: 'small muted' }, 'Upload logo / font / nhạc được lưu ngay; các trường khác lưu khi bấm "Lưu kit".')),
      );
    }
    draw();
    body.replaceChildren(form);
  }

  await fill();
  return { close, editKit };
}
