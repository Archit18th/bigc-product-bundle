/**
 * BC Bundle Cart Breakdown — Storefront Script
 * =====================================================================
 * Add via BigCommerce Control Panel → Storefront → Script Manager.
 *
 * CONFIGURATION (edit the two values in the CONFIG block below):
 *   APP_URL    — the URL where your Bundles App backend is hosted
 *   STORE_HASH — your BigCommerce store hash
 *
 * PLACEMENT:   All pages (the script self-gates to the cart + checkout pages)
 * LOCATION:    Footer
 * =====================================================================
 *
 * WHAT IT DOES:
 * On the Cart page and the multi-step Checkout page, for every bundle line
 * item it injects a nested block directly UNDER the bundle's row, listing
 * each component product the bundle contains — image, name, price (always
 * 0), quantity, and total (0). This replaces the raw ₹0 custom-item lines /
 * the separate "includes" box with a clean, grouped breakdown that reads as
 * part of the bundle line.
 */

(function () {
  'use strict';

  /* ================================================================
   * ✏️  CONFIGURATION — edit these values before uploading
   * ================================================================ */
  // var CONFIG = {
  //   APP_URL: 'https://demolocations-bc-bundle-prod.com', // ← your app's base URL
  //   STORE_HASH: window.BC_BUNDLES_STORE_HASH,                                            // ← your BC store hash
  // };
  // /* ================================================================ */

  // if (CONFIG.APP_URL.indexOf('your-bundles-app') !== -1 || CONFIG.STORE_HASH === 'YOUR_STORE_HASH') {
  //   console.warn('[BC Bundles] bundle-cart.js is not configured — set APP_URL and STORE_HASH.');
  //   return;
  // }
var CONFIG = {
  APP_URL: 'https://bigc-product-bundle.onrender.com',
  STORE_HASH: window.BC_BUNDLES_STORE_HASH
};

if (!CONFIG.APP_URL || !CONFIG.STORE_HASH) {
  console.warn('BC Bundles Configuration is missing. Bundle script will not run.');
  return;
}

  // Only run on the cart page.
  if (!isCartPage()) return;

  var contentsCache = {}; 
  var currencySymbol = null;

  start();

  function start() {
    run();
   
    var pending = false;
    var observer = new MutationObserver(function () {
      if (pending) return;
      pending = true;
      setTimeout(function () { pending = false; run(); }, 150);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function run() {
    // Kill any "includes" box the order script may have dropped on the cart page.
    removeOrderBoxes();
    fetchCart(function (err, cart) {
      if (err || !cart) return;
      // Hide the raw ₹0 component lines — the breakdown below the bundle row
      // shows them instead, so they shouldn't also appear as their own products.
      hideCustomItemRows(cart);
      var items = collectPhysicalItems(cart);
      if (!items.length) return;
      currencySymbol = currencySymbol || symbolFor(cart.currency && cart.currency.code);
      items.forEach(function (item) {
        if (!item.productId) return;
        loadContents(item.productId, function (products) {
          if (products && products.length) injectBreakdown(item, products);
        });
      });
    });
  }

  // ── Gate ───────────────────────────────────────────────────────────────
  function isCartPage() {
    // NEVER the order-confirmation / account order pages — those belong to
    // bundle-order.js. Their Order Summary uses .previewCartContainer, which
    // would otherwise make the DOM check below mistake them for the cart page.
    // (Without this guard, this script wipes the order breakdown and renders the
    // shopper's *current* cart bundle on the thank-you page — wrong components.)
    var path = window.location.pathname;
    if (/\/checkout\/order-confirmation/i.test(path)) return false;
    if (/\/finishorder\.php/i.test(path)) return false;
    if (/[?&](?:order_id|orderId)=\d+/i.test(window.location.search)) return false;

    if (/\/cart\.php/i.test(path)) return true;
    if (/(^|\W)cart(\W|$)/i.test(path)) return true;
    if (/^\/checkout\/?$/i.test(path)) return true;
    return !!document.querySelector('.cart, [class*="cartContent"], .previewCartContainer, [data-cart]');
  }

  function findCartRoot() {
    return (
      document.querySelector('.cart') ||
      document.querySelector('[class*="cartContent"]') ||
      document.querySelector('[data-cart]') ||
      document.querySelector('main') ||
      document.body
    );
  }

  function removeOrderBoxes() {
    var boxes = document.querySelectorAll('.bcb-order-snapshot');
    for (var i = 0; i < boxes.length; i++) boxes[i].parentNode && boxes[i].parentNode.removeChild(boxes[i]);
  }

  // ── Cart data (same-origin storefront API) ──────────────────────────────
  function fetchCart(cb) {
    if (typeof window.fetch !== 'function') return cb(new Error('no fetch'));
    window
      .fetch('/api/storefront/carts?include=lineItems.physicalItems.options', {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      })
      .then(function (r) { return r.json(); })
      .then(function (carts) { cb(null, Array.isArray(carts) ? carts[0] : carts); })
      .catch(function (e) { cb(e); });
  }

  function collectPhysicalItems(cart) {
    var li = cart && cart.lineItems;
    return (li && li.physicalItems) ? li.physicalItems : [];
  }

  // The bundle's components are added as ₹0 "custom items", which BC renders as
  // their own editable cart rows. We already list them inside the bundle's
  // breakdown, so hide the raw rows to avoid duplicate, purchasable-looking lines.
  function hideCustomItemRows(cart) {
    var li = cart && cart.lineItems;
    var customItems = (li && li.customItems) || [];
    if (!customItems.length) return;
    customItems.forEach(function (ci) {
      var el = findDeepestWithText(ci.name); // scoped to cart, skips nav + our nodes
      if (!el) return;
      var row =
        (el.closest && (el.closest('.cart-item') || el.closest('[class*="cart-item"]') ||
                        el.closest('tr') || el.closest('li'))) || el;
      if (row && row.style) row.style.display = 'none';
    });
  }

  // ── Bundle component lookup (app API) ───────────────────────────────────
  function loadContents(productId, cb) {
    if (contentsCache.hasOwnProperty(productId)) {
      // null = pending or confirmed not-a-bundle; arrays resolve immediately.
      if (Array.isArray(contentsCache[productId])) return cb(contentsCache[productId]);
      return; // pending: a prior call will resolve and inject
    }
    contentsCache[productId] = null; // mark in-flight
    var url =
      CONFIG.APP_URL.replace(/\/$/, '') +
      '/storefront/bundle-contents/' +
      CONFIG.STORE_HASH +
      '/' +
      productId;
    window
      .fetch(url, { headers: { 'ngrok-skip-browser-warning': 'true' } })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var products = (data && data.products) || [];
        contentsCache[productId] = products;
        cb(products);
      })
      .catch(function () { contentsCache[productId] = []; });
  }

  // ── Render ──────────────────────────────────────────────────────────────
  function injectBreakdown(item, products) {
    var bundleQty = Number(item.quantity) || 1;
    var anchor = findRowFor(item);
    if (!anchor) return;

    // The breakdown belongs to THIS bundle row. Re-running must not duplicate it.
    var marker = 'bcb-cart-for-' + item.productId;

    if (anchor.tag === 'tr') {
      if (anchor.el.nextSibling && hasClass(anchor.el.nextSibling, marker)) return;
      injectStyles();
      var tr = document.createElement('tr');
      tr.className = 'bcb-cart-row ' + marker;
      var td = document.createElement('td');
      td.colSpan = Math.max(1, anchor.el.children.length);
      td.appendChild(buildBlock(products, bundleQty));
      tr.appendChild(td);
      anchor.el.parentNode.insertBefore(tr, anchor.el.nextSibling);
    } else {
      if (anchor.el.nextSibling && hasClass(anchor.el.nextSibling, marker)) return;
      injectStyles();
      var box = buildBlock(products, bundleQty);
      box.className += ' ' + marker;
      anchor.el.parentNode.insertBefore(box, anchor.el.nextSibling);
    }
  }

  function buildBlock(products, bundleQty) {
    var wrap = document.createElement('div');
    wrap.className = 'bcb-cart-block';

    var head = document.createElement('div');
    head.className = 'bcb-cart-head';
    head.textContent = 'Bundle includes';
    wrap.appendChild(head);

    products.forEach(function (p) {
      var qty = (Number(p.qty) > 0 ? Number(p.qty) : 1) * bundleQty;
      var row = document.createElement('div');
      row.className = 'bcb-cart-item';
      row.innerHTML =
        '<div class="bcb-cart-info">' +
          thumbHtml(p) +
          '<span class="bcb-cart-name">' + escapeHtml(p.name) + '</span>' +
        '</div>' +
        '<span class="bcb-cart-price">' + money(0) + '</span>' +
        '<span class="bcb-cart-qty">' + qty + '</span>' +
        '<span class="bcb-cart-total">' + money(0) + '</span>';
      wrap.appendChild(row);
    });
    return wrap;
  }

  function thumbHtml(p) {
    if (p.thumbnail) {
      return (
        '<img class="bcb-cart-thumb" src="' + escapeHtml(p.thumbnail) +
        '" alt="' + escapeHtml(p.name) + '" loading="lazy">'
      );
    }
    return '<span class="bcb-cart-thumb bcb-cart-thumb-ph">📦</span>';
  }

  // Find the cart line element for this item and tell the caller whether it's a
  // table row (so we inject a full-width <tr>) or a generic block.
  function findRowFor(item) {
    var name = item.name;
    var el = findDeepestWithText(name);
    if (!el) return null;
    var tr = el.closest && el.closest('tr');
    if (tr && tr.parentNode) return { el: tr, tag: 'tr' };
    var li =
      (el.closest && (el.closest('.cart-item') || el.closest('[class*="cart-item"]') || el.closest('li'))) ||
      el;
    return { el: li, tag: 'block' };
  }

  // Site nav/header/footer — a bundle named "test" must never match a menu item
  // like "TEST1"/"CATEGORYTEST", which is what dropped the breakdown at the top.
  var NAV_SELECTOR =
    'nav,header,footer,[role="navigation"],[class*="navPages"],' +
    '[class*="navUser"],[class*="header"],[class*="Header"],[class*="footer"]';

  // Search ONLY inside the cart region (and never the nav/header) for the deepest
  // element containing the line item's name, so the breakdown anchors to the
  // correct cart row even when the product name also appears in the menu.
  function findDeepestWithText(name) {
    if (!name) return null;
    var root = findCartRoot() || document.body;
    var all = root.getElementsByTagName('*');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.className && String(el.className).indexOf('bcb-') !== -1) continue; // our nodes
      if (el.closest && el.closest(NAV_SELECTOR)) continue;                      // skip menu/header
      if ((el.textContent || '').indexOf(name) === -1) continue;
      var childHasIt = false;
      for (var j = 0; j < el.children.length; j++) {
        if ((el.children[j].textContent || '').indexOf(name) !== -1) { childHasIt = true; break; }
      }
      if (!childHasIt) return el;
    }
    return null;
  }

  // ── Utilities ────────────────────────────────────────────────────────────
  function money(amount) {
    return (currencySymbol || '') + Number(amount).toFixed(2);
  }

  function symbolFor(code) {
    var map = { INR: '₹', USD: '$', EUR: '€', GBP: '£', AUD: 'A$', CAD: 'C$', JPY: '¥' };
    if (code && map[code]) return map[code];
    // Fallback: pull the leading symbol off any price-looking text on the page.
    var m = /([^\d\s.,])\s?[\d,]+\.\d{2}/.exec(document.body ? document.body.textContent || '' : '');
    return (m && m[1]) || '';
  }

  function hasClass(node, cls) {
    return node && node.nodeType === 1 && (' ' + (node.className || '') + ' ').indexOf(' ' + cls + ' ') !== -1;
  }

  function injectStyles() {
    if (document.getElementById('bcb-cart-styles')) return;
    var css =
      // Strip the table cell's own chrome so our rows read as native cart lines.
      '.bcb-cart-row > td{padding:0!important;border:none!important;background:transparent!important;}' +
      '.bcb-cart-block{margin:0;font-family:inherit;}' +
      // Subtle, muted label — not a colored banner.
      '.bcb-cart-head{font-size:11px;font-weight:600;color:#9aa3b2;text-transform:uppercase;' +
      'letter-spacing:.6px;margin:2px 0 2px;padding-left:64px;}' +
      // Each component aligns to the cart columns: [image+name] [price] [qty] [total].
      '.bcb-cart-item{display:grid;grid-template-columns:1fr 17% 16% 15%;align-items:center;' +
      'padding:12px 0;font-size:13px;color:#5b6472;border-bottom:1px solid #ededed;}' +
      '.bcb-cart-item:last-child{border-bottom:none;}' +
      '.bcb-cart-info{display:flex;align-items:center;gap:14px;min-width:0;padding-left:8px;}' +
      '.bcb-cart-thumb{width:44px;height:44px;object-fit:cover;border-radius:4px;' +
      'background:#f5f5f5;flex-shrink:0;}' +
      '.bcb-cart-thumb-ph{display:flex;align-items:center;justify-content:center;' +
      'font-size:18px;background:#efefef;}' +
      '.bcb-cart-name{min-width:0;font-weight:400;color:#3f4754;line-height:1.35;}' +
      '.bcb-cart-price{text-align:left;}' +
      '.bcb-cart-qty{text-align:center;}' +
      '.bcb-cart-total{text-align:right;padding-right:6px;}' +
      '@media (max-width:640px){' +
      '.bcb-cart-item{grid-template-columns:1fr auto;row-gap:2px;}' +
      '.bcb-cart-price,.bcb-cart-qty{display:none;}' +
      '.bcb-cart-total{text-align:right;}}';
    var el = document.createElement('style');
    el.id = 'bcb-cart-styles';
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
      .replace(/'/g, '&#39;');
  }
})();
