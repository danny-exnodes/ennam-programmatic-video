//@include common.js
// S2 — Dòng nước qua rừng: máy trượt ngang chậm dọc bờ sông, nước chảy xiết qua ghềnh đá, sương tan trên ngọn thông.
const e = s.ease.inOutSine(s.p);
const ph = s.photo({
  image: 'river',
  frame: { zoom: 1.1, y: 0.55 },
  camera: { zoom: s.lerp(1.02, 1.07, e), dolly: 0.05, truck: [s.lerp(0.02, -0.02, e), 0], handheld: 0.5 },
  wind: { speed: 0.9, gust: 0.7, seed: 5 },
  flow: { amount: 0.024, rate: 0.55, glint: 0.35 },
  sway: { amount: 0.9 },
  fog: { amount: 0.22, speed: 0.04, scale: 1.3, near: 0.0, top: 1, color: '#eef0ec' },
  dof: { focus: 0.45, aperture: 2.5 },
  rays: { x: 0.42, y: 0.02, amount: 0.3, color: '#fff2d6' },
  grade: { exposure: 1.12, temperature: 0.12, saturation: 1.05, contrast: 0.12, shadows: '#e8f2f0', highlights: '#fff6e6' },
  bloom: 0.25,
});
// foreground tree on the near bank (cut-out photo), out of focus, framing the river
ph.tree({ image: 'tree-ash', u: 0.07, v: 1.1, depth: 1.25, height: 1300, sway: 1.2, flutter: 1.4, blur: 8, exposure: 0.55, saturation: 1.0, tint: '#eef2dc', seed: 2 });
