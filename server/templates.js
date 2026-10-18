// Scene templates ("Mẫu cảnh") and quick project recipes ("Nhanh").
// Each scene is real shot code — the same code the AI director writes —
// so the team can start from a template and then ask the director to refine.
import { newId } from './store.js';
import * as yearend from './templates/seasonal/yearend.js';
import * as tet from './templates/seasonal/tet.js';

const J = (v) => JSON.stringify(v);

// Visible text is declared as an editable field (s.field) at the top of the shot,
// so the Inspector "Nội dung" form can change it without code or an AI call.
const field = (name, key, def, label, maxLength = 60) =>
  `const ${name} = s.field(${J(key)}, ${J(def)}, { label: ${J(label)}, maxLength: ${maxLength} });`;
const headlineField = (def) => field('headline', 'headline', def, 'Tiêu đề');
const DEFAULT_FEATURES = [{ icon: 'drop', label: 'Thẩm thấu' }, { icon: 'sun', label: 'Sáng da' }, { icon: 'shield', label: 'Dịu nhẹ' }];
/** Feature badges as `const feats = [...]` with one text field per label. */
const featureFields = (features, max = 3) => {
  const list = (features || []).slice(0, max);
  return `const feats = [\n${list.map((f, i) => `  { icon: ${J(f.icon)}, label: s.field(${J(`feature_${i + 1}`)}, ${J(f.label)}, { label: ${J(`Lợi ích ${i + 1}`)}, maxLength: 18 }) },`).join('\n')}\n];`;
};

