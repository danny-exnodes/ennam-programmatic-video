// Editor bootstrap & wiring.
import { h, fmt, toast, modal } from './ui.js';
import { state, on, emit, update, duration, shotStarts, seek, setProject, saveNow, trackJob } from './state.js';
import { api } from './api.js';
import { engine, refresh, draw, toggle, pause, setPreviewScale, stopAllAudio } from './player.js';
import { renderTimeline, initTimeline, fitTimeline } from './timeline.js';
import { renderInspector } from './inspector.js';
import { renderPanel, playExport } from './panels.js';

const $ = (id) => document.getElementById(id);

async function boot() {
  state.config = await api.config().catch(() => state.config);
  initTimeline();
  const id = new URLSearchParams(location.hash.slice(1)).get('p') || localStorage.getItem('lastProject');
  if (id) {
    try { return await openProject(id); } catch { /* fall through */ }
  }
  const list = await api.projects();
  if (list.length) return openProject(list[0].id);
  const p = await api.create({ name: 'Dự án đầu tiên' });
  openProject(p.id);
}

async function openProject(id) {
  pause();
  stopAllAudio();
  const p = await api.get(id);
  state.view = 'editor';
  state.time = 0;
  state.jobs = [];
  setProject(p, { keepSelection: false });
  localStorage.setItem('lastProject', id);
  history.replaceState(null, '', '#p=' + id);
  $('projName').value = p.name;
  fitTimeline();
  renderAll();
  // resume tracking jobs that are still running on the server; show interrupted ones ("Chạy lại")
  for (const j of await api.jobs(id)) {
    if (j.status === 'running' || j.status === 'queued') trackJob(j, (jj) => onJobDone(jj));
    else if (j.status === 'interrupted') { state.jobs = [...state.jobs, j]; emit('jobs'); }
  }
}

function onJobDone(j) {
  if (j.projectId !== state.project?.id || j.status !== 'done') return;
  if (j.kind === 'render') api.get(state.project.id).then((p) => { state.project.exports = p.exports; renderPanel(); });
  else if (j.kind === 'director' && j.retryOf && j.result?.project) setProject(j.result.project);
}
on('jobdone', onJobDone);

function renderAll() {
  refresh();
  renderPanel();
  renderInspector();
  renderTimeline();
  updateTime();
}

on('project', (e = {}) => {
  refresh();
  renderTimeline();
  if (e.live) return;
  if (e.structural) {
    renderInspector();
    if (state.tab !== 'voice' || e.replaced) renderPanel();
  }
  if (e.replaced) $('projName').value = state.project.name;
  updateTime();
});
on('open', (id) => openProject(id));

function updateTime() {
  $('timecode').textContent = `${fmt(state.time)} / ${fmt(duration())}`;
}
on('time', updateTime);
on('playing', (p) => ($('btnPlay').textContent = p ? '❚❚' : '▶'));
on('frame', () => {
  // surface runtime errors of the visible shot under the viewer
  const it = shotStarts().find((x) => state.time >= x.start && state.time < x.end);
  $('viewerMsg').textContent = it && engine.errors.get(it.shot.id) ? '⚠ ' + engine.errors.get(it.shot.id) : '';
});
on('save', (s) => {
  $('saveState').textContent = s === 'saving' ? 'Đang lưu…' : s === 'saved' ? 'Đã lưu' : s === 'pending' ? '•' : s.startsWith('error') ? '⚠ Lỗi lưu: ' + s.slice(6) : '';
});
// keep selection following playhead while playing
on('time', (t) => {
  if (!state.playing) return;
  const it = shotStarts().find((x) => t >= x.start && t < x.end);
  if (it && it.shot.id !== state.selectedShot) {
    state.selectedShot = it.shot.id;
    renderTimeline();
    renderInspector();
  }
});

// ---- controls ----
$('btnPlay').onclick = () => toggle();
$('btnStart').onclick = () => { seek(0); emit('seeked'); };
$('btnPrevShot').onclick = () => jumpShot(-1);
$('btnNextShot').onclick = () => jumpShot(1);
$('previewQuality').onchange = (e) => setPreviewScale(Number(e.target.value));
$('btnExports').onclick = () => showExports();
$('btnExport').onclick = () => emit('export');
$('btnUndo').onclick = () => showHistory();
$('projName').onchange = (e) => update((p) => { p.name = e.target.value.trim() || p.name; });
document.querySelectorAll('#tabs button').forEach((b) => (b.onclick = () => emit('tab', b.dataset.tab)));

