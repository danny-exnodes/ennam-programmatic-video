// Seasonal bundle "Khai trương / Kỷ niệm" (issue #24c).
//
// Scenes are real shot code (same API as the AI director, docs/SHOT_API.md) built
// without any Claude call. Every visible text, date, venue, company name, the anniversary
// number and the three colours (gold accent, backdrop, silk ribbon) are s.field
// (Vietnamese label) drawn with maxWidth/maxLines; every position is relative to W/H, so
// the same code works at 16:9 and 9:16. Brand Kit: the gold accent follows the kit's
// "accent" colour and the backdrop the kit's "primary" colour (brandColor), the logo
// defaults to s.brand.logo.
//
// Physics, all a pure function of t (scrub / reverse-order safe):
//   - ribbon cutting: the silk ribbon is a Verlet rope (node masses, length constraints,
//     heavy flower knot) integrated at a fixed 1/120 s from a pre-roll before t=0 up to t,
//     interpolated between steps. It is pulled taut (rest length shrinks), golden scissors
//     close, the constraint left of the knot is removed and both halves swing down on
//     their posts like damped pendulums, twisting (satin front/back) in a light flutter;
//   - confetti + glitter + paper streamers fired from both sides (s.fx.burst with gravity,
//     drag, turbulence; streamers follow a drag-limited ballistic path);
//   - balloons rise with buoyancy towards terminal velocity, swaying in a smooth wind;
//   - stage light sweeps, glitter twinkles, marquee bulbs chasing round the countdown ring,
//     a laurel wreath growing round the "Kỷ niệm X năm" number as it counts up.
//
// These scenes are NOT used as few-shot examples in the director system prompt
// (keeps the cached prompt byte-identical, see server/director.js).

const J = (v) => JSON.stringify(v);
export const SEASON = { id: 'opening', name: 'Khai trương / Kỷ niệm', desc: 'Lễ khai trương, cắt băng, đếm ngược, cảm ơn khách, kỷ niệm X năm thành lập' };

// Default copy (correct Vietnamese diacritics). 14.11.2026 is a Saturday.
export const DEFAULTS = {
  company: 'Công ty TNHH Ánh Dương',
  title: 'Khai Trương Hồng Phát',
  subtitle: 'Showroom Ánh Dương – Chi nhánh Quận 7',
  date: 'Thứ Bảy, 14.11.2026 · 09:00',
  venue: '1060 Nguyễn Văn Linh, Phường Tân Phong, Quận 7, TP.HCM',
  years: '10',
  offer: 'Ưu đãi khai trương: giảm 20% toàn bộ sản phẩm',
  accent: '#e3bf72',
  base: '#5c1020',
  ribbon: '#c8102e',
};
/** Fields the "Nhanh" form offers for this season (key, label, maxLength | 'color'). */
export const FORM_FIELDS = [
  { key: 'company', label: 'Tên công ty / thương hiệu', maxLength: 48 },
  { key: 'title', label: 'Tiêu đề (vd. Khai Trương Hồng Phát)', maxLength: 36 },
  { key: 'subtitle', label: 'Dòng phụ / tên cửa hàng, chi nhánh', maxLength: 48 },
  { key: 'date', label: 'Ngày giờ', maxLength: 48 },
  { key: 'venue', label: 'Địa điểm', maxLength: 72 },
  { key: 'years', label: 'Số năm kỷ niệm', maxLength: 4 },
  { key: 'offer', label: 'Ưu đãi / lời nhắn cho khách', maxLength: 64 },
  { key: 'accent', label: 'Màu nhấn (vàng kim)', type: 'color', brandColor: 'accent' },
  { key: 'base', label: 'Màu nền', type: 'color', brandColor: 'primary' },
  { key: 'ribbon', label: 'Màu băng lụa', type: 'color' },
];
const MAXLEN = Object.fromEntries(FORM_FIELDS.map((f) => [f.key, f.maxLength]));

/** `const name = s.field(key, def, { label, maxLength })` */
const tf = (name, key, def, label, maxLength = MAXLEN[key] || 48) =>
  `const ${name} = s.field(${J(key)}, ${J(def)}, { label: ${J(label)}, maxLength: ${maxLength} });`;
const F = {
  company: (o) => tf('company', 'company', o.company ?? DEFAULTS.company, 'Tên công ty / thương hiệu'),
  title: (o) => tf('title', 'title', o.title ?? DEFAULTS.title, 'Tiêu đề'),
  subtitle: (o) => tf('subtitle', 'subtitle', o.subtitle ?? DEFAULTS.subtitle, 'Dòng phụ / tên cửa hàng, chi nhánh'),
  date: (o) => tf('date', 'date', o.date ?? DEFAULTS.date, 'Ngày giờ'),
  venue: (o) => tf('venue', 'venue', o.venue ?? DEFAULTS.venue, 'Địa điểm'),
  years: (o) => tf('years', 'years', o.years ?? DEFAULTS.years, 'Số năm kỷ niệm'),
  offer: (o) => tf('offer', 'offer', o.offer ?? DEFAULTS.offer, 'Ưu đãi / lời nhắn cho khách'),
  // Brand Kit (#36): logo mặc định = logo của kit; vàng kim = màu "accent", nền = màu "primary" của kit
  logo: () => `const logo = s.field('logo', s.brand.logo || '', { type: 'image', label: 'Logo (tuỳ chọn, tên chất liệu)' });`,
  colors: (o) => `const accent = s.field('accent', ${J(o.accent ?? DEFAULTS.accent)}, { type: 'color', label: 'Màu nhấn (vàng kim)', brandColor: 'accent' });
const base = s.field('base', ${J(o.base ?? DEFAULTS.base)}, { type: 'color', label: 'Màu nền', brandColor: 'primary' });
const ribbon = s.field('ribbon', ${J(o.ribbon ?? DEFAULTS.ribbon)}, { type: 'color', label: 'Màu băng lụa' });`,
};

const HEAD = `const { t, d, W, H } = s;
const U = Math.min(W, H), portrait = H > W * 1.15;`;

