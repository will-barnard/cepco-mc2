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

  // GET /tickets sends the total matching count (ignoring limit/offset) as
  // a header rather than changing the body shape, so every existing caller
  // still gets back a plain array. Pagination-aware callers (currently just
  // DashboardView's "Assigned to me"/"Unassigned" lists) read it off a
  // non-enumerable property instead — invisible to .length, v-for, spreads,
  // and JSON.stringify, so nothing else has to know it's there.
  if (Array.isArray(payload)) {
    const total = res.headers.get('X-Total-Count');
    if (total !== null) {
      Object.defineProperty(payload, 'totalCount', { value: Number(total), enumerable: false });
    }
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
