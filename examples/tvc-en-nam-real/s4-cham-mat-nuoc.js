//@include common.js
// S4 — Chạm mặt nước: quay chậm 0,2x, hố nước, cột nước, giọt phụ, gợn sóng làm méo vệt nắng.
const probe = s.nature({ wind: WIND, until: 8 }).leaf(LEAF);
const T0 = probe.impact[0] ?? 4.5;
const P0 = probe.impactAt[0] ?? [0.04, 0, 0.17];
const simT = T0 - 0.12 + 0.2 * s.t + 0.3 * Math.max(0, s.t - 3.2) ** 2 / 2;
const e = s.ease.inOutSine(s.p);
const sc = s.nature({
  time: simT,
  camera: { x: P0[0] + 0.12 + s.lerp(-0.03, 0.02, e), height: 0.07, z: P0[2] - 0.42 + 0.06 * e, pitch: 0.06, yaw: -0.3, fov: 38, focus: 0.42, aperture: 2.2 },
  wind: WIND, sun: { ...SUN, elevation: 0.2, rays: 0.25 }, sky: { top: '#dfe4e0', horizon: '#e8ebe4' }, until: 8,
});
// real forest photo as the far bank (reflected in the water)
const cx = P0[0] + 0.12 + Math.sin(-0.3) * 18, cz = P0[2] - 0.42 + Math.cos(-0.3) * 18;
sc.plate({ image: 'river', x: cx, z: cz, y: -0.6, height: 22, width: 48, crop: [0, 0, 1, 0.68], exposure: 1.5, saturation: 1.1 });
sc.water({ flow: [0.12, 0], depth: 0.55, farZ: 17.6, foam: 0.3, simArea: [P0[0] - 0.6 - 0.12 * T0, P0[2] - 0.5, P0[0] + 0.6 - 0.12 * T0, P0[2] + 0.7] });
sc.leaves({ count: 14, start: -5, end: 6, colors: 'mixed', z: [0.7, 3], size: [0.04, 0.07], seed: 11 });
sc.leaf(LEAF);
sc.render();
// match the photographic shots: a touch more contrast & colour
s.ctx.save();
s.ctx.setTransform(1, 0, 0, 1, 0, 0);
s.ctx.filter = 'contrast(1.2) saturate(1.12) brightness(0.97)';
s.ctx.drawImage(s.ctx.canvas, 0, 0);
s.ctx.restore();