// Shared drawing kit (declared after the fields; depends on `accent`, `base`, `ribbon`).
const KIT = `// --- bộ công cụ khai trương: vàng kim, băng lụa, pháo giấy, đèn quét ---
const hex = (c) => '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
const tone = (k) => hex(s.mix(accent, k > 0 ? '#ffffff' : '#000000', Math.abs(k)));
const bt = (k) => hex(s.mix(base, k > 0 ? '#ffd9a8' : '#000000', Math.abs(k)));
const rb = (k) => hex(s.mix(ribbon, k > 0 ? '#ffe4d2' : '#000000', Math.abs(k)));
const GOLDS = [tone(0.6), tone(0.3), accent, tone(-0.2), '#fff6df'];
const CONF = [tone(0.55), accent, tone(-0.12), rb(0.12), rb(-0.1), '#fff4e2', tone(0.3)];
const CLEAR = 'rgba(0,0,0,0)', TAU = Math.PI * 2;
// Layout only (transparent): real size/lines after auto-shrink, before drawing.
const measure = (str, o) => s.text(str, Object.assign({ y: H * 0.5 }, o, { anim: 'none', out: undefined, color: CLEAR, accent: CLEAR, shadow: false }));
// Gold-leaf text: vertical metallic gradient per glyph line.
const gold = (str, o) => {
  const z = measure(str, o).size;
  const g = s.ctx.createLinearGradient(0, -0.74 * z, 0, 0.42 * z);
  g.addColorStop(0, tone(0.8)); g.addColorStop(0.36, tone(0.34)); g.addColorStop(0.52, tone(-0.16));
  g.addColorStop(0.66, accent); g.addColorStop(0.88, tone(0.5)); g.addColorStop(1, tone(0.2));
  return s.text(str, Object.assign({ shadow: z * 0.2 }, o, { color: g, accent: g }));
};
// Cân dòng: tiêu đề lớn xuống 2 dòng thì ngắt gần giữa (tránh một từ mồ côi ở dòng 2).
const balance = (str, o) => {
  s.ctx.save(); s.ctx.font = (o.italic ? 'italic ' : '') + (o.weight ?? 700) + ' ' + o.size + 'px ' + (o.font === 'serif' ? '"Playfair Display", Georgia, serif' : '"Be Vietnam Pro", Arial, sans-serif');
  const w = s.ctx.measureText(String(str).replace(/\\*/g, '')).width; s.ctx.restore();
  if (w > o.maxWidth && w < o.maxWidth * 1.9) o.maxWidth = Math.max(o.maxWidth * 0.6, Math.min(o.maxWidth, w * 0.6));
  return o;
};
const caps = (str, o) => s.text(String(str).toUpperCase(), Object.assign({ font: 'sans', weight: 600, letterSpacing: 0.26, shadow: false, color: tone(0.5), align: 'center', maxLines: 1 }, o));
const backdrop = (gy) => s.background({ radial: [bt(-0.02), bt(-0.55), bt(-0.88)], x: W / 2, y: gy, r: Math.hypot(W, H) * 0.66 });
// Divider: hairline fading to both ends with a diamond.
const rule = (cx, y, w, k) => { if (k <= 0) return; s.world((c) => {
  const hw = (w / 2) * s.ease.outExpo(k), dm = U * 0.008 * Math.min(1, k * 2), th = Math.max(1, U * 0.0018);
  const g = c.createLinearGradient(cx - hw, 0, cx + hw, 0);
  g.addColorStop(0, s.rgba(accent, 0)); g.addColorStop(0.5, s.rgba(tone(0.35), 0.95)); g.addColorStop(1, s.rgba(accent, 0));
  c.fillStyle = g; c.fillRect(cx - hw, y - th / 2, hw - dm * 2.2, th); c.fillRect(cx + dm * 2.2, y - th / 2, hw - dm * 2.2, th);
  c.fillStyle = tone(0.45); c.beginPath(); c.moveTo(cx, y - dm); c.lineTo(cx + dm, y); c.lineTo(cx, y + dm); c.lineTo(cx - dm, y); c.closePath(); c.fill();
}, 0); };
// Soft light bloom at a point.
const glow = (x, y, r, a, col) => { if (a <= 0.003) return; s.world((c) => {
  const g = c.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, s.rgba('#fff3dc', a)); g.addColorStop(0.3, s.rgba(col, a * 0.45)); g.addColorStop(1, s.rgba(col, 0));
  c.save(); c.globalCompositeOperation = 'lighter'; c.fillStyle = g; c.fillRect(x - r, y - r, r * 2, r * 2); c.restore();
}, 0); };
// Glitter twinkles: 4-point stars flashing at seeded positions.
const twinkle = (n, seed, k) => { if (k <= 0) return; s.world((c) => {
  const r = s.rand(seed); c.save(); c.globalCompositeOperation = 'lighter';
  for (let i = 0; i < n; i++) {
    const x = r() * W, y = r() * H, f = r.range(1.2, 3.2), ph = r() * TAU, sz = U * r.range(0.006, 0.014);
    const v = Math.pow(Math.max(0, Math.sin(t * f + ph)), 12) * k;
    if (v < 0.02) continue;
    const L = sz * (0.7 + v), q = L * 0.16;
    c.fillStyle = s.rgba('#fff3d2', v);
    c.beginPath(); c.moveTo(x, y - L); c.quadraticCurveTo(x + q, y - q, x + L, y); c.quadraticCurveTo(x + q, y + q, x, y + L);
    c.quadraticCurveTo(x - q, y + q, x - L, y); c.quadraticCurveTo(x - q, y - q, x, y - L); c.fill();
  }
  c.restore();
}, 0.6); };
// Đèn quét sân khấu xuyên khói: { x, y, a (rad), amp, f, ph, w, o, c }.
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
  });
  c.restore();
}, 0.35); };
// Vệt sáng quét chéo cả khung (một lần, từ trái sang phải) trong [t0, t1].
const sweep = (t0, t1, a) => { const q = s.prog(t0, t1); if (q <= 0 || q >= 1) return; s.world((c) => {
  const bx = s.lerp(-W * 0.3, W * 1.3, s.ease.inOutSine(q)), bw = U * 0.32, al = a * Math.sin(Math.PI * q);
  c.save(); c.translate(bx, H / 2); c.rotate(0.38);
  const g = c.createLinearGradient(-bw, 0, bw, 0);
  g.addColorStop(0, s.rgba(tone(0.5), 0)); g.addColorStop(0.5, s.rgba('#fff4dc', al)); g.addColorStop(1, s.rgba(tone(0.5), 0));
  c.globalCompositeOperation = 'lighter'; c.fillStyle = g; c.fillRect(-bw, -H * 1.5, bw * 2, H * 3); c.restore();
}, 0); };
// Dây kim tuyến xoắn (serpentine): đầu dây bay theo quỹ đạo có lực cản, thân dây theo vệt đầu, xoắn lượn sóng.
const streamers = (tc, side, seed, n) => { if (t <= tc) return; s.world((c) => {
  const r = s.rand(seed), x0 = side < 0 ? -U * 0.02 : W + U * 0.02, y0 = H * 0.99, g = U * 0.62;
  c.save(); c.lineCap = 'round'; c.lineJoin = 'round';
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 - side * r.range(portrait ? 0.12 : 0.3, portrait ? 0.42 : 0.8), sp = U * r.range(2.0, 3.2), tau = r.range(0.3, 0.45);
    const SC = [tone(0.3), accent, tone(-0.1), rb(0.05), rb(-0.15)], col = SC[Math.floor(r() * SC.length)], dl = r.range(0, 0.18), L = r.range(0.7, 1.1), ph = r() * TAU, amp = U * r.range(0.006, 0.011), wv = r.range(11, 16);
    const age = t - tc - dl; if (age <= 0) continue;
    const pos = (u) => { const e = 1 - Math.exp(-u / tau); return [x0 + Math.cos(a) * sp * tau * e + U * 0.05 * s.noise(u * 0.4, i, seed) * u, y0 + Math.sin(a) * sp * tau * e + g * tau * (u - tau * e)]; };
    const fade = Math.min(1, (7 - age) / 1.5); if (fade <= 0) continue;
    c.strokeStyle = s.rgba(col, fade * 0.9); c.lineWidth = Math.max(1, U * 0.0032);
    c.beginPath();
    const M = 30, len = Math.min(age, L);
    for (let j = 0; j <= M; j++) {
      const u = age - (j / M) * len, [x, y] = pos(u), [x2, y2] = pos(u + 0.004);
      const dx = x2 - x, dy = y2 - y, dn = Math.hypot(dx, dy) || 1, off = Math.sin(u * wv + ph) * amp * Math.min(1, u * 4);
      const X = x - (dy / dn) * off, Y = y + (dx / dn) * off;
      if (j) c.lineTo(X, Y); else c.moveTo(X, Y);
    }
    c.stroke();
  }
  c.restore();
}, 0.9); };
// Pháo giấy + kim tuyến + dây xoắn + tia lửa bắn từ hai bên (vật lý: trọng lực, lực cản, xoáy rối).
const cannons = (tc, seed, o = {}) => [-1, 1].forEach((side, i) => {
  const x = side < 0 ? -U * 0.02 : W + U * 0.02, y = H * 0.99, a = -Math.PI / 2 - side * (portrait ? 0.3 : 0.58), sd = seed + i * 10;
  s.fx.burst({ kind: 'confetti', x, y, start: tc, count: o.count ?? (portrait ? 110 : 140), angle: a, spread: 0.55, speed: [U * 1.3, U * 2.7],
    size: [U * 0.012, U * 0.026], gravity: U * 0.85, drag: 0.55, turbulence: U * 0.45, spin: 8, stagger: 0.14, life: 8, colors: CONF, seed: sd });
  s.fx.burst({ kind: 'confetti', x, y, start: tc + 0.03, count: portrait ? 70 : 90, angle: a, spread: 0.75, speed: [U * 1.0, U * 2.4],
    size: [U * 0.005, U * 0.009], gravity: U * 0.5, drag: 0.9, turbulence: U * 0.5, spin: 12, stagger: 0.2, life: 8, colors: ['#fff8e6', tone(0.7), tone(0.4)], seed: sd + 3 });
  s.fx.burst({ kind: 'spark', x, y, start: tc, count: 40, angle: a, spread: 0.36, speed: [U * 1.6, U * 3.0],
    size: [U * 0.004, U * 0.009], gravity: U * 1.1, drag: 0.45, life: 1.6, colors: [tone(0.7), '#ffffff', accent], seed: sd + 5 });
  if (o.streamers !== false) streamers(tc, side, sd + 7, portrait ? 5 : 7);
});
// Kim tuyến rơi chậm từ trên khung (liên tục).
const glitterRain = (o) => s.fx.burst(Object.assign({ kind: 'confetti', x: W / 2, y: -H * 0.12, count: 70, angle: Math.PI / 2, spread: Math.PI * 0.96,
  speed: [U * 0.08, U * 0.85], size: [U * 0.006, U * 0.012], gravity: U * 0.45, drag: 0.8, turbulence: U * 0.22, spin: 5,
  life: 9, colors: CONF }, o));
// Bông hoa lụa (nơ hoa): ba vòng cánh xếp lớp, tâm thắt nút, hai đuôi lụa. rot = góc xoay.
const rosette = (c, x, y, R, rot) => {
  c.save(); c.translate(x, y); c.rotate(rot);
  [[-0.32, 0.9, -0.42], [0.32, 0.86, -0.32]].forEach(([dx, len, sk]) => {
    c.save(); c.rotate(dx); const tl = R * 1.9 * len;
    const g = c.createLinearGradient(-R * 0.3, 0, R * 0.3, 0); g.addColorStop(0, rb(-0.35)); g.addColorStop(0.5, rb(0.1)); g.addColorStop(1, rb(-0.3));
    c.fillStyle = g; c.beginPath(); c.moveTo(-R * 0.2, 0); c.lineTo(R * 0.2, 0); c.lineTo(R * 0.26 + sk * R * 0.1, tl); c.lineTo(sk * R * 0.1, tl - R * 0.22); c.lineTo(-R * 0.26 + sk * R * 0.1, tl); c.closePath(); c.fill();
    c.strokeStyle = s.rgba(tone(0.2), 0.8); c.lineWidth = Math.max(1, R * 0.03); c.stroke();
    c.restore();
  });
  [[1, 12, 0], [0.74, 10, 0.26], [0.48, 8, 0.1]].forEach(([k, n, off], li) => {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + off, rr = R * k;
      c.save(); c.rotate(a);
      const g = c.createLinearGradient(0, 0, rr, 0);
      g.addColorStop(0, rb(-0.55 + li * 0.1)); g.addColorStop(0.55, rb(0.08 + li * 0.06)); g.addColorStop(0.85, rb(0.3)); g.addColorStop(1, rb(-0.15));
      c.fillStyle = g; c.beginPath(); c.moveTo(0, 0); c.bezierCurveTo(rr * 0.4, -rr * 0.42, rr * 1.05, -rr * 0.36, rr, 0); c.bezierCurveTo(rr * 1.05, rr * 0.36, rr * 0.4, rr * 0.42, 0, 0); c.fill();
      c.restore();
    }
  });
  const kg = c.createRadialGradient(-R * 0.06, -R * 0.06, 0, 0, 0, R * 0.22); kg.addColorStop(0, rb(0.35)); kg.addColorStop(1, rb(-0.45));
  c.fillStyle = kg; c.beginPath(); c.arc(0, 0, R * 0.2, 0, TAU); c.fill();
  c.strokeStyle = s.rgba(tone(0.3), 0.9); c.lineWidth = Math.max(1, R * 0.035); c.stroke();
  c.restore();
};
// Băng lụa: dải satin vẽ theo các nút; xoắn (cos φ) làm hẹp dải và lộ mặt sau tối hơn; viền chỉ vàng.
const silk = (c, pts, w, twist) => {
  const n = pts.length; if (n < 2) return;
  const nm = pts.map((p, i) => { const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)], dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return [-dy / l, dx / l]; });
  const hw = pts.map((p, i) => (w / 2) * (0.22 + 0.78 * Math.abs(Math.cos(twist(i)))));
  for (let i = 0; i < n - 1; i++) {
    const cs = Math.cos(twist(i)), dx = pts[i + 1][0] - pts[i][0], dy = pts[i + 1][1] - pts[i][1];
    const lit = 0.5 + 0.5 * Math.cos(Math.atan2(dy, dx) * 2 - 0.6);
    const col = cs >= 0 ? rb(-0.22 + 0.36 * lit * cs) : rb(-0.5 + 0.12 * lit);
    c.fillStyle = col; c.strokeStyle = col; c.lineWidth = 1;
    c.beginPath();
    c.moveTo(pts[i][0] + nm[i][0] * hw[i], pts[i][1] + nm[i][1] * hw[i]); c.lineTo(pts[i + 1][0] + nm[i + 1][0] * hw[i + 1], pts[i + 1][1] + nm[i + 1][1] * hw[i + 1]);
    c.lineTo(pts[i + 1][0] - nm[i + 1][0] * hw[i + 1], pts[i + 1][1] - nm[i + 1][1] * hw[i + 1]); c.lineTo(pts[i][0] - nm[i][0] * hw[i], pts[i][1] - nm[i][1] * hw[i]);
    c.closePath(); c.fill(); c.stroke();
  }
  c.lineWidth = Math.max(1, w * 0.07); c.strokeStyle = s.rgba(tone(0.25), 0.85);
  [1, -1].forEach((sg) => { c.beginPath(); pts.forEach((p, i) => { const X = p[0] + sg * nm[i][0] * hw[i] * 0.86, Y = p[1] + sg * nm[i][1] * hw[i] * 0.86; if (i) c.lineTo(X, Y); else c.moveTo(X, Y); }); c.stroke(); });
  c.lineWidth = Math.max(1, w * 0.12); c.strokeStyle = s.rgba('#ffffff', 0.12);
  c.beginPath(); pts.forEach((p, i) => { const X = p[0] - nm[i][0] * hw[i] * 0.3, Y = p[1] - nm[i][1] * hw[i] * 0.3; if (i) c.lineTo(X, Y); else c.moveTo(X, Y); }); c.stroke();
};
// Băng cắt khai trương = dây Verlet: N nút, nút giữa là bông hoa lụa nặng; hai đầu buộc vào cột.
// Tích phân bước cố định 1/120 s từ trước t=0 (pre-roll để băng đã nằm yên) → trạng thái là hàm thuần của t.
// o: { x0, x1, y, tc (giây cắt), taut: [t0, t1] (kéo căng), slack, knot (khối lượng nơ), n }
const ribbonSim = (o) => {
  const N = o.n ?? 31, m = (N - 1) / 2, span = o.x1 - o.x0, dt = 1 / 120, pre = 0.8;
  const tt = Math.max(-pre, t) + pre, steps = Math.floor(tt / dt), fr = tt / dt - steps, cut = Math.round((o.tc + pre) / dt);
  const sl0 = o.slack ?? 1.05, sag = span * Math.sqrt((3 * (sl0 - 1)) / 8);
  const P = [], Q = [], iw = [];
  for (let i = 0; i < N; i++) { const u = i / (N - 1), x = o.x0 + span * u, y = o.y + 4 * sag * u * (1 - u); P.push([x, y]); Q.push([x, y]); iw.push(i === 0 || i === N - 1 ? 0 : i === m ? 1 / (o.knot ?? 7) : 1); }
  const g = U * 2.6, damp = 0.994;
  let A = null;
  for (let n = 0; n <= steps; n++) {
    if (n === steps) A = P.map((p) => [p[0], p[1]]);
    const tn = n * dt - pre, cutDone = n >= cut;
    const sl = s.lerp(sl0, 1.0, s.ease.inOutCubic(s.prog(o.taut[0], o.taut[1]))), L = (span * (tn < o.taut[0] ? sl0 : sl)) / (N - 1);
    for (let i = 1; i < N - 1; i++) {
      const p = P[i], q = Q[i], vx = (p[0] - q[0]) * damp, vy = (p[1] - q[1]) * damp;
      const wf = cutDone ? U * 0.35 * s.noise(tn * 1.3, i * 0.21, 17) * Math.min(1, (tn - o.tc) * 2) : 0;
      q[0] = p[0]; q[1] = p[1];
      p[0] += vx + wf * dt * dt; p[1] += vy + g * dt * dt;
    }
    for (let it = 0; it < 10; it++) {
      for (let i = 0; i < N - 1; i++) {
        if (cutDone && i === m - 1) continue;
        const a = P[i], b = P[i + 1], wa = iw[i], wb = iw[i + 1], ws = wa + wb; if (!ws) continue;
        const dx = b[0] - a[0], dy = b[1] - a[1], dl = Math.hypot(dx, dy) || 1e-6, k = (dl - L) / dl / ws;
        a[0] += dx * k * wa; a[1] += dy * k * wa; b[0] -= dx * k * wb; b[1] -= dy * k * wb;
      }
    }
  }
  return P.map((p, i) => [s.lerp(A[i][0], p[0], fr), s.lerp(A[i][1], p[1], fr)]);
};
// Cột vàng giữ băng (ống đứng + quả cầu trên đỉnh).
const post = (c, x, y, h) => {
  const w = U * 0.012, g = c.createLinearGradient(x - w, 0, x + w, 0);
  g.addColorStop(0, tone(-0.45)); g.addColorStop(0.35, tone(0.55)); g.addColorStop(0.6, accent); g.addColorStop(1, tone(-0.5));
  c.fillStyle = g; c.fillRect(x - w / 2, y, w, h);
  c.fillRect(x - w * 0.9, y + U * 0.012, w * 1.8, U * 0.008);
  const bg = c.createRadialGradient(x - w * 0.5, y - w * 0.6, 0, x, y - w * 0.2, w * 1.6);
  bg.addColorStop(0, '#fffaf0'); bg.addColorStop(0.35, tone(0.4)); bg.addColorStop(1, tone(-0.45));
  c.fillStyle = bg; c.beginPath(); c.arc(x, y - w * 0.3, w * 1.25, 0, TAU); c.fill();
};
// Kéo vàng: lưỡi mở góc a (rad), mũi hướng theo dir; đặt sao cho điểm cắt nằm giữa hai lưỡi.
const scissors = (c, x, y, dir, a, L, al) => {
  if (al <= 0.01) return;
  c.save(); c.globalAlpha = al; c.translate(x, y); c.rotate(dir);
  c.shadowColor = 'rgba(0,0,0,0.45)'; c.shadowBlur = L * 0.12; c.shadowOffsetY = L * 0.05;
  [-1, 1].forEach((sg) => {
    c.save(); c.rotate(sg * a / 2);
    const g = c.createLinearGradient(0, -L * 0.06, 0, L * 0.06);
    g.addColorStop(0, tone(0.7)); g.addColorStop(0.5, accent); g.addColorStop(1, tone(-0.4));
    c.fillStyle = g;
    c.beginPath(); c.moveTo(-L * 0.04, -sg * L * 0.045); c.quadraticCurveTo(L * 0.5, -sg * L * 0.05, L, 0); c.quadraticCurveTo(L * 0.5, sg * L * 0.012, -L * 0.04, sg * L * 0.012); c.closePath(); c.fill();
    c.lineWidth = L * 0.035; c.strokeStyle = g; c.beginPath(); c.moveTo(0, 0); c.lineTo(-L * 0.32, sg * L * 0.07); c.stroke();
    c.lineWidth = L * 0.04; c.beginPath(); c.ellipse(-L * 0.46, sg * L * 0.11, L * 0.15, L * 0.1, sg * 0.35, 0, TAU); c.stroke();
    c.restore();
  });
  c.shadowColor = 'rgba(0,0,0,0)';
  c.fillStyle = tone(0.75); c.beginPath(); c.arc(0, 0, L * 0.03, 0, TAU); c.fill();
  c.restore();
};
// Bóng bay: nổi lên theo lực đẩy (tiến tới vận tốc giới hạn), lắc theo gió mượt, dây trễ pha.
// o: { n, seed, band (bề rộng dải hai bên, 0..0.5), size, span (giây phát), alpha }
const balloons = (o) => s.world((c) => {
  const r = s.rand(o.seed ?? 5), cols = [rb(0.02), tone(0.05), '#f4ece2', rb(-0.12), tone(0.25)];
  for (let i = 0; i < o.n; i++) {
    const side = i % 2 ? 1 : -1, xs = side < 0 ? r.range(0.03, o.band ?? 0.2) : 1 - r.range(0.03, o.band ?? 0.2);
    const R = U * r.range(0.034, 0.052) * (o.size ?? 1), dl = r.range(-4.5, o.span ?? 3), vt = U * r.range(0.17, 0.27), tau = 0.9, ph = r() * TAU, col = cols[i % cols.length];
    const age = t - dl; if (age < 0) continue;
    const rise = vt * (age - tau * (1 - Math.exp(-age / tau))), y = H + R * 3 - rise;
    if (y < -R * 5) continue;
    const sw = (u) => U * 0.03 * s.noise(u * 0.45, i * 1.7, 13) + U * 0.008 * Math.sin(u * 1.7 + ph);
    const x = xs * W + sw(age), tilt = (sw(age + 0.05) - sw(age - 0.05)) / (U * 0.012);
    c.save(); c.globalAlpha = o.alpha ?? 1; c.translate(x, y); c.rotate(Math.max(-0.35, Math.min(0.35, tilt)));
    c.strokeStyle = s.rgba('#f6e6c8', 0.55); c.lineWidth = Math.max(1, U * 0.0012);
    const lag = (sw(age - 0.5) - sw(age)) * 1.2;
    c.beginPath(); c.moveTo(0, R * 1.22); c.bezierCurveTo(lag * 0.3, R * 2.2, lag, R * 3, lag * 0.6, R * 4.6); c.stroke();
    const g = c.createRadialGradient(-R * 0.35, -R * 0.45, R * 0.05, 0, 0, R * 1.25);
    g.addColorStop(0, '#ffffff'); g.addColorStop(0.12, hex(s.mix(col, '#ffffff', 0.55))); g.addColorStop(0.55, col); g.addColorStop(1, hex(s.mix(col, '#000000', 0.55)));
    c.fillStyle = g; c.beginPath(); c.ellipse(0, 0, R, R * 1.18, 0, 0, TAU); c.fill();
    c.fillStyle = hex(s.mix(col, '#000000', 0.3)); c.beginPath(); c.moveTo(-R * 0.1, R * 1.26); c.lineTo(R * 0.1, R * 1.26); c.lineTo(0, R * 1.14); c.closePath(); c.fill();
    c.fillStyle = 'rgba(255,255,255,0.35)'; c.beginPath(); c.ellipse(-R * 0.38, -R * 0.5, R * 0.12, R * 0.24, -0.5, 0, TAU); c.fill();
    c.restore();
  }
}, 0.7);
// Vòng nguyệt quế vàng mọc dần quanh tâm (k 0→1): hai nhánh từ đáy vòng lên hai bên.
const laurel = (cx, cy, R, k) => { if (k <= 0.001) return; s.world((c) => {
  c.save(); c.lineCap = 'round';
  [-1, 1].forEach((sd) => {
    const th0 = Math.PI / 2 + sd * 0.16, span = 1.28 * Math.PI * 0.62, th = (u) => th0 + sd * span * u;
    const pt = (u, rr) => [cx + Math.cos(th(u)) * rr, cy + Math.sin(th(u)) * rr];
    c.strokeStyle = tone(-0.1); c.lineWidth = Math.max(1, U * 0.004);
    c.beginPath(); for (let j = 0; j <= 40; j++) { const u = (j / 40) * k, [x, y] = pt(u, R); if (j) c.lineTo(x, y); else c.moveTo(x, y); } c.stroke();
    const NL = 12;
    for (let j = 0; j < NL; j++) {
      const u = (j + 0.6) / NL, g0 = s.clamp((k - u) * 7, 0, 1); if (g0 <= 0) continue;
      const gk = s.ease.outBack(g0), [x, y] = pt(u, R), tan = th(u) + sd * Math.PI / 2, L = U * 0.055 * (1 - u * 0.45) * gk;
      [[1, 0.55], [-1, 0.5]].forEach(([io, sp]) => {
        c.save(); c.translate(x, y); c.rotate(tan + io * sd * sp);
        const lg = c.createLinearGradient(0, 0, L, 0); lg.addColorStop(0, tone(-0.3)); lg.addColorStop(0.5, tone(0.45)); lg.addColorStop(1, tone(0.05));
        c.fillStyle = lg; c.beginPath(); c.moveTo(0, 0); c.quadraticCurveTo(L * 0.5, -L * 0.3, L, 0); c.quadraticCurveTo(L * 0.5, L * 0.3, 0, 0); c.fill();
        c.strokeStyle = s.rgba(tone(-0.45), 0.6); c.lineWidth = Math.max(0.6, L * 0.03); c.beginPath(); c.moveTo(0, 0); c.lineTo(L * 0.85, 0); c.stroke();
        c.restore();
      });
    }
    if (k > 0.98) { const [x, y] = pt(1, R); c.fillStyle = tone(0.3); c.beginPath(); c.arc(x, y, U * 0.006, 0, TAU); c.fill(); }
  });
  c.restore();
}, 0); };`;

