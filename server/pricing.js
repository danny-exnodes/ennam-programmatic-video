// AI cost pricing (issue #34): token usage → estimated USD.
//
// Prices live in config/pricing.json (repo, has `version`, `source`, `verifiedAt`) and can be
// overridden without a deploy by DATA_DIR/pricing.json (same shape; its `models` are merged over
// the repo's, its `version` wins). Files are re-read when their mtime changes, so an override
// takes effect on the next usage line — lines already written keep their `usd` + `pricingVersion`.
//
// Pure helpers (`costOf`, `usdOf`, `priceFor`) take the pricing table as an argument so
// scripts/test-budget.js can check the math offline.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_PRICING_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'config', 'pricing.json');
const FIELDS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];
const RATE_KEYS = ['input', 'output', 'cacheWrite5m', 'cacheRead'];
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
/** USD values are stored rounded to 1e-6 (well below the 1e-4 tolerance of the acceptance test). */
export const roundUsd = (v) => Math.round(num(v) * 1e6) / 1e6;

/** Rates that apply to ONE request (Haiku 5.5: prompt > threshold → longContext rates). */
export function ratesFor(price, u) {
  const lc = price?.longContext;
  if (lc && Number(lc.thresholdPromptTokens) > 0) {
    const prompt = num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens);
    if (prompt > Number(lc.thresholdPromptTokens)) return { ...price, ...lc };
  }
  return price;
}

/** Cost of one request's usage at `price` ({ input, output, cacheWrite5m, cacheRead } USD/MTok). */
export function costOf(price, u = {}) {
  const r = ratesFor(price, u);
  return (num(u.input_tokens) * num(r.input) + num(u.output_tokens) * num(r.output)
    + num(u.cache_creation_input_tokens) * num(r.cacheWrite5m) + num(u.cache_read_input_tokens) * num(r.cacheRead)) / 1e6;
}

const warned = new Set();
/**
 * Price row for `model`. Unknown model → the fallback (director) model's price + one warning
 * per model. → { model, price, priced: model actually used for the price, known }
 */
export function priceFor(pricing, model, fallbackModel) {
  const models = pricing?.models || {};
  if (model && models[model]) return { price: models[model], priced: model, known: true };
  const fb = models[fallbackModel] ? fallbackModel : Object.keys(models)[0];
  if (!warned.has(model || '')) {
    warned.add(model || '');
    console.warn(`[pricing] không có giá cho model "${model || '(trống)'}" — tạm tính theo giá ${fb}`);
  }
  return { price: models[fb] || {}, priced: fb || null, known: false };
}

/**
 * USD of a run. `rounds` (per-request usage, e.g. project.lastDirector.usage.rounds) is priced
 * request by request (needed for prompt-length tiers); without it the total is priced as one request.
 */
export function usdOf(pricing, { model, usage, rounds = null, fallbackModel }) {
  const { price, priced, known } = priceFor(pricing, model, fallbackModel);
  const list = Array.isArray(rounds) && rounds.length ? rounds : [usage || {}];
  return { usd: roundUsd(list.reduce((s, u) => s + costOf(price, u), 0)), pricedAs: priced, known };
}

function validModels(models) {
  const out = {};
  for (const [id, p] of Object.entries(models || {})) {
    if (!p || typeof p !== 'object' || !RATE_KEYS.every((k) => Number.isFinite(Number(p[k])) && Number(p[k]) >= 0)) {
      console.warn(`[pricing] bỏ qua giá không hợp lệ của "${id}"`);
      continue;
    }
    out[id] = p;
  }
  return out;
}

function readJson(file) {
  try { return { st: fs.statSync(file), data: JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`[pricing] không đọc được ${file}: ${e.message}`);
    return null;
  }
}

let cache = null;
/** Current pricing table (repo file + optional DATA_DIR/pricing.json override), cached by mtime. */
export function loadPricing(dataDir) {
  const overrideFile = dataDir ? path.join(dataDir, 'pricing.json') : null;
  const stamp = [REPO_PRICING_FILE, overrideFile].map((f) => { try { return f ? fs.statSync(f).mtimeMs : 0; } catch { return 0; } }).join('|');
  if (cache && cache.stamp === stamp) return cache.pricing;
  const base = readJson(REPO_PRICING_FILE)?.data || { version: 'none', models: {} };
  const over = overrideFile ? readJson(overrideFile)?.data : null;
  const pricing = {
    ...base, ...(over || {}),
    version: String(over?.version || base.version || 'none'),
    models: validModels({ ...(base.models || {}), ...(over?.models || {}) }),
    overridden: !!over,
  };
  cache = { stamp, pricing };
  return pricing;
}

export { FIELDS as PRICED_FIELDS };
