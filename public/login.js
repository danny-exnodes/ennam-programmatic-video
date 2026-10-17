// Login page (issue #25). Public: served without a session (server/auth.js isPublicPath).
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
// only same-origin relative targets
const rawNext = params.get('next') || '/';
const next = rawNext.startsWith('/') && !rawNext.startsWith('//') && !rawNext.startsWith('/\\') ? rawNext : '/';

function showError(msg) {
  $('loginError').textContent = msg;
  $('loginError').hidden = !msg;
}

fetch('/api/auth/status').then((r) => r.json()).then((s) => {
  if (s.authenticated && s.user) return location.replace(next);
  if (s.mode === 'open') return location.replace(next);
  if (s.mode === 'legacy') {
    $('loginHint').textContent = 'Server chưa có tài khoản nào — đang dùng mật khẩu chung. Quản trị hãy tạo admin: npm run user:add -- <tên> --admin';
    $('legacyBox').hidden = false;
    $('legacyUntil').textContent = 'khi có tài khoản';
  } else if (s.transitionEndsAt) {
    $('legacyBox').hidden = false;
    $('legacyUntil').textContent = new Date(s.transitionEndsAt).toLocaleDateString('vi-VN');
  }
}).catch(() => {});

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  showError('');
  $('loginBtn').disabled = true;
  try {
    const r = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: $('username').value.trim(), password: $('password').value }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Không đăng nhập được');
    location.replace(next);
  } catch (err) {
    showError(err.message);
    $('password').select();
  } finally {
    $('loginBtn').disabled = false;
  }
});