const fix = (s) => s.trim() + '\n';

/** Scene definitions. code(o) → shot code; o overrides default copy. */
export const SCENES = {
  'op-ribbon': {
    name: 'Cắt băng khai trương',
    desc: 'Băng lụa đỏ có nơ hoa căng giữa hai cột vàng, kéo căng rồi kéo vàng cắt; hai nửa băng rơi đung đưa (vật lý dây), pháo giấy + kim tuyến nổ hai bên, đèn quét; “Khai Trương Hồng Phát”',
    duration: 5,
    code: (o = {}) => fix(`
${HEAD}
${F.company(o)}
${tf('eyebrow', 'eyebrow', o.eyebrow ?? 'Lễ cắt băng khai trương', 'Dòng giới thiệu', 40)}
${F.title(o)}
${F.subtitle(o)}
${F.date(o)}
${F.logo()}
${F.colors(o)}
${KIT}
const k = Math.min(1, d / 5), T = (x) => x * k;
const tc = T(1.6), ry = H * (portrait ? 0.58 : 0.5), cy = H * (portrait ? 0.37 : 0.48);
backdrop(H * 0.55);
const kick = t > tc ? Math.exp(-(t - tc) * 5) : 0;
s.camera({ zoom: s.lerp(1.06, 1.0, s.ease.outCubic(s.p)), shake: 0.5 + 6 * kick });
s.fx.mist({ x: W / 2, y: H * 1.02, rate: 4, life: 6, rise: H * 0.04, wind: 6, spread: W * 1.2, size: U * 0.5, color: tone(0.1), opacity: 0.04, start: -6, seed: 3, depth: 0.5 });
beams([
  { x: W * 0.12, y: H * 1.03, a: -1.2, amp: 0.3, f: 0.8, ph: 0.4, w: 0.045, o: 0.38, c: tone(0.35) },
  { x: W * 0.88, y: H * 1.03, a: -1.94, amp: 0.3, f: 0.8, ph: 3.3, w: 0.045, o: 0.38, c: tone(0.35) },
], 0.45 + 0.55 * s.smoothstep(tc, tc + 0.6, t));
s.fx.bokeh({ count: portrait ? 14 : 20, size: [U * 0.02, U * 0.065], color: tone(0.2), opacity: 0.22, drift: 12, rise: 8, seed: 11 });
twinkle(24, 5, 0.5 + 0.5 * s.smoothstep(tc, tc + 0.8, t));
glow(W / 2, ry, U * 0.6, 0.1 + 0.5 * kick, accent);
// Băng lụa + cột: kéo căng [T(0.25), T(1.25)], cắt ở tc bên trái nơ hoa.
const x0 = W * (portrait ? 0.08 : 0.07), x1 = W - x0;
const P = ribbonSim({ x0, x1, y: ry, tc, taut: [T(0.25), T(1.25)], slack: 1.05, knot: 7 });
const m = (P.length - 1) / 2, fall = s.smoothstep(tc, tc + 0.5, t), show = s.smoothstep(0, T(0.4), t);
s.world((c) => {
  c.save(); c.globalAlpha = show;
  post(c, x0, ry, H * 1.1 - ry); post(c, x1, ry, H * 1.1 - ry);
  const tw = (end) => (i) => fall * (Math.abs(i - end) * 0.32 + 1.6 * s.noise(i * 0.17, t * 0.6, end + 3));
  if (t < tc) silk(c, P, U * 0.034, () => 0);
  else { silk(c, P.slice(0, m), U * 0.034, tw(m - 1)); silk(c, P.slice(m), U * 0.034, (i) => tw(0)(i)); }
  const kn = P[m], nb = P[Math.min(P.length - 1, m + 1)], ang = t < tc ? 0 : Math.atan2(nb[1] - kn[1], nb[0] - kn[0]) * 0.8;
  rosette(c, kn[0], kn[1], U * (portrait ? 0.075 : 0.07), ang);
  c.restore();
}, 0.9);
// Kéo vàng tiến tới, mở lưỡi, khép lại cắt; rồi lùi xuống mờ dần.
const cp = P[m - 1], cxp = s.lerp(cp[0], P[m][0], 0.35), cyp = s.lerp(cp[1], P[m][1], 0.35);
const app = s.ease.outCubic(s.prog(T(0.45), tc - T(0.2))), back = s.ease.inCubic(s.prog(tc + 0.1, tc + 0.9));
const L = U * 0.17, dir = -2.25, open = t < tc - T(0.18) ? 0.52 + 0.06 * Math.sin(t * 9) : s.lerp(0.52, 0.0, s.ease.inQuad(s.prog(tc - T(0.18), tc)));
const sx = cxp - Math.cos(dir) * L * 0.55 + (1 - app) * U * 0.25 + back * U * 0.1, sy = cyp - Math.sin(dir) * L * 0.55 + (1 - app) * U * 0.45 + back * U * 0.35;
s.world((c) => scissors(c, sx, sy, dir, open, L, Math.min(app * 1.5, 1) * (1 - back)), 0.95);
if (t > tc) s.fx.burst({ kind: 'spark', x: cxp, y: cyp, start: tc, count: 70, angle: 0, spread: TAU, speed: [U * 0.3, U * 1.1], size: [U * 0.004, U * 0.009],
  gravity: U * 0.7, drag: 1.2, life: 1.6, colors: [tone(0.7), '#ffffff', accent], seed: 23 });
glow(cxp, cyp, U * 0.3, 0.8 * kick, accent);
cannons(tc + 0.08, 31);
sweep(tc + 0.3, tc + 1.6, 0.16);
// Chữ trước khi cắt.
caps(company, { x: W / 2, y: ry - U * 0.24, size: U * 0.03, anim: 'fade', start: T(0.2), dur: 0.6 * k, out: tc - 0.05, outDur: 0.3, maxWidth: W * 0.8 });
s.text(eyebrow, { x: W / 2, y: ry - U * 0.15, size: U * 0.056, font: 'serif', italic: true, weight: 400, align: 'center', color: tone(0.55),
  anim: 'fade', start: T(0.35), dur: 0.7 * k, out: tc - 0.05, outDur: 0.3, maxWidth: W * 0.76, maxLines: 1, shadow: false });
// Sau khi cắt: khối tiêu đề.
const ts = tc + 0.35;
const TS = { x: W / 2, size: U * (portrait ? 0.15 : 0.14), font: 'serif', weight: 700, align: 'center', maxWidth: W * (portrait ? 0.84 : 0.76), maxLines: 2, lineHeight: 1.06 };
balance(title, TS);
const mt = measure(title, TS), lh = mt.size * 1.06, y1 = cy - ((mt.lines - 1) * lh) / 2 + mt.size * 0.1;
let top = y1 - mt.size * 0.95 - U * 0.035;
if (logo && s.has(logo)) { s.image(logo, { x: W / 2, y: top - U * 0.12, h: U * 0.11, depth: 0, opacity: s.prog(ts, ts + 0.6) }); }
caps(company, { x: W / 2, y: top, size: U * 0.03, anim: 'fade', start: ts, dur: 0.7, maxWidth: W * 0.8 });
gold(title, Object.assign({ y: y1, anim: 'blur', start: ts + 0.1, dur: 0.9, stagger: 0.07 }, TS));
const yb = y1 + (mt.lines - 1) * lh;
s.text(subtitle, { x: W / 2, y: yb + U * 0.11, size: U * 0.052, font: 'serif', italic: true, weight: 400, align: 'center', color: '#f8e9cf',
  anim: 'rise', start: ts + 0.5, dur: 0.8, maxWidth: W * 0.8, maxLines: 1 });
rule(W / 2, yb + U * 0.165, Math.min(W * 0.5, U * 0.6), s.prog(ts + 0.7, ts + 1.4));
caps(date, { x: W / 2, y: yb + U * 0.235, size: U * 0.032, color: tone(0.42), anim: 'fade', start: ts + 0.85, dur: 0.7, maxWidth: W * 0.8 });
`),
  },

  'op-title': {
    name: 'Tiêu đề khai trương + pháo giấy',
    desc: 'Pháo giấy, kim tuyến và dây xoắn bắn từ hai bên (vật lý), đèn quét, vệt sáng lướt; tiêu đề nhũ vàng, tên cửa hàng, ngày giờ, địa điểm',
    duration: 5,
    code: (o = {}) => fix(`
${HEAD}
${F.company(o)}
${F.title(o)}
${F.subtitle(o)}
${F.date(o)}
${F.venue(o)}
${F.logo()}
${F.colors(o)}
${KIT}
const k = Math.min(1, d / 5), T = (x) => x * k;
const tc = T(0.35), cy = H * (portrait ? 0.46 : 0.47);
backdrop(H * 0.42);
const kick = t > tc ? Math.exp(-(t - tc) * 5) : 0;
s.camera({ zoom: s.lerp(1.07, 1.0, s.ease.outCubic(s.p)), shake: 0.5 + 6 * kick });
s.fx.rays({ x: W / 2, y: -H * 0.12, angle: Math.PI / 2, count: 12, length: H * 1.4, color: tone(0.3), opacity: 0.1, seed: 4 });
s.fx.mist({ x: W / 2, y: H * 1.02, rate: 4, life: 6, rise: H * 0.04, wind: 6, spread: W * 1.2, size: U * 0.5, color: tone(0.1), opacity: 0.04, start: -6, seed: 8, depth: 0.5 });
beams([
  { x: W * 0.06, y: H * 1.03, a: -1.1, amp: 0.3, f: 1.0, ph: 0.4, w: 0.045, o: 0.36, c: tone(0.35) },
  { x: W * 0.3, y: H * 1.03, a: -1.45, amp: 0.36, f: 0.7, ph: 2.0, w: 0.035, o: 0.22, c: '#fff1d6' },
  { x: W * 0.7, y: H * 1.03, a: -1.69, amp: 0.36, f: 0.75, ph: 4.1, w: 0.035, o: 0.22, c: '#fff1d6' },
  { x: W * 0.94, y: H * 1.03, a: -2.04, amp: 0.3, f: 0.95, ph: 3.3, w: 0.045, o: 0.36, c: tone(0.35) },
].filter((b, i) => !portrait || i === 0 || i === 3), 1);
s.fx.bokeh({ count: portrait ? 16 : 22, size: [U * 0.02, U * 0.075], color: tone(0.2), opacity: 0.24, drift: 14, rise: 10, seed: 31 });
cannons(tc, 41);
glitterRain({ start: tc + 0.6, stagger: Math.max(2, d), count: 50, seed: 45 });
twinkle(30, 9, s.smoothstep(tc, tc + 0.8, t));
glow(W / 2, cy, U * 0.7, 0.26 * kick + 0.1 * s.smoothstep(tc, tc + 1, t), accent);
sweep(T(1.6), T(3.0), 0.14);
const TS = { x: W / 2, size: U * (portrait ? 0.16 : 0.15), font: 'serif', weight: 700, align: 'center', maxWidth: W * (portrait ? 0.84 : 0.78), maxLines: 2, lineHeight: 1.06 };
balance(title, TS);
const mt = measure(title, TS), lh = mt.size * 1.06, y1 = cy - ((mt.lines - 1) * lh) / 2 + mt.size * 0.12;
const top = y1 - mt.size * 0.92 - U * 0.04;
if (logo && s.has(logo)) s.image(logo, { x: W / 2, y: top - U * 0.12, h: U * 0.11, depth: 0, opacity: s.prog(tc, tc + T(0.6)) });
caps(company, { x: W / 2, y: top, size: U * 0.03, anim: 'fade', start: tc + T(0.1), dur: 0.8 * k, maxWidth: W * 0.8 });
gold(title, Object.assign({ y: y1, anim: 'blur', start: tc + T(0.25), dur: 1.0 * k, stagger: 0.07 }, TS));
const yb = y1 + (mt.lines - 1) * lh;
s.text(subtitle, { x: W / 2, y: yb + U * 0.11, size: U * 0.054, font: 'serif', italic: true, weight: 400, align: 'center', color: '#f8e9cf',
  anim: 'rise', start: tc + T(0.75), dur: 0.8 * k, maxWidth: W * 0.8, maxLines: 1 });
rule(W / 2, yb + U * 0.165, Math.min(W * 0.56, U * 0.7), s.prog(tc + T(1.0), tc + T(1.8)));
caps(date, { x: W / 2, y: yb + U * 0.235, size: U * 0.032, color: tone(0.45), anim: 'fade', start: tc + T(1.15), dur: 0.8 * k, maxWidth: W * 0.8 });
const VS = { x: W / 2, size: U * 0.03, font: 'sans', weight: 400, align: 'center', maxWidth: W * 0.8, maxLines: 2, lineHeight: 1.3 };
balance(venue, VS);
s.text(venue, Object.assign({ y: yb + U * 0.3, color: '#ead8bd', anim: 'fade', start: tc + T(1.3), dur: 0.8 * k }, VS));
`),
  },

  'op-countdown': {
    name: 'Đếm ngược khai trương',
    desc: 'Vòng bóng đèn marquee chạy quanh số đếm nhũ vàng, tắt dần theo thời gian; về 0 thì pháo giấy hai bên, tia lửa, “Khai Trương Hồng Phát”',
    duration: 8,
    code: (o = {}) => fix(`
${HEAD}
${tf('label', 'countdown_label', o.countdown_label ?? 'Đếm ngược giờ khai trương', 'Dòng trên số đếm', 40)}
const countFrom = s.field('count_from', ${J(o.count_from ?? 5)}, { type: 'number', label: 'Đếm từ (giây)' });
${F.title(o)}
${F.company(o)}
${F.date(o)}
${F.colors(o)}
${KIT}
// Nhịp đếm: N → 1 chia đều (d − 2.5) giây, về 0 ở T0, 2.5 giây cuối là màn khai trương.
const N = Math.max(1, Math.min(60, Math.round(countFrom)));
const T0 = Math.max(N * 0.3, d - 2.5), step = T0 / N;
const cx = W / 2, cy = H * (portrait ? 0.47 : 0.5), R = U * (portrait ? 0.33 : 0.31);
const fin = t >= T0, num = fin ? 0 : N - Math.floor(t / step), u = fin ? 1 : (t - (N - num) * step) / step;
const kick = fin ? Math.exp(-(t - T0) * 4) : 0;
backdrop(cy);
s.camera({ zoom: s.lerp(1.0, 1.05, s.ease.inOutSine(s.p)) + 0.03 * kick, shake: 0.4 + 8 * kick });
beams([
  { x: W * 0.08, y: H * 1.03, a: -1.2, amp: 0.3, f: 0.8, ph: 0.2, w: 0.045, o: 0.34, c: tone(0.35) },
  { x: W * 0.92, y: H * 1.03, a: -1.94, amp: 0.3, f: 0.8, ph: 3.4, w: 0.045, o: 0.34, c: tone(0.35) },
], 0.5 + 0.5 * s.smoothstep(T0 - 0.2, T0 + 0.4, t));
s.fx.bokeh({ count: portrait ? 14 : 20, size: [U * 0.02, U * 0.065], color: tone(0.2), opacity: 0.22, drift: 12, rise: 8, seed: 71 });
twinkle(22, 17, 0.6);
// Vòng bóng đèn marquee: phần còn lại sáng, đèn chạy đuổi; tắt dần theo chiều kim đồng hồ.
const ringOut = s.smoothstep(T0, T0 + 0.7, t);
if (ringOut < 1) s.world((c) => {
  const sc = 1 + ringOut * 0.45, al = 1 - ringOut, left = 1 - s.clamp(t / T0, 0, 1), NB = 40;
  c.save(); c.translate(cx, cy); c.scale(sc, sc); c.globalAlpha = al;
  const dg = c.createRadialGradient(0, 0, R * 0.2, 0, 0, R * 1.12);
  dg.addColorStop(0, s.rgba(bt(-0.4), 0.0)); dg.addColorStop(0.8, s.rgba(bt(-0.7), 0.55)); dg.addColorStop(1, s.rgba(bt(-0.8), 0));
  c.fillStyle = dg; c.beginPath(); c.arc(0, 0, R * 1.12, 0, TAU); c.fill();
  c.strokeStyle = s.rgba(tone(0.1), 0.7); c.lineWidth = U * 0.004; c.beginPath(); c.arc(0, 0, R * 1.0, 0, TAU); c.stroke();
  c.strokeStyle = s.rgba(tone(-0.1), 0.45); c.lineWidth = U * 0.0018; c.beginPath(); c.arc(0, 0, R * 0.9, 0, TAU); c.stroke();
  c.beginPath(); c.arc(0, 0, R * 1.1, 0, TAU); c.stroke();
  for (let i = 0; i < NB; i++) {
    const a = -Math.PI / 2 + (i / NB) * TAU, bx = Math.cos(a) * R * 1.05, by = Math.sin(a) * R * 1.05;
    const on = i / NB >= 1 - left, chase = Math.pow(Math.max(0, Math.cos((i / NB) * TAU * 5 - t * 7)), 6);
    const v = on ? 0.55 + 0.45 * chase : 0, br = U * 0.0085;
    c.fillStyle = on ? hex(s.mix(tone(0.5), '#ffffff', 0.5 * v)) : bt(-0.55);
    c.beginPath(); c.arc(bx, by, br, 0, TAU); c.fill();
    if (!on) { c.strokeStyle = s.rgba(tone(-0.3), 0.6); c.lineWidth = 1; c.stroke(); continue; }
    c.globalCompositeOperation = 'lighter';
    const hg = c.createRadialGradient(bx, by, 0, bx, by, br * 4.5);
    hg.addColorStop(0, s.rgba('#fff4d6', 0.55 * v)); hg.addColorStop(1, s.rgba(accent, 0));
    c.fillStyle = hg; c.fillRect(bx - br * 4.5, by - br * 4.5, br * 9, br * 9);
    c.globalCompositeOperation = 'source-over';
  }
  c.restore();
}, 0);
glow(cx, cy, R * 1.4, fin ? 0.6 * kick : 0.18 * Math.pow(1 - u, 3), accent);
const zs = U * (portrait ? 0.38 : 0.36) * (String(num).length > 1 ? 0.84 : 1);
const pop = fin ? 1 + 0.7 * s.ease.outCubic(s.prog(T0, T0 + 0.6)) : 1 + 0.24 * (1 - s.ease.outCubic(Math.min(1, u * 3.2)));
const al = fin ? 1 - s.prog(T0 + 0.05, T0 + 0.5) : Math.min(1, u * 9) * (1 - s.smoothstep(0.86, 1, u));
if (al > 0.002) {
  s.ctx.save(); s.ctx.globalAlpha = al; s.ctx.translate(cx, cy); s.ctx.scale(pop, pop); s.ctx.translate(-cx, -cy);
  gold(String(num), { x: cx, y: cy + zs * 0.35, size: zs, font: 'serif', weight: 700, align: 'center', anim: 'none', maxWidth: R * 1.5, maxLines: 1 });
  s.ctx.restore();
}
caps(label, { x: W / 2, y: H * (portrait ? 0.16 : 0.11), size: U * 0.032, anim: 'fade', start: 0.1, dur: 0.6, maxWidth: W * 0.8, out: T0 - 0.1, outDur: 0.4 });
// Về 0: pháo giấy hai bên + tia lửa + tiêu đề khai trương.
cannons(T0, 81);
[[0.26, 0.26, 0.15, 101], [0.74, 0.22, 0.4, 102], [0.5, 0.15, 0.65, 103]].forEach(([fx, fy, dt, seed]) => {
  s.fx.burst({ kind: 'spark', x: W * fx, y: H * fy, start: T0 + dt, count: 64, angle: 0, spread: TAU, speed: [U * 0.25, U * 0.6],
    size: [U * 0.004, U * 0.008], gravity: U * 0.2, drag: 1.4, life: 1.7, colors: [tone(0.7), '#ffffff', accent], seed });
});
sweep(T0 + 0.3, T0 + 1.6, 0.15);
if (fin) {
  const FS = { x: W / 2, size: U * (portrait ? 0.15 : 0.14), font: 'serif', weight: 700, align: 'center', maxWidth: W * (portrait ? 0.84 : 0.78), maxLines: 2, lineHeight: 1.06 };
  balance(title, FS);
  const mf = measure(title, FS), flh = mf.size * 1.06;
  const fy = cy + mf.size * 0.3 - ((mf.lines - 1) * flh) / 2 - U * 0.03, fb = fy + (mf.lines - 1) * flh;
  caps(company, { x: W / 2, y: fy - mf.size * 0.95 - U * 0.035, size: U * 0.03, anim: 'fade', start: T0 + 0.3, dur: 0.6, maxWidth: W * 0.8 });
  gold(title, Object.assign({ y: fy, anim: 'blur', start: T0 + 0.15, dur: 0.8, stagger: 0.06 }, FS));
  rule(W / 2, fb + U * 0.075, Math.min(W * 0.5, U * 0.6), s.prog(T0 + 0.5, T0 + 1.2));
  caps(date, { x: W / 2, y: fb + U * 0.145, size: U * 0.032, color: tone(0.42), anim: 'fade', start: T0 + 0.6, dur: 0.6, maxWidth: W * 0.8 });
}
`),
  },

  'op-invite': {
    name: 'Thư mời khai trương',
    desc: 'Thiệp mời nền rượu vang viền vàng, băng lụa đỏ vắt góc với nơ hoa, vệt sáng lướt, kim tuyến rơi; tên sự kiện, cửa hàng, ngày giờ, địa điểm',
    duration: 5,
    code: (o = {}) => fix(`
${HEAD}
${tf('inviteLabel', 'invite_label', o.invite_label ?? 'Trân trọng kính mời', 'Lời mời', 36)}
${F.company(o)}
${F.title(o)}
${F.subtitle(o)}
${F.date(o)}
${F.venue(o)}
${tf('note', 'note', o.note ?? 'Rất hân hạnh được đón tiếp', 'Ghi chú', 48)}
${F.colors(o)}
${KIT}
const k = Math.min(1, d / 5), T = (x) => x * k;
backdrop(H * 0.45);
s.camera({ zoom: s.lerp(1.04, 1.0, s.ease.outCubic(s.p)) });
s.fx.rays({ x: W / 2, y: -H * 0.1, angle: Math.PI / 2, count: 10, length: H * 1.3, color: tone(0.3), opacity: 0.08, seed: 14 });
s.fx.bokeh({ count: portrait ? 14 : 22, size: [U * 0.02, U * 0.07], color: tone(0.2), opacity: 0.2, drift: 12, rise: 8, seed: 81 });
glitterRain({ start: -4, stagger: 4 + d, count: 55, seed: 82 });
const pw = portrait ? W * 0.84 : Math.min(W * 0.56, H * 1.1), ph = portrait ? H * 0.62 : H * 0.82;
const px = W / 2 - pw / 2, py = H / 2 - ph / 2, inn = U * 0.016;
const show = s.ease.outCubic(s.prog(0, T(0.7)));
s.world((c) => {
  c.save(); c.globalAlpha = show;
  c.translate(W / 2, H / 2); c.scale(0.96 + 0.04 * show, 0.96 + 0.04 * show); c.translate(-W / 2, -H / 2);
  c.shadowColor = 'rgba(0,0,0,0.5)'; c.shadowBlur = U * 0.04; c.shadowOffsetY = U * 0.012;
  const g = c.createLinearGradient(px, py, px + pw * 0.4, py + ph);
  g.addColorStop(0, bt(-0.12)); g.addColorStop(0.55, bt(-0.42)); g.addColorStop(1, bt(-0.62));
  c.fillStyle = g; c.beginPath(); c.roundRect(px, py, pw, ph, U * 0.012); c.fill();
  c.shadowColor = 'rgba(0,0,0,0)';
  c.strokeStyle = s.rgba(tone(0.2), 0.95); c.lineWidth = Math.max(1, U * 0.003); c.stroke();
  c.strokeStyle = s.rgba(accent, 0.5); c.lineWidth = Math.max(1, U * 0.0013);
  c.strokeRect(px + inn, py + inn, pw - inn * 2, ph - inn * 2);
  const Lc = U * 0.05, e = inn * 2;
  c.strokeStyle = tone(0.35); c.lineWidth = Math.max(1, U * 0.0024);
  [[px + pw - e, py + ph - e, -1, -1], [px + e, py + ph - e, 1, -1]].forEach(([x, y, sx, sy]) => {
    c.beginPath(); c.moveTo(x, y + sy * Lc); c.lineTo(x, y); c.lineTo(x + sx * Lc, y); c.stroke();
    c.beginPath(); c.moveTo(x + sx * Lc * 0.35, y + sy * Lc * 0.35); c.lineTo(x + sx * Lc * 0.5, y + sy * Lc * 0.2); c.lineTo(x + sx * Lc * 0.65, y + sy * Lc * 0.35);
    c.lineTo(x + sx * Lc * 0.5, y + sy * Lc * 0.5); c.closePath(); c.fillStyle = tone(0.35); c.fill();
  });
  // băng lụa vắt chéo góc trên-trái + góc trên-phải, nơ hoa ở góc trái
  c.save(); c.beginPath(); c.roundRect(px, py, pw, ph, U * 0.012); c.clip();
  const bw = U * 0.03, bl = Math.min(pw, ph) * 0.24;
  [[px, py, 1], [px + pw, py, -1]].forEach(([x, y, sd]) => {
    const pts = []; for (let i = 0; i <= 8; i++) { const q = i / 8; pts.push([x + sd * (bl * 1.2) * q - sd * bw * 0.6, y + bl * 1.2 * (1 - q) - bw * 0.6]); }
    silk(c, pts, bw, () => 0);
  });
  c.restore();
  const q = s.prog(T(2.2), T(3.6));
  if (q > 0 && q < 1) {
    c.save(); c.beginPath(); c.roundRect(px, py, pw, ph, U * 0.012); c.clip();
    const bx = s.lerp(px - pw * 0.4, px + pw * 1.4, s.ease.inOutCubic(q)), bwid = pw * 0.16;
    c.translate(bx, H / 2); c.rotate(0.35);
    const sg = c.createLinearGradient(-bwid, 0, bwid, 0); sg.addColorStop(0, 'rgba(255,236,200,0)'); sg.addColorStop(0.5, 'rgba(255,236,200,0.13)'); sg.addColorStop(1, 'rgba(255,236,200,0)');
    c.globalCompositeOperation = 'lighter'; c.fillStyle = sg; c.fillRect(-bwid, -H, bwid * 2, H * 2); c.restore();
  }
  const sw = s.physics.pendulum({ amplitude: 0.12, period: 2.2, decay: 0.5, delay: T(0.3) });
  rosette(c, px + Math.min(pw, ph) * 0.1, py + Math.min(pw, ph) * 0.1, U * (portrait ? 0.06 : 0.055), -0.8 + sw);
  c.restore();
}, 0);
const MW = pw * 0.76, ip = (x) => T(0.35 + x);
const ks = portrait ? 1.15 : 1, kg = portrait ? 1.85 : 1;
const TS = { x: W / 2, size: Math.min(pw * 0.095 * ks, U * 0.11), font: 'serif', weight: 700, align: 'center', maxWidth: MW, maxLines: 2, lineHeight: 1.06 };
balance(title, TS);
const mt = measure(title, TS), lh = mt.size * 1.06;
let y = py + ph * (portrait ? 0.17 : 0.14);
caps(inviteLabel, { x: W / 2, y, size: pw * 0.03 * ks, anim: 'fade', start: ip(0), dur: 0.7, maxWidth: MW * 0.82 });
y += pw * 0.045 * kg;
caps(company, { x: W / 2, y, size: pw * 0.023 * ks, color: tone(0.2), letterSpacing: 0.18, anim: 'fade', start: ip(0.1), dur: 0.7, maxWidth: MW * 0.82 });
y += mt.size * 0.95 + pw * 0.03 * kg;
gold(title, Object.assign({ y, anim: 'rise', start: ip(0.2), dur: 0.8, stagger: 0.06 }, TS));
y += (mt.lines - 1) * lh + pw * (portrait ? 0.1 : 0.08);
s.text(subtitle, { x: W / 2, y, size: pw * 0.042 * ks, font: 'serif', italic: true, weight: 400, align: 'center', color: '#f8e9cf', anim: 'rise', start: ip(0.4), dur: 0.7, maxWidth: MW, maxLines: 1 });
y += pw * 0.055 * kg;
rule(W / 2, y, pw * 0.5, s.prog(ip(0.55), ip(1.15)));
y += pw * 0.08 * kg;
const md = s.text(date, { x: W / 2, y, size: pw * 0.042 * ks, font: 'sans', weight: 600, align: 'center', color: '#fff3dc', anim: 'rise', start: ip(0.7), dur: 0.7, maxWidth: MW, maxLines: 1 });
y += md.height - md.size + pw * 0.06 * kg;
const VS = { x: W / 2, size: pw * 0.032 * ks, font: 'sans', weight: 400, align: 'center', maxWidth: MW, maxLines: 2, lineHeight: 1.3 };
balance(venue, VS);
const mv = s.text(venue, Object.assign({ y, color: '#efd9c2', anim: 'rise', start: ip(0.85), dur: 0.7 }, VS));
caps(note, { x: W / 2, y: Math.max(y + mv.height + pw * 0.03, py + ph - ph * 0.09), size: pw * 0.023 * ks, color: tone(0.3), anim: 'fade', start: ip(1.05), dur: 0.7, maxWidth: MW });
`),
  },

  'op-thanks': {
    name: 'Cảm ơn khách',
    desc: 'Bóng bay nổi lên (lực đẩy, lắc theo gió), kim tuyến rơi, đèn rọi; lời cảm ơn nhũ vàng, ưu đãi khai trương, hotline/website',
    duration: 5,
    code: (o = {}) => fix(`
${HEAD}
${F.logo()}
${F.company(o)}
${tf('message', 'message', o.message ?? 'Cảm ơn Quý khách đã *ghé thăm*', 'Lời cảm ơn', 56)}
${F.offer(o)}
${tf('hotline', 'hotline', o.hotline ?? 'Hotline 1900 6868 · anhduong.vn', 'Hotline / website', 48)}
${F.colors(o)}
${KIT}
const k = Math.min(1, d / 5), T = (x) => x * k;
const fadeEnd = ${o.fade ? 'true' : 'false'};
const cy = H * (portrait ? 0.48 : 0.5);
backdrop(cy);
s.camera({ zoom: s.lerp(1.0, 1.05, s.ease.inOutSine(s.p)) });
s.fx.rays({ x: W / 2, y: -H * 0.12, angle: Math.PI / 2, count: 12, length: H * 1.4, color: tone(0.3), opacity: 0.1, seed: 24 });
beams([
  { x: W * 0.2, y: -H * 0.03, a: 1.25, amp: 0.2, f: 0.6, ph: 1.0, w: 0.04, o: 0.28, c: tone(0.35) },
  { x: W * 0.8, y: -H * 0.03, a: 1.89, amp: 0.2, f: 0.6, ph: 4.0, w: 0.04, o: 0.28, c: tone(0.35) },
], 1);
s.fx.bokeh({ count: portrait ? 14 : 22, size: [U * 0.02, U * 0.07], color: tone(0.2), opacity: 0.22, drift: 12, rise: 8, seed: 91 });
balloons({ n: portrait ? 10 : 14, seed: 7, band: portrait ? 0.1 : 0.17, size: portrait ? 0.8 : 1.1, span: d });
glitterRain({ start: -4, stagger: 4 + d, count: 60, seed: 92 });
twinkle(24, 21, 1);
glow(W / 2, cy, U * 0.6, 0.12, accent);
const MS = { x: W / 2, size: U * (portrait ? 0.11 : 0.105), font: 'serif', weight: 700, align: 'center', maxWidth: W * (portrait ? 0.7 : 0.62), maxLines: 2, lineHeight: 1.1 };
balance(message, MS);
const mm = measure(message, MS), y1 = cy + mm.size * 0.3 - ((mm.lines - 1) * mm.size * 1.1) / 2;
let top = y1 - mm.size * 0.95 - U * 0.04;
if (logo && s.has(logo)) s.image(logo, { x: W / 2, y: top - U * 0.12, h: U * 0.11, depth: 0, opacity: s.prog(0, T(0.6)) });
caps(company, { x: W / 2, y: top, size: U * 0.032, anim: 'fade', start: T(0.2), dur: 0.7, maxWidth: W * 0.7 });
gold(message, Object.assign({ y: y1, anim: 'rise', start: T(0.4), dur: 0.9, stagger: 0.06 }, MS));
const yb = y1 + (mm.lines - 1) * mm.size * 1.1;
rule(W / 2, yb + U * 0.075, Math.min(W * 0.5, U * 0.6), s.prog(T(0.9), T(1.7)));
const OS = { x: W / 2, size: U * 0.046, font: 'serif', italic: true, weight: 400, align: 'center', maxWidth: W * (portrait ? 0.7 : 0.66), maxLines: 2, lineHeight: 1.25 };
balance(offer, OS);
s.text(offer, { x: W / 2, y: yb + U * 0.155, size: U * 0.046, font: 'serif', italic: true, weight: 400, align: 'center', color: '#f8e9cf', anim: 'fade', start: T(1.1), dur: 0.8, maxWidth: OS.maxWidth, maxLines: 2, lineHeight: 1.25 });
const mo = measure(offer, OS);
caps(hotline, { x: W / 2, y: yb + U * 0.235 + (mo.lines - 1) * mo.size * 1.25, size: U * 0.03, color: tone(0.4), anim: 'fade', start: T(1.4), dur: 0.8, maxWidth: W * 0.7 });
const fade = fadeEnd ? s.prog(d - 0.6, d) : 0;
if (fade > 0) s.world((c) => { c.fillStyle = 'rgba(0,0,0,' + (fade * 0.85).toFixed(3) + ')'; c.fillRect(-W, -H, W * 3, H * 3); }, 0);
`),
  },

  'op-anniv': {
    name: 'Kỷ niệm X năm thành lập',
    desc: 'Số năm đếm lên nhũ vàng, vòng nguyệt quế mọc dần quanh số, chạm số cuối thì bùng tia lửa + pháo giấy hai bên, vệt sáng lướt; “Kỷ niệm 10 năm thành lập”',
    duration: 6,
    code: (o = {}) => fix(`
${HEAD}
${F.company(o)}
${tf('annivLabel', 'anniv_label', o.anniv_label ?? 'Kỷ niệm', 'Dòng trên số năm', 24)}
${F.years(o)}
${tf('unit', 'anniv_unit', o.anniv_unit ?? 'năm thành lập', 'Dòng dưới số năm', 28)}
${tf('tagline', 'tagline', o.tagline ?? 'Hành trình 2016 – 2026 · Cảm ơn Quý khách đã đồng hành', 'Khẩu hiệu', 64)}
${F.logo()}
${F.colors(o)}
${KIT}
const k = Math.min(1, d / 6), T = (x) => x * k;
const tr = T(2.3);
// Bố cục: công ty → "Kỷ niệm" → vòng nguyệt quế quanh số → dòng dưới → gạch → khẩu hiệu; cả khối căn giữa dọc.
const Y = parseInt(String(years).replace(/[^0-9]/g, ''), 10), isNum = /^\\s*\\d+\\s*$/.test(String(years)) && Y > 0;
const NO = { x: W / 2, size: U * (portrait ? 0.36 : 0.27), font: 'serif', weight: 700, align: 'center', maxWidth: W * 0.56, maxLines: 1 };
const TG = { x: W / 2, size: U * 0.04, font: 'serif', italic: true, weight: 400, align: 'center', maxWidth: W * 0.8, maxLines: 2, lineHeight: 1.3 };
balance(tagline, TG);
const mtg = measure(tagline, TG), extra = (mtg.lines - 1) * mtg.size * 1.3, Rmax = (H * 0.86 - U * 0.33 - extra) / 2;
const numStr = isNum ? String(Y).replace(/[0-9]/g, '0') : String(years);
let mn = measure(numStr, NO), R = Math.max(mn.size * 0.74, mn.width / 2 + U * 0.075);
// số dài (vd. 125 năm) → thu nhỏ số để vòng nguyệt quế + cả khối vẫn vừa khung
if (R > Rmax) { NO.size = mn.size * Math.max(0.4, (Rmax - U * 0.075) / (R - U * 0.075)); mn = measure(numStr, NO); R = Math.min(Rmax, Math.max(mn.size * 0.74, mn.width / 2 + U * 0.075)); }
const zs = mn.size, blockH = U * 0.33 + 2 * R + extra;
const topY = H / 2 - blockH / 2 + U * 0.03, cy = topY + U * 0.1 + R, by = cy + zs * 0.35;
backdrop(cy);
const kick = t > tr ? Math.exp(-(t - tr) * 4.5) : 0;
s.camera({ zoom: s.lerp(1.0, 1.07, s.ease.inOutSine(s.p)), shake: 0.4 + 7 * kick });
s.fx.rays({ x: W / 2, y: cy, angle: -Math.PI / 2, count: 14, length: U * 1.2, color: tone(0.3), opacity: 0.05 + 0.1 * s.smoothstep(tr, tr + 0.5, t), seed: 6 });
s.fx.bokeh({ count: portrait ? 16 : 22, size: [U * 0.02, U * 0.07], color: tone(0.2), opacity: 0.22, drift: 12, rise: 8, seed: 51 });
twinkle(26, 13, 0.4 + 0.6 * s.smoothstep(tr, tr + 0.6, t));
// Số năm đếm lên (0 → N) chậm dần như đồng hồ cơ; giá trị không phải số thì hiện nguyên văn.
const cu = s.ease.outCubic(s.prog(T(0.5), tr)), shown = isNum ? String(Math.min(Y, Math.round(Y * cu))) : String(years);
laurel(W / 2, cy, R, s.ease.inOutCubic(s.prog(T(0.4), tr + 0.2)));
glow(W / 2, cy, U * 0.7, 0.5 * kick + 0.1 * s.smoothstep(T(0.3), T(1.2), t), accent);
const pop = 1 + 0.1 * kick, nal = s.smoothstep(T(0.3), T(0.8), t);
if (nal > 0.002) {
  s.ctx.save(); s.ctx.globalAlpha = nal; s.ctx.translate(W / 2, cy); s.ctx.scale(pop, pop); s.ctx.translate(-W / 2, -cy);
  gold(shown, Object.assign({ y: by, anim: 'none' }, NO));
  s.ctx.restore();
}
if (t > tr) s.world((c) => {
  const q = s.ease.outCubic(s.prog(tr, tr + 1.2)), RR = s.lerp(R * 0.6, U * 0.95, q);
  c.save(); c.globalCompositeOperation = 'lighter'; c.strokeStyle = s.rgba(tone(0.4), 0.5 * (1 - q)); c.lineWidth = U * 0.006 * (1 - q) + 1;
  c.beginPath(); c.arc(W / 2, cy, RR, 0, TAU); c.stroke(); c.restore();
}, 0);
s.fx.burst({ kind: 'spark', x: W / 2, y: cy, start: tr, count: 80, angle: -Math.PI / 2, spread: TAU, speed: [U * 0.5, U * 1.6],
  size: [U * 0.004, U * 0.009], gravity: U * 0.55, drag: 1.1, life: 1.8, colors: [tone(0.7), '#ffffff', accent], seed: 61 });
cannons(tr + 0.05, 63, { streamers: true });
sweep(tr + 0.2, tr + 1.5, 0.15);
if (logo && s.has(logo)) s.image(logo, { x: W / 2, y: topY - U * 0.11, h: U * 0.1, depth: 0, opacity: s.prog(T(0.1), T(0.7)) });
caps(company, { x: W / 2, y: topY, size: U * 0.03, anim: 'fade', start: T(0.1), dur: 0.7, maxWidth: W * 0.8 });
s.text(annivLabel, { x: W / 2, y: cy - R + U * 0.01, size: U * 0.06, font: 'serif', italic: true, weight: 400, align: 'center', color: tone(0.55),
  anim: 'fade', start: T(0.2), dur: 0.8, maxWidth: W * 0.5, maxLines: 1, shadow: false });
caps(unit, { x: W / 2, y: cy + R + U * 0.075, size: U * 0.04, color: tone(0.45), letterSpacing: 0.3, anim: 'rise', start: tr - 0.2, dur: 0.7, maxWidth: W * 0.7 });
rule(W / 2, cy + R + U * 0.12, Math.min(W * 0.5, U * 0.6), s.prog(tr + 0.1, tr + 0.9));
s.text(tagline, Object.assign({ y: cy + R + U * 0.19, color: '#f8e9cf', anim: 'fade', start: tr + 0.3, dur: 0.8 }, TG));
`),
  },
};