export const SCENES = {
  hook: {
    name: 'Mở đầu: vấn đề',
    desc: 'Ảnh nền chậm, ánh sáng rò, câu hook hiện chữ mờ dần',
    duration: 3.5,
    code: ({ bg, headline }) => `
const { t, p, W, H } = s;
${headlineField(headline || 'Làn da mệt mỏi, *thiếu sức sống?*')}
s.background('#0b0806');
s.camera({ zoom: s.lerp(1.12, 1.0, s.ease.outCubic(p)), x: s.lerp(30, 0, p), shake: 2 });
${bg ? `s.image(${J(bg)}, { fit: 'cover', brightness: 0.55, saturate: 0.8, blur: s.lerp(6, 1.5, p) });` : `s.background({ radial: ['#2a1a0c', '#050302'] });`}
s.fx.dust({ count: 70, opacity: 0.45, seed: 2 });
s.fx.leak({ intensity: 0.22, seed: 1 });
s.text(headline, {
  x: W * 0.5, y: H * 0.52, size: 78, weight: 700, align: 'center', anim: 'blur', start: 0.4, dur: 0.9, stagger: 0.08,
  out: s.d - 0.5, maxWidth: W * 0.8, maxLines: 2,
});
`,
  },
  splash: {
    name: 'Giọt rơi – vương miện bắn',
    desc: 'Mô phỏng vật lý giọt chất lỏng rơi tạo vương miện, tia Worthington, gợn sóng',
    duration: 4,
    code: ({ bg, headline, material = 'serum', features }) => `
const { t, p, W, H } = s;
${headlineField(headline || 'Sáng mịn, *tươi tắn*')}
${features && features.length ? featureFields(features) : ''}
// Slow push-in like a macro probe lens, with micro handheld shake.
s.camera({ zoom: s.lerp(1.0, 1.08, s.ease.inOutSine(p)), y: s.lerp(0, -20, p), shake: 1.5 });
${bg ? `s.image(${J(bg)}, { fit: 'cover', brightness: 0.75, blur: 2 });` : `s.background({ radial: ['#3a2410', '#0a0604'], y: H * 0.7 });`}
s.fx.rays({ x: W * 0.35, y: -80, count: 7, opacity: 0.12 });
// Physical liquid splash: drop falls, crown forms, spikes pinch off droplets, jet rises.
s.fx.liquidCrown({
  x: W * 0.5, y: H * 0.66, radius: H * 0.2, start: 0.7, material: ${J(material)},
  tilt: 0.3, energy: 1.1, seed: 7, slowmo: 1.6, pool: true,
});
s.fx.bokeh({ count: 14, size: [30, 90], opacity: 0.18, seed: 4 });
s.text(headline, { x: W * 0.25, y: H * 0.86, size: 64, weight: 800, anim: 'rise', start: 1.6, align: 'center', maxWidth: W * 0.42, maxLines: 1 });
s.underline({ x: W * 0.25 - 170, y: H * 0.86 + 26, width: 340, start: 2.1 });
${features && features.length ? `feats.forEach((f, i) => s.badge({ icon: f.icon, label: f.label, x: W * (0.6 + i * 0.12), y: H * 0.8, size: 110, start: 2.0 + i * 0.18 }));` : ''}
`,
  },
  hero: {
    name: 'Ra mắt sản phẩm',
    desc: 'Sản phẩm rơi xuống mặt phẳng nảy lò xo, bóng tiếp xúc, phản chiếu, vệt sáng lướt',
    duration: 4,
    code: ({ product, headline, bg }) => `
const { t, p, W, H } = s;
${headlineField(headline || 'Lumi C+ *15% Vitamin C*')}
${bg ? `s.image(${J(bg)}, { fit: 'cover', blur: 14, brightness: 0.5 });` : `s.background({ radial: ['#3b2410', '#0d0805'], y: H * 0.45 });`}
s.fx.rays({ x: W * 0.7, y: -60, angle: Math.PI * 0.62, count: 8, opacity: 0.14 });
s.camera({ zoom: s.lerp(1.06, 1.0, s.ease.outCubic(p)) });
const floorY = H * 0.8;
// Rigid-body drop with restitution: lands, bounces, settles.
const drop = s.physics.drop({ from: -H * 0.6, floor: floorY, gravity: 5200, restitution: 0.28, delay: 0.2 });
const squash = drop.squash;
${product ? `const r = s.image(${J(product)}, { x: W * 0.5, y: drop.y, h: H * 0.62, anchor: [0.5, 1],
  scale: 1, skewX: 0, shadow: { y: 18, blur: 30 }, reflect: { opacity: 0.18, height: 0.35 } });
s.contactShadow({ x: W * 0.5, y: floorY + 4, width: H * 0.42 * (1 - Math.min(0.6, (floorY - drop.y) / H)), opacity: 0.6 * (1 - Math.min(0.9, (floorY - drop.y) / (H * 0.5))) });
if (r) s.fx.sheen({ rect: [r.x, r.y, r.w, r.h], image: ${J(product)}, start: 1.4, duration: 1.3, intensity: 0.7 });` : `s.droplet({ x: W * 0.5, y: drop.y - 120, r: 120 });`}
void squash;
s.fx.dust({ count: 60, opacity: 0.5, seed: 8 });
s.text(headline, { x: W * 0.5, y: H * 0.18, size: 70, weight: 800, align: 'center', anim: 'rise', start: 1.0, maxWidth: W * 0.8, maxLines: 2 });
`,
  },
  ingredient: {
    name: 'Bùng nổ thành phần',
    desc: 'Thành phần bay ra với trọng lực, xoay, giọt nước bắn, sương mù',
    duration: 3.5,
    code: ({ ingredient, headline, material = 'juice', bg }) => `
const { t, p, W, H } = s;
${headlineField(headline || 'Thẩm thấu nhanh, *cho làn da sáng*')}
${bg ? `s.image(${J(bg)}, { fit: 'cover', brightness: 0.6, blur: 8 });` : `s.background({ radial: ['#4a2a08', '#0c0703'] });`}
s.camera({ zoom: s.lerp(1.0, 1.1, s.ease.outCubic(p)), shake: s.prog(0.3, 0.6) > 0 && s.prog(0.3, 0.6) < 1 ? 5 : 1 });
${ingredient ? `const k = s.spring({ from: 0.6, to: 1, stiffness: 140, damping: 11, delay: 0.1 });
s.image(${J(ingredient)}, { x: W * 0.5, y: H * 0.52, h: H * 0.55 * k, rotate: (1 - k) * 0.4, shadow: true });
s.fx.burst({ x: W * 0.5, y: H * 0.5, start: 0.35, kind: 'image', image: ${J(ingredient)}, count: 9, size: [40, 90], speed: [700, 1300], spread: Math.PI * 2, gravity: 1900, spin: 5, depth: true, seed: 3 });` : ''}
s.fx.burst({ x: W * 0.5, y: H * 0.5, start: 0.35, kind: 'droplet', material: ${J(material)}, count: 60, size: [3, 14], speed: [500, 1500], spread: Math.PI * 2, gravity: 2000, seed: 5 });
s.fx.mist({ x: W * 0.5, y: H * 0.75, rate: 8, rise: 50, size: 160, spread: 500, opacity: 0.035, start: 0.3 });
s.text(headline, { x: W * 0.5, y: H * 0.88, size: 60, weight: 700, align: 'center', anim: 'rise', start: 0.9, maxWidth: W * 0.84, maxLines: 1 });
`,
  },
  features: {
    name: 'Ba lợi ích',
    desc: 'Ba huy hiệu biểu tượng bật lên với lò xo trên nền mờ',
    duration: 3.5,
    code: ({ bg, features, headline }) => `
const { t, p, W, H } = s;
${headlineField(headline || 'Rạng rỡ *mỗi sáng*')}
${featureFields(features && features.length ? features : DEFAULT_FEATURES)}
${bg ? `s.image(${J(bg)}, { fit: 'cover', blur: s.lerp(2, 18, s.ease.outCubic(s.prog(0, 0.8))), brightness: 0.55, scale: s.lerp(1.05, 1.12, p) });` : `s.background({ radial: ['#2c1a0a', '#070403'] });`}
s.fx.bokeh({ count: 18, opacity: 0.22, seed: 12 });
s.text(headline, { x: W * 0.5, y: H * 0.26, size: 72, weight: 800, align: 'center', anim: 'rise', start: 0.2, maxWidth: W * 0.8, maxLines: 2 });
feats.forEach((f, i) => {
  const x = W * 0.5 + (i - (feats.length - 1) / 2) * 300;
  s.badge({ icon: f.icon, label: f.label, x, y: H * 0.55, size: 170, start: 0.6 + i * 0.2 });
});
`,
  },
  pour: {
    name: 'Rót chất lỏng',
    desc: 'Dòng chảy mỏng dần theo trọng lực, vùng va chạm, ánh sáng khúc xạ',
    duration: 4,
    code: ({ material = 'honey', headline, bg }) => `
const { t, p, W, H } = s;
${headlineField(headline || 'Mịn màng *như lụa*')}
${bg ? `s.image(${J(bg)}, { fit: 'cover', brightness: 0.6 });` : `s.background(['#1a0f06', '#3a220c', '#0c0703']);`}
s.camera({ zoom: s.lerp(1.0, 1.06, p) });
s.fx.pour({ x: W * 0.5, y: -20, surfaceY: H * 0.78, width: 46, start: 0.2, end: 3.2, material: ${J(material)} });
s.fx.caustics({ rect: [0, H * 0.7, W, H * 0.3], intensity: 0.25, color: '#ffd27a' });
s.text(headline, { x: W * 0.12, y: H * 0.42, size: 76, weight: 800, anim: 'rise', start: 0.8, maxWidth: W * 0.35, maxLines: 3 });
`,
  },
  drip: {
    name: 'Giọt từ ống nhỏ giọt',
    desc: 'Giọt treo, căng dần, thắt cổ và rơi theo chu kỳ',
    duration: 3.5,
    code: ({ material = 'serum', headline, bg }) => `
const { t, p, W, H } = s;
${headlineField(headline || '*15%* Vitamin C nguyên chất')}
${bg ? `s.image(${J(bg)}, { fit: 'cover', brightness: 0.7, scale: s.lerp(1, 1.06, p) });` : `s.background({ radial: ['#3a2410', '#070403'], y: H * 0.3 });`}
s.fx.drip({ x: W * 0.62, y: H * 0.3, size: 26, start: 0.1, material: ${J(material)}, floorY: H * 1.1 });
s.fx.dust({ count: 50, opacity: 0.4 });
s.text(headline, { x: W * 0.1, y: H * 0.55, size: 68, weight: 800, anim: 'rise', start: 0.5, maxWidth: W * 0.42, maxLines: 3 });
`,
  },
  cta: {
    name: 'Kêu gọi hành động',
    desc: 'Sản phẩm trung tâm, tiêu đề, nút CTA nảy lò xo, loé sáng',
    duration: 3.5,
    code: ({ product, headline, cta, bg }) => `
const { t, p, W, H } = s;
${field('brand', 'headline', headline || 'Lumi C+', 'Tên sản phẩm / thương hiệu', 40)}
${field('subline', 'subline', 'Đặt ngay hôm nay', 'Dòng phụ', 50)}
${field('ctaLabel', 'cta', cta || 'Mua ngay', 'Nút CTA', 20)}
const ctaColor = s.field("cta_color", s.palette.primary, { type: "color", label: "Màu nút CTA" });
${bg ? `s.image(${J(bg)}, { fit: 'cover', blur: 16, brightness: 0.45 });` : `s.background({ radial: ['#3c2410', '#080503'] });`}
s.fx.rays({ x: W * 0.5, y: -100, angle: Math.PI / 2, count: 10, opacity: 0.16 });
const k = s.spring({ from: 0.85, to: 1, stiffness: 90, damping: 12 });
${product ? `const r = s.image(${J(product)}, { x: W * 0.3, y: H * 0.88, h: H * 0.7 * k, anchor: [0.5, 1], shadow: true, reflect: { opacity: 0.15 } });
s.contactShadow({ x: W * 0.3, y: H * 0.885, width: H * 0.4 });
if (r) s.fx.sheen({ rect: [r.x, r.y, r.w, r.h], image: ${J(product)}, start: 0.8, duration: 1.2 });` : ''}
s.text(brand, { x: W * 0.68, y: H * 0.4, size: 110, weight: 800, align: 'center', anim: 'blur', start: 0.3, font: 'sans', maxWidth: W * 0.56, maxLines: 1 });
s.text(subline, { x: W * 0.68, y: H * 0.52, size: 44, weight: 500, align: 'center', anim: 'rise', start: 0.7, color: '#f3e3cc', maxWidth: W * 0.56, maxLines: 1 });
const b = s.spring({ from: 0, to: 1, stiffness: 160, damping: 10, delay: 1.1 });
if (b > 0.01) s.world((c) => {
  c.save(); c.translate(W * 0.68, H * 0.66); c.scale(b, b);
  c.fillStyle = ctaColor; c.beginPath(); c.roundRect(-190, -42, 380, 84, 42); c.fill();
  c.restore();
}, 0);
if (b > 0.01) s.text(ctaLabel, { x: W * 0.68, y: H * 0.66 + 16, size: 40, weight: 700, align: 'center', anim: 'none', shadow: false, maxWidth: 330, maxLines: 1 });
s.fx.flare({ x: W * 0.78, y: H * 0.18, intensity: 0.35 * s.prog(0.5, 1.5) });
`,
  },
  kenburns: {
    name: 'Ảnh chuyển động (Ken Burns)',
    desc: 'Ảnh tĩnh có camera đẩy chậm, thị sai, hạt bụi, chú thích',
    duration: 4,
    code: ({ bg, headline }) => `
const { t, p, W, H } = s;
${headlineField(headline || 'Khoảnh khắc *đáng nhớ*')}
s.camera({ zoom: s.lerp(1.0, 1.15, s.ease.inOutSine(p)), x: s.lerp(-40, 40, p), shake: 1 });
${bg ? `s.image(${J(bg)}, { fit: 'cover' });` : `s.background('#111');`}
s.fx.dust({ count: 40, opacity: 0.35 });
s.fx.leak({ intensity: 0.18, seed: 3 });
s.text(headline, { x: W * 0.08, y: H * 0.85, size: 64, weight: 700, anim: 'rise', start: 0.5, maxWidth: W * 0.84, maxLines: 1 });
`,
  },
};

