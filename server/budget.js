// Monthly AI cost budgets per user (issue #34).
//
// - DATA_DIR/budgets.json: { roles: { member, admin }, users: { <userId>: number|null }, shared,
//   updatedAt, updatedBy }. Values are USD per VN month (UTC+7). Missing / null role default =
//   unlimited; a user key present with `null` = explicitly unlimited (overrides the role); a user
//   key absent = role default. `shared` is the "Chung" group: usage without a user (legacy
//   APP_PASSWORD / open mode, userId null). No file = nothing configured = nobody is limited.
// - DATA_DIR/budget-log.jsonl: one line per "Nới hạn mức" { at, by, byName, userId, month, amount,
//   reason } — adds `amount` USD to that user's (or "Chung") limit for that month only.
// - Both files are read on every check (small), so admin changes apply immediately, no restart.
//
// `checkBudget(userId, kind)` is THE shared gate: every route that creates a job of a paid kind
// (`registerKind(…, { paid: true })` — director today; concept #20 and Higgsfield plates later)
// calls `assertBudget(userId, kind)` BEFORE `createJob`, so a blocked request never queues a job.
// Jobs already queued/running are never cancelled (a slight overrun by the last job is accepted).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './store.js';
import { listJobs, isPaidKind } from './jobs.js';
import { monthUsage, monthOf } from './usage.js';
import { findUser } from './auth.js';
import { roundUsd } from './pricing.js';

export const BUDGETS_FILE = path.join(DATA_DIR, 'budgets.json');
export const BUDGET_LOG_FILE = path.join(DATA_DIR, 'budget-log.jsonl');
export const WARN_AT = 0.8;
export const ROLES = ['member', 'admin'];
export const SHARED_KEY = '_shared'; // "Chung" in APIs that need a string key
export const BLOCKED_MESSAGE = 'Đã hết hạn mức tháng — liên hệ admin';

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
/** null/'' → null (unlimited); number ≥ 0 → rounded USD; anything else → 400. */
function limitValue(v, what) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw bad(`${what}: hạn mức phải là số USD ≥ 0 (để trống = không giới hạn)`);
  return roundUsd(n);
}

const EMPTY = () => ({ roles: {}, users: {}, shared: null });
/** Current budget config (fresh read; corrupt file → treated as "not configured" + warning). */
export function readBudgets() {
  try {
    const d = JSON.parse(fs.readFileSync(BUDGETS_FILE, 'utf8'));
    return { ...EMPTY(), ...d, roles: d.roles || {}, users: d.users || {} };
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`[budget] không đọc được budgets.json: ${e.message} — coi như chưa đặt hạn mức`);
    return EMPTY();
  }
}

let writing = Promise.resolve();
const serial = (fn) => (writing = writing.then(fn, fn));

async function writeJsonAtomic(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
  await fsp.rename(tmp, file);
}

/**
 * Patch the config: { roles?: { member?, admin? }, shared?, users?: { <id>: number|null|'role' } }.
 * Role/shared: number = USD limit, null/'' = unlimited. User: number = override, null = unlimited
 * override, 'role' = remove the override (follow the role default).
 */
export function updateBudgets(patch = {}, by = null) {
  return serial(async () => {
    const cur = readBudgets();
    const next = { roles: { ...cur.roles }, users: { ...cur.users }, shared: cur.shared ?? null };
    if (patch.roles && typeof patch.roles === 'object') {
      for (const r of Object.keys(patch.roles)) {
        if (!ROLES.includes(r)) throw bad(`Vai trò không hợp lệ: ${r}`);
        next.roles[r] = limitValue(patch.roles[r], `Vai trò ${r}`);
      }
    }
    if ('shared' in patch) next.shared = limitValue(patch.shared, 'Nhóm "Chung"');
    if (patch.users && typeof patch.users === 'object') {
      for (const [id, v] of Object.entries(patch.users)) {
        if (!findUser(id)) throw bad(`Không có tài khoản ${id}`);
        if (v === 'role') delete next.users[id];
        else next.users[id] = limitValue(v, 'Hạn mức riêng');
      }
    }
    next.updatedAt = new Date().toISOString();
    next.updatedBy = by?.id || null;
    await writeJsonAtomic(BUDGETS_FILE, next);
    return next;
  });
}

