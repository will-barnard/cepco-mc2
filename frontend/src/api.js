// Thin fetch wrapper. The JWT lives in an HttpOnly cookie set by the backend,
// so credentials: 'include' is all that's needed — no token handling in JS.

const BASE = '/api';

async function request(method, path, body, options = {}) {
  const init = {
    method,
    credentials: 'include',
    headers: {},
    ...options,
  };

  if (body instanceof FormData) {
    init.body = body; // let the browser set the multipart boundary
  } else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  const res = await fetch(`${BASE}${path}`, init);

  if (res.status === 204) return null;

  let payload = null;
  const text = await res.text();
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = text; }
  }

  if (!res.ok) {
    const err = new Error(payload?.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.details = payload?.details;
    throw err;
  }
  return payload;
}

const qs = (params = {}) => {
  const entries = Object.entries(params).filter(
    ([, v]) => v !== undefined && v !== null && v !== '',
  );
  return entries.length ? `?${new URLSearchParams(entries)}` : '';
};

export const api = {
  get: (path, params) => request('GET', path + qs(params)),
  post: (path, body) => request('POST', path, body),
  patch: (path, body) => request('PATCH', path, body),
  del: (path) => request('DELETE', path),
};

export default api;
