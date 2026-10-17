// Measurable QA for the AI director: turns the per-shot metrics returned by
// window.__inspect (public/render-page.js) into concrete issues, and describes
// them as short Vietnamese text for the director's repair feedback.
//
// Metrics are sampled at a few fixed times per shot (default 3: d/6, d/2, 5d/6),
// pixel stats are taken BEFORE post (grade/vignette/grain), at inspect scale 0.5.

/** Near-black: mean luma below this (0..255)… */
export const QA_BLACK_MEAN = 8;
/** …and at most this share of pixels brighter than luma 20 (a tiny logo on black still passes). */
export const QA_BLACK_BRIGHT_MAX = 0.001;
/** Blank: luma standard deviation below this (flat single-colour frame). */
export const QA_BLANK_STD = 2;
/** Black/blank only counts when at least this share of a shot's samples are affected. */
export const QA_FRAME_SHARE = 0.5;
/** Text must stay inside the safe area: this share of width/height from every edge. */
export const QA_SAFE_MARGIN = 0.06;
/** Tolerance in project pixels before text counts as outside the safe area. */
export const QA_SAFE_TOLERANCE_PX = 2;
/** Median render time per frame (ms, inspect scale) above this → too slow. */
export const QA_SLOW_MS = 500;

export const QA_CODES = ['throw', 'black', 'blank', 'text_safe_area', 'slow'];

/** A runtime throw or a syntax error (the shot cannot run) — not just a warning like a missing asset. */
export function isRuntimeFailure(msg) {
  return /Lỗi khi chạy|Lỗi cú pháp/.test(String(msg || ''));
}

const median = (a) => {
  const v = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const fmtT = (ts) => ts.map((t) => t.toFixed(1) + 's').join(', ');

/**
 * insp: { errors, metrics, width, height } from inspectProject().
 * Returns { [shotId]: [{ code, msg }] } — only shots with issues.
 */
export function qaIssues(project, insp = {}) {
  const out = {};
  const add = (id, code, msg) => (out[id] ||= []).push({ code, msg });
  const W = insp.width || project.width || 1920, H = insp.height || project.height || 1080;
  const sx0 = W * QA_SAFE_MARGIN, sx1 = W * (1 - QA_SAFE_MARGIN);
  const sy0 = H * QA_SAFE_MARGIN, sy1 = H * (1 - QA_SAFE_MARGIN);
  const tol = QA_SAFE_TOLERANCE_PX;
  for (const sh of project.shots) {
    const err = insp.errors?.[sh.id];
    if (err && isRuntimeFailure(err)) add(sh.id, 'throw', String(err).split('\n').find(isRuntimeFailure));
    const samples = insp.metrics?.[sh.id]?.samples || [];
    if (!samples.length) continue;
    const need = Math.max(1, Math.ceil(samples.length * QA_FRAME_SHARE));
    const black = samples.filter((m) => m.mean < QA_BLACK_MEAN && m.bright <= QA_BLACK_BRIGHT_MAX);
    const blank = samples.filter((m) => !black.includes(m) && m.std < QA_BLANK_STD);
    if (black.length >= need) {
      add(sh.id, 'black', `khung đen/gần đen ở t=${fmtT(black.map((m) => m.t))} (độ sáng TB ${Math.max(...black.map((m) => m.mean)).toFixed(1)}/255) — kiểm tra nền, ảnh có tải được không, opacity`);
    } else if (blank.length >= need) {
      add(sh.id, 'blank', `khung trống một màu ở t=${fmtT(blank.map((m) => m.t))} (phương sai độ sáng ≈ ${(Math.max(...blank.map((m) => m.std)) ** 2).toFixed(1)}) — chưa vẽ nội dung/sản phẩm?`);
    }
    const bad = new Map();
    for (const m of samples) {
      for (const r of m.text || []) {
        const over = [];
        if (r.x < sx0 - tol) over.push(`trái ${Math.round(sx0 - r.x)}px`);
        if (r.x + r.w > sx1 + tol) over.push(`phải ${Math.round(r.x + r.w - sx1)}px`);
        if (r.y < sy0 - tol) over.push(`trên ${Math.round(sy0 - r.y)}px`);
        if (r.y + r.h > sy1 + tol) over.push(`dưới ${Math.round(r.y + r.h - sy1)}px`);
        if (over.length && !bad.has(r.text)) bad.set(r.text, `"${r.text}" (t=${m.t.toFixed(1)}s, tràn ${over.join(', ')})`);
      }
    }
    if (bad.size) {
      add(sh.id, 'text_safe_area', `chữ ra ngoài vùng an toàn ${Math.round(QA_SAFE_MARGIN * 100)}% (khung an toàn x ${Math.round(sx0)}–${Math.round(sx1)}, y ${Math.round(sy0)}–${Math.round(sy1)}): ${[...bad.values()].slice(0, 3).join('; ')} — dùng maxWidth/align hoặc dời vào trong`);
    }
    const ms = median(samples.map((m) => m.ms));
    if (ms != null && ms > QA_SLOW_MS) {
      add(sh.id, 'slow', `quá chậm: ~${Math.round(ms)} ms/khung (ngưỡng ${QA_SLOW_MS} ms ở render thử) — giảm vòng lặp/số hạt, không tạo canvas mỗi khung, tránh blur lớn`);
    }
  }
  return out;
}

/** Concise Vietnamese list for the director (one line per issue). */
export function describeQa(project, issues) {
  const lines = [];
  for (const [id, list] of Object.entries(issues)) {
    const s = project.shots.find((x) => x.id === id);
    for (const it of list) lines.push(`- Shot "${s ? s.name : id}" (id ${id}): ${it.msg}`);
  }
  return lines.join('\n');
}

/** Compact numbers for logs: "Shot A: sáng 34/σ12, 41 ms". */
export function metricsLine(project, insp = {}) {
  return project.shots.map((sh) => {
    const sm = insp.metrics?.[sh.id]?.samples || [];
    if (!sm.length) return null;
    const mean = sm.reduce((a, m) => a + m.mean, 0) / sm.length;
    const std = sm.reduce((a, m) => a + m.std, 0) / sm.length;
    const ms = median(sm.map((m) => m.ms));
    return `${sh.name}: sáng ${mean.toFixed(0)}/σ${std.toFixed(0)}${ms != null ? `, ${Math.round(ms)} ms` : ''}`;
  }).filter(Boolean).join(' · ');
}
