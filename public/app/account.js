// Accounts UI (issue #25): top-bar user menu + banner, "Tài khoản" (personal API tokens,
// own password, own usage) and "Quản trị" (users, reset password, usage per user per month).
// AI cost budgets (#34): top-bar banner at ≥ 80 %, usage bar on "Tài khoản", USD + % columns,
// budget settings and "Nới hạn mức" on "Quản trị".
import { h, toast, modal } from './ui.js';
import { state } from './state.js';
import { api } from './api.js';

const $ = (id) => document.getElementById(id);
const n = (v) => (Number(v) || 0).toLocaleString('vi-VN');
export const UNKNOWN_USER = 'không rõ';
export const SHARED_GROUP = 'Chung';
const usd = (v) => '$' + (Number(v) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: (Number(v) || 0) < 1 ? 4 : 2 });
const pctText = (b) => (b?.limit == null ? '—' : `${(b.pct ?? 0).toLocaleString('vi-VN')}%`);
const levelOf = (b) => (b?.blocked ? 'over' : b?.warn ? 'warn' : 'ok');

/** Bar "đã dùng / hạn mức / %" (estimated USD). */
export function budgetBar(b) {
  if (!b || b.limit == null) {
    return h('div', { class: 'budget-box', id: 'budgetBox' },
      h('div', { class: 'budget-line' }, h('span', {}, `Đã dùng ${usd(b?.used)} (ước tính)`), h('span', { class: 'muted' }, 'Không giới hạn')));
  }
  const w = Math.max(0, Math.min(100, b.pct || 0));
  return h('div', { class: 'budget-box ' + levelOf(b), id: 'budgetBox' },
    h('div', { class: 'budget-line' },
      h('span', {}, h('strong', {}, usd(b.used)), ` / ${usd(b.limit)} (ước tính)`),
      h('strong', { class: 'budget-pct' }, pctText(b))),
    h('div', { class: 'budget-bar', role: 'progressbar', 'aria-valuenow': String(w), 'aria-valuemin': '0', 'aria-valuemax': '100' }, h('div', { style: { width: w + '%' } })),
    b.raised ? h('div', { class: 'small muted' }, `Gồm ${usd(b.raised)} admin nới thêm tháng này`) : null,
    b.blocked ? h('div', { class: 'budget-msg' }, '⛔ Đã hết hạn mức tháng — liên hệ admin. Job đạo diễn mới sẽ bị từ chối.')
      : b.warn ? h('div', { class: 'budget-msg' }, `⚠ Đã dùng ≥ 80% hạn mức tháng ${b.month}.`) : null);
}

/** Top-bar banner when the caller's budget is ≥ 80 % (hidden below). Safe to call any time. */
export async function refreshBudgetBanner() {
  const el = $('budgetBanner');
  if (!el) return;
  let b = null;
  try { b = await api.budget(); } catch { /* not signed in / older server */ }
  if (!b?.warn) { el.hidden = true; return; }
  el.className = 'budget-banner ' + levelOf(b);
  el.textContent = b.blocked
    ? `⛔ Đã hết hạn mức tháng — liên hệ admin (${usd(b.used)} / ${usd(b.limit)})`
    : `⚠ Đã dùng ${pctText(b)} hạn mức AI tháng này (${usd(b.used)} / ${usd(b.limit)})`;
  el.title = 'Chi phí ước tính theo bảng giá model. Job đang chạy vẫn chạy hết; job đạo diễn mới bị từ chối khi chạm 100%.';
  el.hidden = false;
}

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
  refreshBudgetBanner();

  const menu = $('userMenu');
  if (!a.user) {
    menu.hidden = !(a.mode === 'accounts');
    if (a.mode === 'accounts') menu.replaceChildren(h('a', { href: '/login.html' }, h('button', { class: 'ghost' }, 'Đăng nhập')));
    return;
  }
  menu.replaceChildren(...[ // filter: replaceChildren(null) would print "null" for members
    h('span', { class: 'who' }, '👤 ' + a.user.name),
    h('button', { class: 'ghost', id: 'btnAccount', onclick: showAccount }, 'Tài khoản'),
    a.user.role === 'admin' ? h('button', { class: 'ghost', id: 'btnAdmin', onclick: showAdmin }, 'Quản trị') : null,
    h('button', {
      class: 'ghost', title: 'Đăng xuất',
      onclick: async () => { await api.logout().catch(() => {}); location.href = '/login.html'; },
    }, 'Đăng xuất'),
  ].filter(Boolean));
  menu.hidden = false;
}

