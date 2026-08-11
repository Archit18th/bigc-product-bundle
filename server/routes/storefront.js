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
const router = express.Router();
const { getTokenForStore } = require('./auth');
const bundleService = require('../services/bundleService');

router.get('/bundles/:storeHash/:productId', async (req, res) => {
  const { storeHash, productId } = req.params;

  const accessToken = getTokenForStore(storeHash);
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

module.exports = router;
