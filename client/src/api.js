/**
 * Frontend API client
 * Wraps fetch calls to the backend /api/* endpoints.
 *
 * Auth is cookie-based: the session cookie set during the OAuth load callback is
 * sent automatically via `credentials: 'include'`, so no store hash needs to be
 * threaded through requests here.
 */

const API_BASE = '/api';

async function request(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
  };
  if (body !== undefined) opts.body = JSON.stringify(body);

  const res = await fetch(`${API_BASE}${path}`, opts);
  if (res.status === 204) return null;

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Request failed: ${res.status}`);
  return data;
}

// ─── Bundles ──────────────────────────────────────────────────────────────────

export const listBundles = (params = {}) => {
  const qs = new URLSearchParams(params).toString();
  return request('GET', `/bundles${qs ? `?${qs}` : ''}`);
};

export const getBundle = (id) => request('GET', `/bundles/${id}`);

export const createBundle = (data) => request('POST', '/bundles', data);

export const updateBundle = (id, data) => request('PUT', `/bundles/${id}`, data);

export const deleteBundle = (id) => request('DELETE', `/bundles/${id}`);

// ─── Products ─────────────────────────────────────────────────────────────────

export const searchProducts = (q) =>
  request('GET', `/products/search?q=${encodeURIComponent(q)}`);

export const getProduct = (id) => request('GET', `/products/${id}`);

// ─── Categories ───────────────────────────────────────────────────────────────

// Returns { categories: [...], systemCategoryId: number }
export const getCategories = () => request('GET', '/categories');

export const getCategoryTree = () => request('GET', '/categories/tree');
