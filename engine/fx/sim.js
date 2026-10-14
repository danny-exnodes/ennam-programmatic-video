// Generic deterministic particle simulator.
// Trajectories are integrated ONCE at a fixed 240 Hz step when a shot first
// asks for them, then cached and sampled by time — so scrubbing / exporting
// any frame is exact and cheap, and every render of the project is identical.
import { rng, noise2 } from '../math.js';

const DT = 1 / 240;
const cache = new Map();

export function clearSimCache() {
  cache.clear();
}

/**
 * spec: {
 *   seed, particles: [{ t0, p:[x,y,z], v:[x,y,z], r, life, data }],
 *   gravity: [gx,gy,gz], drag (1/s), wind:[x,y,z], turbulence: {amp, scale},
 *   floor: { y, mode: 'bounce'|'absorb'|'stick'|'none', restitution, friction },
 *   duration
 * }
 * World coords are free (caller projects). Returns { list, events }.
 */
export function simulate(key, specFn) {
  if (cache.has(key)) return cache.get(key);
  const spec = specFn();
  const g = spec.gravity || [0, -9.8, 0];
  const drag = spec.drag ?? 0.2;
  const wind = spec.wind || [0, 0, 0];
  const turb = spec.turbulence;
  const floor = spec.floor || { mode: 'none' };
  const events = [];
  const list = spec.particles.map((pt, idx) => {
    const life = pt.life ?? spec.duration ?? 4;
    const steps = Math.max(2, Math.ceil(life / DT));
    const buf = new Float32Array(steps * 6);
    let [x, y, z] = pt.p;
    let [vx, vy, vz] = pt.v;
    let end = steps;
    const ldrag = drag * (pt.dragMul ?? 1);
    for (let s = 0; s < steps; s++) {
      const o = s * 6;
      buf[o] = x; buf[o + 1] = y; buf[o + 2] = z; buf[o + 3] = vx; buf[o + 4] = vy; buf[o + 5] = vz;
      let ax = g[0] + (wind[0] - vx) * ldrag;
      let ay = g[1] + (wind[1] - vy) * ldrag;
      let az = g[2] + (wind[2] - vz) * ldrag;
      if (turb) {
        const tt = pt.t0 + s * DT;
        ax += turb.amp * noise2(x * turb.scale + tt * 0.7, y * turb.scale, idx * 3 + 1);
        ay += turb.amp * noise2(x * turb.scale, y * turb.scale + tt * 0.7, idx * 3 + 2);
        az += turb.amp * 0.5 * noise2(z * turb.scale + tt, x * turb.scale, idx * 3 + 3);
      }
      vx += ax * DT; vy += ay * DT; vz += az * DT;
      x += vx * DT; y += vy * DT; z += vz * DT;
      if (floor.mode !== 'none' && y < floor.y && vy < 0) {
        if (floor.mode === 'absorb') {
          events.push({ t: pt.t0 + (s + 1) * DT, x, y: floor.y, z, energy: Math.hypot(vx, vy, vz), r: pt.r, idx });
          end = s + 1;
          break;
        } else if (floor.mode === 'stick') {
          y = floor.y; vx = vy = vz = 0;
        } else {
          y = floor.y;
          const e = floor.restitution ?? 0.4;
          if (Math.abs(vy) > 0.3) events.push({ t: pt.t0 + (s + 1) * DT, x, y, z, energy: Math.abs(vy), r: pt.r, idx, bounce: true });
          vy = -vy * e;
          const f = floor.friction ?? 0.85;
          vx *= f; vz *= f;
        }
      }
    }
    return { ...pt, buf, steps: end, life: end * DT, idx };
  });
  const out = { list, events };
  cache.set(key, out);
  // keep cache bounded
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return out;
}

/** State of particle at absolute time t, or null if not alive. */
export function sample(pt, t) {
  const age = t - pt.t0;
  if (age < 0 || age >= pt.life) return null;
  const f = age / DT;
  const i = Math.min(pt.steps - 1, Math.floor(f));
  const j = Math.min(pt.steps - 1, i + 1);
  const k = f - i;
  const b = pt.buf, oi = i * 6, oj = j * 6;
  return {
    x: b[oi] + (b[oj] - b[oi]) * k,
    y: b[oi + 1] + (b[oj + 1] - b[oi + 1]) * k,
    z: b[oi + 2] + (b[oj + 2] - b[oi + 2]) * k,
    vx: b[oi + 3], vy: b[oi + 4], vz: b[oi + 5],
    age, lifeK: age / pt.life,
  };
}

export { rng };
