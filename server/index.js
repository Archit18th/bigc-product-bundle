/**
 * BigCommerce Bundles App — Express Server
 *
 * Serves:
 *   - OAuth + load callbacks  (/auth, /load, /uninstall)
 *   - Private API             (/api/*)    — requires session auth
 *   - Public storefront API   (/storefront/*) — CORS-open, no auth
 *   - Webhook receiver        (/webhooks/*)
 *   - React SPA               (/app/*)    — static files from client/dist
 */

require('dotenv').config();

const express = require('express');
const session = require('express-session');
const cors = require('cors');
const path = require('path');

const { router: authRouter } = require('./routes/auth');
const apiRouter = require('./routes/api');
const storefrontRouter = require('./routes/storefront');
const webhooksRouter = require('./routes/webhooks');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Trust proxy (needed for secure cookies behind Nginx/Heroku/Railway) ─────
app.set('trust proxy', 1);

// ─── Webhooks MUST be registered before the global JSON body parser ───────────
// The webhook handler uses express.raw() to capture the raw body for signature
// verification. If express.json() runs first it consumes the body stream and
// express.raw() will never see the raw bytes — signature check silently breaks.
app.use('/webhooks', webhooksRouter);

// ─── Body parsing (for all other routes) ──────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Sessions ─────────────────────────────────────────────────────────────────
// SameSite=None + Secure is required so the cookie is sent inside the
// BigCommerce control panel iframe (cross-site context in production).
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    },
  })
);

// ─── Iframe embedding — allow BC control panel to frame this app ───────────────
// BigCommerce embeds single-click apps in an iframe inside the control panel.
// We must NOT send X-Frame-Options: DENY/SAMEORIGIN, and the CSP frame-ancestors
// directive must permit mybigcommerce.com.
app.use((_req, res, next) => {
  res.removeHeader('X-Frame-Options');
  res.setHeader(
    'Content-Security-Policy',
    "frame-ancestors 'self' https://*.mybigcommerce.com https://login.bigcommerce.com"
  );
  next();
});

// ─── CORS (storefront endpoint only — others locked to BC iframe origin) ──────
// Public storefront API is called from merchants' storefronts (any origin)
app.use(
  '/storefront',
  cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
  })
);

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/', authRouter);
app.use('/api', apiRouter);
app.use('/storefront', storefrontRouter);
// Note: /webhooks already registered above (before body parser)

// ─── React SPA (production) ───────────────────────────────────────────────────
const clientDist = path.join(__dirname, '..', 'client', 'dist');
app.use('/app', express.static(clientDist));
app.get('/app/*', (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

// Root redirect to app
app.get('/', (_req, res) => res.redirect('/app'));

// ─── Error handler ────────────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[Error]', err.stack || err.message);
  res.status(500).json({ error: 'Internal server error.' });
});

app.listen(PORT, () => {
  console.log(`🚀 BigCommerce Bundles App running on port ${PORT}`);
  console.log(`   Auth callback: ${process.env.BC_AUTH_CALLBACK}`);
  console.log(`   Load callback: ${process.env.BC_LOAD_CALLBACK}`);
});
