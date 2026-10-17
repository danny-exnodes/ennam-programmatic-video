//@include common.js
// S3 — Giọt sương: giọt to trượt, gom giọt nhỏ, treo ở mũi lá.
const e = s.ease.inOutSine(s.p);
const sc = s.nature({
  camera: { x: s.lerp(-0.012, 0.004, e), height: 0.355, z: s.lerp(0.035, 0.045, e), pitch: 0.46, yaw: 0.02, fov: 30, focus: 0.15, aperture: 2.5 },
  wind: WIND, sun: SUN, sky: SKY, until: 8,
});
sc.landscape({ ...LAND, forestZ: 9, treeHeight: 6 });
sc.water({ flow: [0.12, 0], depth: 0.55, farZ: 8.6, foam: 0.3 });
sc.leaves({ count: 14, start: -5, end: 6, colors: 'mixed', z: [0.7, 3], size: [0.04, 0.07], seed: 11 });
sc.leaf(LEAF);
sc.render();
