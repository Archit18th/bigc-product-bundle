/**
 * Script Manager — auto-install the storefront scripts on app install.
 *
 * Instead of the merchant pasting loader snippets into Storefront → Script
 * Manager by hand, the app registers them automatically (via the BigCommerce
 * Scripts API, /v3/content/scripts) during the OAuth install callback.
 *
 * WHY A LOADER, NOT A PLAIN <script src>:
 * Each registered script is a tiny inline loader that fetches the real script
 * from this app WITH the `ngrok-skip-browser-warning` header. A plain `src`
 * URL script can't send that header, so on ngrok's free tier the browser would
 * receive ngrok's HTML interstitial instead of the JS. On a production domain
 * (no interstitial) you can switch these to `kind: 'src'` with a `src` URL.
 *
 * NOTE: requires the app's OAuth token to include the Content (Checkout/Script
 * Manager) scope. Without it the Scripts API returns 403 — install still
 * succeeds, the scripts just aren't registered (logged by the caller).
 */

const { BigCommerceClient } = require('./bigcommerce');

// The storefront scripts this app ships. Each self-gates to the right page.
//
// `visibility` drives which OAuth scope is needed:
//   - 'storefront' → covered by the Content scope (store_v2_content).
//   - 'all_pages' / 'checkout' / 'order_confirmation' → require the *Checkout
//     Content* scope; without it the Scripts API returns 403.
// So link/cart use 'storefront' (work with the Content scope alone). The order
// breakdown must run on the order-confirmation page, which needs Checkout
// Content. Names must be plain — BC rejects punctuation like em-dashes.
const STOREFRONT_SCRIPTS = [
  { name: 'BC Bundles Link', file: 'bundle-link.js', visibility: 'storefront' },
  { name: 'BC Bundles Cart', file: 'bundle-cart.js', visibility: 'storefront' },
  { name: 'BC Bundles Order', file: 'bundle-order.js', visibility: 'order_confirmation' },
];

/** Build the inline loader HTML for one storefront script file. */
function loaderHtml(appUrl, file, storeHash) {
  const src = appUrl.replace(/\/$/, '') + '/storefront/' + file;
  return (
    '<script>\n' +
    '/* BC Bundles loader (' + file + ') — auto-installed by the app. Fetches the\n' +
    '   real script WITH the ngrok-skip-browser-warning header so ngrok\'s free-tier\n' +
    '   interstitial does not return HTML instead of the JS. */\n' +
    '(function () {\n' +
    '  window.BC_BUNDLES_STORE_HASH = ' + JSON.stringify(storeHash) + ';\n' +
    '  var SRC = ' + JSON.stringify(src) + ';\n' +
    '  fetch(SRC, { headers: { \'ngrok-skip-browser-warning\': \'true\' } })\n' +
    '    .then(function (r) { return r.text(); })\n' +
    '    .then(function (code) {\n' +
    '      var s = document.createElement(\'script\');\n' +
    '      s.textContent = code;\n' +
    '      document.body.appendChild(s);\n' +
    '    })\n' +
    '    .catch(function (e) { console.error(\'[BC Bundles] loader failed (' + file + '):\', e); });\n' +
    '})();\n' +
    '</script>'
  );
}

/** The Scripts API payload for one script definition. */
function scriptPayload(appUrl, def, storeHash) {
  return {
    name: def.name,
    description: 'Auto-installed by the BC Bundles app.',
    html: loaderHtml(appUrl, def.file, storeHash),
    // BC removes auto_uninstall scripts automatically when the app is uninstalled.
    auto_uninstall: true,
    load_method: 'default',
    location: 'footer',
    visibility: def.visibility || 'storefront',
    kind: 'script_tag',
    consent_category: 'essential',
  };
}

/**
 * Register (or refresh) all storefront scripts for a store. Idempotent: matches
 * existing scripts by name and PUTs an update, otherwise POSTs a new one — so
 * re-running never creates duplicates.
 *
 * Resilient per-script: a failure on one (e.g. the order script needs the
 * Checkout Content scope and 403s) is captured and does NOT stop the others, so
 * link/cart still install even when order can't.
 *
 * @returns {Array<{name:string, action:'created'|'updated'|'failed', error?:string}>}
 */
async function installStorefrontScripts(storeHash, accessToken, appUrl) {
  if (!appUrl) throw new Error('APP_URL is not set — cannot build script URLs.');
  const client = new BigCommerceClient(storeHash, accessToken);

  // Map existing app scripts by name so we update in place instead of duplicating.
  const existing = await client.v3.get('/content/scripts', { params: { limit: 250 } });
  const uuidByName = new Map((existing.data.data || []).map((s) => [s.name, s.uuid]));

  const results = [];
  for (const def of STOREFRONT_SCRIPTS) {
    const body = scriptPayload(appUrl, def, storeHash);
    const uuid = uuidByName.get(def.name);
    try {
      if (uuid) {
        await client.v3.put('/content/scripts/' + uuid, body);
        results.push({ name: def.name, action: 'updated' });
      } else {
        await client.v3.post('/content/scripts', body);
        results.push({ name: def.name, action: 'created' });
      }
    } catch (err) {
      const status = err.response?.status;
      const msg =
        status === 403
          ? `403 — needs Checkout Content scope for visibility '${body.visibility}'`
          : err.response?.data?.title || err.message;
      results.push({ name: def.name, action: 'failed', error: msg });
    }
  }
  return results;
}

module.exports = { installStorefrontScripts, STOREFRONT_SCRIPTS };
