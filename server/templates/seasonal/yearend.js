// Seasonal bundle "Year End Party / Gala" (issue #24a).
//
// Scenes are real shot code (same API as the AI director, docs/SHOT_API.md) built
// without any Claude call. Every visible text, date, venue, company name and the
// accent colour is an s.field (Vietnamese label) drawn with maxWidth/maxLines, and
// every position is relative to W/H, so the same code works at 16:9 and 9:16.
//
// These scenes are NOT used as few-shot examples in the director system prompt
// (keeps the cached prompt byte-identical, see server/director.js).

const J = (v) => JSON.stringify(v);
export const SEASON = { id: 'yearend', name: 'Year End / Gala', desc: 'Tiệc tất niên, gala cuối năm, đêm chào năm mới' };

// Default copy (correct Vietnamese diacritics). Keys are shared across scenes so the
// "Nhanh" form can prefill them on every shot of a recipe (shot.fields[key]).
export const DEFAULTS = {
  company: 'Công ty Cổ phần Ánh Dương',
  title: 'Gala Year End',
  subtitle: 'Tiệc Tất niên 2026',
  theme: 'Vững bước – Bứt phá',
  date: 'Thứ Bảy, 27.12.2026 · 18:30',
  venue: 'Trung tâm Hội nghị White Palace, TP.HCM',
  accent: '#d9b45f',
};
/** Fields the "Nhanh" form offers for this season (key, label, maxLength | 'color'). */
export const FORM_FIELDS = [
  { key: 'company', label: 'Tên công ty / khách hàng', maxLength: 48 },
  { key: 'title', label: 'Tên sự kiện', maxLength: 36 },
  { key: 'subtitle', label: 'Dòng phụ', maxLength: 40 },
  { key: 'theme', label: 'Chủ đề / slogan', maxLength: 48 },
  { key: 'date', label: 'Ngày giờ', maxLength: 44 },
  { key: 'venue', label: 'Địa điểm', maxLength: 72 },
  { key: 'accent', label: 'Màu nhấn', type: 'color', brandColor: 'accent' },
];
const MAXLEN = Object.fromEntries(FORM_FIELDS.map((f) => [f.key, f.maxLength]));

/** `const name = s.field(key, def, { label, maxLength })` */
const tf = (name, key, def, label, maxLength = MAXLEN[key] || 48) =>
  `const ${name} = s.field(${J(key)}, ${J(def)}, { label: ${J(label)}, maxLength: ${maxLength} });`;
const F = {
  company: (o) => tf('company', 'company', o.company ?? DEFAULTS.company, 'Tên công ty / khách hàng'),
  title: (o) => tf('title', 'title', o.title ?? DEFAULTS.title, 'Tên sự kiện'),
  subtitle: (o) => tf('subtitle', 'subtitle', o.subtitle ?? DEFAULTS.subtitle, 'Dòng phụ'),
  theme: (o) => tf('theme', 'theme', o.theme ?? DEFAULTS.theme, 'Chủ đề / slogan'),
  date: (o) => tf('date', 'date', o.date ?? DEFAULTS.date, 'Ngày giờ'),
  venue: (o) => tf('venue', 'venue', o.venue ?? DEFAULTS.venue, 'Địa điểm'),
  // Brand Kit (#8): logo mặc định = logo của kit (nếu có); màu nhấn mặc định = màu "accent" của kit
  logo: () => `const logo = s.field('logo', s.brand.logo || '', { type: 'image', label: 'Logo (tuỳ chọn, tên chất liệu)' });`,
  accent: (o) => `const accent = s.field('accent', ${J(o.accent ?? DEFAULTS.accent)}, { type: 'color', label: 'Màu nhấn (vàng kim)', brandColor: 'accent' });`,
};

const HEAD = `const { t, d, W, H } = s;
const U = Math.min(W, H), portrait = H > W * 1.15;`;

