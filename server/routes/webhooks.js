/**
 * Webhook Routes
 *
 * BigCommerce sends a POST to /webhooks/inventory whenever a product's
 * inventory or other fields change. We authenticate the request and trigger a
 * bundle re-sync.
 *
 * IMPORTANT: BigCommerce does NOT HMAC-sign webhook bodies — there is no
 * X-Webhook-Signature header. Authentication is done with custom headers set
 * at webhook-creation time (see routes/api.js → registerBundleWebhooks), which
 * BC echoes back on every delivery. We send an `X-Bundle-Secret` header and
 * verify it here in constant time.
 *
 * Docs: https://developer.bigcommerce.com/docs/integrations/webhooks
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { getTokenForStore } = require('./auth');
const {
  syncBundleFromInventory,
  annotateOrderWithBundleContents,
  deductOrderBundleInventory,
  addBundleComponentsToOrder,
  handleOrderStatusForInventory,
} = require('../services/bundleService');
const productIndex = require('../services/productIndex');

const WEBHOOK_SECRET_HEADER = 'x-bundle-secret'; // Express lower-cases header keys

let warnedNoSecret = false;

/**
 * Authenticate a BigCommerce webhook delivery using the shared secret header
 * that we attached when registering the webhook.
 *
 * Returns true only when the provided header matches WEBHOOK_SECRET in
 * constant time. If WEBHOOK_SECRET is not configured we cannot authenticate —
 * we accept the request (so the feature still works) but warn loudly once.
 */
function verifyWebhookSecret(providedSecret) {
  const expectedSecret = process.env.WEBHOOK_SECRET;

  if (!expectedSecret) {
    if (!warnedNoSecret) {
      console.warn(
        '[Webhook] WEBHOOK_SECRET is not set — webhook requests cannot be ' +
        'authenticated. Set WEBHOOK_SECRET (and re-create the webhooks) for production.'
      );
      warnedNoSecret = true;
    }
    return true; // can't verify without a configured secret
  }

  if (!providedSecret) return false; // secret configured but none supplied

  const provBuf = Buffer.from(String(providedSecret), 'utf8');
  const expBuf = Buffer.from(expectedSecret, 'utf8');
  if (provBuf.length !== expBuf.length) return false;
  return crypto.timingSafeEqual(provBuf, expBuf);
}

// Capture the raw body, then parse it as JSON for the handler.
router.use(
  express.raw({ type: 'application/json' }),
  (req, _res, next) => {
    if (Buffer.isBuffer(req.body)) {
      req.rawBody = req.body;
      try {
        req.body = JSON.parse(req.body.toString());
      } catch {
        req.body = {};
      }
    }
    next();
  }
);

// ─── POST /webhooks/inventory ─────────────────────────────────────────────────

