/**
 * BigCommerce OAuth Routes
 *
 * /auth      — OAuth install callback (exchange code for token)
 * /load      — Load callback (verify signed payload, start session)
 * /uninstall — Uninstall callback
 */

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const router = express.Router();
const tokenStore = require('../services/tokenStore');

/**
 * Verify a BigCommerce signed_payload.
 *
 * Format: base64url(json).hmac_sha256_hex(base64url(json), clientSecret)
 * BC sends the HMAC as a lower-case hex string. We compute our own hex HMAC
 * and compare with timingSafeEqual to prevent timing attacks.
 */
function verifySignedPayload(signedPayload, clientSecret) {
  const parts = (signedPayload || '').split('.');
  if (parts.length !== 2) return null;

  const [encodedData, encodedSignature] = parts;
  if (!encodedData || !encodedSignature) return null;

  const expectedSig = crypto
    .createHmac('sha256', clientSecret)
    .update(encodedData)
    .digest('hex');

  // Decode both as hex buffers for constant-time comparison
  const sigBuffer      = Buffer.from(encodedSignature, 'hex');
  const expectedBuffer = Buffer.from(expectedSig, 'hex');

  // Length mismatch means invalid hex or wrong secret — reject without crashing
  if (sigBuffer.length === 0 || sigBuffer.length !== expectedBuffer.length) {
    return null;
  }

  if (!crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
    return null;
  }

  try {
    // base64url uses - and _ instead of + and /; add padding if missing
    const padded = encodedData.replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(padded, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// ─── GET /auth — OAuth install callback ──────────────────────────────────────

router.get('/auth', async (req, res) => {
  const { code, scope, context } = req.query;
  if (!code || !context) {
    return res.status(400).send('Missing required OAuth parameters.');
  }

  try {
    const tokenRes = await axios.post(
      'https://login.bigcommerce.com/oauth2/token',
      {
        client_id:     process.env.BC_CLIENT_ID,
        client_secret: process.env.BC_CLIENT_SECRET,
        code,
        scope,
        grant_type:    'authorization_code',
        redirect_uri:  process.env.BC_AUTH_CALLBACK,
        context,
      }
    );

    const { access_token, user, context: ctx } = tokenRes.data;
    const storeHash = ctx.replace('stores/', '');

    // Persist token (systemCategoryId populated lazily on first bundle creation)
    tokenStore.setStore(storeHash, {
      accessToken: access_token,
      user,
      systemCategoryId: null,
    });

    // Start session — save explicitly before redirecting (BUG-24)
    req.session.storeHash   = storeHash;
    req.session.user        = user;
    req.session.accessToken = access_token;

    req.session.save((err) => {
      if (err) console.error('[Auth] Session save error:', err);
      res.redirect(`/app?store_hash=${storeHash}`);
    });
  } catch (err) {
    console.error('OAuth error:', err.response?.data || err.message);
    return res.status(500).send('Authentication failed. Check server logs.');
  }
});

// ─── GET /load — Load callback ────────────────────────────────────────────────

router.get('/load', (req, res) => {
  const { signed_payload } = req.query;
  if (!signed_payload) return res.status(400).send('Missing signed_payload.');

  const payload = verifySignedPayload(signed_payload, process.env.BC_CLIENT_SECRET);
  if (!payload) return res.status(401).send('Invalid signed payload.');

  const storeHash = payload.store_hash;
  const stored    = tokenStore.getStore(storeHash);

  if (!stored) {
    // Token not in memory (server restart). Merchant clicks → reinstall prompt.
    return res.redirect(
      `https://login.bigcommerce.com/deep-links/marketplace/apps/${process.env.BC_CLIENT_ID}`
    );
  }

  req.session.storeHash   = storeHash;
  req.session.user        = payload.user;
  req.session.accessToken = stored.accessToken;

  // Save session before redirect to avoid a race where the first API call
  // arrives before the session write completes (BUG-24)
  req.session.save((err) => {
    if (err) console.error('[Load] Session save error:', err);
    res.redirect(`/app?store_hash=${storeHash}`);
  });
});

// ─── GET /uninstall — Uninstall callback ──────────────────────────────────────

router.get('/uninstall', (req, res) => {
  const { signed_payload } = req.query;
  if (!signed_payload) return res.status(400).send('Missing signed_payload.');

  const payload = verifySignedPayload(signed_payload, process.env.BC_CLIENT_SECRET);
  if (!payload) return res.status(401).send('Invalid signed payload.');

  tokenStore.deleteStore(payload.store_hash);
  return res.status(200).json({ message: 'Uninstalled successfully.' });
});

// ─── Middleware ───────────────────────────────────────────────────────────────

/**
 * Express middleware: ensure the request has a valid session.
 * Attaches storeHash and accessToken to req.
 */
function requireSession(req, res, next) {
  if (req.session?.storeHash && req.session?.accessToken) {
    req.storeHash   = req.session.storeHash;
    req.accessToken = req.session.accessToken;
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized. Please reload the app.' });
}

/**
 * Get access token for a store hash (used in webhook handler — no session there).
 */
function getTokenForStore(storeHash) {
  return tokenStore.getAccessToken(storeHash);
}

module.exports = { router, requireSession, getTokenForStore };
