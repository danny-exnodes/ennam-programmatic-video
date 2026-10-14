// Media probing + helpers (ffprobe / sharp).
import { spawn } from 'node:child_process';
import sharp from 'sharp';

export const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
export const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

export function run(cmd, args, { input, onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => {
      err += d;
      if (err.length > 200000) err = err.slice(-100000);
      onStderr && onStderr(String(d));
    });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve({ out, err }) : reject(new Error(`${cmd} exited ${code}: ${err.slice(-1500)}`))));
    if (input) p.stdin.end(input);
    else p.stdin.end();
  });
}

export function kindOf(mimetype = '', filename = '') {
  if (mimetype.startsWith('image/') || /\.(png|jpe?g|webp|gif|avif)$/i.test(filename)) return 'image';
  if (mimetype.startsWith('video/') || /\.(mp4|mov|webm|m4v)$/i.test(filename)) return 'video';
  if (mimetype.startsWith('audio/') || /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(filename)) return 'audio';
  return null;
}

export async function probe(file, kind) {
  if (kind === 'image') {
    const m = await sharp(file).metadata();
    return { width: m.width, height: m.height, hasAlpha: !!m.hasAlpha };
  }
  const { out } = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const j = JSON.parse(out);
  const v = j.streams.find((s) => s.codec_type === 'video');
  return {
    duration: Number(j.format?.duration || 0),
    width: v?.width, height: v?.height,
    hasAudio: j.streams.some((s) => s.codec_type === 'audio'),
  };
}

/** Normalize uploads: rotate per EXIF, cap huge images at 3840px, keep alpha (PNG/WebP). */
export async function normalizeImage(src, dst) {
  const img = sharp(src).rotate();
  const m = await img.metadata();
  const big = Math.max(m.width || 0, m.height || 0) > 3840;
  let pipe = big ? img.resize({ width: 3840, height: 3840, fit: 'inside' }) : img;
  if (m.hasAlpha) pipe = pipe.png();
  else pipe = pipe.jpeg({ quality: 92 });
  await pipe.toFile(dst);
}

/** Small JPEG thumbnail as base64 for sending to the AI director (vision). */
export async function thumbBase64(file, max = 768) {
  const buf = await sharp(file).rotate().resize({ width: max, height: max, fit: 'inside' }).jpeg({ quality: 80 }).toBuffer();
  return buf.toString('base64');
}

/** Grab a still from a video for the director to look at. */
export async function videoStillBase64(file, at = 0.5) {
  const { out } = await new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1', '-vf', 'scale=640:-2', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1']);
    const chunks = [];
    p.stdout.on('data', (d) => chunks.push(d));
    p.on('error', reject);
    p.on('close', () => resolve({ out: Buffer.concat(chunks) }));
  });
  return out.length ? out.toString('base64') : null;
}