// Shared drawing kit (declared after the fields; depends on `accent`).
const KIT = `// --- bộ công cụ gala: vàng kim, chữ nhũ, đèn sân khấu ---
const tone = (k) => { const c = s.mix(accent, k > 0 ? '#ffffff' : '#000000', Math.abs(k)); return '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join(''); };
const GOLDS = [tone(0.62), tone(0.3), accent, tone(-0.22), tone(-0.42), '#fff7e2'];
const CLEAR = 'rgba(0,0,0,0)';
// Layout only (transparent): real size/lines after auto-shrink, before drawing.
const measure = (str, o) => s.text(str, Object.assign({ y: H * 0.5 }, o, { anim: 'none', out: undefined, color: CLEAR, accent: CLEAR, shadow: false }));
// Gold-leaf text: vertical metallic gradient per glyph line (follows the word animation).
const gold = (str, o) => {
  const z = measure(str, o).size;
  const g = s.ctx.createLinearGradient(0, -0.74 * z, 0, 0.42 * z);
  g.addColorStop(0, tone(0.78)); g.addColorStop(0.36, tone(0.32)); g.addColorStop(0.5, tone(-0.18));
  g.addColorStop(0.64, accent); g.addColorStop(0.86, tone(0.5)); g.addColorStop(1, tone(0.2));
  return s.text(str, Object.assign({ shadow: z * 0.22 }, o, { color: g, accent: g }));
};
const caps = (str, o) => s.text(String(str).toUpperCase(), Object.assign({ font: 'sans', weight: 600, letterSpacing: 0.3, shadow: false, color: tone(0.5), align: 'center', maxLines: 1 }, o));
const backdrop = (gy) => s.background({ radial: [tone(-0.66), '#0b0805', '#020101'], x: W / 2, y: gy, r: Math.hypot(W, H) * 0.62 });
// Divider: hairline fading to both ends with a diamond.
const rule = (cx, y, w, k) => { if (k <= 0) return; s.world((c) => {
  const hw = (w / 2) * s.ease.outExpo(k), dm = U * 0.008 * Math.min(1, k * 2), th = Math.max(1, U * 0.0018);
  const g = c.createLinearGradient(cx - hw, 0, cx + hw, 0);
  g.addColorStop(0, s.rgba(accent, 0)); g.addColorStop(0.5, s.rgba(tone(0.35), 0.95)); g.addColorStop(1, s.rgba(accent, 0));
  c.fillStyle = g; c.fillRect(cx - hw, y - th / 2, hw - dm * 2.2, th); c.fillRect(cx + dm * 2.2, y - th / 2, hw - dm * 2.2, th);
  c.fillStyle = tone(0.45); c.beginPath(); c.moveTo(cx, y - dm); c.lineTo(cx + dm, y); c.lineTo(cx, y + dm); c.lineTo(cx - dm, y); c.closePath(); c.fill();
}, 0); };
// Moving-head stage beams through haze: { x, y, a (rad), amp, f, ph, w, o, c }.
const beams = (list, k) => { if (k <= 0.001) return; s.world((c) => {
  c.save(); c.globalCompositeOperation = 'lighter';
  const L = Math.hypot(W, H) * 1.15;
  list.forEach((b, i) => {
    const a = b.a + Math.sin(t * b.f + b.ph) * b.amp, ca = Math.cos(a), sa = Math.sin(a), px = -sa, py = ca;
    const fl = k * (0.86 + 0.14 * s.noise(t * 1.1, i * 3.1, 7));
    for (let j = 0; j < 3; j++) {
      const w0 = U * 0.006 * (j + 1), w1 = U * b.w * (0.8 + j * 1.5), al = fl * b.o * [0.42, 0.18, 0.08][j];
      const g = c.createLinearGradient(b.x, b.y, b.x + ca * L, b.y + sa * L);
      g.addColorStop(0, s.rgba(b.c, al)); g.addColorStop(0.4, s.rgba(b.c, al * 0.4)); g.addColorStop(1, s.rgba(b.c, 0));
      c.fillStyle = g; c.beginPath();
      c.moveTo(b.x + px * w0, b.y + py * w0); c.lineTo(b.x + ca * L + px * w1, b.y + sa * L + py * w1);
      c.lineTo(b.x + ca * L - px * w1, b.y + sa * L - py * w1); c.lineTo(b.x - px * w0, b.y - py * w0); c.closePath(); c.fill();
    }
    const R = U * 0.07, rg = c.createRadialGradient(b.x, b.y, 0, b.x, b.y, R);
    rg.addColorStop(0, s.rgba('#ffffff', 0.85 * fl)); rg.addColorStop(0.22, s.rgba(b.c, 0.4 * fl)); rg.addColorStop(1, s.rgba(b.c, 0));
    c.fillStyle = rg; c.fillRect(b.x - R, b.y - R, R * 2, R * 2);
  });
  c.restore();
}, 0.35); };
// Glitter twinkles: 4-point stars flashing at seeded positions.
const twinkle = (n, seed, k) => { if (k <= 0) return; s.world((c) => {
  const r = s.rand(seed); c.save(); c.globalCompositeOperation = 'lighter';
  for (let i = 0; i < n; i++) {
    const x = r() * W, y = r() * H, f = r.range(1.2, 3.2), ph = r() * 6.283, sz = U * r.range(0.006, 0.014);
    const v = Math.pow(Math.max(0, Math.sin(t * f + ph)), 12) * k;
    if (v < 0.02) continue;
    const L = sz * (0.7 + v), q = L * 0.16;
    c.fillStyle = s.rgba('#fff3d2', v);
    c.beginPath(); c.moveTo(x, y - L); c.quadraticCurveTo(x + q, y - q, x + L, y); c.quadraticCurveTo(x + q, y + q, x, y + L);
    c.quadraticCurveTo(x - q, y + q, x - L, y); c.quadraticCurveTo(x - q, y - q, x, y - L); c.fill();
  }
  c.restore();
}, 0.6); };
// Soft light bloom (flash) at a point.
const glow = (x, y, r, a, col) => { if (a <= 0.003) return; s.world((c) => {
  const g = c.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, s.rgba('#fff6e0', a)); g.addColorStop(0.3, s.rgba(col, a * 0.45)); g.addColorStop(1, s.rgba(col, 0));
  c.save(); c.globalCompositeOperation = 'lighter'; c.fillStyle = g; c.fillRect(x - r, y - r, r * 2, r * 2); c.restore();
}, 0); };
// Slow gold glitter falling from above the frame (continuous emission).
const glitterRain = (o) => s.fx.burst(Object.assign({ kind: 'confetti', x: W / 2, y: -H * 0.12, count: 70, angle: Math.PI / 2, spread: Math.PI * 0.96,
  speed: [U * 0.08, U * 0.85], size: [U * 0.006, U * 0.012], gravity: U * 0.45, drag: 0.8, turbulence: U * 0.22, spin: 5,
  life: 9, colors: GOLDS }, o));`;

const fix = (s) => s.trim() + '\n';

