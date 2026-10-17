// Headless render page. Driven by server/render.js via page.evaluate().
import { Engine, loadAssets, loadFonts } from '/engine/engine.js';

const qs = new URLSearchParams(location.search);
const id = qs.get('project');
const scale = Number(qs.get('scale') || 1);
const canvas = document.getElementById('out');
const engine = new Engine(canvas, { scale });
window.__engine = engine;

async function boot(project) {
  try {
    await loadFonts();
    engine.setProject(project);
    await loadAssets(engine, project, (a) => `/files/${project.id}/assets/${encodeURIComponent(a.file)}`);
    window.__ready = true;
  } catch (e) {
    window.__fatal = e.message;
  }
}

window.__setProject = (p) => boot(p);

// fmt 'png' = lossless (golden-frame tests), default JPEG for the MP4 pipe.
async function frame(t, mb = 1, fmt = 'jpeg') {
  engine.renderFrame(t, { motionBlur: mb });
  if (await engine.syncVideos()) engine.renderFrame(t, { motionBlur: mb });
  return (fmt === 'png' ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.94)).split(',')[1];
}
window.__frame = frame;

// Contact sheet + runtime errors for the AI director's self-review.
window.__inspect = async (n = 3, tw = 480) => {
  const p = engine.project;
  const th = Math.round((tw * p.height) / p.width);
  const labelH = 34;
  const sheet = document.createElement('canvas');
  sheet.width = tw * n;
  sheet.height = (th + labelH) * p.shots.length;
  const sc = sheet.getContext('2d');
  sc.fillStyle = '#111';
  sc.fillRect(0, 0, sheet.width, sheet.height);
  const tmp = document.createElement('canvas');
  tmp.width = canvas.width; tmp.height = canvas.height;
  const tc = tmp.getContext('2d');
  engine.errors.clear();
  engine._warned = new Set();
  for (let i = 0; i < p.shots.length; i++) {
    const sh = p.shots[i];
    for (let j = 0; j < n; j++) {
      const lt = (sh.duration * (j + 0.5)) / n;
      engine.renderShotFrame(tc, i, lt);
      sc.drawImage(tmp, j * tw, i * (th + labelH) + labelH, tw, th);
      sc.fillStyle = '#ddd';
      sc.font = '600 18px "Be Vietnam Pro", sans-serif';
      sc.fillText(`Shot ${i + 1} · ${sh.name} · t=${lt.toFixed(1)}s`, j * tw + 8, i * (th + labelH) + 23);
    }
  }
  const errors = {};
  for (const [k, v] of engine.errors) errors[k] = v;
  return { errors, sheet: sheet.toDataURL('image/jpeg', 0.82).split(',')[1] };
};

if (!qs.get('override')) {
  fetch(`/api/projects/${id}`).then((r) => r.json()).then(boot).catch((e) => (window.__fatal = e.message));
}
