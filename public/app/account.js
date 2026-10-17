// Accounts UI (issue #25): top-bar user menu + banner, "Tài khoản" (personal API tokens,
// own password, own usage) and "Quản trị" (users, reset password, usage per user per month).
import { h, toast, modal } from './ui.js';
import { state } from './state.js';
import { api } from './api.js';

const $ = (id) => document.getElementById(id);
const n = (v) => (Number(v) || 0).toLocaleString('vi-VN');
export const UNKNOWN_USER = 'không rõ';

/** Who did it — shown in history + jobs. Hidden while the server has never had accounts. */
export function whoLabel(name) {
  if (!name && state.auth?.mode !== 'accounts') return null;
  return h('span', { class: 'who-tag', title: 'Người thực hiện' }, '👤 ' + (name || UNKNOWN_USER));
}

export async function initAuthUI() {
  try { state.auth = await api.authStatus(); } catch { state.auth = { mode: 'open' }; }
  const a = state.auth;
  const banner = $('authBanner');
  if (a.banner === 'create-admin') {
    banner.textContent = '⚠ Hãy tạo tài khoản admin: npm run user:add -- <tên> --admin';
    banner.title = 'Server đang dùng mật khẩu chung APP_PASSWORD. Tạo tài khoản admin đầu tiên để mỗi người đăng nhập riêng.';
    banner.hidden = false;
  } else if (a.banner === 'app-password') {
    const until = a.transitionEndsAt ? new Date(a.transitionEndsAt).toLocaleDateString('vi-VN') : '';
    banner.textContent = a.via === 'app-password'
      ? `⚠ Bạn đang dùng mật khẩu chung — chỉ còn hiệu lực đến ${until}. Hãy đăng nhập bằng tài khoản riêng.`
      : `⚠ Mật khẩu chung APP_PASSWORD còn được chấp nhận đến ${until} — tạo tài khoản cho cả team.`;
    banner.title = 'Giai đoạn chuyển tiếp 30 ngày kể từ khi tạo tài khoản đầu tiên.';
    banner.hidden = false;
  } else banner.hidden = true;

  const menu = $('userMenu');
  if (!a.user) {
    menu.hidden = !(a.mode === 'accounts');
    if (a.mode === 'accounts') menu.replaceChildren(h('a', { href: '/login.html' }, h('button', { class: 'ghost' }, 'Đăng nhập')));
    return;
  }
  menu.replaceChildren(
    h('span', { class: 'who' }, '👤 ' + a.user.name),
    h('button', { class: 'ghost', id: 'btnAccount', onclick: showAccount }, 'Tài khoản'),
    a.user.role === 'admin' ? h('button', { class: 'ghost', id: 'btnAdmin', onclick: showAdmin }, 'Quản trị') : null,
    h('button', {
      class: 'ghost', title: 'Đăng xuất',
      onclick: async () => { await api.logout().catch(() => {}); location.href = '/login.html'; },
    }, 'Đăng xuất'),
  );
  menu.hidden = false;
}

