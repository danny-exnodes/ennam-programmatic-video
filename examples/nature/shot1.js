const { t, W, H } = s;
const e = s.ease.inOutSine(s.p);
const sc = s.nature({
  camera: { height: 0.5, pitch: 0.13, fov: 46, x: s.lerp(-0.15, 0.1, e), z: s.lerp(0, 0.6, e), focus: 3, aperture: 10 },
  wind: { speed: 1.3, dir: 0.12, gust: 1.0, gusts: [{ t: 1.0, amp: 1.7, dur: 1.4 }, { t: 4.3, amp: 1.1, dur: 1.2 }], seed: 5 },
  sun: { elevation: 0.28, azimuth: -0.38, intensity: 1.1 },
  sky: { top: '#6c98c0', horizon: '#f0e4c2' },
});
sc.sky();
sc.treeline({ z: 18, height: 5.5, color: '#2b4123' });
sc.water({ flow: [0.45, 0], depth: 0.4, color: '#20402e', farZ: 17.6, foam: 0.35 });
sc.reeds({ x: [-2.4, -1.4], z: [1.6, 3.2], count: 34, height: [0.45, 1.05] });
sc.reeds({ x: [1.7, 2.8], z: [1.9, 3.4], count: 30, height: [0.4, 1.1], seed: 9 });
sc.leaves({ count: 40, start: -6, end: 6.5, colors: 'autumn', z: [1.2, 5], size: [0.04, 0.07] });
sc.render();
