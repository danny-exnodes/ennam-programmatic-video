// Token usage per user (issue #25) + estimated USD (issue #34). When a director job finishes,
// its usage total is stored on the job (`job.usage`, with `job.userId`) AND appended as one
// compact line to DATA_DIR/usage/<YYYY-MM>.jsonl — job files are cleaned after 6 h
// (server/jobs.js), the monthly log is the durable source. No prompts, briefs or secrets.
//
// Line: { at, userId, projectId, jobId, usage, model, usd, pricingVersion }. `usd` is computed
// ONCE at write time with the pricing table of that moment (server/pricing.js) so a later price
// change never alters months already recorded. Legacy lines (before #34) have no `usd`: they are
// estimated at read time with the current table (`usdEstimated: true` on the aggregate).
//
// Months are Vietnam time (UTC+7, issue #34). New files are named by VN month; files written
// before #34 were named by UTC month, so a VN month M is read from files M and M-1 and every
// line is re-assigned by `monthOf(line.at)` — old data stays correct.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './store.js';
import { USAGE_FIELDS, pickUsage, DIRECTOR_MODEL } from './director.js';
import { loadPricing, usdOf, roundUsd } from './pricing.js';

export const USAGE_DIR = path.join(DATA_DIR, 'usage');
const MONTH_RE = /^\d{4}-\d{2}$/;
export const VN_OFFSET_MS = 7 * 3600e3;
/** 'YYYY-MM' of `d` in Vietnam time (UTC+7, no DST). */
export const monthOf = (d = new Date()) => new Date(new Date(d).getTime() + VN_OFFSET_MS).toISOString().slice(0, 7);
/** Previous 'YYYY-MM'. */
export function prevMonth(m) {
  const [y, mo] = m.split('-').map(Number);
  return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`;
}

export const currentPricing = () => loadPricing(DATA_DIR);

/** USD of a usage record at the CURRENT pricing → { usd, pricingVersion, pricedAs }. */
export function priceUsage({ model = DIRECTOR_MODEL, usage, rounds = null }) {
  const pricing = currentPricing();
  const { usd, pricedAs } = usdOf(pricing, { model: model || DIRECTOR_MODEL, usage: pickUsage(usage), rounds: rounds?.map((r) => pickUsage(r)), fallbackModel: DIRECTOR_MODEL });
  return { usd, pricingVersion: pricing.version, pricedAs };
}

/** Append { at, userId, projectId, jobId, usage, model, usd, pricingVersion } to usage/<VN month>.jsonl. */
export async function recordUsage({ userId = null, projectId = null, jobId = null, usage, rounds = null, model = DIRECTOR_MODEL, at = new Date().toISOString() }) {
  const { usd, pricingVersion } = priceUsage({ model, usage, rounds });
  const line = { at, userId: userId || null, projectId, jobId, usage: pickUsage(usage), model: model || DIRECTOR_MODEL, usd, pricingVersion };
  await fsp.mkdir(USAGE_DIR, { recursive: true });
  await fsp.appendFile(path.join(USAGE_DIR, `${monthOf(at)}.jsonl`), JSON.stringify(line) + '\n');
  return line;
}

function fileMonths() {
  try {
    return fs.readdirSync(USAGE_DIR).filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, 7)).filter((m) => MONTH_RE.test(m));
  } catch {
    return [];
  }
}

function readFile(month) {
  try {
    return fs.readFileSync(path.join(USAGE_DIR, `${month}.jsonl`), 'utf8').split('\n').filter(Boolean).flatMap((l) => {
      try { return [JSON.parse(l)]; } catch { return []; }
    });
  } catch {
    return [];
  }
}

const lineMonth = (r, fileMonth) => {
  const t = Date.parse(r?.at);
  return Number.isFinite(t) ? monthOf(t) : fileMonth;
};

/** Every usage line of VN month `month` (files M-1 and M, filtered by the line's own `at`). */
export function readMonthLines(month) {
  const out = [];
  for (const fm of [prevMonth(month), month]) for (const r of readFile(fm)) if (lineMonth(r, fm) === month) out.push(r);
  return out;
}

/** VN months that have usage, newest first. */
export async function listMonths() {
  const set = new Set();
  for (const fm of fileMonths()) {
    set.add(fm);
    for (const r of readFile(fm)) set.add(lineMonth(r, fm));
  }
  return [...set].sort().reverse();
}

/** USD of one line: recorded value, or (legacy line / job fallback) estimated now. */
function lineUsd(r) {
  if (Number.isFinite(r.usd)) return { usd: r.usd, estimated: false };
  return { usd: priceUsage({ model: r.model, usage: r.usage }).usd, estimated: true };
}

/**
 * Aggregate one VN month per user: the usage log plus finished director jobs still in
 * memory/disk that carry `usage` but are missing from the log (deduped by jobId).
 * → [{ userId, jobs, total: { input_tokens, … }, usd, usdEstimated }]
 */
export function monthUsage(month, jobs = []) {
  if (!MONTH_RE.test(month || '')) throw Object.assign(new Error('Tháng phải dạng YYYY-MM'), { status: 400 });
  const rows = readMonthLines(month);
  const seen = new Set(rows.map((r) => r.jobId).filter(Boolean));
  for (const j of jobs) {
    if (j.kind !== 'director' || !j.usage || seen.has(j.id)) continue;
    const at = new Date(j.finishedAt || j.createdAt).toISOString();
    if (monthOf(at) !== month) continue;
    rows.push({ at, userId: j.userId || null, projectId: j.projectId, jobId: j.id, usage: j.usage, model: j.usageModel, usd: j.usageUsd });
  }
  const by = new Map();
  for (const r of rows) {
    const k = r.userId || null;
    const acc = by.get(k) || { userId: k, jobs: 0, total: pickUsage({}), usd: 0, usdEstimated: false };
    acc.jobs++;
    const u = pickUsage(r.usage);
    for (const f of USAGE_FIELDS) acc.total[f] += u[f];
    const c = lineUsd(r);
    acc.usd = roundUsd(acc.usd + c.usd);
    if (c.estimated) acc.usdEstimated = true;
    by.set(k, acc);
  }
  return [...by.values()].sort((a, b) => (b.total.input_tokens + b.total.output_tokens) - (a.total.input_tokens + a.total.output_tokens));
}