/** Scene definitions. code(o) → shot code; o overrides default copy. */
export const SCENES = {
  'ye-curtain': {
    name: 'Mở màn: đèn sân khấu',
    desc: 'Đèn moving-head quét qua khói sân khấu, bokeh vàng, tên công ty nhũ vàng + “trân trọng giới thiệu”',
    duration: 4,
    code: (o = {}) => fix(`
${HEAD}
${F.company(o)}
${tf('eyebrow', 'eyebrow', o.eyebrow ?? 'trân trọng giới thiệu', 'Dòng giới thiệu', 40)}
${F.logo()}
${F.accent(o)}
${KIT}
const k = Math.min(1, d / 4), T = (x) => x * k; // nhịp co giãn theo độ dài shot
const cy = H * (portrait ? 0.47 : 0.5);
backdrop(H * 0.62);
s.camera({ zoom: s.lerp(1.0, 1.06, s.ease.inOutSine(s.p)), shake: 0.6 });
const on = s.smoothstep(0, T(0.9), t);
s.fx.mist({ x: W / 2, y: H * 1.02, rate: 4, life: 6, rise: H * 0.04, wind: 6, spread: W * 1.2, size: U * 0.5, color: tone(0.1), opacity: 0.045, start: -6, seed: 3, depth: 0.5 });
beams([
  { x: W * 0.1, y: H * 1.03, a: -1.25, amp: 0.32, f: 0.9, ph: 0.0, w: 0.05, o: 0.55, c: tone(0.35) },
  { x: W * 0.32, y: H * 1.03, a: -1.5, amp: 0.38, f: 0.7, ph: 2.1, w: 0.04, o: 0.45, c: '#fff1d0' },
  { x: W * 0.68, y: H * 1.03, a: -1.64, amp: 0.38, f: 0.75, ph: 4.0, w: 0.04, o: 0.45, c: '#fff1d0' },
  { x: W * 0.9, y: H * 1.03, a: -1.89, amp: 0.32, f: 0.85, ph: 1.3, w: 0.05, o: 0.55, c: tone(0.35) },
], on);
s.fx.bokeh({ count: portrait ? 16 : 22, size: [U * 0.02, U * 0.07], color: tone(0.2), opacity: 0.26 * on, drift: 14, rise: 10, seed: 21 });
twinkle(26, 5, on);
glow(W / 2, cy, U * 0.55, 0.16 * s.smoothstep(T(0.4), T(1.6), t), accent);
let y = cy - U * 0.02;
if (logo && s.has(logo)) {
  s.image(logo, { x: W / 2, y: cy - U * 0.2, h: U * 0.13, depth: 0, opacity: s.prog(T(0.5), T(1.2)) });
  y += U * 0.04;
}
const m = gold(company.toUpperCase(), {
  x: W / 2, y, size: U * (portrait ? 0.07 : 0.066), font: 'sans', weight: 700, letterSpacing: 0.14, align: 'center',
  anim: 'blur', start: T(0.7), dur: 1.0 * k, stagger: 0.02, maxWidth: W * 0.8, maxLines: 2, lineHeight: 1.2,
});
const yb = y + (m.lines - 1) * m.size * 1.2;
rule(W / 2, yb + U * 0.06, Math.min(W * 0.5, U * 0.6), s.prog(T(1.2), T(2.0)));
s.text(eyebrow, {
  x: W / 2, y: yb + U * 0.14, size: U * 0.045, font: 'serif', italic: true, weight: 400, align: 'center', color: tone(0.55),
  anim: 'fade', start: T(1.5), dur: 0.9 * k, maxWidth: W * 0.76, maxLines: 1, shadow: false,
});
s.fx.flare({ x: W / 2, y: cy - U * 0.01, intensity: 0.42 * s.ease.inQuad(s.prog(d * 0.55, d)), color: tone(0.3) });
`),
  },

  'ye-title': {
    name: 'Tiêu đề Gala + pháo giấy kim tuyến',
    desc: 'Pháo giấy kim tuyến bắn từ hai góc (vật lý), tia lửa, kim tuyến rơi, tiêu đề nhũ vàng, chủ đề',
    duration: 5,
    code: (o = {}) => fix(`
${HEAD}
${F.company(o)}
${F.title(o)}
${F.subtitle(o)}
${F.theme(o)}
${F.accent(o)}
${KIT}
const k = Math.min(1, d / 5), T = (x) => x * k;
const tc = T(0.35), cy = H * (portrait ? 0.46 : 0.47);
backdrop(H * 0.4);
const kick = t > tc ? Math.exp(-(t - tc) * 5) : 0;
s.camera({ zoom: s.lerp(1.07, 1.0, s.ease.outCubic(s.p)), shake: 0.6 + 7 * kick });
s.fx.rays({ x: W / 2, y: -H * 0.12, angle: Math.PI / 2, count: 12, length: H * 1.4, color: tone(0.3), opacity: 0.11, seed: 4 });
s.fx.mist({ x: W / 2, y: H * 1.02, rate: 4, life: 6, rise: H * 0.04, wind: 6, spread: W * 1.2, size: U * 0.5, color: tone(0.1), opacity: 0.04, start: -6, seed: 8, depth: 0.5 });
beams([
  { x: W * 0.06, y: H * 1.03, a: -1.1, amp: 0.28, f: 1.1, ph: 0.4, w: 0.045, o: 0.42, c: tone(0.35) },
  { x: W * 0.94, y: H * 1.03, a: -2.04, amp: 0.28, f: 1.0, ph: 3.3, w: 0.045, o: 0.42, c: tone(0.35) },
], 1);
s.fx.bokeh({ count: portrait ? 16 : 22, size: [U * 0.02, U * 0.075], color: tone(0.2), opacity: 0.24, drift: 14, rise: 10, seed: 31 });
// Pháo giấy kim tuyến: hai ống bắn từ góc dưới (trọng lực, lực cản không khí, xoáy rối).
const cannon = (side, seed) => {
  const x = side < 0 ? W * 0.03 : W * 0.97, a = -Math.PI / 2 - side * (portrait ? 0.32 : 0.5);
  s.fx.burst({ kind: 'confetti', x, y: H * 1.02, start: tc, count: portrait ? 120 : 150, angle: a, spread: 0.5,
    speed: [U * 1.3, U * 2.7], size: [U * 0.012, U * 0.026], gravity: U * 0.85, drag: 0.55, turbulence: U * 0.45, spin: 8,
    stagger: 0.12, life: 8, colors: GOLDS, seed });
  s.fx.burst({ kind: 'spark', x, y: H * 1.02, start: tc, count: 46, angle: a, spread: 0.36, speed: [U * 1.6, U * 3.0],
    size: [U * 0.004, U * 0.009], gravity: U * 1.1, drag: 0.45, life: 1.7, colors: [tone(0.7), '#ffffff', accent], seed: seed + 1 });
};
cannon(-1, 11); cannon(1, 21);
glitterRain({ start: tc + 0.5, stagger: Math.max(2, d), seed: 41 });
twinkle(30, 9, s.smoothstep(tc, tc + 0.8, t));
glow(W / 2, cy, U * 0.7, 0.28 * kick + 0.1 * s.smoothstep(tc, tc + 1, t), accent);
// Chữ: công ty → tiêu đề → dòng phụ → chủ đề (khối căn giữa, tự co/xuống dòng).
const TS = { x: W / 2, size: U * (portrait ? 0.17 : 0.16), font: 'serif', weight: 700, align: 'center', maxWidth: W * 0.84, maxLines: 2, lineHeight: 1.06 };
const mt = measure(title, TS);
const lh = mt.size * 1.06, y1 = cy - ((mt.lines - 1) * lh) / 2 + mt.size * 0.12;
caps(company, { x: W / 2, y: y1 - mt.size * 0.92 - U * 0.04, size: U * 0.03, anim: 'fade', start: tc + T(0.1), dur: 0.8 * k, maxWidth: W * 0.8 });
gold(title, Object.assign({ y: y1, anim: 'blur', start: tc + T(0.25), dur: 1.0 * k, stagger: 0.07 }, TS));
const yb = y1 + (mt.lines - 1) * lh;
s.text(subtitle, { x: W / 2, y: yb + U * 0.11, size: U * 0.058, font: 'serif', italic: true, weight: 400, align: 'center', color: '#f4e7c8',
  anim: 'rise', start: tc + T(0.75), dur: 0.8 * k, maxWidth: W * 0.8, maxLines: 1 });
rule(W / 2, yb + U * 0.165, Math.min(W * 0.56, U * 0.7), s.prog(tc + T(1.0), tc + T(1.8)));
caps(theme, { x: W / 2, y: yb + U * 0.235, size: U * 0.032, color: tone(0.42), anim: 'fade', start: tc + T(1.2), dur: 0.8 * k, maxWidth: W * 0.8 });
`),
  },

  'ye-year': {
    name: 'Chuyển năm 2026 sang 2027',
    desc: 'Số năm cuộn sang năm mới, bùng nổ tia lửa + pháo giấy, sóng sáng lan, loé ống kính',
    duration: 5,
    code: (o = {}) => fix(`
${HEAD}
${F.company(o)}
${tf('yearFrom', 'year_from', o.year_from ?? '2026', 'Năm cũ', 6)}
${tf('yearTo', 'year_to', o.year_to ?? '2027', 'Năm mới', 6)}
${tf('greeting', 'greeting', o.greeting ?? 'Chào đón *năm mới* rực rỡ', 'Lời chào', 48)}
${F.accent(o)}
${KIT}
const tc = d * 0.42, cy = H * (portrait ? 0.46 : 0.47);
backdrop(cy);
const kick = t > tc ? Math.exp(-(t - tc) * 4.5) : 0;
s.camera({ zoom: s.lerp(1.0, 1.08, s.ease.inOutSine(s.p)), shake: 0.5 + 9 * kick });
s.fx.rays({ x: W / 2, y: cy, angle: -Math.PI / 2, count: 14, length: U * 1.2, color: tone(0.3), opacity: 0.06 + 0.12 * s.smoothstep(tc, tc + 0.5, t), seed: 6 });
s.fx.bokeh({ count: portrait ? 16 : 24, size: [U * 0.02, U * 0.07], color: tone(0.2), opacity: 0.24, drift: 12, rise: 8, seed: 51 });
twinkle(28, 13, 0.5 + 0.5 * s.smoothstep(tc, tc + 0.6, t));
// Đo chữ số: phần chung giữ nguyên, phần khác cuộn lên như đồng hồ lật.
let n = 0; while (n < Math.min(yearFrom.length, yearTo.length) - 1 && yearFrom[n] === yearTo[n]) n++;
const pre = yearFrom.slice(0, n), oldS = yearFrom.slice(n), newS = yearTo.slice(n);
let ys = U * (portrait ? 0.28 : 0.3);
const YO = { font: 'sans', weight: 600, letterSpacing: 0.02, maxLines: 1, maxWidth: W * 0.8, align: 'left' };
const wOf = (str, z) => (str ? measure(str, Object.assign({ x: W * 0.1, size: z }, YO)).width : 0);
let pw = wOf(pre, ys), ow = wOf(oldS, ys), nw = wOf(newS, ys);
const fitK = Math.min(1, (W * 0.8) / Math.max(1, pw + Math.max(ow, nw)));
ys *= fitK; pw *= fitK; ow *= fitK; nw *= fitK;
const roll = s.ease.inOutCubic(s.prog(tc - 0.3, tc + 0.3));
const x0 = W / 2 - (pw + s.lerp(ow, nw, roll)) / 2, by = cy + ys * 0.36;
const intro = s.prog(0, Math.min(0.9, d * 0.2));
s.ctx.save(); s.ctx.globalAlpha = intro;
if (pre) gold(pre, Object.assign({ x: x0, y: by, size: ys, anim: 'none' }, YO));
s.ctx.save(); s.ctx.beginPath(); s.ctx.rect(x0 + pw - ys * 0.05, by - ys * 1.02, Math.max(ow, nw) + ys * 0.3, ys * 1.3); s.ctx.clip();
if (roll < 1) { s.ctx.save(); s.ctx.globalAlpha *= 1 - roll; gold(oldS, Object.assign({ x: x0 + pw, y: by - roll * ys * 0.34, size: ys, anim: 'none' }, YO)); s.ctx.restore(); }
if (roll > 0) { s.ctx.save(); s.ctx.globalAlpha *= roll; gold(newS, Object.assign({ x: x0 + pw, y: by + (1 - roll) * ys * 0.34, size: ys, anim: 'none' }, YO)); s.ctx.restore(); }
s.ctx.restore(); s.ctx.restore();
// Khoảnh khắc chuyển năm: loé sáng, sóng sáng lan, tia lửa + pháo giấy (vật lý).
glow(W / 2, cy, U * 0.8, 0.55 * kick + 0.08 * intro, accent);
if (t > tc) s.world((c) => {
  const q = s.ease.outCubic(s.prog(tc, tc + 1.2)), R = s.lerp(ys * 0.3, U * 0.9, q);
  c.save(); c.globalCompositeOperation = 'lighter'; c.strokeStyle = s.rgba(tone(0.4), 0.5 * (1 - q)); c.lineWidth = U * 0.006 * (1 - q) + 1;
  c.beginPath(); c.ellipse(W / 2, cy, R, R * 0.92, 0, 0, Math.PI * 2); c.stroke(); c.restore();
}, 0);
s.fx.burst({ kind: 'spark', x: W / 2, y: cy, start: tc, count: 80, angle: -Math.PI / 2, spread: Math.PI * 2, speed: [U * 0.5, U * 1.7],
  size: [U * 0.004, U * 0.009], gravity: U * 0.55, drag: 1.1, life: 1.9, colors: [tone(0.7), '#ffffff', accent], seed: 61 });
s.fx.burst({ kind: 'confetti', x: W / 2, y: cy, start: tc + 0.05, count: portrait ? 110 : 140, angle: -Math.PI / 2, spread: 2.3,
  speed: [U * 0.7, U * 1.9], size: [U * 0.011, U * 0.024], gravity: U * 0.8, drag: 0.6, turbulence: U * 0.35, spin: 8, life: 7, colors: GOLDS, seed: 62 });
s.fx.flare({ x: W / 2, y: cy - ys * 0.25, intensity: 0.6 * kick, color: tone(0.3) });
caps(company, { x: W / 2, y: cy - ys * 0.78 - U * 0.05, size: U * 0.03, anim: 'fade', start: 0.2, dur: 0.8, maxWidth: W * 0.8 });
gold(greeting, { x: W / 2, y: by + U * 0.15, size: U * 0.07, font: 'serif', italic: true, weight: 400, align: 'center',
  anim: 'rise', start: tc + 0.45, dur: 0.9, stagger: 0.06, maxWidth: W * 0.8, maxLines: 1 });
`),
  },

  'ye-countdown': {
    name: 'Đếm ngược 10 về 0',
    desc: 'Số đếm nhũ vàng, vòng tiến độ như mặt đồng hồ, về 0 thì pháo giấy + pháo hoa tia lửa + lời chúc',
    duration: 10,
    code: (o = {}) => fix(`
${HEAD}
${F.title(o)}
const countFrom = s.field('count_from', ${J(o.count_from ?? 10)}, { type: 'number', label: 'Đếm từ (giây)' });
${tf('finale', 'finale', o.finale ?? 'Chúc mừng năm mới!', 'Lời chúc khi về 0', 40)}
${tf('finaleSub', 'finale_sub', o.finale_sub ?? 'Happy New Year 2027', 'Dòng phụ khi về 0', 40)}
${F.accent(o)}
${KIT}
// Nhịp đếm: số từ N → 1 chia đều (d − 2) giây, về 0 ở T0, 2 giây cuối là màn chúc mừng.
const N = Math.max(1, Math.min(60, Math.round(countFrom)));
const T0 = Math.max(N * 0.3, d - 2), step = T0 / N;
const cx = W / 2, cy = H * (portrait ? 0.47 : 0.5), R = U * (portrait ? 0.34 : 0.32);
const fin = t >= T0, num = fin ? 0 : N - Math.floor(t / step), u = fin ? 1 : (t - (N - num) * step) / step;
const kick = fin ? Math.exp(-(t - T0) * 4) : 0;
backdrop(cy);
s.camera({ zoom: s.lerp(1.0, 1.05, s.ease.inOutSine(s.p)) + 0.03 * kick, shake: 0.4 + 8 * kick });
beams([
  { x: W * 0.08, y: H * 1.03, a: -1.2, amp: 0.3, f: 0.8, ph: 0.2, w: 0.045, o: 0.36, c: tone(0.35) },
  { x: W * 0.92, y: H * 1.03, a: -1.94, amp: 0.3, f: 0.8, ph: 3.4, w: 0.045, o: 0.36, c: tone(0.35) },
], 0.55 + 0.45 * s.smoothstep(T0 - 0.2, T0 + 0.4, t));
s.fx.bokeh({ count: portrait ? 14 : 20, size: [U * 0.02, U * 0.065], color: tone(0.2), opacity: 0.22, drift: 12, rise: 8, seed: 71 });
twinkle(22, 17, 0.6);
// Mặt đồng hồ: 60 vạch, vòng tiến độ của từng giây, đầu sáng.
const ringOut = s.smoothstep(T0, T0 + 0.7, t);
if (ringOut < 1) s.world((c) => {
  const sc = 1 + ringOut * 0.5, al = 1 - ringOut, total = s.clamp(t / T0, 0, 1);
  c.save(); c.translate(cx, cy); c.scale(sc, sc); c.globalAlpha = al;
  for (let i = 0; i < 60; i++) {
    const a = -Math.PI / 2 + (i / 60) * Math.PI * 2, lit = i / 60 < total, major = i % 5 === 0;
    const r0 = R * (major ? 1.04 : 1.06), r1 = R * 1.1;
    c.strokeStyle = lit ? s.rgba(tone(0.35), 0.95) : s.rgba(accent, major ? 0.42 : 0.2);
    c.lineWidth = U * (major ? 0.0042 : 0.0024);
    c.beginPath(); c.moveTo(Math.cos(a) * r0, Math.sin(a) * r0); c.lineTo(Math.cos(a) * r1, Math.sin(a) * r1); c.stroke();
  }
  c.strokeStyle = s.rgba(accent, 0.16); c.lineWidth = U * 0.003; c.beginPath(); c.arc(0, 0, R * 0.94, 0, Math.PI * 2); c.stroke();
  if (!fin) {
    const a1 = -Math.PI / 2 + Math.PI * 2 * s.ease.inOutSine(u);
    const g = c.createLinearGradient(-R, -R, R, R); g.addColorStop(0, tone(0.6)); g.addColorStop(0.5, accent); g.addColorStop(1, tone(0.3));
    c.strokeStyle = g; c.lineWidth = U * 0.008; c.lineCap = 'round';
    c.beginPath(); c.arc(0, 0, R * 0.94, -Math.PI / 2, a1); c.stroke();
    const hx = Math.cos(a1) * R * 0.94, hy = Math.sin(a1) * R * 0.94, hg = c.createRadialGradient(hx, hy, 0, hx, hy, U * 0.035);
    hg.addColorStop(0, 'rgba(255,248,230,0.95)'); hg.addColorStop(1, s.rgba(accent, 0));
    c.globalCompositeOperation = 'lighter'; c.fillStyle = hg; c.fillRect(hx - U * 0.035, hy - U * 0.035, U * 0.07, U * 0.07);
  }
  c.restore();
}, 0);
// Số đếm: bật lên mỗi nhịp, mờ dần cuối nhịp; số 0 phóng to rồi tan.
glow(cx, cy, R * 1.5, fin ? 0.6 * kick : 0.2 * Math.pow(1 - u, 3), accent);
const zs = U * (portrait ? 0.4 : 0.38) * (String(num).length > 1 ? 0.86 : 1);
const pop = fin ? 1 + 0.7 * s.ease.outCubic(s.prog(T0, T0 + 0.6)) : 1 + 0.26 * (1 - s.ease.outCubic(Math.min(1, u * 3.2)));
const al = fin ? 1 - s.prog(T0 + 0.05, T0 + 0.55) : Math.min(1, u * 9) * (1 - s.smoothstep(0.84, 1, u));
if (al > 0.002) {
  s.ctx.save(); s.ctx.globalAlpha = al; s.ctx.translate(cx, cy); s.ctx.scale(pop, pop); s.ctx.translate(-cx, -cy);
  gold(String(num), { x: cx, y: cy + zs * 0.35, size: zs, font: 'sans', weight: 400, align: 'center', anim: 'none', maxWidth: R * 1.5, maxLines: 1 });
  s.ctx.restore();
}
caps(title, { x: W / 2, y: H * (portrait ? 0.15 : 0.12), size: U * 0.032, anim: 'fade', start: 0.1, dur: 0.6, maxWidth: W * 0.8, out: T0 - 0.1, outDur: 0.4 });
// Về 0: pháo giấy hai bên + pháo hoa tia lửa + lời chúc.
[[-1, 81], [1, 91]].forEach(([side, seed]) => {
  const x = side < 0 ? W * 0.03 : W * 0.97, a = -Math.PI / 2 - side * (portrait ? 0.3 : 0.48);
  s.fx.burst({ kind: 'confetti', x, y: H * 1.02, start: T0, count: portrait ? 110 : 140, angle: a, spread: 0.5, speed: [U * 1.3, U * 2.6],
    size: [U * 0.012, U * 0.026], gravity: U * 0.85, drag: 0.55, turbulence: U * 0.45, spin: 8, stagger: 0.1, life: 8, colors: GOLDS, seed });
});
[[0.28, 0.27, 0.1, 101], [0.72, 0.24, 0.35, 102], [0.5, 0.17, 0.6, 103]].forEach(([fx, fy, dt, seed]) => {
  s.fx.burst({ kind: 'spark', x: W * fx, y: H * fy, start: T0 + dt, count: 64, angle: 0, spread: Math.PI * 2, speed: [U * 0.25, U * 0.6],
    size: [U * 0.004, U * 0.008], gravity: U * 0.2, drag: 1.4, life: 1.7, colors: [tone(0.7), '#ffffff', accent], seed });
});
if (fin) {
  const FS = { x: W / 2, size: U * (portrait ? 0.12 : 0.11), font: 'serif', weight: 700, align: 'center', maxWidth: W * 0.84, maxLines: 2, lineHeight: 1.08 };
  const mf = measure(finale, FS), flh = mf.size * 1.08;
  const fy = cy + mf.size * 0.3 - ((mf.lines - 1) * flh) / 2 - U * 0.03, fb = fy + (mf.lines - 1) * flh;
  gold(finale, Object.assign({ y: fy, anim: 'blur', start: T0 + 0.2, dur: 0.8, stagger: 0.06 }, FS));
  rule(W / 2, fb + U * 0.07, Math.min(W * 0.5, U * 0.6), s.prog(T0 + 0.5, T0 + 1.2));
  caps(finaleSub, { x: W / 2, y: fb + U * 0.145, size: U * 0.034, color: tone(0.45), anim: 'fade', start: T0 + 0.6, dur: 0.7, maxWidth: W * 0.8 });
}
`),
  },

  'ye-invite': {
    name: 'Thư mời: ngày giờ & địa điểm',
    desc: 'Thiệp mời viền vàng kiểu art-deco, vệt sáng lướt, kim tuyến rơi; tên sự kiện, ngày giờ, địa điểm, dress code',
    duration: 5,
    code: (o = {}) => fix(`
${HEAD}
${tf('inviteLabel', 'invite_label', o.invite_label ?? 'Trân trọng kính mời', 'Lời mời', 36)}
${F.title(o)}
${F.subtitle(o)}
${F.date(o)}
${F.venue(o)}
${tf('dress', 'dresscode', o.dresscode ?? 'Dress code: Black & Gold', 'Dress code / ghi chú', 40)}
${F.accent(o)}
${KIT}
const k = Math.min(1, d / 5), T = (x) => x * k;
backdrop(H * 0.45);
s.camera({ zoom: s.lerp(1.04, 1.0, s.ease.outCubic(s.p)) });
s.fx.rays({ x: W / 2, y: -H * 0.1, angle: Math.PI / 2, count: 10, length: H * 1.3, color: tone(0.3), opacity: 0.08, seed: 14 });
s.fx.bokeh({ count: portrait ? 16 : 24, size: [U * 0.02, U * 0.07], color: tone(0.2), opacity: 0.22, drift: 12, rise: 8, seed: 81 });
glitterRain({ start: -4, stagger: 4 + d, count: 60, seed: 82 });
// Thiệp: nền tối trong suốt, viền đôi vàng, góc art-deco, vệt sáng lướt.
const pw = portrait ? W * 0.84 : Math.min(W * 0.6, H * 1.15), ph = portrait ? H * 0.6 : H * 0.8;
const px = W / 2 - pw / 2, py = H / 2 - ph / 2, inn = U * 0.016;
const show = s.ease.outCubic(s.prog(0, T(0.7)));
s.world((c) => {
  c.save(); c.globalAlpha = show;
  c.translate(W / 2, H / 2); c.scale(0.96 + 0.04 * show, 0.96 + 0.04 * show); c.translate(-W / 2, -H / 2);
  c.fillStyle = 'rgba(8,6,4,0.74)'; c.beginPath(); c.roundRect(px, py, pw, ph, U * 0.01); c.fill();
  c.strokeStyle = s.rgba(tone(0.2), 0.9); c.lineWidth = Math.max(1, U * 0.0022); c.stroke();
  c.strokeStyle = s.rgba(accent, 0.45); c.lineWidth = Math.max(1, U * 0.0012);
  c.strokeRect(px + inn, py + inn, pw - inn * 2, ph - inn * 2);
  const L = U * 0.06, e = inn * 2;
  c.strokeStyle = tone(0.35); c.lineWidth = Math.max(1, U * 0.0024);
  [[px + e, py + e, 1, 1], [px + pw - e, py + e, -1, 1], [px + e, py + ph - e, 1, -1], [px + pw - e, py + ph - e, -1, -1]].forEach(([x, y, sx, sy]) => {
    c.beginPath(); c.moveTo(x, y + sy * L); c.lineTo(x, y); c.lineTo(x + sx * L, y); c.stroke();
    c.beginPath(); c.moveTo(x + sx * L * 0.35, y + sy * L * 0.35); c.lineTo(x + sx * L * 0.5, y + sy * L * 0.2); c.lineTo(x + sx * L * 0.65, y + sy * L * 0.35);
    c.lineTo(x + sx * L * 0.5, y + sy * L * 0.5); c.closePath(); c.fillStyle = tone(0.35); c.fill();
  });
  const q = s.prog(T(2.2), T(3.6));
  if (q > 0 && q < 1) {
    c.save(); c.beginPath(); c.roundRect(px, py, pw, ph, U * 0.01); c.clip();
    const bx = s.lerp(px - pw * 0.4, px + pw * 1.4, s.ease.inOutCubic(q)), bw = pw * 0.16;
    c.translate(bx, H / 2); c.rotate(0.35);
    const g = c.createLinearGradient(-bw, 0, bw, 0); g.addColorStop(0, 'rgba(255,240,205,0)'); g.addColorStop(0.5, 'rgba(255,240,205,0.13)'); g.addColorStop(1, 'rgba(255,240,205,0)');
    c.globalCompositeOperation = 'lighter'; c.fillStyle = g; c.fillRect(-bw, -H, bw * 2, H * 2); c.restore();
  }
  c.restore();
}, 0);
// Nội dung thiệp (căn giữa trong khung, co chữ theo bề rộng thiệp).
const MW = pw * 0.8, ip = (x) => T(0.35 + x);
const ks = portrait ? 1.15 : 1, kg = portrait ? 1.6 : 1; // dọc: chữ to hơn, giãn dòng để phủ thiệp cao
const TS = { x: W / 2, size: Math.min(pw * 0.12 * ks, U * 0.13), font: 'serif', weight: 700, align: 'center', maxWidth: MW, maxLines: 2, lineHeight: 1.06 };
const mt = measure(title, TS), lh = mt.size * 1.06;
let y = py + ph * (portrait ? 0.2 : 0.19);
caps(inviteLabel, { x: W / 2, y, size: pw * 0.03 * ks, anim: 'fade', start: ip(0), dur: 0.7, maxWidth: MW });
y += mt.size * 1.02 + pw * 0.03 * kg;
gold(title, Object.assign({ y, anim: 'rise', start: ip(0.15), dur: 0.8, stagger: 0.06 }, TS));
y += (mt.lines - 1) * lh + pw * (portrait ? 0.112 : 0.088);
s.text(subtitle, { x: W / 2, y, size: pw * 0.048 * ks, font: 'serif', italic: true, weight: 400, align: 'center', color: '#f4e7c8', anim: 'rise', start: ip(0.35), dur: 0.7, maxWidth: MW, maxLines: 1 });
y += pw * 0.06 * kg;
rule(W / 2, y, pw * 0.5, s.prog(ip(0.5), ip(1.1)));
y += pw * 0.085 * kg;
s.text(date, { x: W / 2, y, size: pw * 0.044 * ks, font: 'sans', weight: 600, align: 'center', color: '#fbf1dc', anim: 'rise', start: ip(0.65), dur: 0.7, maxWidth: MW, maxLines: 1 });
y += pw * 0.062 * kg;
const mv = s.text(venue, { x: W / 2, y, size: pw * 0.034 * ks, font: 'sans', weight: 400, align: 'center', color: '#d9ccb2', anim: 'rise', start: ip(0.8), dur: 0.7, maxWidth: MW, maxLines: 2, lineHeight: 1.3 });
caps(dress, { x: W / 2, y: Math.max(y + mv.height + pw * 0.03, py + ph - ph * 0.1), size: pw * 0.024 * ks, color: tone(0.3), anim: 'fade', start: ip(1.0), dur: 0.7, maxWidth: MW });
`),
  },

  'ye-thanks': {
    name: 'Lời chào / cảm ơn',
    desc: 'Lời cảm ơn nhũ vàng, tên công ty, chủ đề, kim tuyến rơi và ánh sáng lấp lánh; mờ dần kết thúc',
    duration: 4,
    code: (o = {}) => fix(`
${HEAD}
${F.logo()}
${F.company(o)}
${tf('message', 'message', o.message ?? 'Cảm ơn một năm *đồng hành*', 'Lời chào / cảm ơn', 56)}
${F.theme(o)}
${F.accent(o)}
${KIT}
const k = Math.min(1, d / 4), T = (x) => x * k;
const cy = H * (portrait ? 0.48 : 0.5);
backdrop(cy);
s.camera({ zoom: s.lerp(1.0, 1.05, s.ease.inOutSine(s.p)) });
s.fx.rays({ x: W / 2, y: -H * 0.12, angle: Math.PI / 2, count: 12, length: H * 1.4, color: tone(0.3), opacity: 0.1, seed: 24 });
beams([
  { x: W * 0.2, y: -H * 0.03, a: 1.25, amp: 0.2, f: 0.6, ph: 1.0, w: 0.04, o: 0.3, c: tone(0.35) },
  { x: W * 0.8, y: -H * 0.03, a: 1.89, amp: 0.2, f: 0.6, ph: 4.0, w: 0.04, o: 0.3, c: tone(0.35) },
], 1);
s.fx.bokeh({ count: portrait ? 16 : 24, size: [U * 0.02, U * 0.07], color: tone(0.2), opacity: 0.24, drift: 12, rise: 8, seed: 91 });
glitterRain({ start: -4, stagger: 4 + d, count: 70, seed: 92 });
twinkle(26, 21, 1);
glow(W / 2, cy, U * 0.6, 0.12, accent);
let top = cy - U * 0.16;
if (logo && s.has(logo)) { s.image(logo, { x: W / 2, y: top - U * 0.1, h: U * 0.12, depth: 0, opacity: s.prog(0, T(0.6)) }); top += U * 0.02; }
caps(company, { x: W / 2, y: top, size: U * 0.032, anim: 'fade', start: T(0.2), dur: 0.7, maxWidth: W * 0.8 });
const MS = { x: W / 2, size: U * (portrait ? 0.105 : 0.1), font: 'serif', weight: 700, align: 'center', maxWidth: W * 0.84, maxLines: 2, lineHeight: 1.1 };
const mm = measure(message, MS);
const y1 = cy + mm.size * 0.3 - ((mm.lines - 1) * mm.size * 1.1) / 2;
gold(message, Object.assign({ y: y1, anim: 'rise', start: T(0.4), dur: 0.9, stagger: 0.06 }, MS));
const yb = y1 + (mm.lines - 1) * mm.size * 1.1;
rule(W / 2, yb + U * 0.07, Math.min(W * 0.5, U * 0.6), s.prog(T(0.9), T(1.7)));
s.text(theme, { x: W / 2, y: yb + U * 0.15, size: U * 0.05, font: 'serif', italic: true, weight: 400, align: 'center', color: '#f4e7c8', anim: 'fade', start: T(1.1), dur: 0.8, maxWidth: W * 0.8, maxLines: 1 });
const fade = s.prog(d - 0.6, d);
if (fade > 0) s.world((c) => { c.fillStyle = 'rgba(0,0,0,' + (fade * 0.85).toFixed(3) + ')'; c.fillRect(-W, -H, W * 3, H * 3); }, 0);
`),
  },
};