const BASE_TEMPLATES = [
  {
    id: 'product-ad', name: 'Quảng cáo sản phẩm 15–20s', aspect: '16:9',
    desc: 'Hook → giọt bắn → thành phần → lợi ích → CTA', scenes: ['hook', 'splash', 'ingredient', 'features', 'cta'],
  },
  {
    id: 'teaser', name: 'Teaser 8s', aspect: '16:9', desc: 'Giọt rơi → ra mắt sản phẩm', scenes: ['drip', 'hero'],
  },
  {
    id: 'event-recap', name: 'Recap sự kiện', aspect: '16:9', desc: 'Chuỗi ảnh sự kiện Ken Burns + tiêu đề', scenes: ['kenburns', 'kenburns', 'kenburns', 'cta'],
  },
];

// Seasonal bundles ("Theo mùa"): server/templates/seasonal/*.js. Their scenes are kept
// out of SCENES on purpose — director.js builds its cached system prompt from SCENES.
const SEASONAL = [yearend, tet];
export const SEASONS = SEASONAL.map((m) => ({ ...m.SEASON, fields: m.FORM_FIELDS, defaults: m.DEFAULTS }));
export const SEASONAL_SCENES = Object.fromEntries(SEASONAL.flatMap((m) =>
  Object.entries(m.SCENES).map(([k, v]) => [k, { ...v, season: m.SEASON.id }])));
