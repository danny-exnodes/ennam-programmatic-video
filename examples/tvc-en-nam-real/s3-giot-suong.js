//@include common.js
// S3 — Giọt sương: macro chiếc lá, lấy nét dần vào lá; giọt nước ở mũi lá lớn dần, kéo dài rồi rơi (quay chậm).
const t = s.t;
const pull = s.ease.inOutCubic(s.prog(0.0, 1.6));
const ph = s.photo({
  image: 'leaf',
  frame: { zoom: 1.35, x: 0.66, y: 0.52 },
  camera: { zoom: s.lerp(1.0, 1.06, s.ease.inOutSine(s.p)), dolly: 0.06, truck: [s.lerp(0.006, -0.006, s.p), 0], handheld: 0.35 },
  wind: { speed: 0.6, gust: 0.6, seed: 2 },
  sway: { amount: 0.35, freq: 0.8 },
  dof: { focus: s.lerp(0.15, 0.85, pull), aperture: 9, max: 22 },
  grade: { exposure: 1.3, temperature: 0.1, saturation: 1.45, contrast: 0.18, shadows: '#e4efe8', highlights: '#dcffb8' },
  bloom: 0.3, bloomThreshold: 0.35,
  light: { x: -0.4, y: -0.9 },
});
// dew resting on the leaf surface
const dew = [[0.7, 0.52, 6], [0.745, 0.6, 4.5], [0.64, 0.47, 3.5], [0.86, 0.66, 4], [0.69, 0.42, 3], [0.78, 0.55, 2.6], [0.42, 0.3, 4], [0.47, 0.22, 3], [0.6, 0.27, 3.2]];
for (const [u, v, r] of dew) ph.drop({ u, v, r: r * 2.2, mode: 'sessile', sy: 0.85 });
// pendant drop at the leaf tip: grows, stretches, pinches off at tDet, falls (slow motion)
const tip = ph.toScreen(0.798, 0.722);
const tDet = 3.1;
if (t < tDet) {
  const g = s.clamp(t / tDet);
  const r = s.lerp(14, 26, Math.sqrt(g));
  const stretch = s.lerp(0.1, 0.9, Math.pow(g, 3)) + 0.04 * Math.sin(t * 9);
  ph.drop({ x: tip[0] - 2, y: tip[1] - 3, r, mode: 'pendant', stretch, beta: 0.25 });
} else {
  const dt = t - tDet;
  const y = tip[1] + 22 + 0.5 * 2600 * dt * dt + 60 * dt;
  const wob = 0.12 * Math.exp(-dt * 3) * Math.sin(dt * 34);
  ph.drop({ x: tip[0] + 4 + dt * 14, y, r: 24, sx: 1 + wob, sy: 1 - wob, mode: 'ball', fov: 7 });
  // the tip springs back with a tiny remnant drop
  ph.drop({ x: tip[0] - 2, y: tip[1] - 3 - 3 * Math.exp(-dt * 6) * Math.sin(dt * 30), r: 9, mode: 'pendant', stretch: 0.1, beta: 0.25 });
}
