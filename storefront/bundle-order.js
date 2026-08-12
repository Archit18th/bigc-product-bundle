/**
 * BC Bundle Order Breakdown — Storefront Script
 * =====================================================================
 * Add via BigCommerce Control Panel → Storefront → Script Manager.
 *
 * CONFIGURATION (edit the two values in the CONFIG block below):
 *   APP_URL    — the URL where your Bundles App backend is hosted
 *   STORE_HASH — your BigCommerce store hash
 *
 * PLACEMENT:   All pages (the script self-gates to order pages)
 * LOCATION:    Footer
 * =====================================================================
 *
 * WHAT IT DOES:
 * On the order-confirmation ("Thank you") page and the account order-detail
 * page, it reads the order number, asks the app which bundles are in that order,
 * and renders each bundle's component products + quantities under the Order
 * Summary. Component data is read from the bundle at order time, so it reflects
 * exactly what the customer bought.
 */

(function () {
  'use strict';

  /* ================================================================
   * ✏️  CONFIGURATION — edit these values before uploading
   * ================================================================ */
  var CONFIG = {
    APP_URL: 'https://bigc-product-bundle.onrender.com', // ← your app's base URL
    STORE_HASH: 'vtc0o6t1vd',                                            // ← your BC store hash
  };
  /* ================================================================ */

  if (CONFIG.APP_URL.indexOf('your-bundles-app') !== -1 || CONFIG.STORE_HASH === 'YOUR_STORE_HASH') {
    console.warn('[BC Bundles] bundle-order.js is not configured — set APP_URL and STORE_HASH.');
    return;
  }

  // Never run on the cart page — that surface is handled by bundle-cart.js,
  // which nests each bundle's components under its cart line. Without this guard
  // the order script's fallback placement drops an "includes" box at the top of
  // the cart.
  if (/\/cart\.php/i.test(window.location.pathname)) return;

  // POSITIVE page gate: only run on the order-confirmation ("Thank you") page or
  // an account order-detail page. Without this, getOrderId() can resolve a stray
  // number on catalog pages (category / search / brand) and the fallback placement
  // drops the "includes" box at the top of those pages — which is not wanted.
  // A single order DETAIL page always carries ?order_id=NNN (account view), while
  // the account "Orders" LIST page is action=order_status with NO order_id — so
  // gating on the order_id param cleanly admits the detail page and the
  // confirmation pages while excluding the list (and all catalog pages).
  var _path = window.location.pathname;
  var _hasOrderParam = /[?&](?:order_id|orderId)=\d+/i.test(window.location.search);
  var _onOrderPage =
    /\/checkout\/order-confirmation/i.test(_path) || // Optimized One-Page Checkout confirmation
    /\/finishorder\.php/i.test(_path) ||             // legacy confirmation page
    _hasOrderParam;                                  // account order DETAIL (?order_id=NNN)
  if (!_onOrderPage) return;

  // Retry a few times: the confirmation page renders its summary asynchronously,
  // so the anchor element / order number may not be present on first tick.
  var attempts = 0;
  (function run() {
    var orderId = getOrderId();
    if (!orderId) {
      if (++attempts <= 10) return setTimeout(run, 600);
      return;
    }
    fetchJSON(buildUrl(orderId), function (err, data) {
      if (err || !data || !data.bundles || !data.bundles.length) return;
      injectStyles();
      render(data.bundles);
    });
  })();

  function buildUrl(orderId) {
    return (
      CONFIG.APP_URL.replace(/\/$/, '') +
      '/storefront/order-bundles/' +
      CONFIG.STORE_HASH +
      '/' +
      orderId
    );
  }

  // ── Resolve the order id across the storefront pages that show an order ──
  // Ordered most-reliable → least, and the text fallbacks are written so the
  // script never fires on the multi-order account "Orders" list page.
  function getOrderId() {
    // 1. URL query param (account order-detail: ?order_id=NNN / ?orderId=NNN) —
    //    authoritative when present.
    var qs = /[?&](?:order_id|orderId)=(\d+)/i.exec(window.location.search);
    if (qs) return qs[1];

    var bodyText = document.body ? document.body.textContent || '' : '';

    // 2. Confirmation page copy: "Your order number is 319" (always singular).
    //    PREFERRED over BCData / [data-order-id] below, because on the thank-you
    //    page those can carry a STALE id from an earlier order in the same
    //    session — which made this script fetch the wrong order's bundle and show
    //    the wrong components. The visible "order number is N" is the real order.
    var conf = /order\s*number\s*is\s*#?\s*(\d+)/i.exec(bodyText);
    if (conf) return conf[1];

    // 3. Stencil global, when present.
    if (window.BCData && window.BCData.order_id) return String(window.BCData.order_id);

    // 4. A data attribute the theme may expose.
    var el = document.querySelector('[data-order-id]');
    if (el && (el.getAttribute('data-order-id') || '').replace(/\D/g, '')) {
      return el.getAttribute('data-order-id').replace(/\D/g, '');
    }

    // 5. "Order #314" heading — ONLY when exactly one distinct order number
    //    appears on the page. This matches a single order-detail page but skips
    //    the account "Orders" list (which shows many "Order #..." entries).
    var re = /order\s*#\s*(\d+)/gi, m, seen = {}, ids = [];
    while ((m = re.exec(bodyText))) {
      if (!seen[m[1]]) { seen[m[1]] = 1; ids.push(m[1]); }
    }
    if (ids.length === 1) return ids[0];

    return null;
  }

  // ── Render the breakdown (cart-style, nested under each bundle's order line) ──
  function render(bundles) {
    injectStyles();
    bundles.forEach(function (b) {
      var bundleQty = Number(b.quantity) > 0 ? Number(b.quantity) : 1;
      var marker = 'bcb-order-for-' + slug(b.name);
      // Re-runs / retries must not duplicate a bundle's breakdown.
      if (document.querySelector('.' + marker)) return;

      var block = buildBlock(b.products || [], bundleQty);
      var line = findOrderLineItem(b.name);

      if (line) {
        var tr = line.closest && line.closest('tr');
        if (tr && tr.parentNode) {
          // Table layout (account order page): inject a full-width row directly
          // under the bundle's product row, above the totals rows.
          var newTr = document.createElement('tr');
          newTr.className = 'bcb-order-row ' + marker;
          var td = document.createElement('td');
          td.colSpan = Math.max(1, tr.children.length);
          td.appendChild(block);
          newTr.appendChild(td);
          tr.parentNode.insertBefore(newTr, tr.nextSibling);
          return;
        }
        var li = (line.closest && line.closest('li')) || line;
        if (li.parentNode) {
          var wrap = document.createElement('div');
          wrap.className = 'bcb-order-snapshot ' + marker;
          wrap.appendChild(block);
          li.parentNode.insertBefore(wrap, li.nextSibling);
          return;
        }
      }

      // Fallback: under the Order Contents/Summary heading — NEVER the page top
      // (the old behaviour anchored to the nav when the name matched a menu item).
      var box = document.createElement('div');
      box.className = 'bcb-order-snapshot ' + marker;
      box.appendChild(block);
      placeFallback(box);
    });
  }

  // Cart-style breakdown: [image + name] [price] [qty] [total] per component.
  function buildBlock(products, bundleQty) {
    var wrap = document.createElement('div');
    wrap.className = 'bcb-order-block';

    var head = document.createElement('div');
    head.className = 'bcb-order-head';
    head.textContent = 'Bundle includes';
    wrap.appendChild(head);

    products.forEach(function (p) {
      var qty = (Number(p.qty) > 0 ? Number(p.qty) : 1) * bundleQty;
      var row = document.createElement('div');
      row.className = 'bcb-order-item';
      // Mirror the order line format: [image] "qty × name" … total.
      row.innerHTML =
        '<div class="bcb-order-info">' +
          thumbHtml(p) +
          '<span class="bcb-order-name">' + qty + ' &times; ' + escapeHtml(p.name) + '</span>' +
        '</div>' +
        '<span class="bcb-order-total">' + money(0) + '</span>';
      wrap.appendChild(row);
    });
    return wrap;
  }

  function thumbHtml(p) {
    if (p.thumbnail) {
      return (
        '<img class="bcb-order-thumb" src="' + escapeHtml(p.thumbnail) +
        '" alt="' + escapeHtml(p.name) + '" loading="lazy">'
      );
    }
    return '<span class="bcb-order-thumb bcb-order-thumb-ph">📦</span>';
  }

  // Site nav/header/footer — a bundle named "test" must never anchor to a menu
  // item like "CATEGORYTEST" / "TEST1", which is what dropped the box at the top.
  var NAV_SELECTOR =
    'nav,header,footer,[role="navigation"],[class*="navPages"],' +
    '[class*="navUser"],[class*="header"],[class*="Header"],[class*="footer"]';

  // Find the deepest element in the ORDER-CONTENTS region whose text contains the
  // bundle's name (its order line). Scoped + nav-excluded so it can't wander into
  // the global navigation. Returns null if not found.
  function findOrderLineItem(name) {
    if (!name) return null;
    var root = orderContentRoot();
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
      if (!childHasIt) return el; // deepest element containing the name
    }
    return null;
  }

  // The container holding the order's line items, so the name search stays out of
  // the page navigation. Prefer the "Order Contents" region; else the account/main.
  function orderContentRoot() {
    var headings = document.querySelectorAll('h1,h2,h3,h4,.page-heading');
    for (var i = 0; i < headings.length; i++) {
      if (/^order\s+contents/i.test((headings[i].textContent || '').trim())) {
        return headings[i].parentNode || headings[i];
      }
    }
    return (
      document.querySelector('.account-body') ||
      document.querySelector('.account-content') ||
      document.querySelector('.page-content') ||
      document.querySelector('main') ||
      document.querySelector('[role="main"]') ||
      document.body
    );
  }

  // Fallback placement when the line item can't be located — under the Order
  // Contents/Summary heading or the account body, but NEVER at the page top.
  function placeFallback(box) {
    var summary =
      document.querySelector('.previewCartContainer') ||
      document.querySelector('[class*="orderSummary"]') ||
      document.querySelector('[class*="OrderSummary"]');
    if (summary) { summary.appendChild(box); return; }

    var headings = document.querySelectorAll('h1,h2,h3,h4,.page-heading');
    for (var i = 0; i < headings.length; i++) {
      if (/^order\s+(contents|summary|details)/i.test((headings[i].textContent || '').trim())) {
        headings[i].insertAdjacentElement('afterend', box);
        return;
      }
    }

    var main =
      document.querySelector('.account-body') ||
      document.querySelector('.account-content') ||
      document.querySelector('.page-content') ||
      document.querySelector('main');
    if (main) { main.appendChild(box); }
  }

  function slug(s) {
    return (
      String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x'
    );
  }

  // ── Currency for the total column (matches the order line's ₹ formatting) ──
  var _sym = null;
  function money(amount) {
    if (_sym === null) _sym = symbolFor();
    return _sym + Number(amount).toFixed(2);
  }
  function symbolFor() {
    var m = /([^\d\s.,])\s?[\d,]+\.\d{2}/.exec(document.body ? document.body.textContent || '' : '');
    return (m && m[1]) || '';
  }

  // ── Utilities ────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('bcb-order-styles')) return;
    var css =
      // Strip the injected table cell's chrome so our rows read as native lines.
      '.bcb-order-row > td{padding:0!important;border:none!important;background:transparent!important;}' +
      '.bcb-order-snapshot{margin:8px 0;}' +
      '.bcb-order-block{margin:0;font-family:inherit;}' +
      // Subtle, muted label — not a colored banner.
      '.bcb-order-head{font-size:11px;font-weight:600;color:#9aa3b2;text-transform:uppercase;' +
      'letter-spacing:.6px;margin:2px 0 2px;padding-left:64px;}' +
      // Each component aligns to columns: [image + "qty × name"] [total].
      '.bcb-order-item{display:grid;grid-template-columns:1fr auto;align-items:center;' +
      'padding:12px 0;font-size:13px;color:#5b6472;border-bottom:1px solid #ededed;}' +
      '.bcb-order-item:last-child{border-bottom:none;}' +
      '.bcb-order-info{display:flex;align-items:center;gap:14px;min-width:0;padding-left:8px;}' +
      '.bcb-order-thumb{width:44px;height:44px;object-fit:cover;border-radius:4px;' +
      'background:#f5f5f5;flex-shrink:0;}' +
      '.bcb-order-thumb-ph{display:flex;align-items:center;justify-content:center;' +
      'font-size:18px;background:#efefef;}' +
      '.bcb-order-name{min-width:0;font-weight:400;color:#3f4754;line-height:1.35;}' +
      '.bcb-order-total{text-align:right;padding-right:6px;color:#5b6472;}';
    var el = document.createElement('style');
    el.id = 'bcb-order-styles';
    el.textContent = css;
    document.head.appendChild(el);
  }

  function fetchJSON(url, callback) {
    var NGROK_HEADER = { 'ngrok-skip-browser-warning': 'true' };
    if (typeof window.fetch === 'function') {
      window
        .fetch(url, { headers: NGROK_HEADER })
        .then(function (res) { return res.json(); })
        .then(function (data) { callback(null, data); })
        .catch(function (err) { callback(err, null); });
    } else {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.setRequestHeader('ngrok-skip-browser-warning', 'true');
      xhr.onreadystatechange = function () {
        if (xhr.readyState === 4) {
          if (xhr.status === 200) {
            try { callback(null, JSON.parse(xhr.responseText)); }
            catch (e) { callback(e, null); }
          } else {
            callback(new Error('HTTP ' + xhr.status), null);
          }
        }
      };
      xhr.send();
    }
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