/** All quick recipes: base ones, then season-tagged ones (`season: 'yearend'`, …). */
export const TEMPLATES = [...BASE_TEMPLATES, ...SEASONAL.flatMap((m) => m.RECIPES)];

/** Seasonal recipe → shots. Form values (company, date, …) prefill shot.fields; empty values keep defaults. */
function buildSeasonal(p, tpl, fields = {}) {
  const pre = {};
  for (const [k, v] of Object.entries(fields || {})) if (typeof v === 'string' && v.trim()) pre[k] = v.trim();
  p.shots = tpl.scenes.map((e, i) => {
    const sc = SEASONAL_SCENES[e.scene];
    return {
      id: newId('s'),
      name: sc.name,
      duration: e.duration ?? sc.duration,
      transition: i === 0 ? { type: 'cut', duration: 0.5 } : (e.transition || { type: 'dissolve', duration: 0.5 }),
      code: sc.code(e.opts || {}),
      fields: { ...pre },
    };
  });
  if (tpl.style) p.style = { ...p.style, ...tpl.style };
  return p;
}

function pickAssets(p) {
  const imgs = p.assets.filter((a) => a.type === 'image' || a.type === 'video');
  const by = (re) => imgs.find((a) => re.test(a.name) || re.test(a.desc || ''));
  const product = by(/hero|bottle|product|chai|san-pham|sp/i) || imgs[0];
  const ingredient = by(/splash|orange|cam|fruit|ingredient|thanh-phan|leaf|la/i);
  const bgs = imgs.filter((a) => a !== product && a !== ingredient);
  return { product: product?.name, ingredient: ingredient?.name, bgs: bgs.map((a) => a.name), all: imgs.map((a) => a.name) };
}

