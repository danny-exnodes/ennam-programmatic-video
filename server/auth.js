// Per-user accounts (issue #25): users store, password hashing, server-side
// sessions, personal API tokens, auth middleware, login rate limit and the
// APP_PASSWORD transition. Shared by server/index.js and the review routes (#10).
//
// Modes (decided per request from DATA_DIR/users.json + APP_PASSWORD):
//   open     — no users, no APP_PASSWORD → no auth at all (dev / old behavior)
//   legacy   — no users, APP_PASSWORD set → old shared Basic Auth + banner "Hãy tạo tài khoản admin"
//   accounts — ≥ 1 user → session cookie or `Authorization: Bearer ems_…` token;
//              APP_PASSWORD (Basic) still accepted for 30 days after the first user
//              was created (`firstUserAt` in users.json), with a log warning + banner.
//
// Storage:
//   users.json            { version, firstUserAt, users: [{ id, username, name, role, status,
//                           passwordHash: "scrypt$N$r$p$salt$hash", tokens: [{ id, name, prefix, hash: sha256 }] }] }
//   sessions/<sha256>.json one file per session; the cookie holds only the random
//                           256-bit id, the file name is its SHA-256 (a directory listing
//                           does not reveal usable ids).
// Secrets (passwords, raw tokens, session ids) are never logged.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { DATA_DIR, newId } from './store.js';

const scryptAsync = promisify(crypto.scrypt);

export const USERS_FILE = path.join(DATA_DIR, 'users.json');
export const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
export const COOKIE_NAME = 'ems_session';
export const TOKEN_PREFIX = 'ems_';
export const SESSION_TTL_MS = 14 * 24 * 3600e3;
export const TRANSITION_MS = 30 * 24 * 3600e3;
const SESSION_TOUCH_MS = 10 * 60e3; // sliding expiry: refresh at most every 10 min
const posInt = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.floor(Number(v)) : d);
/** users.json read cache — bounds how long an external edit (CLI, disable) takes to apply. */
export const USERS_CACHE_MS = posInt(process.env.AUTH_CACHE_MS, 30000);
export const LOGIN_MAX = 10;
export const LOGIN_WINDOW_MS = 15 * 60e3;

// scrypt N=2^15, r=8, p=1, 16-byte salt (Tech Lead decision on #25). maxmem must exceed 128·N·r = 32 MiB.
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 32 };
const scryptOpts = (N, r, p) => ({ N, r, p, maxmem: 256 * N * r });

// Random per-process secret so the server's own headless render pages (server/render.js)
// can load /render.html, /engine and /api/projects/:id. Accepted from loopback only.
const INTERNAL_TOKEN = crypto.randomBytes(32).toString('hex');
export const INTERNAL_HEADER = 'x-ems-internal';

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// ---------------------------------------------------------------- passwords
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const { N, r, p, keylen } = SCRYPT;
  const key = await scryptAsync(String(password), salt, keylen, scryptOpts(N, r, p));
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, keyB64] = parts;
  const want = Buffer.from(keyB64, 'base64');
  try {
    const got = await scryptAsync(String(password), Buffer.from(saltB64, 'base64'), want.length, scryptOpts(Number(N), Number(r), Number(p)));
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  } catch {
    return false;
  }
}
// constant work for unknown usernames (no user enumeration by timing)
let dummyHash = null;
const getDummyHash = async () => (dummyHash ||= await hashPassword(crypto.randomBytes(16).toString('hex')));

export function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw httpError(400, 'Mật khẩu cần ít nhất 8 ký tự');
  if (pw.length > 256) throw httpError(400, 'Mật khẩu quá dài');
}
export function normalizeUsername(u) {
  const s = String(u || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{1,31}$/.test(s)) throw httpError(400, 'Tên đăng nhập 2–32 ký tự: chữ thường, số, . _ -');
  return s;
}
function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// ---------------------------------------------------------------- users store
let cache = null; // { at, db, byToken: Map(hash → { user, token }) }

function emptyDb() {
  return { version: 1, firstUserAt: null, users: [] };
}