function jumpShot(d) {
  const st = shotStarts();
  const i = st.findIndex((x) => state.time >= x.start && state.time < x.end);
  const j = Math.max(0, Math.min(st.length - 1, (i < 0 ? 0 : i) + d));
  if (st[j]) {
    seek(st[j].start + 0.001);
    emit('seeked');
  }
}

window.addEventListener('keydown', (e) => {
  if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
  if (e.code === 'Space') { e.preventDefault(); toggle(); }
  else if (e.key === 'ArrowLeft') { seek(state.time - (e.shiftKey ? 1 : 1 / 30)); emit('seeked'); }
  else if (e.key === 'ArrowRight') { seek(state.time + (e.shiftKey ? 1 : 1 / 30)); emit('seeked'); }
  else if (e.key === 'Home') { seek(0); emit('seeked'); }
  else if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); saveNow(); }
});
window.addEventListener('beforeunload', (e) => { if (state.dirty) { saveNow(); e.preventDefault(); } });

// ---- export ----
on('export', () => {
  const p = state.project;
  if (!p.shots.length) return toast('Chưa có shot nào để xuất', { error: true });
  const pick = async (quality) => {
    document.getElementById('modal').hidden = true;
    await saveNow();
    try {
      const job = await api.render(p.id, quality);
      emit('tab', 'director');
      toast('Đã bắt đầu xuất video — theo dõi tiến độ ở tab Đạo diễn AI');
      trackJob(job, (j) => {
        if (j.status === 'done') {
          toast('✅ Xuất xong: ' + j.result.file, { ms: 6000 });
          onJobDone(j);
          playExport(j.result.file);
        } else toast('Xuất lỗi: ' + j.error, { error: true, ms: 10000 });
      });
    } catch (e) { toast(e.message, { error: true }); }
  };
  modal('Xuất video', h('div', { class: 'choice' },
    h('div', { class: 'card', onclick: () => pick('draft') }, h('strong', {}, '⚡ Nháp'), h('div', { class: 'muted' }, 'Render nửa độ phân giải rồi phóng lên, không motion blur. Nhanh để duyệt nội bộ.')),
    h('div', { class: 'card', onclick: () => pick('standard') }, h('strong', {}, '🎬 Chuẩn'), h('div', { class: 'muted' }, `${p.width}×${p.height} · ${p.fps}fps · motion blur 3 mẫu/khung. Dùng để gửi khách.`)),
    h('div', { class: 'card', onclick: () => pick('high') }, h('strong', {}, '💎 Cao nhất'), h('div', { class: 'muted' }, 'Motion blur 6 mẫu/khung, bitrate cao. Chậm hơn ~2 lần, cho màn LED / TVC.')),
  ));
});

function showExports() {
  const p = state.project;
  const list = p.exports || [];
  modal('Bản đã xuất', list.length
    ? h('div', { class: 'list' }, list.map((e) => h('div', { class: 'item' },
      h('button', { class: 'icon', onclick: () => playExport(e.file) }, '▶'),
      h('div', { class: 'grow' }, e.file, h('span', { class: 'small muted' }, `  · ${fmt(e.duration)} · ${e.quality || ''} · ${new Date(e.createdAt).toLocaleString('vi-VN')}`)))))
    : h('p', { class: 'muted' }, 'Chưa có bản xuất nào.'));
}

async function showHistory() {
  const p = state.project;
  const list = await api.history(p.id);
  const label = { 'ai-director': 'Trước khi đạo diễn sửa', 'ai-shot': 'Trước khi đạo diễn sửa shot', template: 'Trước khi dựng mẫu', 'before-restore': 'Trước khi khôi phục', save: 'Lưu' };
  modal('Lịch sử phiên bản', list.length
    ? h('div', { class: 'list' }, list.map((x) => h('div', { class: 'item' },
      h('div', { class: 'grow' }, label[x.reason] || x.reason, h('span', { class: 'small muted' }, '  · ' + x.at.replace(/T(\d\d)-(\d\d)-(\d\d).*/, ' $1:$2:$3'))),
      h('button', {
        onclick: async () => {
          if (!confirm('Khôi phục phiên bản này? (bản hiện tại vẫn được lưu vào lịch sử)')) return;
          setProject(await api.restore(p.id, x.file), { keepSelection: false });
          document.getElementById('modal').hidden = true;
          toast('Đã khôi phục');
        },
      }, 'Khôi phục'))))
    : h('p', { class: 'muted' }, 'Chưa có lịch sử. Mỗi lần đạo diễn AI hoặc mẫu thay đổi dự án, bản cũ được lưu ở đây.'));
}

new ResizeObserver(() => draw()).observe($('viewer'));
boot().catch((e) => toast('Không tải được: ' + e.message, { error: true, ms: 10000 }));
