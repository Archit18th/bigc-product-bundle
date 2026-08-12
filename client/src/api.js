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

// Inline SKU edit from the bundle list (updates only the SKU).
export const updateBundleSku = (id, sku) =>
  request('PUT', `/bundles/${id}/sku`, { sku });

export const deleteBundle = (id) => request('DELETE', `/bundles/${id}`);

// Toggle a bundle's "expand on order" flag (bundle list "Modify" action). When
// enabled, purchases of this bundle show their products as $0 lines on the order.
// Returns { success, enabled }.
export const setBundleModify = (id, enabled) =>
  request('PUT', `/bundles/${id}/modify`, { enabled });

// ─── Products ─────────────────────────────────────────────────────────────────

export const searchProducts = (q) =>
  request('GET', `/products/search?q=${encodeURIComponent(q)}`);

// Recently-synced products, shown in the picker dropdown when the merchant
// focuses the empty search box (before typing a query).
export const getRecommendedProducts = (limit = 8) =>
  request('GET', `/products/recommended?limit=${limit}`);

export const getProduct = (id) => request('GET', `/products/${id}`);

// ─── Product index (local cache / re-index) ─────────────────────────────────

// Trigger a full re-index of the store's products into the local DB.
// Returns { success, synced, pages, lastSyncedAt, durationMs }.
export const reindexProducts = () => request('POST', '/products/reindex');

// Index status for the header. Returns { count, lastSyncedAt }.
export const getIndexStatus = () => request('GET', '/products/index-status');

// ─── Store info (currency) ──────────────────────────────────────────────────────

// Returns { currency, currency_symbol, decimal_places }
export const getStoreInfo = () => request('GET', '/store-info');

// ─── Categories ───────────────────────────────────────────────────────────────

// Returns { categories: [...], systemCategoryId: number }
export const getCategories = () => request('GET', '/categories');

export const getCategoryTree = () => request('GET', '/categories/tree');