function indexDb(db) {
  const byToken = new Map();
  for (const u of db.users) for (const t of u.tokens || []) byToken.set(t.hash, { user: u, token: t });
  return byToken;
}

/**
 * Current users db (cached ≤ USERS_CACHE_MS). A missing file is an empty db; an
 * unreadable/corrupt file never falls back to "no users" (that would open the
 * server): the last good copy is kept, or an error is thrown (fail closed).
 */
export function getDb({ fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && cache && now - cache.at < USERS_CACHE_MS) return cache.db;
  let db;
  try {
    db = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    if (!db || !Array.isArray(db.users)) throw new Error('users.json sai cấu trúc');
  } catch (e) {
    if (e.code === 'ENOENT') db = emptyDb();
    else {
      console.error('[auth] không đọc được users.json:', e.message);
      if (cache) { cache.at = now; return cache.db; }
      throw httpError(503, 'Lỗi dữ liệu tài khoản (users.json) — liên hệ quản trị');
    }
  }
  cache = { at: now, db, byToken: indexDb(db) };
  return db;
}

function saveDb(db) {
  fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true });
  const tmp = `${USERS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, USERS_FILE);
  cache = { at: Date.now(), db, byToken: indexDb(db) };
}

/** Read-modify-write on a fresh copy of users.json. */
function mutate(fn) {
  const db = structuredClone(getDb({ fresh: true }));
  const out = fn(db);
  saveDb(db);
  return out;
}

export const publicUser = (u) => (u ? { id: u.id, username: u.username, name: u.name || u.username, role: u.role, status: u.status, createdAt: u.createdAt } : null);
export const findUser = (id) => getDb().users.find((u) => u.id === id) || null;

/** Display name for a stored userId (history, jobs, usage). null → unknown. */
export function userLabel(userId) {
  if (!userId) return null;
  const u = findUser(userId);
  return u ? (u.name || u.username) : null;
}

export async function createUser({ username, password, name, role = 'member' }) {
  const uname = normalizeUsername(username);
  validatePassword(password);
  if (!['admin', 'member'].includes(role)) throw httpError(400, 'Vai trò không hợp lệ');
  const passwordHash = await hashPassword(password);
  return publicUser(mutate((db) => {
    if (db.users.some((u) => u.username === uname)) throw httpError(409, `Tên đăng nhập "${uname}" đã có`);
    const now = new Date().toISOString();
    const u = { id: newId('u'), username: uname, name: String(name || '').trim().slice(0, 80) || uname, role, status: 'active', passwordHash, tokens: [], createdAt: now, updatedAt: now };
    db.users.push(u);
    if (!db.firstUserAt) db.firstUserAt = now; // start of the 30-day APP_PASSWORD transition
    return u;
  }));
}

export async function updateUser(id, patch = {}) {
  const out = mutate((db) => {
    const u = db.users.find((x) => x.id === id);
    if (!u) throw httpError(404, 'Không có tài khoản');
    if (patch.status != null) {
      if (!['active', 'disabled'].includes(patch.status)) throw httpError(400, 'Trạng thái không hợp lệ');
      u.status = patch.status;
    }
    if (patch.role != null) {
      if (!['admin', 'member'].includes(patch.role)) throw httpError(400, 'Vai trò không hợp lệ');
      u.role = patch.role;
    }
    if (patch.name != null) u.name = String(patch.name).trim().slice(0, 80) || u.username;
    if (!db.users.some((x) => x.role === 'admin' && x.status === 'active')) throw httpError(400, 'Phải còn ít nhất một admin đang hoạt động');
    u.updatedAt = new Date().toISOString();
    return u;
  });
  if (out.status === 'disabled') await deleteSessionsOf(out.id);
  return publicUser(out);
}

export async function setPassword(id, password, { keepSession = null } = {}) {
  validatePassword(password);
  const passwordHash = await hashPassword(password);
  mutate((db) => {
    const u = db.users.find((x) => x.id === id);
    if (!u) throw httpError(404, 'Không có tài khoản');
    u.passwordHash = passwordHash;
    u.updatedAt = new Date().toISOString();
  });
  await deleteSessionsOf(id, keepSession); // a password reset logs out other sessions
}

export function listUsers() {
  return getDb({ fresh: true }).users.map((u) => ({ ...publicUser(u), tokens: (u.tokens || []).length }));
}

// ---------------------------------------------------------------- API tokens
export function createToken(userId, name) {
  const raw = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
  const meta = mutate((db) => {
    const u = db.users.find((x) => x.id === userId);
    if (!u) throw httpError(404, 'Không có tài khoản');
    u.tokens = u.tokens || [];
    if (u.tokens.length >= 20) throw httpError(400, 'Tối đa 20 token mỗi người — thu hồi bớt token cũ');
    const t = { id: newId('t'), name: String(name || '').trim().slice(0, 60) || 'Token', prefix: raw.slice(0, 10), hash: sha256(raw), createdAt: new Date().toISOString() };
    u.tokens.push(t);
    return t;
  });
  return { token: raw, ...publicToken(meta) }; // raw token is returned exactly once
}
export const publicToken = (t) => ({ id: t.id, name: t.name, prefix: t.prefix, createdAt: t.createdAt });
export function listTokens(userId) {
  return (findUser(userId)?.tokens || []).map(publicToken);
}
export function revokeToken(userId, tokenId) {
  return mutate((db) => {
    const u = db.users.find((x) => x.id === userId);
    if (!u) throw httpError(404, 'Không có tài khoản');
    const before = (u.tokens || []).length;
    u.tokens = (u.tokens || []).filter((t) => t.id !== tokenId);
    if (u.tokens.length === before) throw httpError(404, 'Không có token');
    return true;
  });
}

// ---------------------------------------------------------------- sessions
const sessions = new Map(); // sha256(id) → session (write-through cache of sessions/*.json)
const sessionFile = (hash) => path.join(SESSIONS_DIR, `${hash}.json`);

async function writeSession(hash, s) {
  await fsp.mkdir(SESSIONS_DIR, { recursive: true });
  const tmp = `${sessionFile(hash)}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(s), { mode: 0o600 });
  await fsp.rename(tmp, sessionFile(hash));
}

