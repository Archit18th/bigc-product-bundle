/**
 * BC Bundle Link — Storefront Script
 * =====================================================================
 * Add this script via BigCommerce Control Panel → Storefront → Script Manager.
 *
 * CONFIGURATION (edit the two lines in the CONFIG block below):
 *   APP_URL    — the URL where your Bundles App backend is hosted
 *                e.g. 'https://bundles.myapp.com'
 *   STORE_HASH — your BigCommerce store hash
 *                e.g. 'abc123xyz'
 *
 * PLACEMENT:   Pages with Products (recommended)
 * LOCATION:    Footer
 * =====================================================================
 *
 * WHAT IT DOES:
 * On any product page, this script checks whether the current product
 * belongs to one or more bundles. If it does, it injects a "View bundles
 * containing this product" link near the product price.
 *
 * Clicking the link can either:
 *   A) Open a modal overlay listing all available bundles (DISPLAY_MODE = 'modal')
 *   B) Redirect to a filtered category page            (DISPLAY_MODE = 'redirect')
 *
 * Set DISPLAY_MODE below to choose your preferred behaviour.
 */

(function () {
  'use strict';

  /* ================================================================
   * ✏️  CONFIGURATION — edit these values before uploading
   * ================================================================ */
  var CONFIG = {
    APP_URL: 'https://demolocations-bc-bundle-prod.com',   // ← your app's base URL
    STORE_HASH: window.BC_BUNDLES_STORE_HASH,                   // ← your BC store hash

     
    DISPLAY_MODE: 'modal',

    // Only used when DISPLAY_MODE = 'redirect'
    // Format: '/bundles/' or a search results URL pattern
    // The product ID is appended as a query param: ?bundle_product=<id>
    REDIRECT_URL: '/bundles/',

    // Text shown on the link
    LINK_TEXT: 'Available in {count} bundle{plural}',

    // CSS class prefix (avoids conflicts with theme styles)
    PREFIX: 'bcb',
  };
  /* ================================================================ */

  // ── Guards ─────────────────────────────────────────────────────────

  // BUG-18: warn loudly if the merchant hasn't edited the CONFIG block
  if (
    CONFIG.STORE_HASH === 'YOUR_STORE_HASH' ||
    CONFIG.APP_URL === 'https://your-bundles-app.com' ||
    CONFIG.APP_URL.includes('your-bundles-app')
  ) {
    console.warn(
      '[BC Bundles] bundle-link.js is not configured. ' +
      'Edit APP_URL and STORE_HASH at the top of the script before uploading to Script Manager.'
    );
    return;
  }

  // Resolve the current product's ID. Themes vary: the Stencil default exposes
  // window.BCData.product_id, but some themes (e.g. this store's) populate
  // BCData WITHOUT product_id and instead carry it only in the add-to-cart
  // form's hidden input or a data-entity-id attribute. Try each in turn so the
  // script works regardless of theme.
  // Only run on a real product DETAIL page. Category/search/brand pages render
  // product CARDS that also carry data-entity-id, so without this gate the
  // script would resolve a card's ID and inject on listing pages too.
  if (!isProductPage()) return;

  var productId = getProductId();
  if (!productId) return; // not a resolvable product page — nothing to do

  // ── Inject styles ──────────────────────────────────────────────────

  var STYLES = '\n\
  .bcb-trigger {\n\
    display: inline-flex;\n\
    align-items: center;\n\
    gap: 6px;\n\
    margin: 10px 0;\n\
    padding: 6px 12px;\n\
    background: #f0f5ff;\n\
    border: 1px solid #4b6bfb;\n\
    border-radius: 20px;\n\
    color: #4b6bfb;\n\
    font-size: 13px;\n\
    font-weight: 600;\n\
    cursor: pointer;\n\
    text-decoration: none;\n\
    transition: background 0.15s, transform 0.1s;\n\
    font-family: inherit;\n\
  }\n\
  .bcb-trigger:hover {\n\
    background: #e0ecff;\n\
    transform: translateY(-1px);\n\
  }\n\
  .bcb-trigger svg { flex-shrink: 0; }\n\
\n\
  /* ── "This bundle includes" list (on the bundle product page) ── */\n\
  /* Neutral Cornerstone-style card: bordered box with a light header bar. */\n\
  .bcb-contents {\n\
    margin: 16px 0;\n\
    padding: 0;\n\
    background: #fff;\n\
    border: 1px solid #e0e0e0;\n\
    border-radius: 4px;\n\
    overflow: hidden;\n\
    font-family: inherit;\n\
  }\n\
  .bcb-contents-title {\n\
    margin: 0;\n\
    padding: 12px 16px;\n\
    font-size: 13px;\n\
    font-weight: 600;\n\
    color: #333;\n\
    text-transform: uppercase;\n\
    letter-spacing: 0.5px;\n\
    background: #fafafa;\n\
    border-bottom: 1px solid #e0e0e0;\n\
  }\n\
  .bcb-contents-list { margin: 0; padding: 0 16px; list-style: none; }\n\
  .bcb-contents-item {\n\
    display: flex;\n\
    align-items: baseline;\n\
    gap: 8px;\n\
    padding: 10px 0;\n\
    font-size: 14px;\n\
    color: #333;\n\
    border-bottom: 1px solid #f0f0f0;\n\
  }\n\
  .bcb-contents-item:last-child { border-bottom: none; }\n\
  .bcb-contents-qty { font-weight: 600; color: #888; flex-shrink: 0; min-width: 22px; }\n\
  .bcb-contents-name { font-weight: 400; }\n\
\n\
  /* ── Modal overlay ── */\n\
  .bcb-overlay {\n\
    position: fixed;\n\
    inset: 0;\n\
    background: rgba(0,0,0,0.45);\n\
    z-index: 99998;\n\
    display: flex;\n\
    align-items: flex-end;\n\
    justify-content: center;\n\
    animation: bcbFadeIn 0.2s ease;\n\
  }\n\
  @media (min-width: 640px) {\n\
    .bcb-overlay { align-items: center; }\n\
  }\n\
  @keyframes bcbFadeIn { from { opacity: 0; } to { opacity: 1; } }\n\
\n\
  .bcb-panel {\n\
    background: #fff;\n\
    border-radius: 16px 16px 0 0;\n\
    padding: 0;\n\
    width: 100%;\n\
    max-width: 520px;\n\
    max-height: 80vh;\n\
    overflow-y: auto;\n\
    box-shadow: 0 -4px 40px rgba(0,0,0,0.15);\n\
    animation: bcbSlideUp 0.25s ease;\n\
  }\n\
  @media (min-width: 640px) {\n\
    .bcb-panel {\n\
      border-radius: 16px;\n\
      max-height: 85vh;\n\
    }\n\
  }\n\
  @keyframes bcbSlideUp {\n\
    from { transform: translateY(30px); opacity: 0; }\n\
    to   { transform: translateY(0);    opacity: 1; }\n\
  }\n\
\n\
  .bcb-panel-header {\n\
    display: flex;\n\
    align-items: center;\n\
    justify-content: space-between;\n\
    padding: 18px 20px 14px;\n\
    border-bottom: 1px solid #f0f0f0;\n\
    position: sticky;\n\
    top: 0;\n\
    background: #fff;\n\
    z-index: 1;\n\
    border-radius: 16px 16px 0 0;\n\
  }\n\
  .bcb-panel-title {\n\
    font-size: 16px;\n\
    font-weight: 700;\n\
    color: #1a1a1a;\n\
    margin: 0;\n\
    font-family: inherit;\n\
  }\n\
  .bcb-panel-close {\n\
    width: 32px;\n\
    height: 32px;\n\
    border-radius: 50%;\n\
    border: none;\n\
    background: #f4f5f6;\n\
    cursor: pointer;\n\
    display: flex;\n\
    align-items: center;\n\
    justify-content: center;\n\
    font-size: 16px;\n\
    color: #666;\n\
    flex-shrink: 0;\n\
  }\n\
  .bcb-panel-close:hover { background: #e8e9eb; }\n\
\n\
  .bcb-bundle-list { padding: 12px 20px 20px; }\n\
\n\
  .bcb-bundle-card {\n\
    display: flex;\n\
    align-items: center;\n\
    gap: 14px;\n\
    padding: 14px;\n\
    border: 1px solid #e8e9eb;\n\
    border-radius: 10px;\n\
    margin-bottom: 10px;\n\
    text-decoration: none;\n\
    color: inherit;\n\
    transition: box-shadow 0.15s, border-color 0.15s;\n\
    cursor: pointer;\n\
  }\n\
  .bcb-bundle-card:hover {\n\
    border-color: #4b6bfb;\n\
    box-shadow: 0 2px 12px rgba(75,107,251,0.12);\n\
  }\n\
  .bcb-bundle-thumb {\n\
    width: 56px;\n\
    height: 56px;\n\
    object-fit: cover;\n\
    border-radius: 8px;\n\
    background: #f0f0f0;\n\
    flex-shrink: 0;\n\
  }\n\
  .bcb-bundle-thumb-placeholder {\n\
    width: 56px;\n\
    height: 56px;\n\
    border-radius: 8px;\n\
    background: #e8e9eb;\n\
    display: flex;\n\
    align-items: center;\n\
    justify-content: center;\n\
    font-size: 22px;\n\
    flex-shrink: 0;\n\
  }\n\
  .bcb-bundle-info { flex: 1; min-width: 0; }\n\
  .bcb-bundle-name {\n\
    font-size: 14px;\n\
    font-weight: 600;\n\
    color: #1a1a1a;\n\
    margin: 0 0 4px;\n\
    white-space: nowrap;\n\
    overflow: hidden;\n\
    text-overflow: ellipsis;\n\
    font-family: inherit;\n\
  }\n\
  .bcb-bundle-price {\n\
    font-size: 15px;\n\
    font-weight: 700;\n\
    color: #2b6bfb;\n\
    font-family: inherit;\n\
  }\n\
  .bcb-bundle-arrow {\n\
    color: #aaa;\n\
    font-size: 18px;\n\
    flex-shrink: 0;\n\
  }\n\
  .bcb-empty {\n\
    text-align: center;\n\
    padding: 30px 20px;\n\
    color: #888;\n\
    font-size: 14px;\n\
    font-family: inherit;\n\
  }\n\
  .bcb-spinner {\n\
    text-align: center;\n\
    padding: 30px;\n\
    color: #888;\n\
    font-family: inherit;\n\
  }\n\
  ';

  injectStyles(STYLES);

  // ── Fetch bundles from app API ─────────────────────────────────────

  var apiUrl =
    CONFIG.APP_URL.replace(/\/$/, '') +
    '/storefront/bundles/' +
    CONFIG.STORE_HASH +
    '/' +
    productId;

  fetchJSON(apiUrl, function (err, data) {
    if (err || !data || !data.bundles || data.bundles.length === 0) return;

    var bundles = data.bundles;
    injectTrigger(bundles);
  });

  // ── Fetch this bundle's OWN contents (if it is a bundle product) ────
  // Lists the component products on the bundle product's own page.
  var contentsUrl =
    CONFIG.APP_URL.replace(/\/$/, '') +
    '/storefront/bundle-contents/' +
    CONFIG.STORE_HASH +
    '/' +
    productId;

  fetchJSON(contentsUrl, function (err, data) {
    if (err || !data || !data.products || data.products.length === 0) return;
    injectContents(data.products);
    // This product IS a bundle — take over its Add to Cart so the components
    // are added as their own ₹0 cart lines (via the app's server-side cart),
    // instead of the native add which would only add the single bundle line.
    interceptAddToCart();
  });

  // ── Bundle add-to-cart interception ─────────────────────────────────────────

  function interceptAddToCart() {
    var btn = findAddToCartButton();
    if (!btn) return;
    // Capture-phase listener so we beat the theme's own handler and can stop it.
    btn.addEventListener('click', onAddToCart, true);
    // Also guard the surrounding form submit (Enter key / theme form handlers).
    var form = btn.form || (btn.closest && btn.closest('form'));
    if (form) form.addEventListener('submit', onAddToCart, true);
  }

  function findAddToCartButton() {
    var selectors = [
      '#form-action-addToCart',
      '.add-to-cart-button',
      '[data-button-type="add-cart"]',
      '[data-wait-message]',
    ];
    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      if (el) return el;
    }
    return null;
  }

  function onAddToCart(e) {
    e.preventDefault();
    e.stopPropagation();
    if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();

    var qty = readQuantity();
    var channelId =
      (window.BCData && window.BCData.channel_id) || undefined;

    // Read the shopper's existing cart id (same-origin storefront API) so we add
    // to it rather than wiping it with a brand-new cart. Null if no cart yet.
    getCurrentCartId(function (cartId) {
      var payload = {
        bundleProductId: productId,
        quantity: qty,
        cartId: cartId || undefined,
        channelId: channelId,
      };
      postJSON(
        CONFIG.APP_URL.replace(/\/$/, '') + '/storefront/cart/add-bundle/' + CONFIG.STORE_HASH,
        payload,
        function (err, res) {
          if (err || !res || res.error) {
            // Never silently break add-to-cart — fall back to the native flow.
            return submitNative();
          }
          // New cart → adopt it via its storefront URL. Existing cart → refresh.
          if (!cartId && res.cartUrl) {
            window.location.href = res.cartUrl;
          } else {
            window.location.href = '/cart.php';
          }
        }
      );
    });
  }

  function readQuantity() {
    var input =
      document.querySelector('[name="qty[]"]') ||
      document.querySelector('input.form-input--incrementTotal') ||
      document.querySelector('input[name="qty"]');
    var n = input ? parseInt(input.value, 10) : 1;
    return n && n > 0 ? n : 1;
  }

  function getCurrentCartId(cb) {
    if (typeof window.fetch !== 'function') return cb(null);
    window
      .fetch('/api/storefront/carts', { credentials: 'include' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (carts) {
        var cart = Array.isArray(carts) ? carts[0] : null;
        cb(cart && cart.id ? cart.id : null);
      })
      .catch(function () { cb(null); });
  }

  function submitNative() {
    var btn = findAddToCartButton();
    var form = btn && (btn.form || (btn.closest && btn.closest('form')));
    if (form && typeof form.submit === 'function') {
      form.submit();
    } else if (btn) {
      // Re-dispatch a click without our interceptor (it only blocks via the
      // capture listener above, which we can't easily detach here, so reload).
      window.location.reload();
    }
  }

  // ── Inject "This bundle includes" list ──────────────────────────────

  function injectContents(products) {
    if (document.querySelector('.bcb-contents')) return; // avoid duplicates

    var items = products
      .map(function (p) {
        var qty = p.qty && p.qty > 0 ? p.qty : 1;
        return (
          '<li class="bcb-contents-item">' +
            '<span class="bcb-contents-qty">' + qty + ' &times;</span> ' +
            '<span class="bcb-contents-name">' + escapeHtml(p.name) + '</span>' +
          '</li>'
        );
      })
      .join('');

    var box = document.createElement('div');
    box.className = 'bcb-contents';
    box.innerHTML =
      '<p class="bcb-contents-title">This bundle includes:</p>' +
      '<ul class="bcb-contents-list">' + items + '</ul>';

    // Insert after the price (same anchor logic as the trigger), else fall back.
    var anchor = null;
    var sel = [
      '.productView-price', '[data-product-price-with-tax]',
      '[data-product-price-without-tax]', '.price-section',
      '.product-price', '.pdp-price',
    ];
    for (var i = 0; i < sel.length; i++) {
      anchor = document.querySelector(sel[i]);
      if (anchor) { anchor.insertAdjacentElement('afterend', box); return; }
    }
    var main =
      document.querySelector('.productView-details') ||
      document.querySelector('.productView') ||
      document.querySelector('main') ||
      document.body;
    main.insertBefore(box, main.firstChild);
  }

  // ── Inject trigger link ────────────────────────────────────────────

  function injectTrigger(bundles) {
    var count = bundles.length;
    var label = CONFIG.LINK_TEXT
      .replace('{count}', count)
      .replace('{plural}', count === 1 ? '' : 's');

    var trigger = document.createElement('a');
    trigger.className = 'bcb-trigger';
    trigger.href = '#';
    trigger.setAttribute('role', 'button');
    trigger.setAttribute('aria-haspopup', 'dialog');
    trigger.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path></svg>' +
      '<span>' + escapeHtml(label) + '</span>';

    trigger.addEventListener('click', function (e) {
      e.preventDefault();
      if (CONFIG.DISPLAY_MODE === 'redirect') {
        window.location.href =
          CONFIG.REDIRECT_URL + '?bundle_product=' + productId;
      } else {
        openModal(bundles);
      }
    });

    // Try to insert after price, before add-to-cart
    var inserted = false;
    var priceSelectors = [
      '.productView-price',
      '[data-product-price-with-tax]',
      '[data-product-price-without-tax]',
      '.price-section',
      '.product-price',
      '.pdp-price',
    ];
    for (var i = 0; i < priceSelectors.length; i++) {
      var el = document.querySelector(priceSelectors[i]);
      if (el) {
        el.insertAdjacentElement('afterend', trigger);
        inserted = true;
        break;
      }
    }
    if (!inserted) {
      // Fallback: insert before add-to-cart button
      var cartSelectors = [
        '#form-action-addToCart',
        '.add-to-cart-button',
        '[data-button-type="add-cart"]',
        '.productView-details',
      ];
      for (var j = 0; j < cartSelectors.length; j++) {
        var cartEl = document.querySelector(cartSelectors[j]);
        if (cartEl) {
          cartEl.insertAdjacentElement('beforebegin', trigger);
          inserted = true;
          break;
        }
      }
    }
    if (!inserted) {
      // Last resort
      var main =
        document.querySelector('.productView') ||
        document.querySelector('main') ||
        document.body;
      main.prepend(trigger);
    }
  }

  // ── Modal ──────────────────────────────────────────────────────────

  function openModal(bundles) {
    // Remove any existing modal
    var existing = document.getElementById('bcb-modal-overlay');
    if (existing) existing.remove();

    var overlay = document.createElement('div');
    overlay.className = 'bcb-overlay';
    overlay.id = 'bcb-modal-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Bundles containing this product');

    overlay.innerHTML =
      '<div class="bcb-panel" id="bcb-panel">' +
        '<div class="bcb-panel-header">' +
          '<p class="bcb-panel-title">Available Bundles</p>' +
          '<button class="bcb-panel-close" id="bcb-close-btn" aria-label="Close">✕</button>' +
        '</div>' +
        '<div class="bcb-bundle-list">' +
          buildBundleListHTML(bundles) +
        '</div>' +
      '</div>';

    document.body.appendChild(overlay);

    // Trap focus & close handlers
    document.getElementById('bcb-close-btn').addEventListener('click', closeModal);

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closeModal();
    });

    document.addEventListener('keydown', handleKeyDown);
    document.getElementById('bcb-close-btn').focus();
  }

  function closeModal() {
    var overlay = document.getElementById('bcb-modal-overlay');
    if (overlay) {
      overlay.style.animation = 'none';
      overlay.style.opacity = '0';
      overlay.style.transition = 'opacity 0.15s';
      setTimeout(function () { overlay.remove(); }, 150);
    }
    document.removeEventListener('keydown', handleKeyDown);
  }

  function handleKeyDown(e) {
    if (e.key === 'Escape') closeModal();
  }

  function buildBundleListHTML(bundles) {
    if (!bundles || bundles.length === 0) {
      return '<div class="bcb-empty">No available bundles found for this product.</div>';
    }

    return bundles
      .map(function (b) {
        var thumb = b.thumbnail
          ? '<img class="bcb-bundle-thumb" src="' + escapeHtml(b.thumbnail) + '" alt="' + escapeHtml(b.name) + '" loading="lazy">'
          : '<div class="bcb-bundle-thumb-placeholder">📦</div>';

        var price =
          b.sale_price && Number(b.sale_price) < Number(b.price)
            ? formatCurrency(b.sale_price)
            : formatCurrency(b.calculated_price || b.price);

        return (
          '<a href="' + escapeHtml(b.url) + '" class="bcb-bundle-card">' +
            thumb +
            '<div class="bcb-bundle-info">' +
              '<p class="bcb-bundle-name">' + escapeHtml(b.name) + '</p>' +
              '<span class="bcb-bundle-price">' + price + '</span>' +
            '</div>' +
            '<span class="bcb-bundle-arrow">›</span>' +
          '</a>'
        );
      })
      .join('');
  }

  // ── Utilities ──────────────────────────────────────────────────────

  // True only on a product DETAIL page (PDP), false on category/search/brand
  // listing pages. Those listings render product cards (with data-entity-id),
  // so we require a signal unique to a single-product page.
  function isProductPage() {
    // BCData.product_attributes is set only on PDPs (true on this store's theme).
    if (window.BCData && window.BCData.product_attributes) return true;
    // Standard Stencil product-detail container.
    if (document.querySelector('.productView')) return true;
    return false;
  }

  // Find the current product's ID across theme variations. Returns a string/
  // number, or null if this isn't a resolvable product page.
  function getProductId() {
    // 1. Stencil default
    if (window.BCData && window.BCData.product_id) return window.BCData.product_id;
    // 2. Add-to-cart form hidden input (present on most storefront themes)
    var input = document.querySelector('input[name="product_id"]');
    if (input && input.value) return input.value;
    // 3. data-entity-id on the product view (Cornerstone and derivatives)
    var el = document.querySelector('[data-entity-id]');
    if (el && el.getAttribute('data-entity-id')) return el.getAttribute('data-entity-id');
    return null;
  }

  function fetchJSON(url, callback) {
    // The 'ngrok-skip-browser-warning' header bypasses ngrok's free-tier browser
    // interstitial (which otherwise returns an HTML warning page instead of our
    // JSON). Harmless on non-ngrok hosts. Required while the app is tunnelled
    // through *.ngrok-free.dev.
    var NGROK_HEADER = { 'ngrok-skip-browser-warning': 'true' };
    if (typeof window.fetch === 'function') {
      window
        .fetch(url, { headers: NGROK_HEADER })
        .then(function (res) { return res.json(); })
        .then(function (data) { callback(null, data); })
        .catch(function (err) { callback(err, null); });
    } else {
      // XHR fallback for older browsers
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.setRequestHeader('ngrok-skip-browser-warning', 'true');
      xhr.onreadystatechange = function () {
        if (xhr.readyState === 4) {
          if (xhr.status === 200) {
            try {
              callback(null, JSON.parse(xhr.responseText));
            } catch (e) {
              callback(e, null);
            }
          } else {
            callback(new Error('HTTP ' + xhr.status), null);
          }
        }
      };
      xhr.send();
    }
  }

  // POST JSON to the app (used to build the bundle cart). Sends the same
  // ngrok-skip header as fetchJSON so the response isn't the ngrok interstitial.
  function postJSON(url, body, callback) {
    var headers = {
      'Content-Type': 'application/json',
      'ngrok-skip-browser-warning': 'true',
    };
    if (typeof window.fetch === 'function') {
      window
        .fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(body) })
        .then(function (res) { return res.json(); })
        .then(function (data) { callback(null, data); })
        .catch(function (err) { callback(err, null); });
    } else {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', url, true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.setRequestHeader('ngrok-skip-browser-warning', 'true');
      xhr.onreadystatechange = function () {
        if (xhr.readyState === 4) {
          if (xhr.status >= 200 && xhr.status < 300) {
            try { callback(null, JSON.parse(xhr.responseText)); }
            catch (e) { callback(e, null); }
          } else {
            callback(new Error('HTTP ' + xhr.status), null);
          }
        }
      };
      xhr.send(JSON.stringify(body));
    }
  }

  function injectStyles(css) {
    var el = document.createElement('style');
    el.textContent = css;
    document.head.appendChild(el);
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;'); // BUG-21: escape single quotes for attribute safety
  }

  var _bcbCurrencySymbol = null;

  // Resolve the storefront's currency SYMBOL. BCData.shop_currency is often unset
  // (it defaulted us to USD → "US$551.25" on an INR store), so prefer sniffing the
  // leading symbol off a real price already rendered on the page (e.g. "₹309.00").
  function currencySymbol() {
    if (_bcbCurrencySymbol !== null) return _bcbCurrencySymbol;
    var m = /([^\d\s.,])\s?[\d,]+\.\d{2}/.exec(
      document.body ? document.body.textContent || '' : ''
    );
    _bcbCurrencySymbol = (m && m[1]) || '';
    return _bcbCurrencySymbol;
  }

  function formatCurrency(amount) {
    var num = Number(amount);
    if (isNaN(num)) return '';
    // Match what the storefront actually shows by using its own currency symbol.
    var sym = currencySymbol();
    if (sym) return sym + num.toFixed(2);
    // Fallback: locale-aware formatting via the shop currency code, if known.
    if (window.Intl && Intl.NumberFormat) {
      try {
        var currency =
          (window.BCData && (window.BCData.currency_code || window.BCData.shop_currency)) ||
          'USD';
        return new Intl.NumberFormat(navigator.language || 'en', {
          style: 'currency',
          currency: currency,
        }).format(num);
      } catch (_) {
        // fall through to simple fallback
      }
    }
    return num.toFixed(2);
  }

})();
