// Small DOM helpers.
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'value') el.value = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function fmt(t, digits = 1) {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(digits).padStart(digits ? 3 + digits : 2, '0')}`;
}

let toastTimer;
export function toast(msg, { error = false, ms = 3200 } = {}) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast' + (error ? ' err' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

export function modal(title, body) {
  const m = document.getElementById('modal');
  document.getElementById('modalTitle').textContent = title;
  const b = document.getElementById('modalBody');
  b.replaceChildren(body);
  m.hidden = false;
  const close = () => {
    m.hidden = true;
    b.querySelectorAll('video,audio').forEach((v) => v.pause());
  };
  document.getElementById('modalClose').onclick = close;
  m.onclick = (e) => { if (e.target === m) close(); };
  return close;
}

export function slider(label, value, { min = 0, max = 1, step = 0.01, fmt: f = (v) => v, onInput }) {
  const out = h('span', { class: 'small muted' }, f(value));
  const inp = h('input', { type: 'range', min, max, step, value, oninput: (e) => { out.textContent = f(Number(e.target.value)); onInput(Number(e.target.value)); } });
  return h('div', {}, h('label', {}, label), h('div', { class: 'slider' }, inp, out));
}