// Hậu kỳ gợi ý cho bộ gala (merge vào project.style khi dựng từ công thức theo mùa).
const STYLE = { grade: 'luxe', bloom: 0.32, vignette: 0.42, grain: 0.03, letterbox: 0 };

/** Quick recipes (season-tagged). scenes: [{ scene, duration?, opts?, transition? }] */
export const RECIPES = [
  {
    id: 'yearend-teaser', name: 'Year End · Teaser 10s', aspect: '16:9 · 9:16', season: 'yearend', style: STYLE,
    desc: 'Mở màn đèn sân khấu → tiêu đề Gala + pháo giấy kim tuyến → thư mời ngày giờ, địa điểm',
    scenes: [
      { scene: 'ye-curtain', duration: 3 },
      { scene: 'ye-title', duration: 3.5, transition: { type: 'flash', duration: 0.4 } },
      { scene: 'ye-invite', duration: 3.5, transition: { type: 'dissolve', duration: 0.6 } },
    ],
  },
  {
    id: 'yearend-led', name: 'Year End · Mở màn LED 20s', aspect: '16:9 · 9:16', season: 'yearend', style: STYLE,
    desc: 'Công ty trân trọng giới thiệu → chuyển năm 2026 → 2027 bùng nổ → tiêu đề Gala → lời chào mừng',
    scenes: [
      { scene: 'ye-curtain', duration: 5 },
      { scene: 'ye-year', duration: 5, transition: { type: 'dissolve', duration: 0.6 } },
      { scene: 'ye-title', duration: 6, transition: { type: 'flash', duration: 0.4 } },
      { scene: 'ye-thanks', duration: 4, transition: { type: 'dissolve', duration: 0.7 }, opts: { message: 'Chào mừng đến với *đêm Gala*' } },
    ],
  },
  {
    id: 'yearend-countdown', name: 'Year End · Countdown 10→0 (10s)', aspect: '16:9 · 9:16', season: 'yearend', style: STYLE,
    desc: 'Đếm ngược 10 → 0 trên mặt đồng hồ vàng, về 0 thì pháo giấy, pháo hoa tia lửa và lời chúc mừng năm mới',
    scenes: [{ scene: 'ye-countdown', duration: 10 }],
  },
];
