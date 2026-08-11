/**
 * Public Storefront API Routes — no session required, CORS open
 *
 * Called by the storefront script (bundle-link.js) injected via Script Manager.
 *
 *   GET /storefront/bundles/:storeHash/:productId
 *       Returns lightweight bundle list for the given product.
 *       Only returns available bundles.
 */

const express = require('express');
const path = require('path');
const router = express.Router();
const { getTokenForStore } = require('./auth');
const bundleService = require('../services/bundleService');

// Serve the storefront script itself so merchants can add it to Script Manager
// with a one-line <script src> tag instead of pasting the whole file (which
// BigCommerce's inline-content validator can reject). CORS is already open on
// /storefront, and ngrok serves sub-resource (script) loads without the
// browser interstitial. Editing storefront/bundle-link.js updates it live.
router.get('/bundle-link.js', (_req, res) => {
  res.type('application/javascript');
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, '..', '..', 'storefront', 'bundle-link.js'));
});

// Serve the order-confirmation storefront script (renders each bundle's
// component breakdown under the Order Summary on the thank-you / order pages).
router.get('/bundle-order.js', (_req, res) => {
  res.type('application/javascript');
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, '..', '..', 'storefront', 'bundle-order.js'));
});

// Serve the cart storefront script (nests each bundle's component breakdown
// under its line item on the cart page).
router.get('/bundle-cart.js', (_req, res) => {
  res.type('application/javascript');
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, '..', '..', 'storefront', 'bundle-cart.js'));
});

// Bundle composition for an order — consumed by bundle-order.js on the customer
// order-confirmation / order-details page. Returns ONLY the composition (bundle
// name + component names/quantities), no prices or PII, so it's safe on the
// CORS-open storefront surface.
router.get('/order-bundles/:storeHash/:orderId', async (req, res) => {
  const { storeHash, orderId } = req.params;

  const accessToken = await getTokenForStore(storeHash);
  if (!accessToken) {
    return res.status(404).json({ bundles: [], error: 'Store not found.' });
  }

  try {
    const bundles = await bundleService.getOrderBundleComposition(
      storeHash,
      accessToken,
      Number(orderId)
    );
    res.json({ bundles });
  } catch (err) {
    console.error('storefront order-bundles error:', err.message);
    res.status(500).json({ bundles: [], error: 'Failed to fetch order bundles.' });
  }
});

router.get('/bundles/:storeHash/:productId', async (req, res) => {
  const { storeHash, productId } = req.params;

  const accessToken = await getTokenForStore(storeHash);
  if (!accessToken) {
    // Store not authenticated (e.g. after server restart)
    return res.status(404).json({ bundles: [], error: 'Store not found.' });
  }

  try {
    const bundles = await bundleService.getBundlesForProduct(
      storeHash,
      accessToken,
      Number(productId)
    );
    res.json({ bundles });
  } catch (err) {
    console.error('storefront getBundles error:', err.message);
    res.status(500).json({ bundles: [], error: 'Failed to fetch bundles.' });
  }
});

// Components INSIDE a bundle — for the bundle product's own page to list what
// it contains ("This bundle includes…"). Returns [] if not a bundle.
router.get('/bundle-contents/:storeHash/:productId', async (req, res) => {
  const { storeHash, productId } = req.params;

  const accessToken = await getTokenForStore(storeHash);
  if (!accessToken) {
    return res.status(404).json({ products: [], error: 'Store not found.' });
  }

  try {
    const products = await bundleService.getBundleContents(
      storeHash,
      accessToken,
      Number(productId)
    );
    res.json({ products });
  } catch (err) {
    console.error('storefront getBundleContents error:', err.message);
    res.status(500).json({ products: [], error: 'Failed to fetch bundle contents.' });
  }
});

// Add a bundle to the cart — consumed by bundle-link.js when the shopper clicks
// "Add to Cart" on a bundle product page. Adds the priced bundle product plus a
// ₹0 custom line item per component so the components show as their own cart
// lines. Body: { bundleProductId, quantity, cartId, channelId }.
router.post('/cart/add-bundle/:storeHash', async (req, res) => {
  const { storeHash } = req.params;
  const { bundleProductId, quantity, cartId, channelId } = req.body || {};

  if (!bundleProductId) {
    return res.status(400).json({ error: 'bundleProductId is required.' });
  }

  const accessToken = await getTokenForStore(storeHash);
  if (!accessToken) {
    return res.status(404).json({ error: 'Store not found.' });
  }

  try {
    const result = await bundleService.addBundleToCart(storeHash, accessToken, {
      bundleProductId: Number(bundleProductId),
      quantity: Number(quantity) || 1,
      cartId: cartId || undefined,
      channelId: Number(channelId) || undefined,
    });
    if (!result.isBundle) {
      return res.status(400).json({ error: 'Not a bundle product.' });
    }
    res.json({ cartId: result.cartId, cartUrl: result.cartUrl });
  } catch (err) {
    console.error('storefront add-bundle error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to add bundle to cart.' });
  }
});

module.exports = router;
