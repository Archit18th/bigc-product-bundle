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
const userStore = require('../services/userStore');
const scriptManager = require('../services/scriptManager');

/** base64url-decode to a Buffer (handles missing padding). */
function b64urlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64');
}

/**
 * Verify a BigCommerce `signed_payload_jwt` and return its claims.
 *
 * BigCommerce signs load/uninstall callbacks as an HS256 JWT using the app's
 * client secret. (The older `signed_payload` HMAC param is deprecated and not
 * verified here.) We verify the signature in constant time, then check the
 * standard temporal claims and that the audience equals our client ID.
 *
 * Returns the decoded payload on success, or null on any failure.
 */
function verifySignedPayloadJWT(token, clientSecret, clientId) {
  const parts = (token || '').split('.');
  if (parts.length !== 3) return null;

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  if (!encodedHeader || !encodedPayload || !encodedSignature) return null;

  // Recompute the HS256 signature over `header.payload` (base64url, no padding).
  const expectedSig = crypto
    .createHmac('sha256', clientSecret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest();

  const sigBuffer = b64urlDecode(encodedSignature);

  // Constant-time compare; bail on length mismatch (wrong secret / tampering).
  if (sigBuffer.length !== expectedSig.length) return null;
  if (!crypto.timingSafeEqual(sigBuffer, expectedSig)) return null;

  let payload;
  try {
    payload = JSON.parse(b64urlDecode(encodedPayload).toString('utf8'));
  } catch {
    return null;
  }

  // Temporal validity (seconds since epoch). Allow 60s of clock skew.
  const now  = Math.floor(Date.now() / 1000);
  const skew = 60;
  if (typeof payload.exp === 'number' && now > payload.exp + skew) return null;
  if (typeof payload.nbf === 'number' && now + skew < payload.nbf) return null;

  // Audience must be this app's client ID.
  if (clientId && payload.aud !== clientId) return null;

  return payload;
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

    const { access_token, user, owner, context: ctx } = tokenRes.data;
    const storeHash = ctx.replace('stores/', '');

    // We only track the STORE OWNER in the users table, not every app user.
    // BigCommerce sends `owner` (store owner) separately from `user` (whoever
    // is acting). Fall back to `user` if owner is missing.
    const ownerInfo = owner || user;

    // Persist token (systemCategoryId populated lazily on first bundle creation)
    await tokenStore.setStore(storeHash, {
      accessToken: access_token,
      user: ownerInfo,
      systemCategoryId: null,
    });

    // Record ONLY the store owner (id, email, token) in the users table,
    // and mark them logged in (user_status = true).
    await userStore.upsertUser(storeHash, ownerInfo, access_token);
    await userStore.setUserStatus(storeHash, ownerInfo?.id ?? null, true);

    // Auto-install the storefront scripts so the merchant never has to paste
    // them into Script Manager by hand. Best-effort: a failure here (e.g. the
    // token lacks the Content scope) must NOT block a successful install.
    try {
      const results = await scriptManager.installStorefrontScripts(
        storeHash,
        access_token,
        process.env.APP_URL
      );
      console.log('[Auth] storefront scripts installed:', results);
    } catch (scriptErr) {
      console.error(
        '[Auth] storefront script install failed (install still OK):',
        scriptErr.response?.data || scriptErr.message
      );
    }

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

router.get('/load', async (req, res) => {
  const { signed_payload_jwt } = req.query;
  if (!signed_payload_jwt) return res.status(400).send('Missing signed_payload_jwt.');

  const payload = verifySignedPayloadJWT(
    signed_payload_jwt,
    process.env.BC_CLIENT_SECRET,
    process.env.BC_CLIENT_ID
  );
  if (!payload) return res.status(401).send('Invalid signed payload.');

  // In the JWT, the store context lives in `sub` as "stores/<hash>".
  const storeHash = (payload.sub || '').replace('stores/', '');
  const stored    = await tokenStore.getStore(storeHash);

  if (!stored) {
    // Token not in memory (server restart). Merchant clicks → reinstall prompt.
    return res.redirect(
      `https://login.bigcommerce.com/deep-links/marketplace/apps/${process.env.BC_CLIENT_ID}`
    );
  }

  req.session.storeHash   = storeHash;
  req.session.user        = payload.user;
  req.session.accessToken = stored.accessToken;

  // Record/refresh ONLY the store owner in the users table, and mark them
  // logged in (user_status = true). `owner` is the store owner; `user` is
  // whoever opened the app — we intentionally ignore non-owner users here.
  const ownerInfo = payload.owner || payload.user;
  await userStore.upsertUser(storeHash, ownerInfo, stored.accessToken);
  await userStore.setUserStatus(storeHash, ownerInfo?.id ?? null, true);

  // Save session before redirect to avoid a race where the first API call
  // arrives before the session write completes (BUG-24)
  req.session.save((err) => {
    if (err) console.error('[Load] Session save error:', err);
    res.redirect(`/app?store_hash=${storeHash}`);
  });
});

// ─── GET /uninstall — Uninstall callback ──────────────────────────────────────

router.get('/uninstall', async (req, res) => {
  const { signed_payload_jwt } = req.query;
  if (!signed_payload_jwt) return res.status(400).send('Missing signed_payload_jwt.');

  const payload = verifySignedPayloadJWT(
    signed_payload_jwt,
    process.env.BC_CLIENT_SECRET,
    process.env.BC_CLIENT_ID
  );
  if (!payload) return res.status(401).send('Invalid signed payload.');

  const storeHash = (payload.sub || '').replace('stores/', '');
  await tokenStore.deleteStore(storeHash);
  await userStore.deleteUsersForStore(storeHash);
  return res.status(200).json({ message: 'Uninstalled successfully.' });
});

// ─── POST /logout — end the session ───────────────────────────────────────────
// Embedded BC apps have no built-in logout event, so this is an explicit one:
// mark the user logged out (user_status = false) and destroy the session.
router.post('/logout', async (req, res) => {
  const storeHash = req.session?.storeHash;
  const bcUserId = req.session?.user?.id ?? null;
  try {
    if (storeHash) await userStore.setUserStatus(storeHash, bcUserId, false);
  } catch (err) {
    console.error('[Logout] setUserStatus error:', err.message);
  }
  req.session.destroy(() => res.status(200).json({ message: 'Logged out.' }));
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
async function getTokenForStore(storeHash) {
  return tokenStore.getAccessToken(storeHash);
}

module.exports = { router, requireSession, getTokenForStore };