export async function createSession(userId) {
  const id = crypto.randomBytes(32).toString('base64url'); // 256-bit
  const hash = sha256(id);
  const now = Date.now();
  const s = { userId, createdAt: now, lastSeenAt: now, expiresAt: now + SESSION_TTL_MS };
  await writeSession(hash, s);
  sessions.set(hash, s);
  return id;
}

function readSession(hash) {
  if (sessions.has(hash)) return sessions.get(hash);
  try {
    const s = JSON.parse(fs.readFileSync(sessionFile(hash), 'utf8'));
    sessions.set(hash, s);
    return s;
  } catch {
    return null;
  }
}

export async function destroySession(id) {
  const hash = sha256(id);
  sessions.delete(hash);
  await fsp.rm(sessionFile(hash), { force: true });
}

/** Remove every session of a user (disable / password reset), except `keepId`. */
export async function deleteSessionsOf(userId, keepId = null) {
  const keep = keepId ? sha256(keepId) : null;
  for (const [h, s] of sessions) if (s.userId === userId && h !== keep) sessions.delete(h);
  let files = [];
  try { files = await fsp.readdir(SESSIONS_DIR); } catch { return; }
  for (const f of files) {
    if (!f.endsWith('.json') || f === `${keep}.json`) continue;
    try {
      const s = JSON.parse(await fsp.readFile(path.join(SESSIONS_DIR, f), 'utf8'));
      if (s.userId === userId) await fsp.rm(path.join(SESSIONS_DIR, f), { force: true });
    } catch { /* ignore */ }
  }
}

