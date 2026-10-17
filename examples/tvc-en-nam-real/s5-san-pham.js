//@include common.js
// S5 — Én Nam bên thác: chai đặt trên phiến đá trước thác nhỏ; máy đẩy vào, chuyển nét từ thác về chai.
const e = s.ease.inOutSine(s.p);
const rack = s.ease.inOutCubic(s.prog(0.6, 2.4));
const ph = s.photo({
  image: 'waterfall',
  frame: { zoom: 1.2, x: 0.56, y: 0.58 },
  camera: { zoom: s.lerp(1.0, 1.08, e), dolly: s.lerp(0.0, 0.12, e), truck: [s.lerp(-0.02, 0.012, e), s.lerp(0.006, -0.004, e)], handheld: 0.4 },
  wind: { speed: 0.7, gust: 0.6, seed: 9 },
  flow: { amount: 0.03, rate: 0.7, glint: 0.4 },
  sway: { amount: 0.8 },
  dof: { focus: 0.35, focusAt: [0.45, 0.735], focusMix: rack, aperture: 34, max: 18 },
  grade: { exposure: 1.45, temperature: 0.18, saturation: 1.12, contrast: 0.12, shadows: '#e2efec', highlights: '#fff6e4' },
  bloom: 0.3, bloomThreshold: 0.4,
  light: { x: -0.6, y: -0.75 }, sunIntensity: 1.0,
});
ph.bottle({ u: 0.45, v: 0.748, height: 560, frost: 0.45, drops: 80, seed: 21, brightness: 0.78, saturate: 0.85, contrast: 0.95, blur: s.lerp(6, 0.5, rack), sky: '#9aa8a2', tint: '#d9e8e4' });
