async function req(method, url, body, isForm) {
  const r = await fetch(url, {
    method,
    headers: body && !isForm ? { 'content-type': 'application/json' } : undefined,
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
  });
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  // session expired / user disabled (accounts mode) → back to the login page
  if (r.status === 401 && data && data.login) {
    location.href = `${data.login}?next=${encodeURIComponent(location.pathname + location.hash)}`;
    throw new Error('Cần đăng nhập');
  }
  if (!r.ok) throw new Error((data && data.error) || r.statusText);
  return data;
}
export const api = {
  config: () => req('GET', '/api/config'),
  projects: () => req('GET', '/api/projects'),
  create: (b) => req('POST', '/api/projects', b),
  get: (id) => req('GET', `/api/projects/${id}`),
  save: (p, opts = {}) => req('PUT', `/api/projects/${p.id}${opts.snapshot ? `?snapshot=1&reason=${encodeURIComponent(opts.reason || 'save')}` : ''}`, p),
  remove: (id) => req('DELETE', `/api/projects/${id}`),
  duplicate: (id) => req('POST', `/api/projects/${id}/duplicate`),
  template: (id, b) => req('POST', `/api/projects/${id}/template`, b),
  upload: (id, files, extra = {}) => {
    const fd = new FormData();
    for (const f of files) fd.append('files', f);
    for (const [k, v] of Object.entries(extra)) fd.append(k, v);
    return req('POST', `/api/projects/${id}/assets`, fd, true);
  },
  patchAsset: (id, aid, b) => req('PATCH', `/api/projects/${id}/assets/${aid}`, b),
  deleteAsset: (id, aid) => req('DELETE', `/api/projects/${id}/assets/${aid}`),
  tts: (id, lineId, voice) => req('POST', `/api/projects/${id}/voice/${lineId}/tts`, { voice }),
  director: (id, b) => req('POST', `/api/projects/${id}/director`, b),
  render: (id, quality) => req('POST', `/api/projects/${id}/render`, { quality }),
  deleteExport: (id, file) => req('DELETE', `/api/projects/${id}/exports/${encodeURIComponent(file)}`),
  job: (jid) => req('GET', `/api/jobs/${jid}`),
  jobs: (pid) => req('GET', `/api/jobs?project=${pid}`),
  cancel: (jid) => req('POST', `/api/jobs/${jid}/cancel`),
  retry: (jid) => req('POST', `/api/jobs/${jid}/retry`),
  jobEventsUrl: (jid) => `/api/jobs/${jid}/events`,
  history: (id) => req('GET', `/api/projects/${id}/history`),
  restore: (id, file) => req('POST', `/api/projects/${id}/history/${encodeURIComponent(file)}/restore`),
  // accounts (issue #25)
  authStatus: () => req('GET', '/api/auth/status'),
  logout: () => req('POST', '/api/auth/logout'),
  tokens: () => req('GET', '/api/account/tokens'),
  createToken: (name) => req('POST', '/api/account/tokens', { name }),
  revokeToken: (tid) => req('DELETE', `/api/account/tokens/${tid}`),
  changePassword: (current, password) => req('POST', '/api/account/password', { current, password }),
  myUsage: (month) => req('GET', `/api/account/usage${month ? `?month=${month}` : ''}`),
  users: () => req('GET', '/api/admin/users'),
  createUser: (b) => req('POST', '/api/admin/users', b),
  updateUser: (uid, b) => req('PATCH', `/api/admin/users/${uid}`, b),
  resetPassword: (uid, password) => req('POST', `/api/admin/users/${uid}/password`, { password }),
  usage: (month) => req('GET', `/api/admin/usage${month ? `?month=${month}` : ''}`),
};
export const fileUrl = (p, a) => `/files/${p.id}/assets/${encodeURIComponent(a.file)}`;
export const exportUrl = (p, f, dl) => `/files/${p.id}/exports/${encodeURIComponent(f)}${dl ? '?download=1' : ''}`;