async function gcSessions() {
  let files = [];
  try { files = await fsp.readdir(SESSIONS_DIR); } catch { return; }
  const now = Date.now();
  for (const f of files) {
    const full = path.join(SESSIONS_DIR, f);
    if (f.endsWith('.tmp')) { await fsp.rm(full, { force: true }); continue; }
    try {
      const s = JSON.parse(await fsp.readFile(full, 'utf8'));
      if (!(s.expiresAt > now)) { await fsp.rm(full, { force: true }); sessions.delete(f.replace(/\.json$/, '')); }
    } catch { await fsp.rm(full, { force: true }); }
  }
}

// ---------------------------------------------------------------- cookies
function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k && !(k in out)) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
/** `Secure` when COOKIE_SECURE=1 or the request came over HTTPS (directly or X-Forwarded-Proto). */
function isSecure(req) {
  if (process.env.COOKIE_SECURE === '1') return true;
  if (req.secure) return true;
  return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}
export function setSessionCookie(req, res, id) {
  const parts = [`${COOKIE_NAME}=${id}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`];
  if (isSecure(req)) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}
export function clearSessionCookie(req, res) {
  const parts = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (isSecure(req)) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}
export const sessionIdOf = (req) => parseCookies(req.headers.cookie)[COOKIE_NAME] || null;

// ---------------------------------------------------------------- mode / transition
export function authMode() {
  const db = getDb();
  if (db.users.length) return 'accounts';
  return process.env.APP_PASSWORD ? 'legacy' : 'open';
}
/** End of the APP_PASSWORD grace period (ms), or null when not applicable. */
export function transitionEndsAt() {
  const db = getDb();
  if (!db.users.length || !process.env.APP_PASSWORD) return null;
  const first = Date.parse(db.firstUserAt || '') || Date.parse(db.users[0]?.createdAt || '') || Date.now();
  return first + TRANSITION_MS;
}
const transitionActive = () => { const e = transitionEndsAt(); return e != null && Date.now() < e; };

function basicPassword(req) {
  const h = String(req.headers.authorization || '');
  if (!/^basic /i.test(h)) return null;
  const decoded = Buffer.from(h.slice(6).trim(), 'base64').toString();
  const i = decoded.indexOf(':');
  return i < 0 ? null : decoded.slice(i + 1);
}
const appPasswordOk = (req) => {
  const p = basicPassword(req);
  return p != null && !!process.env.APP_PASSWORD && safeEq(p, process.env.APP_PASSWORD);
};
const isLoopback = (req) => /^(::1|127\.\d+\.\d+\.\d+|::ffff:127\.\d+\.\d+\.\d+)$/.test(req.socket?.remoteAddress || '');

let lastLegacyWarn = 0;
function warnLegacy() {
  if (Date.now() - lastLegacyWarn < 10 * 60e3) return;
  lastLegacyWarn = Date.now();
  console.warn(`[auth] CẢNH BÁO: có request dùng APP_PASSWORD (mật khẩu chung). Mật khẩu chung chỉ còn được chấp nhận đến ${new Date(transitionEndsAt()).toISOString()} — hãy đăng nhập bằng tài khoản riêng.`);
}

/**
 * Who is calling? → { mode, user, via } where via ∈ session | token | internal | app-password | none.
 * `user` is a stored user (active) or null. Also returns `sessionId` when the session should be re-sent (sliding).
 */