router.post('/inventory', async (req, res) => {
  // Acknowledge quickly (BC expects 200 within 10s)
  res.status(200).json({ received: true });

  // Authenticate via the shared secret header BC echoes back.
  if (!verifyWebhookSecret(req.headers[WEBHOOK_SECRET_HEADER])) {
    console.warn('[Webhook] Invalid or missing secret header, ignoring.');
    return;
  }

  // Guard: rawBody must exist (content-type mismatch would leave it undefined)
  if (!req.rawBody) {
    console.warn('[Webhook] No raw body captured — unexpected content-type?');
    return;
  }

  // ── Parse BC webhook payload ──────────────────────────────────────────
  // BC actual payload shape:
  //   { producer: "stores/abc123", store_id: "1025646" (numeric, NOT the hash),
  //     scope: "store/product/inventory/updated",
  //     data: { type: "product", id: 174 } }
  //
  // The store HASH is in `producer`, not `store_id`.
  // The product ID is data.id, not data.product_id.
  const { producer, data } = req.body;
  if (!producer || !data) {
    console.warn('[Webhook] Missing producer or data', req.body);
    return;
  }

  // "stores/abc123" → "abc123"
  const storeHash = (producer || '').replace(/^stores\//, '');
  // Works for both product-level and variant-level inventory updates
  const productId = data.id;

  if (!storeHash || !productId) {
    console.warn('[Webhook] Could not parse storeHash or productId', { producer, data });
    return;
  }

  const accessToken = await getTokenForStore(storeHash);
  if (!accessToken) {
    console.warn(`[Webhook] No token for store ${storeHash}. Skipping.`);
    return;
  }

  // Keep the local product index fresh so DB-first reads reflect this change
  // between full re-indexes. Non-fatal if it fails (e.g. product was deleted).
  try {
    await productIndex.refreshOne(storeHash, accessToken, productId);
  } catch (err) {
    console.warn(`[Webhook] index refresh for product ${productId} failed:`, err.message);
  }

  try {
    const results = await syncBundleFromInventory(storeHash, accessToken, productId);
    if (results.length > 0) {
      console.log(
        `[Webhook] Synced ${results.length} bundle(s) for product ${productId}:`,
        results.map((r) =>
          `bundle ${r.bundleId} → ${r.available ? 'available' : 'disabled'}`
        ).join(', ')
      );
    }
  } catch (err) {
    console.error('[Webhook] syncBundleFromInventory error:', err.message);
  }
});

// ─── POST /webhooks/order ─────────────────────────────────────────────────────
// Fires on store/order/created. For each bundle in the order we (1) write the
// component breakdown into staff_notes (admin order page) and (2) deduct each
// component's inventory and re-sync the bundle's buildable count.

router.post('/order', async (req, res) => {
  // Acknowledge quickly (BC expects 200 within 10s)
  res.status(200).json({ received: true });

  // Authenticate via the shared secret header BC echoes back.
  if (!verifyWebhookSecret(req.headers[WEBHOOK_SECRET_HEADER])) {
    console.warn('[Webhook] Invalid or missing secret header, ignoring.');
    return;
  }

  if (!req.rawBody) {
    console.warn('[Webhook] No raw body captured — unexpected content-type?');
    return;
  }

  // Payload: { producer: "stores/abc123", scope: "store/order/created",
  //            data: { type: "order", id: 308 } }
  const { producer, data } = req.body;
  if (!producer || !data) {
    console.warn('[Webhook] Missing producer or data', req.body);
    return;
  }

  const storeHash = (producer || '').replace(/^stores\//, '');
  const orderId = data.id;

  if (!storeHash || !orderId) {
    console.warn('[Webhook] Could not parse storeHash or orderId', { producer, data });
    return;
  }

  const accessToken = await getTokenForStore(storeHash);
  if (!accessToken) {
    console.warn(`[Webhook] No token for store ${storeHash}. Skipping.`);
    return;
  }

  // 1. Annotate staff_notes (admin display).
  try {
    const result = await annotateOrderWithBundleContents(storeHash, accessToken, orderId);
    if (result.updated) {
      console.log(`[Webhook] Annotated order ${orderId} with ${result.bundles} bundle(s).`);
    }
  } catch (err) {
    console.error('[Webhook] annotateOrderWithBundleContents error:', err.message);
  }

  // 2. Deduct component inventory + re-sync bundle counts.
  try {
    const inv = await deductOrderBundleInventory(storeHash, accessToken, orderId);
    if (!inv.skipped) {
      console.log(
        `[Webhook] Order ${orderId}: deducted inventory for ${inv.adjusted} ` +
        `component(s) across ${inv.bundles} bundle(s).`
      );
    }
  } catch (err) {
    console.error('[Webhook] deductOrderBundleInventory error:', err.message);
  }

  // 3. Expand bundles into $0 component line items — ONLY for bundles the
  //    merchant flagged via the bundle list "Modify" action. Bundles without
  //    the flag are skipped inside addBundleComponentsToOrder (no order-modify
  //    API call happens for them). Idempotent via an order metafield.
  try {
    const comp = await addBundleComponentsToOrder(storeHash, accessToken, orderId);
    if (!comp.skipped) {
      console.log(
        `[Webhook] Order ${orderId}: added ${comp.added} component line item(s) ` +
        `at $0 across ${comp.bundles} flagged bundle(s).`
      );
    }
  } catch (err) {
    console.error('[Webhook] addBundleComponentsToOrder error:', err.message);
  }
});

// ─── POST /webhooks/order-status ──────────────────────────────────────────────
// Fires on store/order/statusUpdated. If the order moved into a reversed status
// (refunded/cancelled/declined), restore the component inventory we deducted.

router.post('/order-status', async (req, res) => {
  res.status(200).json({ received: true });

  if (!verifyWebhookSecret(req.headers[WEBHOOK_SECRET_HEADER])) {
    console.warn('[Webhook] Invalid or missing secret header, ignoring.');
    return;
  }
  if (!req.rawBody) {
    console.warn('[Webhook] No raw body captured — unexpected content-type?');
    return;
  }

  const { producer, data } = req.body;
  if (!producer || !data) {
    console.warn('[Webhook] Missing producer or data', req.body);
    return;
  }

  const storeHash = (producer || '').replace(/^stores\//, '');
  const orderId = data.id;
  if (!storeHash || !orderId) {
    console.warn('[Webhook] Could not parse storeHash or orderId', { producer, data });
    return;
  }

  const accessToken = await getTokenForStore(storeHash);
  if (!accessToken) {
    console.warn(`[Webhook] No token for store ${storeHash}. Skipping.`);
    return;
  }

  try {
    const result = await handleOrderStatusForInventory(storeHash, accessToken, orderId);
    if (!result.skipped) {
      console.log(`[Webhook] Order ${orderId}: restored inventory for ${result.restored} component(s).`);
    }
  } catch (err) {
    console.error('[Webhook] handleOrderStatusForInventory error:', err.message);
  }
});

module.exports = router;
