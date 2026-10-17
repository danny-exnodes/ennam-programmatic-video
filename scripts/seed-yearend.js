// Demo projects for the "Year End / Gala" seasonal bundle (issue #24a): one project per
// recipe (Teaser 10s, Mở màn LED 20s, Countdown 10→0), built from the templates — no
// Claude API call, no assets needed.
//   npm run seed:yearend                 # 16:9 (server must be running, PORT default 5173)
//   npm run seed:yearend -- --vertical   # also a 9:16 copy of every recipe
const BASE = `http://127.0.0.1:${process.env.PORT || 5173}`;
const vertical = process.argv.includes('--vertical');

const j = async (r) => { const x = await r.json(); if (!r.ok) throw new Error(x.error || r.statusText); return x; };
const post = (url, body) => fetch(BASE + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(j);

const cfg = await j(await fetch(`${BASE}/api/config`));
const recipes = cfg.templates.filter((t) => t.season === 'yearend');
if (!recipes.length) throw new Error('server chưa có công thức theo mùa "yearend"');
const sizes = [[1920, 1080, '16:9'], ...(vertical ? [[1080, 1920, '9:16']] : [])];
for (const [width, height, label] of sizes) {
  for (const r of recipes) {
    const p = await post('/api/projects', { name: `${r.name} (demo ${label})`, width, height });
    const np = await post(`/api/projects/${p.id}/template`, { template: r.id });
    console.log(`Demo project: ${p.id} · ${r.id} · ${label} · ${np.shots.length} shot · ${BASE}/#p=${p.id}`);
  }
}
