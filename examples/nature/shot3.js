//@include common.js
const { t, W, H } = s;
// probe the shared simulation for the drop's impact time & place
const probe = s.nature({ wind: WIND, until: 8 }).leaf(LEAF);
const T0 = probe.impact[0] ?? 4.5;
const P0 = probe.impactAt[0] ?? [0.04, 0, 0.17];
// slow motion: 0.2x around the impact, easing back to 0.5x
const simT = T0 - 0.12 + 0.2 * t + 0.3 * Math.max(0, t - 3.6) ** 2 / 2;
const e = s.ease.inOutSine(s.p);
const sc = s.nature({
  time: simT,
  camera: { x: P0[0] + 0.12 + s.lerp(-0.03, 0.02, e), height: 0.07, z: P0[2] - 0.42 + 0.06 * e, pitch: 0.06, yaw: -0.3, fov: 38, focus: 0.42, aperture: 2.2 },
  wind: WIND, sun: SUN, sky: SKY, until: 8,
});
sc.sky();
sc.treeline({ z: 16, height: 4.2, color: '#26391f' });
sc.water({ flow: [0.12, 0], depth: 0.55, farZ: 15.6, foam: 0.3, simArea: [P0[0] - 0.6 - 0.12 * T0, P0[2] - 0.5, P0[0] + 0.6 - 0.12 * T0, P0[2] + 0.7] });
sc.leaves({ count: 14, start: -5, end: 6, colors: 'autumn', z: [0.7, 3], size: [0.04, 0.07], seed: 11 });
sc.leaf(LEAF);
sc.render();
