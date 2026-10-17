// Create an account in DATA_DIR/users.json (issue #25).
// usage: npm run user:add -- <username> [--admin] [--name "Tên hiển thị"] [--password-stdin]
//   - on a TTY the password is prompted twice (not echoed);
//   - --password-stdin reads it from stdin (first line), e.g. for provisioning scripts.
// The first account created starts the 30-day APP_PASSWORD transition (see README).
// A running server picks the new account up within AUTH_CACHE_MS (default 30 s).
import { createUser, authMode, USERS_FILE } from '../server/auth.js';

const args = process.argv.slice(2);
const flag = (f) => { const i = args.indexOf(f); if (i < 0) return false; args.splice(i, 1); return true; };
const opt = (f) => { const i = args.indexOf(f); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v ?? null; };

const admin = flag('--admin');
const fromStdin = flag('--password-stdin');
const name = opt('--name');
const username = args[0];
if (!username || username.startsWith('-')) {
  console.error('Cách dùng: npm run user:add -- <username> [--admin] [--name "Tên hiển thị"] [--password-stdin]');
  process.exit(2);
}

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data.split(/\r?\n/)[0];
}

/** Hidden prompt on a TTY (raw mode, no echo). */
function prompt(question) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    stdout.write(question);
    let buf = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') { done(); return resolve(buf); }
        if (c === '\u0003') { done(); return reject(new Error('Đã huỷ')); }
        if (c === '\u007f' || c === '\b') buf = buf.slice(0, -1);
        else buf += c;
      }
    };
    const done = () => { stdin.off('data', onData); stdin.setRawMode(false); stdin.pause(); stdout.write('\n'); };
    stdin.on('data', onData);
  });
}

try {
  let password;
  if (fromStdin) password = await readStdin();
  else if (process.stdin.isTTY) {
    password = await prompt(`Mật khẩu cho ${username}: `);
    const again = await prompt('Nhập lại mật khẩu: ');
    if (again !== password) throw new Error('Hai lần nhập không khớp');
  } else throw new Error('Không có TTY — dùng --password-stdin để đọc mật khẩu từ stdin');
  const before = authMode();
  const u = await createUser({ username, password, name, role: admin ? 'admin' : 'member' });
  console.log(`Đã tạo tài khoản ${u.username} (${u.role}${u.name !== u.username ? ', ' + u.name : ''}) trong ${USERS_FILE}`);
  if (before !== 'accounts') {
    console.log('Đây là tài khoản đầu tiên: server chuyển sang đăng nhập bằng tài khoản riêng'
      + (process.env.APP_PASSWORD ? '; APP_PASSWORD còn được chấp nhận 30 ngày.' : '.'));
  }
} catch (e) {
  console.error('Lỗi:', e.message);
  process.exit(1);
}
