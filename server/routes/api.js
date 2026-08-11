/**
 * Private API Routes — requires session auth
 *
 * Bundles
 *   GET    /api/bundles              — list all bundles
 *   POST   /api/bundles              — create a bundle
 *   GET    /api/bundles/:id          — get a single bundle
 *   PUT    /api/bundles/:id          — update a bundle
 *   DELETE /api/bundles/:id          — delete a bundle
 *
 * Products
 *   GET    /api/products/search      — search products (for picker)
 *   GET    /api/products/recommended — recently-synced products (picker dropdown)
 *   GET    /api/products/:id         — get single product
 *
 * Categories
 *   GET    /api/categories           — get category list
 *   GET    /api/categories/tree      — get category tree
 *
 * Webhooks
 *   POST   /api/webhooks/register    — register inventory webhook
 */

const express = require('express');
const router = express.Router();
const { requireSession } = require('./auth');
const { BigCommerceClient } = require('../services/bigcommerce');
const bundleService = require('../services/bundleService');
const productIndex = require('../services/productIndex');
const userStore = require('../services/userStore');

// Apply session guard to all /api/* routes
router.use(requireSession);

// Helper: create BC client from req
const client = (req) =>
  new BigCommerceClient(req.storeHash, req.accessToken);

// ─── Bundles ─────────────────────────────────────────────────────────────────

