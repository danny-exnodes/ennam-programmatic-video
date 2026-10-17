//@include common.js
// S2 — Dòng suối: nước chảy về phía camera qua các tảng đá, cơn gió làm lá rơi, lá tiền cảnh mờ.
const e = s.ease.inOutSine(s.p);
const sc = s.nature({
  camera: { x: s.lerp(-0.25, 0.15, e), height: s.lerp(0.5, 0.42, e), z: 0, pitch: 0.06, yaw: 0.05, fov: 46, focus: 3.0, aperture: 8 },
  wind: { speed: 1.2, gust: 1.0, gusts: [{ t: 1.0, amp: 1.7, dur: 1.4 }], seed: 6 },
  sun: { elevation: 0.38, azimuth: 0.32, intensity: 1.25, color: '#fff3dc', rays: 0.6 },
  sky: SKY,
});
sc.landscape({ ...LAND, forestZ: 24, treeHeight: 9, crown: 2.6, mist: 0.2 });
sc.water({ flow: [0.12, -0.55], depth: 0.35, farZ: 23.6, foam: 0.4, chop: 0.6, color: '#1c3a33' });
sc.rocks([{ x: -0.6, z: 2.4, r: 0.32, h: 0.3 }, { x: 0.95, z: 3.3, r: 0.45, h: 0.4 }, { x: 0.15, z: 5.6, r: 0.55, h: 0.38 }, { x: -1.7, z: 4.4, r: 0.4, h: 0.32 }, { x: 2.2, z: 6.5, r: 0.6, h: 0.45 }]);
sc.leaves({ count: 26, start: -5, end: 6, colors: 'mixed', z: [1.2, 6], size: [0.035, 0.06] });
sc.foliage({ side: 'left', depth: 0.55, count: 6, size: 0.09 });
sc.render();
