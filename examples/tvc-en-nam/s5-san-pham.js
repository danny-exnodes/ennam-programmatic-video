//@include common.js
// S5 — Én Nam: chai nước trên tảng đá rêu bên suối, hơi nước đọng, giọt chảy, camera đẩy vào và lượn nhẹ.
const e = s.ease.inOutSine(s.p);
const sc = s.nature({
  camera: { x: s.lerp(-0.07, 0.04, e), height: s.lerp(0.36, 0.33, e), z: s.lerp(-0.9, -0.66, e), pitch: s.lerp(0.11, 0.1, e), yaw: s.lerp(0.06, -0.04, e), fov: 30, focus: s.lerp(0.95, 0.71, e), aperture: 2.6 },
  wind: { speed: 0.9, gust: 0.6, seed: 9 },
  sun: { elevation: 0.32, azimuth: -0.55, intensity: 1.3, color: '#fff3dc', rays: 0.5 },
  sky: SKY,
});
sc.landscape({ ...LAND, forestZ: 13, treeHeight: 8, crown: 2.4, mist: 0.2 });
sc.water({ flow: [0.32, 0], depth: 0.35, farZ: 12.6, foam: 0.35, color: '#1c3a33' });
sc.rocks([{ x: 0.0, z: 0.05, r: 0.2, h: 0.24, seed: 7, color: '#8a8478' }, { x: 0.65, z: 1.7, r: 0.35, h: 0.3 }, { x: -0.85, z: 2.3, r: 0.42, h: 0.34 }, { x: 0.3, z: 3.6, r: 0.5, h: 0.3 }]);
sc.leaves({ count: 10, start: -4, end: 7, colors: 'mixed', z: [0.8, 4], size: [0.035, 0.055], seed: 4 });
sc.bottle({ x: 0.0, y: 0.15, z: 0.05, height: 0.21, radius: 0.032, frost: 0.45, drops: 80 });
sc.foliage({ side: 'right', depth: 0.42, count: 5, size: 0.08, y: 0.08 });
sc.render();