/** "Nới hạn mức" lines (optionally for one month), oldest first. */
export function readRaises(month = null) {
  let lines = [];
  try {
    lines = fs.readFileSync(BUDGET_LOG_FILE, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  } catch { /* no log yet */ }
  return month ? lines.filter((r) => r.month === month) : lines;
}

/** Admin adds `amount` USD to the limit of `userId` (null = "Chung") for the CURRENT VN month. */
export function raiseBudget({ userId = null, amount, reason }, by) {
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) throw bad('Số USD nới thêm phải > 0');
  const why = String(reason || '').trim().slice(0, 300);
  if (!why) throw bad('Cần ghi lý do nới hạn mức');
  if (userId && !findUser(userId)) throw bad(`Không có tài khoản ${userId}`);
  const line = { at: new Date().toISOString(), by: by?.id || null, byName: by?.name || by?.username || null, userId: userId || null, month: monthOf(), amount: roundUsd(amt), reason: why };
  return serial(async () => {
    await fsp.mkdir(path.dirname(BUDGET_LOG_FILE), { recursive: true });
    await fsp.appendFile(BUDGET_LOG_FILE, JSON.stringify(line) + '\n');
    return line;
  });
}

/** Base limit (before raises) for userId (null = "Chung") → { base, source: 'user'|'role'|'shared'|null }. */
export function baseLimit(userId, cfg = readBudgets()) {
  if (!userId) return { base: cfg.shared ?? null, source: cfg.shared != null ? 'shared' : null };
  if (Object.prototype.hasOwnProperty.call(cfg.users, userId)) return { base: cfg.users[userId] ?? null, source: 'user' };
  const role = findUser(userId)?.role;
  const r = role ? cfg.roles[role] : null;
  return { base: r ?? null, source: r != null ? 'role' : null };
}

/**
 * Budget status of userId (null = "Chung") for a VN month (default: current).
 * → { month, limit (null = unlimited), base, raised, source, used, pct, warn, blocked }
 * `used` = USD recorded for the month (+ finished jobs not yet in the log). Raises count only
 * when the user has a base limit (raising "unlimited" means nothing).
 */
export function budgetStatus(userId, { month = monthOf(), cfg = readBudgets(), rows = null } = {}) {
  const { base, source } = baseLimit(userId || null, cfg);
  const raised = roundUsd(readRaises(month).filter((r) => (r.userId || null) === (userId || null)).reduce((s, r) => s + (Number(r.amount) || 0), 0));
  const row = (rows || monthUsage(month, listJobs())).find((r) => (r.userId || null) === (userId || null));
  const used = roundUsd(row?.usd || 0);
  const limit = base == null ? null : roundUsd(base + raised);
  const pct = limit == null ? null : limit > 0 ? Math.round((used / limit) * 1000) / 10 : (used > 0 ? Infinity : 0);
  const blocked = limit != null && used >= limit;
  const warn = limit != null && (blocked || used >= roundUsd(limit * WARN_AT));
  return { month, userId: userId || null, limit, base, raised, source, used, pct: Number.isFinite(pct) ? pct : 100, warn, blocked };
}

/**
 * Shared gate for paid jobs. → { ok: true, status } or { ok: false, status, error, message }.
 * Non-paid kinds (render, …) always pass.
 */
export function checkBudget(userId, kind) {
  if (!isPaidKind(kind)) return { ok: true, status: null };
  const status = budgetStatus(userId || null);
  if (!status.blocked) return { ok: true, status };
  return { ok: false, status, error: BLOCKED_MESSAGE, message: BLOCKED_MESSAGE };
}

/** Throws a 402 (`code: 'budget_exceeded'`, Vietnamese message) when checkBudget refuses. */
export function assertBudget(userId, kind) {
  const r = checkBudget(userId, kind);
  if (!r.ok) {
    console.warn(`[budget] chặn job ${kind} của ${userId || '"Chung"'}: đã dùng $${r.status.used} / $${r.status.limit} (${r.status.month})`);
    throw Object.assign(new Error(BLOCKED_MESSAGE), { status: 402, code: 'budget_exceeded', budget: r.status });
  }
  return r;
}
