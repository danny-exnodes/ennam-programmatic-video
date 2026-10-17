// Shared world for the Én Nam TVC: one wind, one sun, one dew leaf (shots 3–4 share the same drop).
const SUN = { elevation: 0.3, azimuth: -0.45, intensity: 1.25, color: '#fff3dc' };
const SKY = { top: '#5a93d0', horizon: '#dfe9ec' };
const WIND = { speed: 1.2, dir: 0.1, gust: 1.0, gusts: [{ t: 1.1, amp: 1.9, dur: 1.2 }, { t: 3.4, amp: 1.7, dur: 1.0 }], seed: 7 };
const LAND = { mist: 0.3, mountainNear: '#4a6650', mountainFar: '#9fb3c0' };
const LEAF = {
  anchor: [-0.05, 0.3, 0.2], yaw: -0.25, pitch: 0.3, length: 0.095, width: 0.38, curve: 0.95,
  color: '#3a7a26', color2: '#9ab43c', seed: 2, freq: 2.0, releaseBy: 4.3, twig: [-0.2, 0.36, 0.26],
  drops: [
    { u: 0.3, v: 0.06, r: 0.003 }, { u: 0.5, v: 0.02, r: 0.0019 }, { u: 0.68, v: -0.04, r: 0.0016 },
    { u: 0.22, v: -0.52, r: 0.0016 }, { u: 0.44, v: 0.56, r: 0.0022 }, { u: 0.6, v: -0.5, r: 0.0013 },
    { u: 0.3, v: 0.62, r: 0.0011 }, { u: 0.8, v: 0.3, r: 0.001 }, { u: 0.14, v: 0.22, r: 0.0014 },
    { u: 0.52, v: -0.28, r: 0.0009 }, { u: 0.38, v: -0.66, r: 0.001 }, { u: 0.7, v: 0.42, r: 0.0012 },
  ],
};
