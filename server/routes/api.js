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
    const { name, description, price, category_ids, products } = req.body;

    if (!name || !price || !products || products.length < 2) {
      return res.status(400).json({
        error: 'name, price, and at least 2 products are required.',
      });
    }

    const result = await bundleService.createBundle(
      req.storeHash,
      req.accessToken,
      { name, description, price: Number(price), category_ids: category_ids || [], products }
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

router.get('/products/:id', async (req, res) => {
  try {
    const bc = client(req);
    const product = await bc.getProduct(Number(req.params.id));
    res.json(product);
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
  const destination = `${process.env.APP_URL}/webhooks/inventory`;
  const scopes = [
    'store/product/inventory/updated',
    'store/product/updated',
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
  for (const scope of scopes) {
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