export function resolveAuth(req) {
  const mode = authMode();
  if (mode === 'open') return { mode, user: null, via: 'none', ok: true };
  if (req.headers[INTERNAL_HEADER] && isLoopback(req) && safeEq(req.headers[INTERNAL_HEADER], INTERNAL_TOKEN)) {
    return { mode, user: null, via: 'internal', ok: true };
  }
  if (mode === 'legacy') return { mode, user: null, via: 'app-password', ok: appPasswordOk(req) };

  const db = getDb();
  const sid = sessionIdOf(req);
  if (sid) {
    const hash = sha256(sid);
    const s = readSession(hash);
    if (s && s.expiresAt > Date.now()) {
      const u = db.users.find((x) => x.id === s.userId);
      if (u && u.status === 'active') {
        let refresh = false;
        if (Date.now() - s.lastSeenAt > SESSION_TOUCH_MS) { // sliding 14-day expiry
          s.lastSeenAt = Date.now();
          s.expiresAt = s.lastSeenAt + SESSION_TTL_MS;
          writeSession(hash, s).catch(() => {});
          refresh = true;
        }
        return { mode, user: u, via: 'session', ok: true, refreshSession: refresh ? sid : null };
      }
    } else if (s) {
      sessions.delete(hash);
      fsp.rm(sessionFile(hash), { force: true }).catch(() => {});
    }
  }
  const authz = String(req.headers.authorization || '');
  if (/^bearer /i.test(authz)) {
    const raw = authz.slice(7).trim();
    if (raw.startsWith(TOKEN_PREFIX)) {
      const hit = cache?.byToken.get(sha256(raw));
      if (hit && hit.user.status === 'active') return { mode, user: hit.user, via: 'token', ok: true };
    }
    return { mode, user: null, via: 'none', ok: false };
  }
  if (appPasswordOk(req) && transitionActive()) {
    warnLegacy();
    return { mode, user: null, via: 'app-password', ok: true, legacyWarning: true };
  }
  return { mode, user: null, via: 'none', ok: false };
}

// Paths outside auth: review links (#10), the login page and its assets, auth endpoints.
const PUBLIC_EXACT = new Set(['/login.html', '/login.js', '/styles.css', '/fonts.css', '/favicon.ico', '/api/auth/login', '/api/auth/logout', '/api/auth/status', '/legacy-login']);
const PUBLIC_PREFIX = ['/review/', '/fonts/'];
export const isPublicPath = (p) => PUBLIC_EXACT.has(p) || p === '/review' || PUBLIC_PREFIX.some((x) => p.startsWith(x));

const wantsHtml = (req) => req.method === 'GET' && !req.path.startsWith('/api/') && /text\/html/.test(String(req.headers.accept || ''));

/** Main middleware: sets req.auth and req.user (stored user or null); 401 when not allowed. */
export function authMiddleware() {
  return (req, res, next) => {
    let a;
    try { a = resolveAuth(req); } catch (e) { return next(e); }
    req.auth = a;
    req.user = a.user ? publicUser(a.user) : null;
    if (a.refreshSession) setSessionCookie(req, res, a.refreshSession);
    if (a.legacyWarning) res.set('X-Auth-Warning', 'app-password-deprecated');
    if (a.ok || isPublicPath(req.path)) return next();
    if (a.mode === 'legacy') {
      return res.set('WWW-Authenticate', 'Basic realm="Ennam Studio"').status(401).send('Cần đăng nhập');
    }
    if (wantsHtml(req)) {
      const nextUrl = req.originalUrl.startsWith('/') && !req.originalUrl.startsWith('//') ? req.originalUrl : '/';
      return res.redirect(302, '/login.html?next=' + encodeURIComponent(nextUrl));
    }
    res.status(401).json({ error: 'Cần đăng nhập', login: '/login.html' });
  };
}

export function requireUser(req, res, next) {
  if (req.user) return next();
  res.status(403).json({ error: 'Cần đăng nhập bằng tài khoản riêng' });
}
export function requireAdmin(req, res, next) {
  if (req.user?.role === 'admin') return next();
  res.status(403).json({ error: 'Chỉ admin' });
}

/** Banner for the UI: 'create-admin' (legacy mode) | 'app-password' (transition) | null. */
export function bannerFor(a) {
  if (a.mode === 'legacy') return 'create-admin';
  if (a.mode === 'accounts' && transitionActive() && (a.via === 'app-password' || a.user?.role === 'admin')) return 'app-password';
  return null;
}

// ---------------------------------------------------------------- login rate limit
const attempts = new Map(); // ip → [failed-at ms]
function recentFailures(ip) {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter((t) => now - t < LOGIN_WINDOW_MS);
  if (list.length) attempts.set(ip, list); else attempts.delete(ip);
  return list;
}

