# BigCommerce Bundle Manager

A single-click BigCommerce app that lets merchants create and manage product bundles. Bundles are real BC products with automatic availability sync driven by component inventory.

## Features

- **Create bundles** from any combination of existing products with individual quantity settings
- **Auto-disable** bundles when any component product goes out of stock (via webhook)
- **Bundle quantity** = minimum stock across all components
- **Category assignment** — choose which storefront categories the bundle appears in
- **Storefront script** — lightweight JS for Script Manager that shows a "View bundles" link on component product pages, opening a modal or redirecting to a bundle list

---

## Architecture

```
bigcommerce-bundles/
├── server/                  Node.js + Express backend
│   ├── index.js             Entry point
│   ├── routes/
│   │   ├── auth.js          OAuth callbacks (/auth, /load, /uninstall)
│   │   ├── api.js           Private API (session-guarded)
│   │   ├── storefront.js    Public storefront API (CORS-open)
│   │   └── webhooks.js      Inventory webhook receiver
│   └── services/
│       ├── bigcommerce.js   BC API v2/v3 wrapper
│       └── bundleService.js Bundle business logic
├── client/                  React + BigDesign frontend
│   ├── src/
│   │   ├── App.jsx
│   │   ├── api.js           Frontend fetch helpers
│   │   ├── pages/
│   │   │   ├── BundleList.jsx
│   │   │   ├── CreateBundle.jsx
│   │   │   └── EditBundle.jsx
│   │   └── components/
│   │       ├── BundleForm.jsx
│   │       ├── ProductPicker.jsx   (debounced search)
│   │       └── CategoryPicker.jsx  (tree select)
└── storefront/
    └── bundle-link.js       Script Manager script (vanilla JS, no deps)
```

### How bundles are stored

