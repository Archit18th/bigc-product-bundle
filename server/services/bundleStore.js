/**
 * Bundle Store — local mirror of bundles in MySQL (Prisma).
 *
 * The bundle's source of truth is BigCommerce (product + metafields). This
 * table is a convenience mirror for fast lookup / history. All timestamps are
 * stored in IST via istNow().
 *
 * Writes are best-effort: callers wrap them so a DB hiccup never fails the
 * underlying BigCommerce operation.
 */

const prisma = require('./prisma');
const { istNow } = require('./time');

/**
 * Insert or update the local row for a bundle.
 *
 * @param {string} storeHash
 * @param {Object} b
 * @param {number} b.bundleProductId
 * @param {string} b.name
 * @param {number} b.price            regular price (component subtotal)
 * @param {number} b.salePrice        discounted price
 * @param {number} b.discountPercent
 * @param {number} b.inventoryLevel   buildable / reserved bundle stock
 * @param {boolean} b.available
 * @param {Array}  b.components        component snapshot
 */
async function saveBundle(storeHash, b) {
  const now = istNow();
  const data = {
    name: b.name ?? '',
    price: b.price ?? 0,
    salePrice: b.salePrice ?? 0,
    discountPercent: b.discountPercent ?? 0,
    inventoryLevel: b.inventoryLevel ?? 0,
    available: !!b.available,
    components: b.components ?? [],
    // Storefront SEO URL — leave existing value untouched if not provided.
    ...(b.url !== undefined ? { url: b.url } : {}),
    inventorySyncedAt: now,
    updatedAt: now,
  };

  return prisma.bundle.upsert({
    where: { store_bundle: { storeHash, bundleProductId: b.bundleProductId } },
    create: {
      storeHash,
      bundleProductId: b.bundleProductId,
      createdAt: now,
      ...data,
    },
    update: data,
  });
}

/** Remove the local row for a bundle (on delete). */
async function removeBundle(storeHash, bundleProductId) {
  await prisma.bundle.deleteMany({ where: { storeHash, bundleProductId } });
}

/** List local bundle rows for a store. */
async function listBundles(storeHash) {
  return prisma.bundle.findMany({
    where: { storeHash },
    orderBy: { createdAt: 'desc' },
  });
}

/** How many bundles are mirrored locally for this store. */
async function count(storeHash) {
  return prisma.bundle.count({ where: { storeHash } });
}

/** The single mirrored row for a bundle product (null if not a mirrored bundle). */
async function getByProductId(storeHash, bundleProductId) {
  return prisma.bundle.findUnique({
    where: { store_bundle: { storeHash, bundleProductId: Number(bundleProductId) } },
  });
}

/**
 * Available bundle rows whose component list contains `productId`.
 *
 * `components` is a JSON array of objects ({ product_id, qty, ... }), which MySQL
 * can't index for membership, so we load the store's available bundles and filter
 * in JS. Fine for a normal store (tens–low hundreds of bundles); switch to a raw
 * JSON_CONTAINS query only if a store ever has thousands.
 */
async function findAvailableContaining(storeHash, productId) {
  const pid = Number(productId);
  const rows = await prisma.bundle.findMany({
    where: { storeHash, available: true },
    orderBy: { createdAt: 'desc' },
  });
  return rows.filter(
    (b) =>
      Array.isArray(b.components) &&
      b.components.some((c) => Number(c.product_id) === pid)
  );
}

module.exports = {
  saveBundle,
  removeBundle,
  listBundles,
  count,
  getByProductId,
  findAvailableContaining,
};
