// Shared helpers for headless render tests (scripts/golden.js, scripts/test-qa.js):
// pinned Chromium from @sparticuz/chromium, a free port, and a temporary server.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Path of the pinned Chromium (exact version in package-lock.json), or null when the
 * platform has no pinned build (only Linux x64). CHROME_PATH overrides (onWarn is told).
 */
export async function pinnedChrome({ onWarn = () => {} } = {}) {
  if (process.env.CHROME_PATH) {
    onWarn(`dùng CHROME_PATH=${process.env.CHROME_PATH} thay cho @sparticuz/chromium — kết quả có thể lệch nếu khác phiên bản`);
    return process.env.CHROME_PATH;
  }
  if (process.platform !== 'linux' || process.arch !== 'x64') return null;
  const chromium = (await import('@sparticuz/chromium')).default;
  const exe = await chromium.executablePath();
  // fonts.conf bundled with the package → identical fallback fonts on every machine
  process.env.FONTCONFIG_PATH ??= path.join(os.tmpdir(), 'fonts');
  return exe;
}

/** Point server/render.js at the pinned binary with the same flags as the golden tests. */
export function usePinnedChrome(exe) {
  process.env.CHROME_PATH = exe;
  // hinting from the system fontconfig would leak into text rasterisation
  if (!(process.env.CHROME_ARGS || '').includes('--font-render-hinting=none')) {
    process.env.CHROME_ARGS = [process.env.CHROME_ARGS, '--font-render-hinting=none'].filter(Boolean).join(' ');
  }
}

export const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.unref();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

/**
 * Start server/index.js on a free port with DATA_DIR=dataDir (sets process.env.PORT so
 * server/render.js talks to it). Resolves { port, stop, log } once /engine/engine.js answers,
 * or { error, log } when it does not come up. The child is killed by PID on exit/signals.
 * `env` overrides the child's environment (e.g. { APP_PASSWORD } to run behind auth).
 */
export async function startTempServer(dataDir, { env = {} } = {}) {
  const port = await freePort();
  process.env.PORT = String(port);
  const logFile = path.join(dataDir, 'server.log');
  const fd = fs.openSync(logFile, 'w');
  const srv = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, APP_PASSWORD: '', ...env },
    stdio: ['ignore', fd, fd],
  });
  const stop = () => {
    if (srv.exitCode === null && srv.signalCode === null) srv.kill('SIGTERM');
    try { fs.closeSync(fd); } catch { /* already closed */ }
  };
  process.on('exit', stop);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stop(); process.exit(2); });
  const log = () => { try { return fs.readFileSync(logFile, 'utf8'); } catch { return ''; } };
  const probeAuth = env.APP_PASSWORD ? { authorization: 'Basic ' + Buffer.from(`team:${env.APP_PASSWORD}`).toString('base64') } : {};
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/engine/engine.js`, { headers: probeAuth })).ok) return { port, stop, log }; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  stop();
  return { error: 'server tạm không khởi động', log };
}
