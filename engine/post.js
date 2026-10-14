// Finishing pass applied to the whole frame: color grade, bloom/halation,
// vignette and film grain. Mimics what a colorist and a real lens add.
import { rgba, rng } from './math.js';
import { offscreen } from './fx/atmosphere.js';

export const GRADES = {
  none: { label: 'Gốc', filter: '' },
  warm: { label: 'Ấm áp', filter: 'saturate(1.08) contrast(1.06) sepia(0.12) brightness(1.02)', tint: ['#ff9a3c', 0.05] },
  golden: { label: 'Giờ vàng', filter: 'saturate(1.15) contrast(1.08) sepia(0.2)', tint: ['#ffb14a', 0.08] },
  cinematic: { label: 'Điện ảnh (teal & orange)', filter: 'saturate(1.1) contrast(1.15) brightness(0.97)', tint: ['#00707a', 0.06], tint2: ['#ff8a3a', 0.05] },
  clean: { label: 'Trong trẻo', filter: 'saturate(1.02) contrast(1.04) brightness(1.04)', tint: ['#dff3ff', 0.04] },
  cool: { label: 'Lạnh', filter: 'saturate(0.95) contrast(1.08) hue-rotate(-6deg)', tint: ['#4aa3ff', 0.06] },
  luxe: { label: 'Sang trọng tối', filter: 'saturate(0.9) contrast(1.22) brightness(0.92)', tint: ['#2a1a08', 0.08] },
  film: { label: 'Phim nhựa', filter: 'saturate(0.88) contrast(1.1) sepia(0.15)', tint: ['#f2e2c4', 0.05] },
  mono: { label: 'Đen trắng', filter: 'grayscale(1) contrast(1.15)' },
};

export function applyPost(outCtx, src, style = {}, frameIndex = 0) {
  const W = outCtx.canvas.width, H = outCtx.canvas.height;
  const grade = GRADES[style.grade] || GRADES.none;
  outCtx.save();
  outCtx.filter = grade.filter || 'none';
  outCtx.drawImage(src, 0, 0, W, H);
  outCtx.restore();

  // bloom: blurred bright pass added on top (halation around highlights)
  if (style.bloom > 0) {
    const bw = Math.round(W / 4), bh = Math.round(H / 4);
    const b = offscreen('bloom', bw, bh);
    const bc = b.getContext('2d');
    bc.clearRect(0, 0, bw, bh);
    bc.filter = `brightness(0.7) contrast(2.2) blur(${Math.max(2, bw / 90)}px)`;
    bc.drawImage(src, 0, 0, bw, bh);
    bc.filter = 'none';
    outCtx.save();
    outCtx.globalCompositeOperation = 'screen';
    outCtx.globalAlpha = Math.min(1, style.bloom);
    outCtx.drawImage(b, 0, 0, W, H);
    outCtx.restore();
  }
  if (grade.tint) tint(outCtx, grade.tint[0], grade.tint[1], 'soft-light');
  if (grade.tint2) tint(outCtx, grade.tint2[0], grade.tint2[1], 'overlay');

  if (style.vignette > 0) {
    const g = outCtx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, Math.hypot(W, H) * 0.6);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,0,0,${Math.min(0.95, style.vignette)})`);
    outCtx.fillStyle = g;
    outCtx.fillRect(0, 0, W, H);
  }
  if (style.grain > 0) {
    const tile = grainTile(frameIndex % 8);
    outCtx.save();
    outCtx.globalCompositeOperation = 'overlay';
    outCtx.globalAlpha = Math.min(1, style.grain * 2.2);
    const pat = outCtx.createPattern(tile, 'repeat');
    outCtx.fillStyle = pat;
    outCtx.fillRect(0, 0, W, H);
    outCtx.restore();
  }
  if (style.letterbox > 0) {
    const bar = H * style.letterbox;
    outCtx.fillStyle = '#000';
    outCtx.fillRect(0, 0, W, bar);
    outCtx.fillRect(0, H - bar, W, bar);
  }
}

function tint(ctx, color, a, mode) {
  ctx.save();
  ctx.globalCompositeOperation = mode;
  ctx.fillStyle = rgba(color, a * 4);
  ctx.globalAlpha = 1;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.restore();
}

const grainTiles = [];
function grainTile(i) {
  if (grainTiles[i]) return grainTiles[i];
  const c = offscreen('grain' + i, 256, 256);
  const cx = c.getContext('2d');
  const img = cx.createImageData(256, 256);
  const r = rng(1000 + i);
  for (let p = 0; p < img.data.length; p += 4) {
    const v = 128 + (r() + r() + r() - 1.5) * 110;
    img.data[p] = img.data[p + 1] = img.data[p + 2] = v;
    img.data[p + 3] = 255;
  }
  cx.putImageData(img, 0, 0);
  grainTiles[i] = c;
  return c;
}