// ---------------------------------------------------------------- Tài khoản
export async function showAccount() {
  const u = state.auth.user;
  const body = h('div', {});
  const tokensBox = h('div', {});
  const onceBox = h('div', {});
  const usageBox = h('p', { class: 'small muted' }, 'Đang tải…');
  const budgetBox = h('div', {}, h('p', { class: 'small muted' }, 'Đang tải…'));

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
    h('div', { class: 'acct-section' }, h('h4', {}, 'Chi phí AI tháng này'), budgetBox),
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
    budgetBox.replaceChildren(budgetBar(r.budget));
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
    const isCurrent = r.month === r.currentMonth;
    const t0 = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    usageBox.replaceChildren(r.rows.length
      ? h('table', { class: 'acct-table', id: 'usageTable' },
        h('tr', {}, h('th', {}, 'Người dùng'), h('th', {}, 'Lần chạy'), h('th', {}, 'Vào'), h('th', {}, 'Ra'), h('th', {}, 'Đọc cache'), h('th', {}, 'Ghi cache'),
          h('th', { title: 'Chi phí ước tính theo bảng giá lúc ghi' }, 'USD'), h('th', {}, 'Hạn mức'), h('th', {}, '% hạn mức'), isCurrent ? h('th', {}) : null),
        r.rows.map((x) => {
          const t = x.total || t0, b = x.budget;
          return h('tr', { 'data-user': x.userId || '' },
            h('td', {}, x.userId ? (x.name || x.userId) : `${SHARED_GROUP} (${UNKNOWN_USER})`),
            h('td', { class: 'num' }, x.jobs),
            h('td', { class: 'num' }, n(t.input_tokens)), h('td', { class: 'num' }, n(t.output_tokens)),
            h('td', { class: 'num' }, n(t.cache_read_input_tokens)), h('td', { class: 'num' }, n(t.cache_creation_input_tokens)),
            h('td', { class: 'num', title: x.usdEstimated ? 'Có dòng usage cũ — tính theo bảng giá hiện tại' : '' }, usd(x.usd) + (x.usdEstimated ? '*' : '')),
            h('td', { class: 'num' }, b?.limit == null ? 'không giới hạn' : usd(b.limit) + (b.raised ? ` (+${usd(b.raised)})` : '')),
            h('td', { class: 'num' }, h('span', { class: 'pct-tag ' + levelOf(b) }, pctText(b))),
            isCurrent ? h('td', { class: 'num' }, b?.limit != null ? h('button', { class: 'btn-raise', onclick: () => raise(x) }, 'Nới hạn mức') : null) : null);
        }))
      : h('p', { class: 'small muted' }, `Tháng ${r.month} chưa có lần chạy đạo diễn nào.`),
    h('p', { class: 'small muted' }, `USD là ước tính theo bảng giá ${r.pricing?.version || '?'}${r.pricing?.verifiedAt ? ` (kiểm ${r.pricing.verifiedAt})` : ''}, ghi vào từng lần chạy lúc chạy xong; đổi bảng giá không làm đổi số đã ghi. Tháng tính theo giờ Việt Nam.`));
  }

  async function raise(x) {
    const who = x.userId ? (x.name || x.userId) : SHARED_GROUP;
    const amount = prompt(`Nới hạn mức tháng này cho "${who}" thêm bao nhiêu USD?`, '5');
    if (amount == null) return;
    const reason = prompt('Lý do nới hạn mức (bắt buộc, ghi vào nhật ký):', '');
    if (reason == null) return;
    try {
      await api.raiseBudget({ userId: x.userId || null, amount: Number(amount), reason });
      toast(`Đã nới hạn mức cho ${who} — có hiệu lực ngay`);
      fillUsage(monthSel.value);
      fillBudgets();
      refreshBudgetBanner();
    } catch (e) { toast(e.message, { error: true }); }
  }

  const budgetBox = h('div', {});
  async function fillBudgets() {
    const [{ config: c, raises, month }, users] = await Promise.all([api.budgets(), api.users()]);
    const val = (v) => (v == null ? '' : String(v));
    const inp = (v, ph) => h('input', { type: 'number', min: '0', step: '0.5', value: val(v), placeholder: ph, class: 'budget-input' });
    const roleIn = { member: inp(c.roles?.member, 'không giới hạn'), admin: inp(c.roles?.admin, 'không giới hạn') };
    const sharedIn = inp(c.shared, 'không giới hạn');
    const userIns = users.map((u) => {
      const has = Object.prototype.hasOwnProperty.call(c.users || {}, u.id);
      const el = inp(has ? c.users[u.id] : null, has ? 'không giới hạn' : `theo vai trò (${u.role})`);
      el.dataset.user = u.id;
      el.dataset.has = has ? '1' : '';
      return { u, el, has };
    });
    budgetBox.replaceChildren(
      h('p', { class: 'small muted' }, 'USD ước tính / tháng (giờ Việt Nam). Để trống = không giới hạn. ≥ 80% hiện cảnh báo, ≥ 100% chặn job đạo diễn mới (job đang chạy vẫn chạy hết).'),
      h('div', { class: 'acct-form', id: 'budgetForm' },
        h('label', { class: 'small' }, 'Mặc định vai trò member', roleIn.member),
        h('label', { class: 'small' }, 'Mặc định vai trò admin', roleIn.admin),
        h('label', { class: 'small full' }, `Nhóm "${SHARED_GROUP}" (usage chưa gắn người: mật khẩu chung / chế độ mở)`, sharedIn)),
      h('table', { class: 'acct-table', id: 'budgetUsers', style: { marginTop: '8px' } },
        h('tr', {}, h('th', {}, 'Hạn mức riêng'), h('th', {}, 'USD / tháng'), h('th', {})),
        userIns.map(({ u, el, has }) => h('tr', {},
          h('td', {}, `${u.name} `, h('span', { class: 'badge' + (u.role === 'admin' ? ' admin' : '') }, u.role)),
          h('td', {}, el),
          h('td', { class: 'num' }, has ? h('button', {
            title: 'Bỏ hạn mức riêng, dùng mặc định của vai trò',
            onclick: async () => { try { await api.updateBudgets({ users: { [u.id]: 'role' } }); fillBudgets(); fillUsage(monthSel.value); } catch (e) { toast(e.message, { error: true }); } },
          }, 'Theo vai trò') : null)))),
      h('div', { class: 'row', style: { marginTop: '8px' } }, h('button', {
        class: 'primary shrink', id: 'btnSaveBudgets',
        onclick: async () => {
          const users = {};
          for (const { u, el, has } of userIns) if (el.value !== '' || has) users[u.id] = el.value === '' ? null : Number(el.value);
          try {
            await api.updateBudgets({ roles: { member: roleIn.member.value, admin: roleIn.admin.value }, shared: sharedIn.value, users });
            toast('Đã lưu hạn mức — có hiệu lực ngay');
            fillBudgets(); fillUsage(monthSel.value); refreshBudgetBanner();
          } catch (e) { toast(e.message, { error: true }); }
        },
      }, 'Lưu hạn mức')),
      h('h4', { style: { margin: '14px 0 6px' } }, `Nhật ký nới hạn mức tháng ${month}`),
      raises.length
        ? h('table', { class: 'acct-table', id: 'raiseLog' },
          h('tr', {}, h('th', {}, 'Lúc'), h('th', {}, 'Ai nới'), h('th', {}, 'Cho'), h('th', {}, 'USD'), h('th', {}, 'Lý do')),
          raises.map((x) => h('tr', {},
            h('td', {}, new Date(x.at).toLocaleString('vi-VN')), h('td', {}, x.byName || x.by || '—'),
            h('td', {}, x.userId ? (users.find((u) => u.id === x.userId)?.name || x.userId) : SHARED_GROUP),
            h('td', { class: 'num' }, '+' + usd(x.amount)), h('td', {}, x.reason))))
        : h('p', { class: 'small muted' }, 'Chưa có lần nới nào.'));
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
      h('div', { class: 'row' }, h('h4', { style: { margin: 0 } }, 'Chi phí & token đạo diễn AI theo người'), h('span', { class: 'shrink' }, monthSel)),
      h('div', { style: { height: '8px' } }), usageBox),
    h('div', { class: 'acct-section' }, h('h4', {}, 'Hạn mức chi phí AI'), budgetBox),
  );
  modal('Quản trị', body);
  fillUsers().catch((e) => toast(e.message, { error: true }));
  fillUsage().catch((e) => toast(e.message, { error: true }));
  fillBudgets().catch((e) => toast(e.message, { error: true }));
}
