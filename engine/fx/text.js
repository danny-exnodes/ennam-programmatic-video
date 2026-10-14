// Kinetic typography and line icons. Text supports *highlight* markup:
// "Sáng mịn, *tươi tắn*" renders "tươi tắn" in the accent color.
import { clamp, ease, lerp, rgba, TAU } from '../math.js';

export const FONTS = {
  sans: '"Be Vietnam Pro", "Helvetica Neue", Arial, sans-serif',
  serif: '"Playfair Display", Georgia, serif',
};

function parseRuns(str) {
  const runs = [];
  const re = /\*([^*]+)\*/g;
  let last = 0, m;
  while ((m = re.exec(str))) {
    if (m.index > last) runs.push({ text: str.slice(last, m.index), hi: false });
    runs.push({ text: m[1], hi: true });
    last = m.index + m[0].length;
  }
  if (last < str.length) runs.push({ text: str.slice(last), hi: false });
  // split into words, keep run flag
  const words = [];
  for (const r of runs) {
    const parts = r.text.split(/(\s+)/);
    for (const p of parts) if (p) words.push({ text: p, hi: r.hi, space: /^\s+$/.test(p) });
  }
  return words;
}

/**
 * opts: x,y,size,font('sans'|'serif'|css),weight,color,accent,align('left'|'center'|'right'),
 * anim('rise'|'fade'|'blur'|'type'|'wipe'|'pop'|'none'), start, dur, stagger, out (s, fade out start),
 * shadow (bool|number), letterSpacing (em), maxWidth (wrap), lineHeight
 * Returns {width, height, x0, y0} of laid out block.
 */
