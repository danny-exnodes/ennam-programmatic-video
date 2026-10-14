// Physically-motivated material presets.
// A material describes how a liquid / solid *looks* (optical) and *moves*
// (mechanical). The liquid simulator reads the mechanical part, the
// renderer reads the optical part — so "honey" splashes slower, with fewer,
// fatter droplets AND looks thick and glowing, without the shot author
// having to tune both.
import { hexToRgb, rgba, shade, clamp } from './math.js';

export const MATERIALS = {
  serum: {
    label: 'Serum vàng hổ phách',
    color: '#c67a1c', core: '#ffd27a', edge: '#4a2200', spec: '#fff6e0',
    opacity: 0.82, gloss: 0.9, scatter: 0.75, // light transmitted through body
    viscosity: 0.35, surfaceTension: 0.6, density: 1.0,
  },
  water: {
    label: 'Nước trong',
    color: '#9fc9e8', core: '#ffffff', edge: '#2a5b80', spec: '#ffffff',
    opacity: 0.38, gloss: 1, scatter: 0.4,
    viscosity: 0.05, surfaceTension: 0.75, density: 1.0,
  },
  milk: {
    label: 'Sữa',
    color: '#f4f1ea', core: '#ffffff', edge: '#b9b3a6', spec: '#ffffff',
    opacity: 0.97, gloss: 0.65, scatter: 0.15,
    viscosity: 0.2, surfaceTension: 0.55, density: 1.03,
  },
  honey: {
    label: 'Mật ong',
    color: '#d08a10', core: '#ffcf4a', edge: '#5a2a00', spec: '#fff3c4',
    opacity: 0.88, gloss: 0.95, scatter: 0.85,
    viscosity: 0.9, surfaceTension: 0.7, density: 1.4,
  },
  oil: {
    label: 'Dầu dưỡng',
    color: '#e3b23c', core: '#fff0a8', edge: '#7a5200', spec: '#ffffff',
    opacity: 0.6, gloss: 1, scatter: 0.7,
    viscosity: 0.55, surfaceTension: 0.4, density: 0.92,
  },
  gel: {
    label: 'Gel trong',
    color: '#bfe9d9', core: '#ffffff', edge: '#3f8f78', spec: '#ffffff',
    opacity: 0.45, gloss: 1, scatter: 0.5,
    viscosity: 0.75, surfaceTension: 0.8, density: 1.05,
  },
  cream: {
    label: 'Kem dưỡng',
    color: '#f6e6d8', core: '#ffffff', edge: '#c8a88f', spec: '#ffffff',
    opacity: 1, gloss: 0.5, scatter: 0.05,
    viscosity: 0.95, surfaceTension: 0.5, density: 1.1,
  },
  juice: {
    label: 'Nước cam',
    color: '#f08a12', core: '#ffd36b', edge: '#7a2e00', spec: '#ffffff',
    opacity: 0.85, gloss: 0.9, scatter: 0.65,
    viscosity: 0.12, surfaceTension: 0.65, density: 1.04,
  },
  coffee: {
    label: 'Cà phê',
    color: '#5a3018', core: '#b9763c', edge: '#1a0a02', spec: '#fff2e0',
    opacity: 0.93, gloss: 0.95, scatter: 0.35,
    viscosity: 0.1, surfaceTension: 0.65, density: 1.0,
  },
  wine: {
    label: 'Rượu vang',
    color: '#7a0f23', core: '#d23a50', edge: '#2a0008', spec: '#ffffff',
    opacity: 0.85, gloss: 1, scatter: 0.6,
    viscosity: 0.1, surfaceTension: 0.6, density: 0.99,
  },
};

export function resolveMaterial(m) {
  if (!m) return { ...MATERIALS.serum };
  if (typeof m === 'string') return { ...(MATERIALS[m] || MATERIALS.serum) };
  const base = MATERIALS[m.base] || MATERIALS.serum;
  return { ...base, ...m };
}

/**
 * Draw a single liquid droplet / blob with transmission, rim (Fresnel),
 * caustic and specular highlights.
 * light: {x,y} normalized direction where light comes FROM (screen space).
 */
export function drawDroplet(ctx, x, y, r, mat, opts = {}) {
  if (r < 0.35) return;
  const { light = { x: -0.45, y: -0.85 }, vx = 0, vy = 0, alpha = 1, stretchK = 0.0016 } = opts;
  const speed = Math.hypot(vx, vy);
  const stretch = 1 + Math.min(1.6, speed * stretchK * (1 - mat.surfaceTension * 0.4));
  ctx.save();
  ctx.translate(x, y);
  if (speed > 1) ctx.rotate(Math.atan2(vy, vx) - Math.PI / 2);
  ctx.scale(1 / Math.sqrt(stretch), stretch);
  const a = alpha * mat.opacity;
  // body (transmission): bright core displaced AWAY from light (light passes through)
  const cx = -light.x * r * 0.35, cy = -light.y * r * 0.35;
  const g = ctx.createRadialGradient(cx, cy, r * 0.05, 0, 0, r);
  g.addColorStop(0, rgba(mat.core, a * (0.55 + 0.45 * mat.scatter)));
  g.addColorStop(0.55, rgba(mat.color, a));
  g.addColorStop(0.88, rgba(shade(mat.edge, 0.15), Math.min(1, a * 1.1)));
  g.addColorStop(1, rgba(mat.edge, Math.min(1, a * 1.15)));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  if (r > 2) {
    // caustic: focused light on the far side
    const cg = ctx.createRadialGradient(cx * 1.6, cy * 1.6, 0, cx * 1.6, cy * 1.6, r * 0.45);
    cg.addColorStop(0, rgba(mat.core, 0.55 * alpha * mat.scatter));
    cg.addColorStop(1, rgba(mat.core, 0));
    ctx.fillStyle = cg;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    // fresnel rim on lit side
    ctx.lineWidth = Math.max(0.6, r * 0.08);
    ctx.strokeStyle = rgba(mat.spec, 0.35 * alpha * mat.gloss);
    const la = Math.atan2(light.y, light.x);
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.92, la - 1.1, la + 1.1);
    ctx.stroke();
  }
  // specular highlight toward light
  const sx = light.x * r * 0.45, sy = light.y * r * 0.45;
  const sr = Math.max(0.6, r * 0.28);
  const sg = ctx.createRadialGradient(sx, sy, 0, sx, sy, sr);
  sg.addColorStop(0, rgba(mat.spec, 0.95 * alpha * mat.gloss));
  sg.addColorStop(0.4, rgba(mat.spec, 0.45 * alpha * mat.gloss));
  sg.addColorStop(1, rgba(mat.spec, 0));
  ctx.fillStyle = sg;
  ctx.beginPath();
  ctx.ellipse(sx, sy, sr, sr * 0.75, Math.atan2(sy, sx), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

export function materialFill(ctx, mat, x0, y0, x1, y1, alpha = 1) {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  g.addColorStop(0, rgba(mat.edge, alpha * clamp(mat.opacity * 1.1)));
  g.addColorStop(0.35, rgba(mat.color, alpha * mat.opacity));
  g.addColorStop(0.7, rgba(mat.core, alpha * mat.opacity * (0.6 + 0.4 * mat.scatter)));
  g.addColorStop(1, rgba(mat.color, alpha * mat.opacity));
  return g;
}

export { hexToRgb };