// ---------------------------------------------------------------- Tài khoản
export async function showAccount() {
  const u = state.auth.user;
  const body = h('div', {});
  const tokensBox = h('div', {});
  const onceBox = h('div', {});
  const usageBox = h('p', { class: 'small muted' }, 'Đang tải…');

  async function fillTokens() {
    const list = await api.tokens();
    tokensBox.replaceChildren(list.length
      ? h('table', { class: 'acct-table' },
        h('tr', {}, h('th', {}, 'Tên'), h('th', {}, 'Mã đầu'), h('th', {}, 'Tạo lúc'), h('th', {})),
        list.map((t) => h('tr', {},
          h('td', {}, t.name), h('td', {}, h('code', {}, t.prefix + '…')),
          h('td', {}, new Date(t.createdAt).toLocaleString('vi-VN')),
          h('td', { class: 'num' }, h('button', {
            onclick: async () => {
              if (!confirm(`Thu hồi token "${t.name}"? Script đang dùng token này sẽ bị từ chối ngay.`)) return;
              await api.revokeToken(t.id);
              onceBox.replaceChildren();
              fillTokens();
              toast('Đã thu hồi token');
            },
          }, 'Thu hồi')))))
      : h('p', { class: 'small muted' }, 'Chưa có token nào.'));
  }

  const tokenName = h('input', { placeholder: 'Tên token, VD: script render, app mobile' });
  const createBtn = h('button', {
    class: 'primary shrink',
    onclick: async () => {
      try {
        const t = await api.createToken(tokenName.value.trim() || 'Token');
        tokenName.value = '';
        const code = h('code', {}, t.token);
        onceBox.replaceChildren(h('div', { class: 'token-once' },
          h('strong', {}, `Token "${t.name}" — chỉ hiện MỘT lần, hãy sao chép ngay:`), code,
          h('div', { class: 'row' },
            h('button', { class: 'shrink', onclick: () => navigator.clipboard?.writeText(t.token).then(() => toast('Đã sao chép')) }, '📋 Sao chép'),
            h('span', { class: 'small muted' }, 'Dùng: Authorization: Bearer <token>'))));
        fillTokens();
      } catch (e) { toast(e.message, { error: true }); }
    },
  }, '+ Tạo token');

  const cur = h('input', { type: 'password', placeholder: 'Mật khẩu hiện tại', autocomplete: 'current-password' });
  const pw1 = h('input', { type: 'password', placeholder: 'Mật khẩu mới (≥ 8 ký tự)', autocomplete: 'new-password' });
  const pw2 = h('input', { type: 'password', placeholder: 'Nhập lại mật khẩu mới', autocomplete: 'new-password' });

  body.append(
    h('p', {}, h('strong', {}, u.name), h('span', { class: 'muted' }, `  · ${u.username} · `), h('span', { class: 'badge' + (u.role === 'admin' ? ' admin' : '') }, u.role)),
    h('div', { class: 'acct-section' }, h('h4', {}, 'Token đã dùng tháng này'), usageBox),
    h('div', { class: 'acct-section' },
      h('h4', {}, 'API token cá nhân'),
      h('p', { class: 'small muted' }, 'Cho script hoặc app gọi API thay bạn (Authorization: Bearer …). Server chỉ lưu bản băm — token chỉ hiện một lần khi tạo.'),
      h('div', { class: 'row' }, tokenName, createBtn), onceBox, h('div', { style: { height: '8px' } }), tokensBox),
    h('div', { class: 'acct-section' },
      h('h4', {}, 'Đổi mật khẩu'),
      h('div', { class: 'acct-form' }, h('div', { class: 'full' }, cur), pw1, pw2,
        h('button', {
          class: 'full',
          onclick: async () => {
            if (pw1.value !== pw2.value) return toast('Hai mật khẩu mới không khớp', { error: true });
            try {
              await api.changePassword(cur.value, pw1.value);
              cur.value = pw1.value = pw2.value = '';
              toast('Đã đổi mật khẩu (các phiên đăng nhập khác đã bị đăng xuất)');
            } catch (e) { toast(e.message, { error: true }); }
          },
        }, 'Đổi mật khẩu'))),
  );
  modal('Tài khoản', body);
  fillTokens().catch((e) => toast(e.message, { error: true }));
  api.myUsage().then((r) => {
    const t = r.total;
    usageBox.textContent = t
      ? `${r.month}: ${r.jobs} lần đạo diễn · vào ${n(t.input_tokens)} · ra ${n(t.output_tokens)} · đọc cache ${n(t.cache_read_input_tokens)} · ghi cache ${n(t.cache_creation_input_tokens)}`
      : `${r.month}: chưa dùng đạo diễn AI.`;
  }).catch(() => (usageBox.textContent = '—'));
}