Each bundle is a **real BigCommerce product** with:
- `inventory_tracking: "product"` — so BC manages stock natively
- `availability: "available"` or `"disabled"` — auto-toggled by webhook
- `inventory_level` — set to the number of complete bundles buildable from current component stock (min of `floor(component_stock / qty)`)
- Membership in a hidden **"Bundle Manager (System)"** category — the reliable, BC-native way to list all bundle products in the admin UI (the v3 API can't filter products by custom-field value). This category is `is_visible: false` and never appears on the storefront.
- Custom field `bundle_type = bc-bundle` and metafield `bc_bundles / is_bundle` — supplementary bundle markers
- Metafield `bc_bundles / bundle_components` — JSON config with component product IDs and quantities (storefront-readable)

Each **component product** gets a metafield:
- `bc_bundles / bundle_memberships` — JSON array of bundle product IDs this product belongs to (storefront-readable, used by the storefront script)

---

## Setup

### 1. Register the BigCommerce App

1. Log in to [developer.bigcommerce.com](https://developer.bigcommerce.com/)
2. Go to **My Apps → Create an App**
3. Set the following callback URLs (replace `https://your-app.com` with your actual domain):

   | Field | Value |
   |-------|-------|
   | Auth Callback URL | `https://your-app.com/auth` |
   | Load Callback URL | `https://your-app.com/load` |
   | Uninstall Callback URL | `https://your-app.com/uninstall` |

4. Under **OAuth Scopes**, enable:
   - Products: **Modify**
   - Store Content: **Modify** (for webhook registration)
   - Information & Settings: **Read-Only**

5. Note down your **Client ID** and **Client Secret**

### 2. Configure the backend

```bash
cd server
cp .env.example .env
```

Edit `.env`:
```
BC_CLIENT_ID=your_client_id
BC_CLIENT_SECRET=your_client_secret
BC_AUTH_CALLBACK=https://your-app.com/auth
BC_LOAD_CALLBACK=https://your-app.com/load
BC_UNINSTALL_CALLBACK=https://your-app.com/uninstall
APP_URL=https://your-app.com
SESSION_SECRET=a_long_random_string_here
WEBHOOK_SECRET=another_long_random_string_here
PORT=3000
NODE_ENV=production
```

> `WEBHOOK_SECRET` is sent as a custom header on every registered webhook and
> verified by the receiver. BigCommerce does **not** HMAC-sign webhook payloads —
> this shared-secret header is the supported way to authenticate callbacks. If
> it is unset, webhooks are still processed but cannot be authenticated (a
> warning is logged). Always set it in production.

### 3. Install dependencies

```bash
# Backend
cd server
npm install

# Frontend
cd ../client
npm install
```

### 4. Build the frontend

```bash
cd client
npm run build
# Output goes to client/dist/ — served by the Express server at /app
```

### 5. Start the server

```bash
cd server
npm start
```

For development (hot reload backend + Vite dev server):
```bash
# Terminal 1 — backend
cd server && npm run dev

# Terminal 2 — frontend (proxies /api to localhost:3000)
cd client && npm run dev
# Then visit: http://localhost:5173/app
```

### 6. Deploy

The app needs a **publicly accessible HTTPS URL** for BigCommerce OAuth callbacks and webhooks.

Recommended platforms:
- **Railway** — `railway up` from project root
- **Render** — connect GitHub repo, set env vars in dashboard
- **Heroku** — `git push heroku main`
- **VPS** — behind Nginx with Let's Encrypt SSL

> The `SESSION_SECRET` must be consistent across restarts. On platforms that kill the process on redeploy, merchants may need to reload the app once after a deployment.

> **Token storage:** OAuth tokens are persisted in a local **SQLite** database (`server/services/tokenStore.js`, default `data/bundles.db`) that survives process restarts and redeploys, so webhook syncs keep working without a manual app reload. The session itself still uses an in-memory `express-session` store, so an active admin UI session is lost on restart and the merchant re-authenticates on next load — but background webhook syncs are unaffected. SQLite is single-writer; for multiple app instances or zero-downtime rolling deploys, swap `tokenStore.js` for a Redis/Postgres implementation (the exported interface is identical, so no other file changes). Set `DB_PATH` to a mounted persistent volume on platforms with ephemeral disks (e.g. Railway).

---

## Installing the app in a store

1. In the BigCommerce Dev Portal, click **Install** on your app (or share the install link with a merchant)
2. The merchant approves the OAuth permissions
3. The app UI loads inside the BigCommerce Control Panel

---

## Adding the storefront script

The storefront script runs on product pages and shows a "Available in N bundles" link for products that are part of bundles.

### Steps

1. Open `storefront/bundle-link.js`
2. Edit the two config values at the top of the file:
   ```js
   APP_URL: 'https://your-bundles-app.com',  // your deployed app URL
   STORE_HASH: 'abc123xyz',                  // find this in BC Settings → API
   ```
3. Choose display mode (optional, default is `modal`):
   ```js
   DISPLAY_MODE: 'modal',    // shows a slide-up panel
   // or
   DISPLAY_MODE: 'redirect', // navigates to REDIRECT_URL + ?bundle_product=<id>
   ```
4. In BigCommerce Control Panel, go to **Storefront → Script Manager → Create a Script**:
   - **Name:** Bundle Link
   - **Location on page:** Footer
   - **Select pages where script will be added:** Pages with Products
   - **Script category:** Functional
   - **Script type:** Script
   - Paste the full contents of `bundle-link.js` into the script body
5. Click **Save**

### Redirect mode setup (optional)

If you prefer `DISPLAY_MODE: 'redirect'`, create a category in BigCommerce called "Bundles" (or any name) and set `REDIRECT_URL` to that category's URL. You can also point it to a search results URL.

When a customer clicks the link, they'll be sent to:
```
https://yourstore.com/bundles/?bundle_product=12345
```

You can use your theme's JavaScript to read the `bundle_product` query parameter and filter the product listing — the value is the component product's ID.

---

## Webhook

The app automatically registers two webhooks on first bundle creation:
- `store/product/inventory/updated` — fires when a product's stock level changes
- `store/product/updated` — fires when any product field changes, including availability (so manually disabling a component also disables its bundles)

Both point at the same endpoint and re-sync every bundle containing the changed product (recalculating availability and inventory level).

Webhook endpoint: `POST https://your-app.com/webhooks/inventory`

Each webhook is registered with an `X-Bundle-Secret` custom header (value = `WEBHOOK_SECRET`). BigCommerce echoes this header back on every delivery, and the receiver verifies it in constant time — this is how callbacks are authenticated, since **BigCommerce does not HMAC-sign webhook bodies**.

No manual registration needed — it's idempotent and handled on the first `POST /api/bundles` call.

---

## API Reference

All routes under `/api/*` require a valid session (set during OAuth load). The storefront endpoint is public (CORS open).

### Private API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/bundles` | List all bundles |
| `POST` | `/api/bundles` | Create a bundle |
| `GET` | `/api/bundles/:id` | Get a single bundle |
| `PUT` | `/api/bundles/:id` | Update a bundle |
| `DELETE` | `/api/bundles/:id` | Delete a bundle |
| `GET` | `/api/products/search?q=` | Search products (for picker) |
| `GET` | `/api/categories` | List categories |

### Public Storefront API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/storefront/bundles/:storeHash/:productId` | Get available bundles for a product |

---

## Customising the storefront script

The `bundle-link.js` script is self-contained vanilla JS with no external dependencies. All styles are injected inline.

To change the link appearance, edit the `STYLES` string in the script. All CSS classes are namespaced with `.bcb-` to avoid theme conflicts.

To change the link position, modify the `priceSelectors` and `cartSelectors` arrays to match your theme's CSS selectors.

---

## Production checklist

- [ ] `SESSION_SECRET` is set to a long, random string
- [ ] `WEBHOOK_SECRET` is set to a long, random string (webhooks can't be authenticated without it)
- [ ] App is running behind HTTPS
- [ ] SQLite `DB_PATH` points at a persistent volume (or token store swapped for Redis/DB) for multi-instance or zero-downtime deploys
- [ ] App URL and callback URLs match exactly in both `.env` and the BC Dev Portal
- [ ] OAuth scopes include Products (Modify) and Store Content (Modify)
- [ ] Storefront script configured with correct `APP_URL` and `STORE_HASH`
- [ ] Webhook fires are tested by reducing a component product's stock to 0
