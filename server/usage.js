// Token usage per user (issue #25). When a director job finishes, its usage total is
// stored on the job (`job.usage`, with `job.userId`) AND appended as one compact line to
// DATA_DIR/usage/<YYYY-MM>.jsonl — job files are cleaned after 6 h (server/jobs.js),
// the monthly log is the durable source. No prompts, briefs or secrets are written.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './store.js';
import { USAGE_FIELDS, pickUsage } from './director.js';

export const USAGE_DIR = path.join(DATA_DIR, 'usage');
const MONTH_RE = /^\d{4}-\d{2}$/;
export const monthOf = (d = new Date()) => new Date(d).toISOString().slice(0, 7);

/** Append { at, userId, projectId, jobId, usage } to usage/<YYYY-MM>.jsonl. */
export async function recordUsage({ userId = null, projectId = null, jobId = null, usage, at = new Date().toISOString() }) {
  const line = { at, userId: userId || null, projectId, jobId, usage: pickUsage(usage) };
  await fsp.mkdir(USAGE_DIR, { recursive: true });
  await fsp.appendFile(path.join(USAGE_DIR, `${monthOf(at)}.jsonl`), JSON.stringify(line) + '\n');
  return line;
}

export async function listMonths() {
  try {
    return (await fsp.readdir(USAGE_DIR)).filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, 7)).filter((m) => MONTH_RE.test(m)).sort().reverse();
  } catch {
    return [];
  }
}

function readLines(month) {
  try {
    return fs.readFileSync(path.join(USAGE_DIR, `${month}.jsonl`), 'utf8').split('\n').filter(Boolean).flatMap((l) => {
      try { return [JSON.parse(l)]; } catch { return []; }
    });
  } catch {
    return [];
  }
}

/**
 * Aggregate one month per user: the usage log plus finished director jobs still in
 * memory/disk that carry `usage` but are missing from the log (deduped by jobId).
 * → [{ userId, jobs, total: { input_tokens, … } }]
 */
export function monthUsage(month, jobs = []) {
  if (!MONTH_RE.test(month || '')) throw Object.assign(new Error('Tháng phải dạng YYYY-MM'), { status: 400 });
  const rows = readLines(month);
  const seen = new Set(rows.map((r) => r.jobId).filter(Boolean));
  for (const j of jobs) {
    if (j.kind !== 'director' || !j.usage || seen.has(j.id)) continue;
    const at = new Date(j.finishedAt || j.createdAt).toISOString();
    if (monthOf(at) !== month) continue;
    rows.push({ at, userId: j.userId || null, projectId: j.projectId, jobId: j.id, usage: j.usage });
  }
  const by = new Map();
  for (const r of rows) {
    const k = r.userId || null;
    const acc = by.get(k) || { userId: k, jobs: 0, total: pickUsage({}) };
    acc.jobs++;
    const u = pickUsage(r.usage);
    for (const f of USAGE_FIELDS) acc.total[f] += u[f];
    by.set(k, acc);
  }
  return [...by.values()].sort((a, b) => (b.total.input_tokens + b.total.output_tokens) - (a.total.input_tokens + a.total.output_tokens));
}
