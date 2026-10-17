//@include common.js
// S6 — Packshot: chai trung tâm, tên thương hiệu & slogan, đàn én bay phía sau.
const e = s.ease.outCubic(s.p);
const sc = s.nature({
  camera: { x: 0.12, height: 0.31, z: s.lerp(-0.62, -0.57, e), pitch: 0.1, yaw: 0, fov: 30, focus: 0.65, aperture: 3.2 },
  wind: { speed: 0.8, gust: 0.4, seed: 9 },
  sun: { elevation: 0.3, azimuth: -0.35, intensity: 1.3, color: '#fff3dc', rays: 0.6 },
  sky: SKY,
});
sc.landscape({ ...LAND, forestZ: 14, treeHeight: 7, crown: 2.4, mist: 0.25 });
sc.water({ flow: [0.25, 0], depth: 0.4, farZ: 13.6, foam: 0.3, color: '#1c3a33' });
sc.rocks([{ x: 0.0, z: 0.05, r: 0.2, h: 0.24, seed: 7, color: '#8a8478' }, { x: 0.8, z: 2.4, r: 0.4, h: 0.3 }]);
sc.bottle({ x: 0.0, y: 0.15, z: 0.05, height: 0.21, radius: 0.032, frost: 0.4, drops: 70 });
sc.swallows({ count: 3, from: [-14, 4, 16], to: [14, 5.5, 14], start: 0.4, dur: 3.2, spread: 2, size: 0.16 });
sc.render();
const { W, H } = s;
s.text('Én Nam', { x: W * 0.72, y: H * 0.45, size: 132, font: 'serif', weight: 700, anim: 'blur', start: 0.5, dur: 1.0, color: '#ffffff', shadow: true });
s.text('Tinh khiết từ *đại ngàn*', { x: W * 0.72, y: H * 0.45 + 78, size: 46, weight: 600, anim: 'rise', start: 1.1, dur: 0.8, color: '#f4f8f2', accent: '#bfe6a8', shadow: true });
s.underline({ x: W * 0.72 - 120, y: H * 0.45 + 108, width: 240, start: 1.6, color: '#bfe6a8' });
s.text('NƯỚC KHOÁNG THIÊN NHIÊN', { x: W * 0.72, y: H * 0.45 + 160, size: 24, weight: 600, anim: 'fade', start: 1.8, dur: 0.8, color: '#e8f1ea' });
s.fx.leak({ intensity: 0.12, color: '#fff2cf', color2: '#cfe9ff', seed: 2 });
