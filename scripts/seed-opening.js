// Demo projects for the "Khai trương / Kỷ niệm" seasonal bundle (issue #24c): one project per
// recipe (Teaser 8s, Countdown 5→0, Cảm ơn khách, Kỷ niệm X năm), built from the templates — no
// Claude API call, no assets needed.
//   npm run seed:opening                 # 16:9 (server must be running, PORT default 5173)
//   npm run seed:opening -- --vertical   # also a 9:16 copy of every recipe
const BASE = `http://127.0.0.1:${process.env.PORT || 5173}`;
const vertical = process.argv.includes('--vertical');

const j = async (r) => { const x = await r.json(); if (!r.ok) throw new Error(x.error || r.statusText); return x; };
const post = (url, body) => fetch(BASE + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(j);

const cfg = await j(await fetch(`${BASE}/api/config`));
const recipes = cfg.templates.filter((t) => t.season === 'opening');
if (!recipes.length) throw new Error('server chưa có công thức theo mùa "opening"');
const sizes = [[1920, 1080, '16:9'], ...(vertical ? [[1080, 1920, '9:16']] : [])];
for (const [width, height, label] of sizes) {
  for (const r of recipes) {
    const p = await post('/api/projects', { name: `${r.name} (demo ${label})`, width, height });
    const np = await post(`/api/projects/${p.id}/template`, { template: r.id });
    console.log(`Demo project: ${p.id} · ${r.id} · ${label} · ${np.shots.length} shot · ${BASE}/#p=${p.id}`);
  }
}