router.get('/bundles', async (req, res) => {
  try {
    const result = await bundleService.listBundles(
      req.storeHash,
      req.accessToken,
      { limit: Number(req.query.limit) || 50, page: Number(req.query.page) || 1 }
    );
    res.json(result);
  } catch (err) {
    console.error('listBundles error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/bundles', async (req, res) => {
  try {
    const { name, description, discount_percent, category_ids, products } = req.body;

    if (!name || !products || products.length < 2) {
      return res.status(400).json({
        error: 'name and at least 2 products are required.',
      });
    }

    // Price is derived from component prices + an optional % discount, so the
    // client no longer sends a price — only an optional discount_percent (0–100).
    const result = await bundleService.createBundle(
      req.storeHash,
      req.accessToken,
      {
        name,
        description,
        discount_percent: Number(discount_percent) || 0,
        category_ids: category_ids || [],
        products,
      }
    );

    // Register inventory webhook (idempotent)
    await registerInventoryWebhook(client(req), req.storeHash);

    res.status(201).json(result);
  } catch (err) {
    console.error('createBundle error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/bundles/:id', async (req, res) => {
  try {
    const bundle = await bundleService.getBundle(
      req.storeHash,
      req.accessToken,
      Number(req.params.id)
    );
    res.json(bundle);
  } catch (err) {
    if (err.message === 'Product is not a bundle') {
      return res.status(404).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

router.put('/bundles/:id', async (req, res) => {
  try {
    // BUG-03: validate products array before delegating (updateBundle also validates,
    // but early rejection gives the client a proper 400 not a 500)
    const { products } = req.body;
    if (!products || !Array.isArray(products) || products.length < 2) {
      return res.status(400).json({
        error: 'products array with at least 2 items is required.',
      });
    }
    const result = await bundleService.updateBundle(
      req.storeHash,
      req.accessToken,
      Number(req.params.id),
      req.body
    );
    res.json(result);
  } catch (err) {
    console.error('updateBundle error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Inline SKU edit from the bundle list — updates only the SKU, so it skips the
// full products-array validation that PUT /bundles/:id requires.
router.put('/bundles/:id/sku', async (req, res) => {
  try {
    const { sku } = req.body;
    if (!sku || !String(sku).trim()) {
      return res.status(400).json({ error: 'sku is required.' });
    }
    const result = await bundleService.updateBundleSku(
      req.storeHash,
      req.accessToken,
      Number(req.params.id),
      sku
    );
    res.json(result);
  } catch (err) {
    // Surface BC's own message (e.g. duplicate SKU) when present.
    const bcErr = err.response?.data;
    const msg =
      bcErr?.title ||
      (bcErr?.errors && Object.values(bcErr.errors)[0]) ||
      err.message;
    const status = msg.includes('not a bundle')
      ? 404
      : err.response?.status === 409 || /sku/i.test(msg)
      ? 409
      : 500;
    console.error('updateBundleSku error:', bcErr || err.message);
    res.status(status).json({ error: msg });
  }
});

router.delete('/bundles/:id', async (req, res) => {
  try {
    await bundleService.deleteBundle(
      req.storeHash,
      req.accessToken,
      Number(req.params.id)
    );
    res.status(204).end();
  } catch (err) {
    console.error('deleteBundle error:', err.message);
    // BUG-13: if product isn't a bundle, return 404 not 500
    const status = err.message.includes('not a bundle') ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

// ─── Products ─────────────────────────────────────────────────────────────────

router.get('/products/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 2) {
      return res.json([]);
    }
    const bc = client(req);
    const products = await bc.searchProducts(q.trim(), 20);
    res.json(
      products.map((p) => ({
        id: p.id,
        name: p.name,
        sku: p.sku,
        price: p.price,
        availability: p.availability,
        inventory_level: p.inventory_level,
        inventory_tracking: p.inventory_tracking,
        thumbnail:
          p.images?.[0]?.url_thumbnail ||
          p.primary_image?.url_thumbnail ||
          null,
      }))
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Product index (local cache / re-index) ─────────────────────────────────
// NOTE: these must be declared BEFORE '/products/:id' so the literal paths
// aren't swallowed by the ':id' param route.

/**
 * Trigger a full re-index of the store's products into the local DB.
 * The app reads inventory from this index instead of the BC API.
 * Stamps catalog_last_sync on the current user.
 */
router.post('/products/reindex', async (req, res) => {
  try {
    const summary = await productIndex.reindexStore(req.storeHash, req.accessToken);

    // Record when this store's catalog was last synced (on the logged-in user).
    // markCatalogSynced defaults to IST for the human-facing column.
    const bcUserId = req.session?.user?.id ?? null;
    await userStore.markCatalogSynced(req.storeHash, bcUserId);

    res.json({
      success: true,
      synced: summary.synced,
      pages: summary.pages,
      lastSyncedAt: summary.at,
      durationMs: summary.durationMs,
    });
  } catch (err) {
    console.error('reindex error:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Recommended products for the picker dropdown — shown when the merchant
 * focuses the empty search box (before typing). Returns the most recently
 * synced products from the local index, in the same shape as /products/search.
 */
router.get('/products/recommended', async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 8, 1), 20);
    const rows = await productIndex.listRecent(req.storeHash, limit);
    res.json(
      rows.map((r) => ({
        id: r.productId,
        name: r.name,
        sku: r.sku,
        price: r.price,
        availability: r.availability,
        inventory_level: r.inventoryLevel,
        inventory_tracking: r.inventoryTracking,
        thumbnail: r.thumbnail,
      }))
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Index status for the UI: how many products are cached and when last synced.
 */
router.get('/products/index-status', async (req, res) => {
  try {
    const [count, lastSyncedAt] = await Promise.all([
      productIndex.indexedCount(req.storeHash),
      productIndex.lastSyncedAt(req.storeHash),
    ]);
    res.json({ count, lastSyncedAt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/products/:id', async (req, res) => {
  try {
    // DB-first: read from the local index, fall back to a live BC fetch
    // (and cache it) when the product isn't indexed yet.
    const product = await productIndex.getProduct(
      req.storeHash,
      Number(req.params.id),
      req.accessToken
    );
    if (!product) return res.status(404).json({ error: 'Product not found.' });
    res.json(product);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Store info (currency) ──────────────────────────────────────────────────────

router.get('/store-info', async (req, res) => {
  try {
    const bc = client(req);
    const info = await bc.getStoreInfo();
    // storeHash lets the client build control-panel URLs (e.g. product edit).
    res.json({ ...info, storeHash: req.storeHash });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Categories ───────────────────────────────────────────────────────────────

router.get('/categories', async (req, res) => {
  try {
    const bc = client(req);
    // BUG-11: return systemCategoryId alongside the list so the client can
    // filter by ID instead of by name (name-based filter breaks if renamed).
    const { ensureSystemCategory } = require('../services/bundleService');
    const [categories, systemCategoryId] = await Promise.all([
      bc.getCategories(),
      ensureSystemCategory(bc, req.storeHash),
    ]);
    res.json({ categories, systemCategoryId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/categories/tree', async (req, res) => {
  try {
    const bc = client(req);
    const tree = await bc.getCategoryTree();
    res.json(tree);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Orders ───────────────────────────────────────────────────────────────────

/**
 * Write the bundle component breakdown into an order's staff_notes on demand.
 * Useful for back-filling orders placed before the order webhook was registered,
 * or for re-running it manually. The order webhook does this automatically for
 * new orders. Idempotent.
 */
router.post('/orders/:id/annotate-bundles', async (req, res) => {
  try {
    const result = await bundleService.annotateOrderWithBundleContents(
      req.storeHash,
      req.accessToken,
      Number(req.params.id)
    );
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('annotateOrderWithBundleContents error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Deduct component inventory for an order's bundles on demand (back-fill / test).
 * Idempotent — won't deduct twice for the same order. The order webhook does
 * this automatically for new orders.
 */
router.post('/orders/:id/deduct-inventory', async (req, res) => {
  try {
    const result = await bundleService.deductOrderBundleInventory(
      req.storeHash,
      req.accessToken,
      Number(req.params.id)
    );
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('deductOrderBundleInventory error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Restore component inventory for an order on demand (back-fill / test). Only
 * acts if the order is currently in a deducted state. The order-status webhook
 * does this automatically on cancel/refund.
 */
router.post('/orders/:id/restore-inventory', async (req, res) => {
  try {
    const result = await bundleService.restoreOrderBundleInventory(
      req.storeHash,
      req.accessToken,
      Number(req.params.id)
    );
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('restoreOrderBundleInventory error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Toggle the "expand on order" flag for a bundle (the bundle list "Modify"
 * action). When enabled, purchases of this bundle get their component products
 * added to the order as $0 line items by the order webhook.
 *
 * PUT /api/bundles/:id/modify   body: { enabled: boolean }
 * → { success, enabled }
 */
router.put('/bundles/:id/modify', async (req, res) => {
  try {
    const result = await bundleService.setBundleExpandFlag(
      req.storeHash,
      req.accessToken,
      Number(req.params.id),
      req.body.enabled !== false // default to enabling
    );
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('setBundleExpandFlag error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Webhook registration ──────────────────────────────────────────────────────

router.post('/webhooks/register', async (req, res) => {
  try {
    const bc = client(req);
    const results = await registerBundleWebhooks(bc, req.storeHash);
    res.json({ success: true, webhooks: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Register both webhooks needed for bundle availability sync (idempotent).
 *
 * 1. store/product/inventory/updated — fires when stock level changes
 *    → handles out-of-stock scenarios
 *
 * 2. store/product/updated — fires when any product field changes,
 *    including availability (enabled ↔ disabled)
 *    → handles the case where a merchant disables a component product
 *    manually from the Products admin without touching stock
 *
 * Both webhooks point to the same handler endpoint which reuses
 * syncBundleFromInventory (the name is kept for historical reasons;
 * it actually re-evaluates both stock AND availability).
 *
 * Each webhook is registered with a custom secret header. BigCommerce echoes
 * this header back on every delivery, and the receiver verifies it — this is
 * the supported way to authenticate BC webhooks (BC does not HMAC-sign bodies).
 */
async function registerBundleWebhooks(bcClient, storeHash) {
  const inventoryDestination = `${process.env.APP_URL}/webhooks/inventory`;
  const orderDestination = `${process.env.APP_URL}/webhooks/order`;
  const orderStatusDestination = `${process.env.APP_URL}/webhooks/order-status`;

  // Each scope is paired with the endpoint that handles it.
  const hooks = [
    { scope: 'store/product/inventory/updated', destination: inventoryDestination },
    { scope: 'store/product/updated', destination: inventoryDestination },
    // store/order/created → staff_notes breakdown + deduct component inventory.
    { scope: 'store/order/created', destination: orderDestination },
    // store/order/statusUpdated → restore component inventory on cancel/refund.
    { scope: 'store/order/statusUpdated', destination: orderStatusDestination },
  ];

  // Attach the shared secret as a custom header when one is configured.
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) {
    console.warn(
      '[Webhook] WEBHOOK_SECRET is not set — webhooks will be registered ' +
      'without a verification header and the receiver cannot authenticate them. ' +
      'Set WEBHOOK_SECRET in your environment for production.'
    );
  }
  const headers = secret ? { 'X-Bundle-Secret': secret } : undefined;

  const results = [];
  for (const { scope, destination } of hooks) {
    try {
      const result = await bcClient.registerWebhook(scope, destination, headers);
      results.push(result);
    } catch (err) {
      console.warn(`Webhook '${scope}' registration for ${storeHash} failed:`, err.message);
    }
  }
  return results;
}

// Alias so the bundle creation path (which calls registerInventoryWebhook) still works
const registerInventoryWebhook = registerBundleWebhooks;

module.exports = router;
