//@include common.js
// S6 — Packshot: cùng phiến đá bên thác, hậu cảnh nhoè sâu; tên thương hiệu & slogan.
const e = s.ease.outCubic(s.p);
const ph = s.photo({
  image: 'waterfall',
  frame: { zoom: 1.3, x: 0.62, y: 0.6 },
  camera: { zoom: s.lerp(1.0, 1.03, e), dolly: 0.04, truck: [s.lerp(0.006, -0.004, e), 0], handheld: 0.25 },
  wind: { speed: 0.6, gust: 0.5, seed: 9 },
  flow: { amount: 0.03, rate: 0.7, glint: 0.4 },
  dof: { focus: 0.95, aperture: 16, max: 26 },
  grade: { exposure: 1.4, temperature: 0.2, saturation: 1.05, contrast: 0.1, shadows: '#e2efec', highlights: '#fff6e4' },
  bloom: 0.35, bloomThreshold: 0.35,
  light: { x: -0.6, y: -0.75 },
});
const { W, H } = s;
ph.bottle({ x: W * 0.32, y: H * 0.86, height: 640, frost: 0.4, drops: 70, seed: 21, brightness: 0.85, saturate: 0.9, sky: '#9aa8a2', tint: '#d9e8e4' });
s.text('Én Nam', { x: W * 0.7, y: H * 0.45, size: 132, font: 'serif', weight: 700, anim: 'blur', start: 0.5, dur: 1.0, color: '#ffffff', shadow: true });
s.text('Tinh khiết từ *đại ngàn*', { x: W * 0.7, y: H * 0.45 + 78, size: 46, weight: 600, anim: 'rise', start: 1.1, dur: 0.8, color: '#f4f8f2', accent: '#bfe6a8', shadow: true });
s.underline({ x: W * 0.7 - 120, y: H * 0.45 + 108, width: 240, start: 1.6, color: '#bfe6a8' });
s.text('NƯỚC KHOÁNG THIÊN NHIÊN', { x: W * 0.7, y: H * 0.45 + 160, size: 24, weight: 600, anim: 'fade', start: 1.8, dur: 0.8, color: '#e8f1ea' });