/** POST /api/auth/login { username, password } → sets the session cookie. */
export async function login(req, res) {
  const ip = req.ip || req.socket?.remoteAddress || '?';
  const fails = recentFailures(ip);
  if (fails.length >= LOGIN_MAX) {
    const wait = Math.ceil((LOGIN_WINDOW_MS - (Date.now() - fails[0])) / 1000);
    res.set('Retry-After', String(wait));
    console.warn(`[auth] chặn đăng nhập từ ${ip}: quá ${LOGIN_MAX} lần sai trong 15 phút`);
    return res.status(429).json({ error: `Sai quá ${LOGIN_MAX} lần — thử lại sau ${Math.ceil(wait / 60)} phút` });
  }
  const { username, password } = req.body || {};
  const db = getDb({ fresh: true });
  if (!db.users.length) return res.status(400).json({ error: 'Chưa có tài khoản nào — admin chạy `npm run user:add -- <tên> --admin`' });
  const uname = String(username || '').trim().toLowerCase();
  const u = db.users.find((x) => x.username === uname);
  const good = await verifyPassword(String(password || ''), u ? u.passwordHash : await getDummyHash());
  if (!u || !good || u.status !== 'active') {
    fails.push(Date.now());
    attempts.set(ip, fails);
    console.warn(`[auth] đăng nhập thất bại: "${uname.slice(0, 32)}" từ ${ip}`);
    return res.status(401).json({ error: u && good ? 'Tài khoản đã bị khoá' : 'Sai tên đăng nhập hoặc mật khẩu' });
  }
  const sid = await createSession(u.id);
  setSessionCookie(req, res, sid);
  console.log(`[auth] ${u.username} đăng nhập từ ${ip}`);
  res.json({ user: publicUser(u) });
}

export async function logout(req, res) {
  const sid = sessionIdOf(req);
  if (sid) await destroySession(sid);
  clearSessionCookie(req, res);
  res.json({ ok: true });
}

/** GET /legacy-login — during the transition, lets a browser use the old shared password (Basic prompt). */
export function legacyLogin(req, res) {
  const mode = authMode();
  if ((mode === 'legacy' || (mode === 'accounts' && transitionActive())) && appPasswordOk(req)) return res.redirect(302, '/');
  if (mode === 'legacy' || (mode === 'accounts' && transitionActive())) {
    return res.set('WWW-Authenticate', 'Basic realm="Ennam Studio"').status(401).send('Cần mật khẩu chung');
  }
  res.status(410).send('Mật khẩu chung đã hết hạn — đăng nhập bằng tài khoản riêng tại /login.html');
}

// ---------------------------------------------------------------- render pages
/**
 * Headers for Playwright render pages (server/render.js) so they pass auth:
 * the per-process internal token (server process, loopback), plus EMS_TOKEN
 * (personal token, for dev scripts run in another process) or APP_PASSWORD Basic.
 */
export function renderAuthHeaders() {
  const h = { [INTERNAL_HEADER]: INTERNAL_TOKEN };
  if (process.env.EMS_TOKEN) h.authorization = `Bearer ${process.env.EMS_TOKEN}`;
  else if (process.env.APP_PASSWORD) h.authorization = 'Basic ' + Buffer.from(`team:${process.env.APP_PASSWORD}`).toString('base64');
  return h;
}

/** Call once at server start: log the mode, clean expired sessions. */
export function initAuth() {
  const mode = authMode();
  if (mode === 'open') console.log('  Đăng nhập: tắt (chưa có tài khoản, không đặt APP_PASSWORD)');
  else if (mode === 'legacy') console.log('  Đăng nhập: mật khẩu chung APP_PASSWORD — hãy tạo admin: npm run user:add -- <tên> --admin');
  else {
    const end = transitionEndsAt();
    console.log(`  Đăng nhập: tài khoản riêng (${getDb().users.length} tài khoản)${end ? ` · APP_PASSWORD ${Date.now() < end ? 'còn được chấp nhận đến ' + new Date(end).toISOString() : 'đã hết hạn'}` : ''}`);
  }
  gcSessions().catch(() => {});
  setInterval(() => gcSessions().catch(() => {}), 3600e3).unref();
}