export function text(ctx, t, str, o = {}) {
  const size = o.size ?? 72;
  const weight = o.weight ?? 700;
  const fam = FONTS[o.font ?? 'sans'] ?? o.font;
  const color = o.color ?? '#ffffff';
  const accent = o.accent ?? '#f5b54a';
  const start = o.start ?? 0;
  const dur = o.dur ?? 0.8;
  const stagger = o.stagger ?? 0.06;
  const anim = o.anim ?? 'rise';
  const lh = (o.lineHeight ?? 1.18) * size;
  ctx.save();
  ctx.font = `${o.italic ? 'italic ' : ''}${weight} ${size}px ${fam}`;
  ctx.textBaseline = 'alphabetic';
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${(o.letterSpacing ?? 0) * size}px`;
  const words = parseRuns(String(str));
  // layout with wrapping
  const lines = [[]];
  let lineW = 0;
  const maxW = o.maxWidth ?? Infinity;
  for (const w of words) {
    if (w.text === '\n') { lines.push([]); lineW = 0; continue; }
    const ww = ctx.measureText(w.text).width;
    if (!w.space && lineW + ww > maxW && lines[lines.length - 1].length) {
      lines.push([]);
      lineW = 0;
    }
    if (w.space && lines[lines.length - 1].length === 0) continue;
    lines[lines.length - 1].push({ ...w, w: ww });
    lineW += ww;
  }
  const align = o.align ?? 'left';
  let idx = 0;
  let blockW = 0;
  const outK = o.out != null ? clamp((t - o.out) / (o.outDur ?? 0.5)) : 0;
  lines.forEach((line, li) => {
    const lw = line.reduce((s, w) => s + w.w, 0);
    blockW = Math.max(blockW, lw);
    let cx = align === 'center' ? (o.x ?? 0) - lw / 2 : align === 'right' ? (o.x ?? 0) - lw : (o.x ?? 0);
    const cy = (o.y ?? 0) + li * lh;
    for (const w of line) {
      if (w.space) { cx += w.w; continue; }
      const k = anim === 'none' ? 1 : clamp((t - start - idx * stagger) / dur);
      const e = ease.outCubic(k);
      let dx = 0, dy = 0, a = e, blur = 0, sc = 1;
      if (anim === 'rise') { dy = (1 - e) * size * 0.6; }
      else if (anim === 'blur') { blur = (1 - e) * size * 0.25; sc = lerp(1.08, 1, e); }
      else if (anim === 'pop') { sc = ease.outBack(k) ; a = clamp(k * 3); }
      else if (anim === 'type') { a = k > 0 ? 1 : 0; }
      a *= 1 - outK;
      dy -= outK * size * 0.3;
      if (a > 0.001) {
        ctx.save();
        ctx.globalAlpha *= a;
        if (blur > 0.3) ctx.filter = `blur(${blur.toFixed(1)}px)`;
        if (o.shadow !== false) {
          ctx.shadowColor = 'rgba(0,0,0,0.45)';
          ctx.shadowBlur = typeof o.shadow === 'number' ? o.shadow : size * 0.25;
          ctx.shadowOffsetY = size * 0.04;
        }
        ctx.translate(cx + dx + w.w / 2, cy + dy - size * 0.35);
        ctx.scale(sc, sc);
        ctx.fillStyle = w.hi ? accent : color;
        if (anim === 'wipe') {
          ctx.beginPath();
          ctx.rect(-w.w / 2 - 2, -size, (w.w + 4) * e, size * 2);
          ctx.clip();
        }
        ctx.fillText(w.text, -w.w / 2, size * 0.35);
        ctx.restore();
      }
      cx += w.w;
      idx++;
    }
  });
  ctx.restore();
  return { width: blockW, height: lines.length * lh, lines: lines.length, words: idx };
}

/** Animated underline / accent bar that draws in. */
export function underline(ctx, t, o = {}) {
  const k = ease.outExpo(clamp((t - (o.start ?? 0)) / (o.dur ?? 0.7)));
  if (k <= 0) return;
  const x = o.x ?? 0, y = o.y ?? 0, w = (o.width ?? 300) * k;
  const th = o.thickness ?? 5;
  ctx.save();
  const g = ctx.createLinearGradient(x, 0, x + (o.width ?? 300), 0);
  const c = o.color ?? '#f08a12';
  g.addColorStop(0, rgba(c, 1));
  g.addColorStop(1, rgba(o.color2 ?? c, o.fadeEnd === false ? 1 : 0.15));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(x, y - th / 2, w, th, th / 2) : ctx.rect(x, y - th / 2, w, th);
  ctx.fill();
  ctx.restore();
}

// 24x24 line icons (stroke paths), Lucide-like geometry drawn from scratch.
const ICONS = {
  drop: 'M12 3 C12 3 5.5 10.2 5.5 14.5 A6.5 6.5 0 0 0 18.5 14.5 C18.5 10.2 12 3 12 3 Z',
  sun: 'M12 8 A4 4 0 1 0 12 16 A4 4 0 1 0 12 8 Z M12 2 V4 M12 20 V22 M4.9 4.9 L6.3 6.3 M17.7 17.7 L19.1 19.1 M2 12 H4 M20 12 H22 M4.9 19.1 L6.3 17.7 M17.7 6.3 L19.1 4.9',
  shield: 'M12 3 L19 6 V11.5 C19 16 16 19.5 12 21 C8 19.5 5 16 5 11.5 V6 Z',
  leaf: 'M5 19 C5 10 11 5 20 4 C19 13 14 19 5 19 Z M5 19 L13 11',
  sparkle: 'M12 3 L13.8 10.2 L21 12 L13.8 13.8 L12 21 L10.2 13.8 L3 12 L10.2 10.2 Z',
  heart: 'M12 20 C12 20 3.5 14.5 3.5 8.8 A4.3 4.3 0 0 1 12 7 A4.3 4.3 0 0 1 20.5 8.8 C20.5 14.5 12 20 12 20 Z',
  check: 'M4.5 12.5 L9.5 17.5 L19.5 6.5',
  star: 'M12 3 L14.7 8.8 L21 9.5 L16.3 13.8 L17.6 20 L12 16.9 L6.4 20 L7.7 13.8 L3 9.5 L9.3 8.8 Z',
  bolt: 'M13 2 L4 14 H11 L10 22 L20 9 H13 Z',
  flask: 'M9 3 H15 M10 3 V9 L4.5 18.5 A1.6 1.6 0 0 0 5.9 21 H18.1 A1.6 1.6 0 0 0 19.5 18.5 L14 9 V3 M7 15 H17',
  clock: 'M12 3 A9 9 0 1 0 12 21 A9 9 0 1 0 12 3 Z M12 7 V12 L15.5 14',
  moon: 'M20 14.5 A8 8 0 1 1 9.5 4 A6.5 6.5 0 0 0 20 14.5 Z',
  wave: 'M2 12 C5 8 7 8 10 12 C13 16 15 16 18 12 C19.5 10 20.8 9.5 22 9.5 M2 17 C5 13 7 13 10 17 C13 21 15 21 18 17',
  gift: 'M3 9 H21 V13 H3 Z M5 13 V21 H19 V13 M12 9 V21 M12 9 C9 9 7 7.5 8 5.5 C9 4 11 5.5 12 9 C13 5.5 15 4 16 5.5 C17 7.5 15 9 12 9',
  cart: 'M3 4 H6 L8.5 15 H18.5 L21 7 H7 M9 20 A1 1 0 1 0 9 18 A1 1 0 1 0 9 20 M18 20 A1 1 0 1 0 18 18 A1 1 0 1 0 18 20',
  arrow: 'M5 12 H19 M13 6 L19 12 L13 18',
  play: 'M8 5 L19 12 L8 19 Z',
  snow: 'M12 2 V22 M3.3 7 L20.7 17 M3.3 17 L20.7 7',
  fire: 'M12 22 C7.5 22 5 18.8 5 15.2 C5 10.5 9.5 8.5 9.5 3.5 C12.5 5.5 14 8 13.8 11 C15 10 15.5 8.8 15.6 7.5 C17.8 9.5 19 12.3 19 15.2 C19 18.8 16.5 22 12 22 Z',
};
const pathCache = new Map();
export function icon(ctx, name, o = {}) {
  const d = ICONS[name] || name;
  let p = pathCache.get(d);
  if (!p) { p = new Path2D(d); pathCache.set(d, p); }
  const s = (o.size ?? 48) / 24;
  ctx.save();
  ctx.translate((o.x ?? 0) - 12 * s, (o.y ?? 0) - 12 * s);
  ctx.scale(s, s);
  ctx.lineWidth = (o.stroke ?? 1.6);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = o.color ?? '#fff';
  if (o.fill) { ctx.fillStyle = o.fill; ctx.fill(p); }
  ctx.stroke(p);
  ctx.restore();
}
export const ICON_NAMES = Object.keys(ICONS);

/** Feature badge: ring + icon + label, pops in with spring-like overshoot. */
export function badge(ctx, t, o = {}) {
  const k = clamp((t - (o.start ?? 0)) / (o.dur ?? 0.6));
  if (k <= 0) return;
  const s = ease.outBack(k);
  const x = o.x ?? 0, y = o.y ?? 0, R = (o.size ?? 120) / 2;
  const color = o.color ?? '#ffffff';
  const ring = o.ring ?? '#f5c27a';
  ctx.save();
  ctx.globalAlpha *= clamp(k * 2.5);
  ctx.translate(x, y);
  ctx.scale(s, s);
  // glass disc
  const g = ctx.createRadialGradient(-R * 0.3, -R * 0.4, R * 0.1, 0, 0, R);
  g.addColorStop(0, 'rgba(255,255,255,0.18)');
  g.addColorStop(1, 'rgba(0,0,0,0.25)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, R, 0, TAU);
  ctx.fill();
  ctx.lineWidth = Math.max(2, R * 0.045);
  ctx.strokeStyle = ring;
  ctx.beginPath();
  ctx.arc(0, 0, R, -Math.PI / 2, -Math.PI / 2 + TAU * ease.outCubic(clamp(k * 1.4)));
  ctx.stroke();
  icon(ctx, o.icon ?? 'sparkle', { size: R * 0.95, color, stroke: 1.5 });
  ctx.restore();
  if (o.label) {
    text(ctx, t, o.label, {
      x, y: y + R * 1.55 + (o.labelSize ?? R * 0.42), size: o.labelSize ?? R * 0.42, weight: 700,
      align: 'center', color, anim: 'rise', start: (o.start ?? 0) + 0.15, dur: 0.6, stagger: 0,
    });
  }
}
