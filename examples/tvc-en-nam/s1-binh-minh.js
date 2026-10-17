//@include common.js
// S1 — Bình minh đại ngàn: mặt nước phẳng lặng, núi trong sương, mặt trời lên giữa hai dãy núi, đàn én lướt qua.
const e = s.ease.inOutSine(s.p);
const sc = s.nature({
  camera: { x: s.lerp(-0.3, 0.3, e), height: s.lerp(0.95, 0.8, e), z: s.lerp(0, 1.4, e), pitch: -0.035, fov: 46, focus: 30, aperture: 4 },
  wind: { ...WIND, speed: 0.6, gust: 0.3 },
  sun: { elevation: 0.075, azimuth: 0.1, intensity: 1.3, color: '#fff0d4', rays: 0.9 },
  sky: { top: '#5f97cf', horizon: '#e9e6dc' },
});
sc.landscape({ ...LAND, forestZ: 75, treeHeight: 8, crown: 3.2, mist: 0.28, fog: 4200, clouds: 0.45 });
sc.water({ flow: [0.08, 0], depth: 0.6, farZ: 74.5, chop: 0.3, color: '#22423c' });
sc.swallows({ count: 4, from: [-14, 3.2, 16], to: [12, 4.2, 13], start: 0.5, dur: 3.8, spread: 2, size: 0.2 });
sc.leaves({ count: 6, start: -4, end: 5, colors: 'mixed', z: [2, 6], size: [0.035, 0.055] });
sc.render();
// low morning mist drifting over the water
s.fx.mist({ x: s.W * 0.5, y: s.H * 0.6, rate: 3, life: 7, rise: 4, wind: 22, spread: 2200, size: 420, opacity: 0.03, color: '#ffffff', depth: 0, start: -7 });
