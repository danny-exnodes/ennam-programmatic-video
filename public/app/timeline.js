// Multi-track timeline: shots, voice-over lines, music.
import { h, fmt } from './ui.js';
import { state, on, emit, update, duration, shotStarts, seek, selectShot } from './state.js';

const $ = (id) => document.getElementById(id);
let pps = 50; // pixels per second
const PAD = 4;

const x = (t) => PAD + t * pps;
const tAt = (px) => (px - PAD) / pps;

export function renderTimeline() {
  const p = state.project;
  if (!p) return;
  const total = duration();
  $('tlTitle').textContent = `${p.name} · ${fmt(total)}`;
  const width = Math.max($('tlScroll').clientWidth, x(Math.max(total, 1) + 3) + 60);
  $('tlContent').style.width = width + 'px';

  // ruler
  const ruler = $('tlRuler');
  ruler.replaceChildren();
  const step = pps > 90 ? 1 : pps > 35 ? 2 : pps > 15 ? 5 : 10;
  for (let t = 0; t <= total + 4; t += step) ruler.append(h('span', { style: { left: x(t) + 'px' } }, fmt(t, 0).replace(/^0:/, ':')));

  // shots
  const tr = $('trackShots');
  tr.replaceChildren();
  shotStarts().forEach((it, i) => {
    const c = h('div', {
      'data-id': it.shot.id,
      class: 'clip shot' + (it.shot.id === state.selectedShot ? ' sel' : ''),
      style: { left: x(it.start) + 'px', width: Math.max(8, it.shot.duration * pps - 3) + 'px' },
      title: `${it.shot.name} · ${it.shot.duration.toFixed(1)}s · vào: ${it.shot.transition?.type || 'cut'}`,
    },
    it.shot.transition && it.shot.transition.type !== 'cut' ? h('span', { class: 'tr' }, '⤳') : null,
    h('span', { class: 'ph' }, `${i + 1} · ${it.shot.name}`),
    h('div', { class: 'handle' }));
    c.addEventListener('pointerdown', (e) => shotPointer(e, it, i, c));
    tr.append(c);
  });

  // voice
  const tv = $('trackVoice');
  tv.replaceChildren();
  for (const v of p.voice || []) {
    const c = h('div', {
      class: 'clip voice' + (v.assetId ? '' : ' noaudio'),
      style: { left: x(v.start) + 'px', width: Math.max(30, v.duration * pps - 2) + 'px' },
      title: v.text + (v.assetId ? '' : ' (chưa có audio)'),
    }, h('span', { class: 'ph' }, '🎙 ' + v.text));
    c.addEventListener('pointerdown', (e) => voicePointer(e, v, c));
    tv.append(c);
  }
  const lastEnd = Math.max(total, ...(p.voice || []).map((v) => v.start + v.duration));
  tv.append(h('div', {
    class: 'clip add', style: { left: x(lastEnd) + 12 + 'px', width: '90px', justifyContent: 'center' },
    onclick: () => addVoiceLine(),
  }, '+ Câu thoại'));

  // music
  const tm = $('trackMusic');
  tm.replaceChildren();
  const m = p.music && p.assets.find((a) => a.id === p.music.assetId);
  if (m) {
    tm.append(h('div', {
      class: 'clip music', style: { left: x(0) + 'px', width: Math.max(40, total * pps - 2) + 'px' },
      onclick: () => emit('tab', 'music'),
    }, `🎵 ${m.original || m.name} · ${Math.round((p.music.volume ?? 0.3) * 100)}%`));
  } else {
    tm.append(h('div', { class: 'clip add', style: { left: x(0) + 'px', width: '120px', justifyContent: 'center' }, onclick: () => emit('tab', 'music') }, '+ Thêm nhạc'));
  }
  placeHead();
}

