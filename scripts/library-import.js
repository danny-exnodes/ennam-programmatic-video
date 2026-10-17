// Import licensed stock material into the shared library (DATA_DIR/library),
// with a JSON sidecar recording source, author and licence for every file.
// Runs on a machine with normal internet access (the team's server / laptop).
//
// usage:
//   node scripts/library-import.js --provider pexels   --query "forest stream" --type video --count 8
//   node scripts/library-import.js --provider pixabay  --query "waterfall"     --type photo --count 12
//   node scripts/library-import.js --provider openverse --query "fern leaf dew" --count 20
//   node scripts/library-import.js --provider polyhaven --type hdri --query forest --count 5
//   node scripts/library-import.js --list
//
// Keys: PEXELS_API_KEY, PIXABAY_API_KEY (free). Openverse & Poly Haven need none.
// See library/sources.json for each source's licence and whether it may be used in ads.
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return acc;
}, []));
const ROOT = path.resolve(process.env.DATA_DIR || 'data', 'library');
const catalog = JSON.parse(fs.readFileSync(path.resolve('library/sources.json'), 'utf8')).sources;

if (args.list) {
  const files = fs.existsSync(ROOT) ? fs.readdirSync(ROOT, { recursive: true }).filter((f) => f.endsWith('.json')) : [];
  for (const f of files) {
    const m = JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    console.log(`${m.ads_ok === false ? '✗ ads' : '✓ ads'}  ${m.provider.padEnd(9)} ${m.type.padEnd(6)} ${m.license.padEnd(18)} ${m.title || m.id}  ← ${m.file}`);
  }
  process.exit(0);
}

const provider = args.provider;
const query = args.query || 'forest';
const type = args.type || 'photo';
const count = Number(args.count || 10);
if (!provider) {
  console.error('Thiếu --provider (pexels | pixabay | openverse | polyhaven). Xem library/sources.json.');
  process.exit(1);
}
const src = catalog.find((s) => s.id === provider);

async function json(url, headers = {}) {
  const r = await fetch(url, { headers: { 'user-agent': 'EnnamMotionStudio/0.1', ...headers } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}
async function download(url, file) {
  const r = await fetch(url, { headers: { 'user-agent': 'EnnamMotionStudio/0.1' } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
}
const slug = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);

async function items() {
  if (provider === 'pexels') {
    const key = process.env.PEXELS_API_KEY;
    if (!key) throw new Error('Đặt PEXELS_API_KEY (miễn phí tại pexels.com/api)');
    if (type === 'video') {
      const d = await json(`https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=${count}&orientation=landscape`, { Authorization: key });
      return d.videos.map((v) => {
        const f = v.video_files.filter((x) => x.file_type === 'video/mp4' && x.width <= 1920).sort((a, b) => b.width - a.width)[0] || v.video_files[0];
        return { id: v.id, url: f.link, ext: 'mp4', title: query, author: v.user?.name, page: v.url, license: 'Pexels License', width: f.width, height: f.height, duration: v.duration };
      });
    }
    const d = await json(`https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=${count}`, { Authorization: key });
    return d.photos.map((p) => ({ id: p.id, url: p.src.original, ext: 'jpg', title: p.alt || query, author: p.photographer, page: p.url, license: 'Pexels License', width: p.width, height: p.height }));
  }
  if (provider === 'pixabay') {
    const key = process.env.PIXABAY_API_KEY;
    if (!key) throw new Error('Đặt PIXABAY_API_KEY (miễn phí tại pixabay.com/api/docs)');
    if (type === 'video') {
      const d = await json(`https://pixabay.com/api/videos/?key=${key}&q=${encodeURIComponent(query)}&per_page=${Math.max(3, count)}`);
      return d.hits.map((h) => ({ id: h.id, url: (h.videos.large?.url || h.videos.medium.url), ext: 'mp4', title: h.tags, author: h.user, page: h.pageURL, license: 'Pixabay Content License', width: h.videos.large?.width, height: h.videos.large?.height, duration: h.duration }));
    }
    const d = await json(`https://pixabay.com/api/?key=${key}&q=${encodeURIComponent(query)}&image_type=${type === 'cutout' ? 'illustration' : 'photo'}&per_page=${Math.max(3, count)}`);
    return d.hits.map((h) => ({ id: h.id, url: h.largeImageURL, ext: 'jpg', title: h.tags, author: h.user, page: h.pageURL, license: 'Pixabay Content License', width: h.imageWidth, height: h.imageHeight }));
  }
  if (provider === 'openverse') {
    const d = await json(`https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&license_type=commercial&page_size=${count}`);
    return d.results.map((r) => ({
      id: r.id, url: r.url, ext: (r.filetype || path.extname(new URL(r.url).pathname).slice(1) || 'jpg').toLowerCase(), title: r.title, author: r.creator, page: r.foreign_landing_url,
      license: `CC ${String(r.license).toUpperCase()} ${r.license_version || ''}`.trim(), licenseUrl: r.license_url, attribution: r.attribution, width: r.width, height: r.height,
    }));
  }
  if (provider === 'polyhaven') {
    const t = { hdri: 'hdris', texture: 'textures', model: 'models' }[type] || 'hdris';
    const list = await json(`https://api.polyhaven.com/assets?t=${t}${query ? `&categories=${encodeURIComponent(query)}` : ''}`);
    const ids = Object.keys(list).slice(0, count);
    const out = [];
    for (const id of ids) {
      const files = await json(`https://api.polyhaven.com/files/${id}`);
      let url, ext;
      if (t === 'hdris') { url = files.hdri?.['2k']?.hdr?.url; ext = 'hdr'; out.push({ id, url, ext, title: list[id].name, author: Object.keys(list[id].authors || {}).join(', '), page: `https://polyhaven.com/a/${id}`, license: 'CC0' }); }
      else if (t === 'textures') { url = files.Diffuse?.['2k']?.jpg?.url || files.diffuse?.['2k']?.jpg?.url; ext = 'jpg'; out.push({ id, url, ext, title: list[id].name, page: `https://polyhaven.com/a/${id}`, license: 'CC0' }); }
      else { url = files.gltf?.['1k']?.gltf?.url; ext = 'gltf'; out.push({ id, url, ext, title: list[id].name, page: `https://polyhaven.com/a/${id}`, license: 'CC0' }); }
    }
    return out.filter((x) => x.url);
  }
  throw new Error('Provider chưa hỗ trợ: ' + provider);
}

const list = await items();
let n = 0;
for (const it of list) {
  const name = `${slug(it.title || query)}-${it.id}.${it.ext}`;
  const rel = path.join(provider, type, name);
  const file = path.join(ROOT, rel);
  if (fs.existsSync(file)) continue;
  try {
    await download(it.url, file);
    const meta = { provider, type, query, file: rel, ...it, commercial: src?.commercial ?? null, ads_ok: src?.ads_ok ?? null, importedAt: new Date().toISOString() };
    fs.writeFileSync(file + '.json', JSON.stringify(meta, null, 2));
    n++;
    console.log('✓', rel, '·', it.license, it.author ? '· ' + it.author : '');
  } catch (e) {
    console.warn('✗', it.url, e.message);
  }
}
console.log(`Đã tải ${n}/${list.length} file vào ${ROOT}`);