export function buildFromTemplate(project, { template, scene, at, headline, features, material, cta, fields } = {}) {
  if (scene && SEASONAL_SCENES[scene]) {
    const p = structuredClone(project);
    const sc = SEASONAL_SCENES[scene];
    const shot = { id: newId('s'), name: sc.name, duration: sc.duration, transition: { type: p.shots.length ? 'dissolve' : 'cut', duration: 0.5 }, code: sc.code({}), fields: {} };
    const idx = at == null ? p.shots.length : Math.max(0, Math.min(p.shots.length, at));
    p.shots.splice(idx, 0, shot);
    return p;
  }
  const seasonal = template && TEMPLATES.find((x) => x.id === template && x.season);
  if (seasonal) return buildSeasonal(structuredClone(project), seasonal, fields);
  const A = pickAssets(project);
  const make = (key, i, extra = {}) => {
    const sc = SCENES[key];
    const bg = A.bgs.length ? A.bgs[i % A.bgs.length] : key === 'kenburns' ? A.all[i % Math.max(1, A.all.length)] : null;
    return {
      id: newId('s'),
      name: sc.name,
      duration: sc.duration,
      transition: { type: i === 0 ? 'cut' : 'dissolve', duration: 0.5 },
      code: sc.code({ bg, product: A.product, ingredient: A.ingredient, headline, features, material, cta, ...extra }).trim() + '\n',
      fields: {},
    };
  };
  const p = structuredClone(project);
  if (scene) {
    const shot = make(scene, p.shots.length);
    const idx = at == null ? p.shots.length : Math.max(0, Math.min(p.shots.length, at));
    p.shots.splice(idx, 0, shot);
    return p;
  }
  const tpl = BASE_TEMPLATES.find((x) => x.id === template) || BASE_TEMPLATES[0];
  p.shots = tpl.scenes.map((k, i) => make(k, i));
  return p;
}
