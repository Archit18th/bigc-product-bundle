/**
 * Product Index — local MySQL cache of BigCommerce products.
 *
 * The app reads product/inventory data from the `products` table instead of
 * calling the BigCommerce API on every request. This file owns:
 *
 *   reindexStore  — full sync: pull ALL products from BC → upsert into `products`
 *   upsertFromBC  — write a single BC product object into the index (webhooks)
 *   refreshOne    — fetch one product live from BC and cache it
 *   getProduct    — DB-first read with optional live API fallback
 *   getProducts   — DB-first read for many ids at once
 *
 * Stock semantics mirror bundleService.resolveComponents:
 *   - inventory_tracking 'none'    → unlimited (stored as 0, treated as ∞ on read)
 *   - inventory_tracking 'variant' → sum of variant inventory levels
 *   - inventory_tracking 'product' → product.inventory_level
 */

const prisma = require('./prisma');
const { BigCommerceClient } = require('./bigcommerce');

/** Compute the thumbnail URL from a BC product object. */
function thumbOf(p) {
  return (
    p.images?.[0]?.url_thumbnail ||
    p.primary_image?.url_thumbnail ||
    null
  );
}

/** Compute the stored inventory level from a BC product object. */
function stockOf(p) {
  if (p.inventory_tracking === 'variant') {
    return (p.variants || []).reduce((sum, v) => sum + (v.inventory_level ?? 0), 0);
  }
  // 'none' has no meaningful number — store 0; reads treat 'none' as unlimited.
  return p.inventory_level ?? 0;
}

/** Map a BC product object to the `products` table shape. */
function toRow(storeHash, p) {
  return {
    storeHash,
    productId: p.id,
    name: p.name ?? '',
    sku: p.sku ?? null,
    price: Number(p.price) || 0,
    inventoryLevel: stockOf(p),
    inventoryTracking: p.inventory_tracking ?? null,
    availability: p.availability ?? null,
    thumbnail: thumbOf(p),
    lastSyncedAt: new Date(),
  };
}

/** Convert a stored row into the shape the app uses for stock math. */
function rowToProduct(row) {
  return {
    product_id: row.productId,
    name: row.name,
    sku: row.sku,
    price: Number(row.price) || 0,
    // 'none' tracking = untracked = unlimited (Infinity), matching the BC path.
    stock: row.inventoryTracking === 'none' ? Infinity : row.inventoryLevel,
    inventory_tracking: row.inventoryTracking,
    availability: row.availability,
    thumbnail: row.thumbnail,
    lastSyncedAt: row.lastSyncedAt,
  };
}

// ─── Writes ──────────────────────────────────────────────────────────────────

/** Upsert a single BC product object into the index. */
async function upsertFromBC(storeHash, bcProduct) {
  const data = toRow(storeHash, bcProduct);
  return prisma.product.upsert({
    where: { store_product: { storeHash, productId: bcProduct.id } },
    create: data,
    update: data,
  });
}

/**
 * Full re-index for a store: pull every product from BigCommerce and upsert it
 * into the `products` table. Returns a summary the UI can display.
 *
 * @returns {{synced:number, pages:number, at:Date, durationMs:number}}
 */
async function reindexStore(storeHash, accessToken, { onProgress } = {}) {
  const client = new BigCommerceClient(storeHash, accessToken);
  const startedAt = Date.now();

  let pages = 0;
  const products = await client.getAllProducts((info) => {
    pages = info.totalPages;
    if (onProgress) onProgress(info);
  });

  // Upsert sequentially in small batches to avoid hammering the connection pool.
  let synced = 0;
  const BATCH = 25;
  for (let i = 0; i < products.length; i += BATCH) {
    const slice = products.slice(i, i + BATCH);
    await Promise.all(slice.map((p) => upsertFromBC(storeHash, p)));
    synced += slice.length;
  }

  const at = new Date();
  return { synced, pages, at, durationMs: Date.now() - startedAt };
}

/** Fetch one product live from BC and cache it in the index. */
async function refreshOne(storeHash, accessToken, productId) {
  const client = new BigCommerceClient(storeHash, accessToken);
  const p = await client.getProduct(productId);
  await upsertFromBC(storeHash, p);
  return p;
}

/** Remove a product from the index (e.g. product/deleted webhook). */
async function removeOne(storeHash, productId) {
  await prisma.product.deleteMany({ where: { storeHash, productId } });
}

// ─── Reads (DB-first) ─────────────────────────────────────────────────────────

/**
 * Read a single product from the index. DB-first; if it's not cached yet and an
 * accessToken is provided, fall back to a live BC fetch and cache it.
 * Returns the app-shaped product object, or null if it can't be resolved.
 */
async function getProduct(storeHash, productId, accessToken = null) {
  const row = await prisma.product.findUnique({
    where: { store_product: { storeHash, productId } },
  });
  if (row) return rowToProduct(row);

  if (accessToken) {
    try {
      const p = await refreshOne(storeHash, accessToken, productId);
      // toRow() yields the same field names rowToProduct() reads.
      return rowToProduct(toRow(storeHash, p));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Read many products from the index at once. Returns a Map keyed by productId
 * of app-shaped products (only those found in the index).
 */
async function getProducts(storeHash, productIds) {
  const rows = await prisma.product.findMany({
    where: { storeHash, productId: { in: productIds } },
  });
  const map = new Map();
  for (const r of rows) map.set(r.productId, rowToProduct(r));
  return map;
}

/**
 * List the most recently synced products for the picker's "recommended"
 * dropdown (shown when the merchant focuses the empty search box). Returns raw
 * rows ordered newest-synced first; the route maps them to the search shape.
 */
async function listRecent(storeHash, limit = 8) {
  return prisma.product.findMany({
    where: { storeHash },
    orderBy: { lastSyncedAt: 'desc' },
    take: limit,
  });
}

/** When was this store's index last refreshed? (most recent lastSyncedAt) */
async function lastSyncedAt(storeHash) {
  const row = await prisma.product.findFirst({
    where: { storeHash },
    orderBy: { lastSyncedAt: 'desc' },
    select: { lastSyncedAt: true },
  });
  return row?.lastSyncedAt ?? null;
}

/** How many products are indexed for this store. */
async function indexedCount(storeHash) {
  return prisma.product.count({ where: { storeHash } });
}

module.exports = {
  reindexStore,
  upsertFromBC,
  refreshOne,
  removeOne,
  getProduct,
  getProducts,
  listRecent,
  lastSyncedAt,
  indexedCount,
};