export function addVoiceLine() {
  update((p) => {
    p.voice = p.voice || [];
    p.voice.push({ id: 'v' + Math.random().toString(16).slice(2, 10), text: 'Câu thoại mới', start: Math.round(state.time * 10) / 10, duration: 2.5, assetId: null });
  });
  emit('tab', 'voice');
}

function placeHead() {
  $('playhead').style.left = x(state.time) + 'px';
  const sc = $('tlScroll');
  const px = x(state.time);
  if (state.playing && (px > sc.scrollLeft + sc.clientWidth - 40 || px < sc.scrollLeft)) sc.scrollLeft = px - 80;
}

function shotPointer(e, it, index, el) {
  e.preventDefault();
  const resize = e.target.classList.contains('handle');
  const startX = e.clientX;
  const d0 = it.shot.duration;
  let moved = false;
  selectShot(it.shot.id, { seekTo: false });
  try { el.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
  const move = (ev) => {
    const dx = ev.clientX - startX;
    if (Math.abs(dx) > 3) moved = true;
    if (!moved) return;
    if (resize) {
      const nd = Math.max(0.5, Math.round((d0 + dx / pps) * 10) / 10);
      it.shot.duration = nd;
      emit('project', { structural: true, live: true });
    } else {
      el.style.transform = `translateX(${dx}px)`;
      el.style.zIndex = 5;
    }
  };
  const up = (ev) => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    if (!moved) {
      // click: seek inside the shot where clicked
      const r = el.getBoundingClientRect();
      seek(it.start + Math.max(0, Math.min(it.shot.duration - 0.01, (ev.clientX - r.left) / pps)));
      emit('seeked');
      return;
    }
    if (resize) {
      update(() => {});
    } else {
      const center = it.start + it.shot.duration / 2 + (ev.clientX - startX) / pps;
      const starts = shotStarts();
      let to = starts.findIndex((s) => center < s.start + s.shot.duration / 2);
      if (to < 0) to = starts.length;
      if (to > index) to -= 1;
      update((p) => {
        const [sh] = p.shots.splice(index, 1);
        p.shots.splice(to, 0, sh);
      });
    }
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
}

function voicePointer(e, v, el) {
  e.preventDefault();
  const startX = e.clientX;
  const s0 = v.start;
  let moved = false;
  try { el.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
  const move = (ev) => {
    const dx = ev.clientX - startX;
    if (Math.abs(dx) > 3) moved = true;
    if (moved) {
      v.start = Math.max(0, Math.round((s0 + dx / pps) * 10) / 10);
      el.style.left = x(v.start) + 'px';
    }
  };
  const up = () => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    if (moved) update(() => {});
    else {
      emit('tab', 'voice');
      emit('focusVoice', v.id);
    }
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
}

export function initTimeline() {
  const ruler = $('tlRuler');
  const scrub = (e) => {
    const r = $('tlContent').getBoundingClientRect();
    seek(tAt(e.clientX - r.left));
  };
  ruler.addEventListener('pointerdown', (e) => {
    ruler.setPointerCapture(e.pointerId);
    scrub(e);
    const mv = (ev) => scrub(ev);
    const up = () => { ruler.removeEventListener('pointermove', mv); ruler.removeEventListener('pointerup', up); emit('seeked'); };
    ruler.addEventListener('pointermove', mv);
    ruler.addEventListener('pointerup', up);
  });
  $('tlZoomIn').onclick = () => { pps = Math.min(400, pps * 1.4); renderTimeline(); };
  $('tlZoomOut').onclick = () => { pps = Math.max(8, pps / 1.4); renderTimeline(); };
  on('time', placeHead);
  on('select', () => document.querySelectorAll('#trackShots .clip.shot').forEach((c) => c.classList.toggle('sel', c.dataset.id === state.selectedShot)));
  window.addEventListener('resize', renderTimeline);
}

export function fitTimeline() {
  const w = document.getElementById('tlScroll').clientWidth - 140;
  pps = Math.max(10, Math.min(120, w / Math.max(4, duration())));
}
