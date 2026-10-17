//@include common.js
// S1 — Đại ngàn trong sương: flycam tiến chậm và nâng nhẹ, sương trôi qua rặng thông, cây cỏ lay trong gió.
const e = s.ease.inOutSine(s.p);
s.photo({
  image: 'fogland',
  frame: { zoom: 1.08, y: 0.52 },
  camera: { zoom: s.lerp(1.0, 1.05, e), dolly: s.lerp(0, 0.09, e), truck: [s.lerp(-0.014, 0.014, e), s.lerp(0.012, -0.01, e)], handheld: 0.5 },
  wind: { speed: 1.0, gust: 0.8, seed: 3 },
  sway: { amount: 1.1, freq: 0.9 },
  fog: { amount: 0.38, speed: 0.05, scale: 0.9, near: 0.0, color: '#e2e7e4' },
  dof: { focus: 0.6, aperture: 3 },
  rays: { x: 0.62, y: -0.05, amount: 0.25, color: '#fff3dc' },
  grade: { exposure: 1.05, temperature: 0.2, saturation: 1.08, contrast: 0.14, shadows: '#e6f0ee', highlights: '#fff8ec' },
  bloom: 0.2,
});
