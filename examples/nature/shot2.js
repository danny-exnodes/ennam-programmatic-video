//@include common.js
const { t, W, H } = s;
const e = s.ease.inOutSine(s.p);
const sc = s.nature({
  camera: { x: s.lerp(-0.02, 0.0, e), height: 0.36, z: s.lerp(-0.005, 0.01, e), pitch: 0.42, yaw: 0.02, fov: 40, focus: 0.19, aperture: 3 },
  wind: WIND, sun: SUN, sky: SKY, until: 8,
});
sc.sky();
sc.treeline({ z: 9, height: 5, color: '#2b4123' });
sc.water({ flow: [0.12, 0], depth: 0.55, farZ: 8.6, foam: 0.3 });
sc.leaves({ count: 14, start: -5, end: 6, colors: 'autumn', z: [0.7, 3], size: [0.04, 0.07], seed: 11 });
sc.leaf(LEAF);
sc.render();