// ---------------------------------------------------------------- Quản trị
export async function showAdmin() {
  const body = h('div', {});
  const usersBox = h('div', {});
  const usageBox = h('div', {});
  const monthSel = h('select', { style: { width: 'auto' } });

  async function fillUsers() {
    const list = await api.users();
    const me = state.auth.user;
    usersBox.replaceChildren(h('table', { class: 'acct-table', id: 'usersTable' },
      h('tr', {}, h('th', {}, 'Tên hiển thị'), h('th', {}, 'Đăng nhập'), h('th', {}, 'Vai trò'), h('th', {}, 'Trạng thái'), h('th', {}, 'Token'), h('th', {})),
      list.map((u) => h('tr', {},
        h('td', {}, u.name), h('td', {}, u.username),
        h('td', {}, h('span', { class: 'badge' + (u.role === 'admin' ? ' admin' : '') }, u.role)),
        h('td', {}, u.status === 'active' ? h('span', { class: 'badge' }, 'hoạt động') : h('span', { class: 'badge off' }, 'đã khoá')),
        h('td', { class: 'num' }, u.tokens),
        h('td', { class: 'num' },
          u.id === me.id ? h('span', { class: 'small muted' }, '(bạn)') : [
            h('button', {
              onclick: async () => {
                const next = u.status === 'active' ? 'disabled' : 'active';
                if (next === 'disabled' && !confirm(`Khoá "${u.name}"? Phiên đăng nhập và token của người này bị từ chối ngay.`)) return;
                try { await api.updateUser(u.id, { status: next }); fillUsers(); toast(next === 'disabled' ? 'Đã khoá' : 'Đã mở khoá'); } catch (e) { toast(e.message, { error: true }); }
              },
            }, u.status === 'active' ? 'Khoá' : 'Mở khoá'), ' ',
            h('button', {
              onclick: async () => {
                const pw = prompt(`Mật khẩu mới cho ${u.username} (≥ 8 ký tự):`);
                if (!pw) return;
                try { await api.resetPassword(u.id, pw); toast('Đã đặt lại mật khẩu (người này bị đăng xuất)'); } catch (e) { toast(e.message, { error: true }); }
              },
            }, 'Đặt lại mật khẩu'),
          ])))));
  }

  async function fillUsage(month) {
    const r = await api.usage(month);
    if (!monthSel.options.length || month == null) {
      monthSel.replaceChildren(...r.months.map((m) => h('option', { value: m, selected: m === r.month }, m)));
    }
    usageBox.replaceChildren(r.rows.length
      ? h('table', { class: 'acct-table', id: 'usageTable' },
        h('tr', {}, h('th', {}, 'Người dùng'), h('th', {}, 'Lần chạy'), h('th', {}, 'Vào'), h('th', {}, 'Ra'), h('th', {}, 'Đọc cache'), h('th', {}, 'Ghi cache')),
        r.rows.map((x) => h('tr', {},
          h('td', {}, x.name || (x.userId ? x.userId : UNKNOWN_USER)),
          h('td', { class: 'num' }, x.jobs),
          h('td', { class: 'num' }, n(x.total.input_tokens)), h('td', { class: 'num' }, n(x.total.output_tokens)),
          h('td', { class: 'num' }, n(x.total.cache_read_input_tokens)), h('td', { class: 'num' }, n(x.total.cache_creation_input_tokens)))))
      : h('p', { class: 'small muted' }, `Tháng ${r.month} chưa có lần chạy đạo diễn nào.`));
  }
  monthSel.onchange = () => fillUsage(monthSel.value);

  const f = {
    username: h('input', { placeholder: 'Tên đăng nhập (chữ thường, không dấu)', autocomplete: 'off' }),
    name: h('input', { placeholder: 'Tên hiển thị, VD: Lan Anh' }),
    password: h('input', { type: 'password', placeholder: 'Mật khẩu ban đầu (≥ 8 ký tự)', autocomplete: 'new-password' }),
    role: h('select', {}, h('option', { value: 'member' }, 'member — thành viên'), h('option', { value: 'admin' }, 'admin — quản trị')),
  };
  body.append(
    h('div', { class: 'acct-section' }, h('h4', {}, 'Tài khoản'), usersBox),
    h('div', { class: 'acct-section' },
      h('h4', {}, 'Thêm tài khoản'),
      h('div', { class: 'acct-form', id: 'newUserForm' }, f.username, f.name, f.password, f.role,
        h('button', {
          class: 'primary full',
          onclick: async () => {
            try {
              const u = await api.createUser({ username: f.username.value, name: f.name.value, password: f.password.value, role: f.role.value });
              f.username.value = f.name.value = f.password.value = '';
              fillUsers();
              toast(`Đã tạo tài khoản ${u.username}`);
            } catch (e) { toast(e.message, { error: true }); }
          },
        }, '+ Tạo tài khoản'))),
    h('div', { class: 'acct-section' },
      h('div', { class: 'row' }, h('h4', { style: { margin: 0 } }, 'Token đạo diễn AI theo người'), h('span', { class: 'shrink' }, monthSel)),
      h('div', { style: { height: '8px' } }), usageBox),
  );
  modal('Quản trị', body);
  fillUsers().catch((e) => toast(e.message, { error: true }));
  fillUsage().catch((e) => toast(e.message, { error: true }));
}