// Hậu kỳ gợi ý cho bộ khai trương (merge vào project.style khi dựng từ công thức theo mùa).
const STYLE = { grade: 'warm', bloom: 0.32, vignette: 0.42, grain: 0.03, letterbox: 0 };

/** Quick recipes (season-tagged). scenes: [{ scene, duration?, opts?, transition? }] */
export const RECIPES = [
  {
    id: 'opening-teaser', name: 'Khai trương · Teaser 8s', aspect: '16:9 · 9:16', season: 'opening', style: STYLE,
    desc: 'Cắt băng lụa (vật lý dây) + pháo giấy hai bên “Khai Trương Hồng Phát” → thư mời: cửa hàng, ngày giờ, địa điểm',
    scenes: [
      { scene: 'op-ribbon', duration: 4.5 },
      { scene: 'op-invite', duration: 3.5, transition: { type: 'dissolve', duration: 0.6 } },
    ],
  },
  {
    id: 'opening-countdown', name: 'Khai trương · Countdown 5→0 (8s)', aspect: '16:9 · 9:16', season: 'opening', style: STYLE,
    desc: 'Đếm ngược 5 → 0 trong vòng bóng đèn marquee, về 0 thì pháo giấy, tia lửa và “Khai Trương Hồng Phát” (chiếu LED trước giờ cắt băng)',
    scenes: [{ scene: 'op-countdown', duration: 8 }],
  },
  {
    id: 'opening-thanks', name: 'Khai trương · Cảm ơn khách 10s', aspect: '16:9 · 9:16', season: 'opening', style: STYLE,
    desc: 'Tiêu đề khai trương + pháo giấy, đèn quét → bóng bay, lời cảm ơn, ưu đãi khai trương, hotline',
    scenes: [
      { scene: 'op-title', duration: 5 },
      { scene: 'op-thanks', duration: 5, transition: { type: 'dissolve', duration: 0.6 }, opts: { fade: true } },
    ],
  },
  {
    id: 'opening-anniversary', name: 'Kỷ niệm · X năm thành lập 11s', aspect: '16:9 · 9:16', season: 'opening', style: STYLE,
    desc: 'Số năm đếm lên trong vòng nguyệt quế vàng, bùng tia lửa + pháo giấy → tri ân khách hàng & đối tác',
    scenes: [
      { scene: 'op-anniv', duration: 6 },
      { scene: 'op-thanks', duration: 5, transition: { type: 'dissolve', duration: 0.6 }, opts: { message: 'Tri ân Quý khách đã *đồng hành*', offer: 'Ưu đãi tri ân: giảm 10% cho mọi đơn hàng trong tháng kỷ niệm', fade: true } },
    ],
  },
];
