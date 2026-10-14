// Preview player: runs the engine in the editor and keeps music / voice in sync.
import { Engine, loadFonts } from '/engine/engine.js';
import { state, on, emit, duration, seek } from './state.js';
import { fileUrl } from './api.js';

const canvas = document.getElementById('preview');
export const engine = new Engine(canvas, { scale: 0.5 });
engine.showErrors = true;

const mediaCache = new Map(); // asset id -> element (image/video)
const audioCache = new Map(); // asset id -> HTMLAudioElement
let fontsReady = loadFonts();

export async function syncAssets() {
  const p = state.project;
  if (!p) return;
  engine.assets.clear();
  const loads = [];
  for (const a of p.assets) {
    if (a.type === 'image' || a.type === 'video') {
      let el = mediaCache.get(a.id);
      if (!el) {
        el = a.type === 'image' ? new Image() : document.createElement('video');
        if (a.type === 'video') { el.muted = true; el.playsInline = true; el.preload = 'auto'; }
        el.src = fileUrl(p, a);
        mediaCache.set(a.id, el);
        loads.push(new Promise((res) => {
          el.addEventListener(a.type === 'image' ? 'load' : 'loadeddata', res, { once: true });
          el.addEventListener('error', res, { once: true });
        }));
      }
      engine.setAsset(a.name, el, a.type);
    }
  }
  if (loads.length) Promise.all(loads).then(() => draw());
}

export function refresh() {
  if (!state.project) return;
  engine.setProject(state.project);
  engine._warned = new Set();
  syncAssets();
  draw();
}

let raf = 0;
export function draw() {
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(() => {
    if (!state.project || !state.project.shots.length) {
      const c = canvas.getContext('2d');
      c.fillStyle = '#000';
      c.fillRect(0, 0, canvas.width, canvas.height);
      return;
    }
    engine.errors.clear();
    engine._warned = new Set();
    engine.renderFrame(state.time);
    emit('frame');
  });
}

// ---------------- playback ----------------
let lastTs = 0;
function tick(ts) {
  if (!state.playing) return;
  const dt = lastTs ? (ts - lastTs) / 1000 : 0;
  lastTs = ts;
  let t = state.time + Math.min(dt, 0.1);
  if (t >= duration()) {
    t = 0;
    syncAudio(true);
  }
  state.time = t;
  engine.renderFrame(t);
  // keep <video> assets roughly in step during preview
  for (const r of engine.videoRequests) if (Math.abs(r.el.currentTime - r.time) > 0.25) r.el.currentTime = r.time;
  emit('time', t);
  requestAnimationFrame(tick);
}

export async function play() {
  if (!state.project?.shots.length) return;
  await fontsReady;
  if (state.time >= duration() - 0.05) state.time = 0;
  state.playing = true;
  lastTs = 0;
  syncAudio(true);
  emit('playing', true);
  requestAnimationFrame(tick);
}
export function pause() {
  state.playing = false;
  for (const a of audioCache.values()) a.pause();
  emit('playing', false);
  draw();
}
export function toggle() {
  state.playing ? pause() : play();
}

function audioFor(asset) {
  let a = audioCache.get(asset.id);
  if (!a) {
    a = new Audio(fileUrl(state.project, asset));
    a.preload = 'auto';
    audioCache.set(asset.id, a);
  }
  return a;
}

/** Start/stop/seek audio elements so they match the playhead. */
function syncAudio(force = false) {
  const p = state.project;
  if (!p) return;
  const t = state.time;
  const total = duration();
  const m = p.music && p.assets.find((x) => x.id === p.music.assetId);
  if (m) {
    const a = audioFor(m);
    const fi = p.music.fadeIn ?? 0.5, fo = p.music.fadeOut ?? 1.5;
    const env = Math.min(1, t / Math.max(0.01, fi), (total - t) / Math.max(0.01, fo));
    a.volume = Math.max(0, Math.min(1, (p.music.volume ?? 0.3) * env));
    const want = t + (p.music.offset || 0);
    if (state.playing) {
      if (force || Math.abs(a.currentTime - want) > 0.3) a.currentTime = want;
      if (a.paused) a.play().catch(() => {});
    }
  }
  for (const v of p.voice || []) {
    const asset = v.assetId && p.assets.find((x) => x.id === v.assetId);
    if (!asset) continue;
    const a = audioFor(asset);
    a.volume = Math.min(1, v.volume ?? 1);
    const local = t - v.start;
    const len = asset.duration || v.duration;
    if (state.playing && local >= 0 && local < len) {
      if (force || Math.abs(a.currentTime - local) > 0.3) a.currentTime = local;
      if (a.paused) a.play().catch(() => {});
    } else if (!a.paused) a.pause();
  }
}
setInterval(() => state.playing && syncAudio(false), 250);

on('time', () => {
  if (!state.playing) draw();
});
on('seeked', () => syncAudio(true));

export function setPreviewScale(s) {
  engine.setScale(s);
  draw();
}

export function stopAllAudio() {
  for (const a of audioCache.values()) a.pause();
}

export { seek };
