/**
 * BigCommerce API Service
 * Wraps the BC Management API (v2/v3) with retry logic and error handling.
 */

const axios = require('axios');

const BUNDLE_METAFIELD_NAMESPACE = 'bc_bundles';
const BUNDLE_CONFIG_KEY = 'bundle_components'; // on the bundle product
const BUNDLE_MEMBERSHIP_KEY = 'bundle_memberships'; // on component products
const METAFIELD_PERMISSION = 'read_and_sf_access'; // storefront-readable

class BigCommerceClient {
  constructor(storeHash, accessToken) {
    this.storeHash = storeHash;
    this.accessToken = accessToken;
    this.v2 = axios.create({
      baseURL: `https://api.bigcommerce.com/stores/${storeHash}/v2`,
      headers: {
        'X-Auth-Token': accessToken,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    });
    this.v3 = axios.create({
      baseURL: `https://api.bigcommerce.com/stores/${storeHash}/v3`,
      headers: {
        'X-Auth-Token': accessToken,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    });
  }

  // ─── Products ────────────────────────────────────────────────────────────────

  async searchProducts(query, limit = 20) {
    const res = await this.v3.get('/catalog/products', {
      params: {
        keyword: query,
        limit,
        include: 'variants,images',
        // No availability filter: merchants should be able to add any product to
        // a bundle, including currently-disabled ones. Bundle availability is
        // driven by inventory_level (stock), not the product's availability flag.
      },
    });
    return res.data.data;
  }

  /**
   * Fetch every product in the catalog, paginating automatically.
   * Used by the product-index sync (re-index). Includes variants + images so
   * the index can compute variant-level stock and store a thumbnail.
   *
   * @param {(info:{page:number, totalPages:number, count:number}) => void} [onPage]
   *        optional callback invoked after each page (for progress logging).
   * @returns {Promise<Array>} all product objects
   */
  async getAllProducts(onPage) {
    const all = [];
    let page = 1;
    while (true) {
      const res = await this.v3.get('/catalog/products', {
        params: {
          include: 'variants,images,primary_image',
          limit: 250,
          page,
        },
      });
      const batch = res.data.data || [];
      all.push(...batch);

      const pagination = res.data.meta?.pagination;
      if (onPage) {
        onPage({
          page,
          totalPages: pagination?.total_pages ?? page,
          count: all.length,
        });
      }
      if (!pagination || page >= pagination.total_pages) break;
      page++;
    }
    return all;
  }

  async getProduct(productId) {
    const res = await this.v3.get(`/catalog/products/${productId}`, {
      // images/primary_image are needed so component thumbnails resolve (used
      // for the bundle config + the collage thumbnail in the bundle list).
      params: { include: 'variants,images,primary_image' },
    });
    return res.data.data;
  }

  async createProduct(data) {
    const res = await this.v3.post('/catalog/products', data);
    return res.data.data;
  }

  /**
   * Return the store's currency settings so the UI can format prices in the
   * merchant's real currency (e.g. INR ₹) instead of a hard-coded symbol.
   * GET /v2/store includes currency code, symbol, and decimal places.
   */
  async getStoreInfo() {
    const res = await this.v2.get('/store');
    const s = res.data || {};
    return {
      currency: s.currency || 'USD',                 // ISO code, e.g. "INR"
      currency_symbol: s.currency_symbol || '$',     // e.g. "₹"
      decimal_places: s.decimal_places ?? 2,
    };
  }

  async updateProduct(productId, data) {
    const res = await this.v3.put(`/catalog/products/${productId}`, data);
    return res.data.data;
  }

  async deleteProduct(productId) {
    await this.v3.delete(`/catalog/products/${productId}`);
  }

  // ─── Carts (server-to-server V3) ──────────────────────────────────────────────
  // Used to add a bundle to the cart as the priced bundle product PLUS one ₹0
  // "custom item" per component, so the components show as their own cart lines.
  // Custom items are display-only (no catalog link) — they don't deduct inventory
  // (the order webhook already deducts components off the bundle line) and, at
  // list_price 0, don't change the total.

  /**
   * Create a new cart. Returns the created cart object, including
   * redirect_urls.cart_url (a storefront URL that adopts this cart).
   * @param {{lineItems?:Array, customItems?:Array, channelId?:number}} opts
   */
  async createCart({ lineItems = [], customItems = [], channelId } = {}) {
    const body = { line_items: lineItems, custom_items: customItems };
    if (channelId) body.channel_id = channelId;
    const res = await this.v3.post('/carts', body, {
      params: { include: 'redirect_urls' },
    });
    return res.data.data;
  }

  /**
   * Add items to an existing cart. Returns the updated cart object.
   */
  async addCartItems(cartId, { lineItems = [], customItems = [] } = {}) {
    const res = await this.v3.post(`/carts/${cartId}/items`, {
      line_items: lineItems,
      custom_items: customItems,
    });
    return res.data.data;
  }

  /**
   * Create storefront redirect URLs for a cart. Returns { cart_url, checkout_url, ... }.
   */
  async getCartRedirectUrls(cartId) {
    const res = await this.v3.post(`/carts/${cartId}/redirect_urls`, {});
    return res.data.data;
  }

  // ─── Channel assignments ────────────────────────────────────────────────────
  // Products created via the v3 API are NOT auto-assigned to any storefront
  // channel (unlike products created in the admin UI). Without an assignment a
  // product is invisible on every storefront, so bundles must be assigned
  // explicitly after creation.

  /**
   * Return the channel assignments for one or more product IDs.
   * @param {number|number[]} productIds
   * @returns {Array<{channel_id:number, product_id:number}>}
   */
  async getProductChannelAssignments(productIds) {
    const ids = (Array.isArray(productIds) ? productIds : [productIds]).join(',');
    const res = await this.v3.get('/catalog/products/channel-assignments', {
      params: { 'product_id:in': ids, limit: 250 },
    });
    return res.data.data;
  }

  /**
   * Assign a product to the given storefront channels (idempotent — PUT upserts).
   * No-op when channelIds is empty.
   */
  async assignProductToChannels(productId, channelIds) {
    if (!channelIds || !channelIds.length) return;
    const body = channelIds.map((channel_id) => ({ product_id: productId, channel_id }));
    await this.v3.put('/catalog/products/channel-assignments', body);
  }

  // ─── Metafields ───────────────────────────────────────────────────────────────

  async getProductMetafields(productId, namespace, key) {
    const params = { namespace };
    if (key) params.key = key;
    const res = await this.v3.get(`/catalog/products/${productId}/metafields`, {
      params,
    });
    return res.data.data;
  }

  async upsertProductMetafield(productId, namespace, key, value) {
    const existing = await this.getProductMetafields(productId, namespace, key);
    const payload = {
      namespace,
      key,
      value: typeof value === 'string' ? value : JSON.stringify(value),
      permission_set: METAFIELD_PERMISSION,
    };

    if (existing.length > 0) {
      const res = await this.v3.put(
        `/catalog/products/${productId}/metafields/${existing[0].id}`,
        payload
      );
      return res.data.data;
    } else {
      const res = await this.v3.post(
        `/catalog/products/${productId}/metafields`,
        payload
      );
      return res.data.data;
    }
  }

  async deleteProductMetafield(productId, namespace, key) {
    const existing = await this.getProductMetafields(productId, namespace, key);
    for (const mf of existing) {
      await this.v3.delete(
        `/catalog/products/${productId}/metafields/${mf.id}`
      );
    }
  }

  // ─── Categories ───────────────────────────────────────────────────────────────

  /**
   * Returns all categories in the store, paginating automatically.
   * Hard-coding limit:250 silently drops categories beyond 250 (BUG-15).
   */
  async getCategories() {
    const allCategories = [];
    let page = 1;
    while (true) {
      const res = await this.v3.get('/catalog/categories', {
        params: { limit: 250, page },
      });
      const batch = res.data.data || [];
      allCategories.push(...batch);
      const pagination = res.data.meta?.pagination;
      if (!pagination || page >= pagination.total_pages) break;
      page++;
    }
    return allCategories;
  }

  async getCategoryTree() {
    const res = await this.v3.get('/catalog/categories/tree');
    return res.data.data;
  }

  /**
   * Returns the ID of the hidden "Bundle Manager (System)" category.
   * Creates it if it doesn't exist yet.
   *
   * This category has is_visible=false so it never appears on the storefront.
   * It is used purely as a reliable filter key to list all bundle products via
   * GET /v3/catalog/products?categories=<id>, since the BC API does not support
   * filtering products by custom field values.
   *
   * Every bundle product is assigned to this category (in addition to any
   * visible categories the merchant selects). It should never be deleted.
   */
  async getOrCreateSystemCategory() {
    const SYSTEM_NAME = 'Bundle Manager (System)';

    // Search for the category by name
    const res = await this.v3.get('/catalog/categories', {
      params: { name: SYSTEM_NAME, limit: 1 },
    });

    if (res.data.data.length > 0) {
      return res.data.data[0].id;
    }

    // Create it hidden at the root level (parent_id: 0)
    const created = await this.v3.post('/catalog/categories', {
      name: SYSTEM_NAME,
      parent_id: 0,
      is_visible: false,
      description:
        'System category used by the Bundle Manager app to identify bundle products. ' +
        'Do not delete or rename this category.',
    });

    return created.data.data.id;
  }

  // ─── Inventory ────────────────────────────────────────────────────────────────

  async getProductInventory(productId) {
    const product = await this.getProduct(productId);
    // If inventory_tracking is 'product', use inventory_level
    // If 'variant', sum all variant levels
    if (product.inventory_tracking === 'none') {
      return Infinity; // treat as unlimited
    }
    // if (product.inventory_tracking === 'product') {
    //   return product.inventory_level ?? 0;
    // }
    if (product.inventory_tracking === 'variant') {
      return (product.variants || []).reduce(
        (sum, v) => sum + (v.inventory_level ?? 0),
        0
      );
    }
    return product.inventory_level ?? 0;
  }

  /**
   * Reserve or return a component's real inventory in BigCommerce.
   *
   * @param {number} productId
   * @param {number} delta  negative to RESERVE (deduct), positive to RETURN (add back)
   * @returns {{adjusted:boolean, level?:number, reason?:string}}
   *
   * Tracking behaviour:
   *  - 'none'    → untracked, nothing to reserve; skipped.
   *  - 'variant' → variant-level reservation is not handled in this version;
   *                skipped with a warning so variant stock is never corrupted.
   *  - 'product' → inventory_level is adjusted, clamped to a floor of 0.
   */
  async adjustProductInventory(productId, delta) {
    if (!delta) return { adjusted: false, reason: 'no-op (delta 0)' };

    const product = await this.getProduct(productId);

    if (product.inventory_tracking === 'none') {
      return { adjusted: false, reason: 'untracked — nothing to reserve' };
    }
    if (product.inventory_tracking === 'variant') {
      console.warn(
        `[Inventory] Product ${productId} is variant-tracked — skipping ` +
        `reservation (not supported in this version).`
      );
      return { adjusted: false, reason: 'variant tracking not supported' };
    }

    const current = product.inventory_level ?? 0;
    const next = Math.max(0, current + delta); // never below 0
    await this.updateProduct(productId, { inventory_level: next });
    return { adjusted: true, level: next };
  }

  // ─── Orders ───────────────────────────────────────────────────────────────────
  // Used to annotate an order with its bundle contents (written into staff_notes
  // so it shows on the admin order page). Orders live in the V2 API.

  /** Fetch a single order (V2). Returns null on 404. */
  async getOrder(orderId) {
    try {
      const res = await this.v2.get(`/orders/${orderId}`);
      return res.data;
    } catch (err) {
      if (err.response?.status === 404) return null;
      throw err;
    }
  }

  /**
   * Fetch the line items (products) of an order (V2). Each item includes
   * `id`, `product_id`, `name`, `sku`, `quantity`.
   */
  async getOrderProducts(orderId) {
    const res = await this.v2.get(`/orders/${orderId}/products`);
    return res.data || [];
  }

  /** Update an order (V2) — used to write the bundle breakdown into staff_notes. */
  async updateOrder(orderId, data) {
    const res = await this.v2.put(`/orders/${orderId}`, data);
    return res.data;
  }

  /** Read a single order metafield (V3), or null. Used as the inventory-
   *  adjustment idempotency record so retries can't double-apply. */
  async getOrderMetafield(orderId, namespace, key) {
    const res = await this.v3.get(`/orders/${orderId}/metafields`, {
      params: { namespace, key },
    });
    return res.data.data?.[0] || null;
  }

  /** Upsert an order metafield (V3). app_only — internal, not storefront-readable. */
  async upsertOrderMetafield(orderId, namespace, key, value) {
    const existing = await this.getOrderMetafield(orderId, namespace, key);
    const payload = {
      namespace,
      key,
      value: typeof value === 'string' ? value : JSON.stringify(value),
      permission_set: 'app_only',
    };
    if (existing) {
      const res = await this.v3.put(
        `/orders/${orderId}/metafields/${existing.id}`,
        payload
      );
      return res.data.data;
    }
    const res = await this.v3.post(`/orders/${orderId}/metafields`, payload);
    return res.data.data;
  }

  // ─── Webhooks ─────────────────────────────────────────────────────────────────

  /**
   * Register a webhook (idempotent).
   *
   * BigCommerce does NOT sign webhook payloads with an HMAC header. The
   * supported way to authenticate callbacks is to attach custom `headers` at
   * creation time — BC echoes them back on every delivery. We send a shared
   * secret header that the receiver compares in constant time.
   *
   * @param {string} scope
   * @param {string} destination
   * @param {Object} [headers]  custom headers BC will send back (e.g. secret)
   */
  async registerWebhook(scope, destination, headers = undefined) {
    // Check if already registered
    const existing = await this.v2.get('/hooks');
    const found = existing.data.find(
      (h) => h.scope === scope && h.destination === destination
    );
    // BUG-14: reactivate a deactivated webhook rather than leaving it dormant.
    // Also re-sync the secret header so rotating WEBHOOK_SECRET takes effect.
    if (found) {
      const needsReactivate = !found.is_active;
      const needsHeaderSync =
        headers && JSON.stringify(found.headers || {}) !== JSON.stringify(headers);
      if (needsReactivate || needsHeaderSync) {
        const payload = { is_active: true };
        if (headers) payload.headers = headers;
        await this.v2.put(`/hooks/${found.id}`, payload);
        console.log(
          `[Webhook] Updated webhook id=${found.id} scope=${scope} ` +
          `(reactivate=${needsReactivate}, headerSync=${needsHeaderSync})`
        );
      }
      return found;
    }

    const res = await this.v2.post('/hooks', {
      scope,
      destination,
      is_active: true,
      ...(headers ? { headers } : {}),
    });
    return res.data;
  }

  async listWebhooks() {
    const res = await this.v2.get('/hooks');
    return res.data;
  }

  // ─── Bundle helpers ───────────────────────────────────────────────────────────

  /**
   * Read the bundle config metafield from a bundle product.
   * Returns null if not a bundle.
   */
  async getBundleConfig(productId) {
    const mfs = await this.getProductMetafields(
      productId,
      BUNDLE_METAFIELD_NAMESPACE,
      BUNDLE_CONFIG_KEY
    );
    if (!mfs.length) return null;
    try {
      return JSON.parse(mfs[0].value);
    } catch {
      return null;
    }
  }

  /**
   * Read bundle membership metafield from a component product.
   * Returns array of bundle product IDs, or [].
   */
  async getBundleMemberships(productId) {
    const mfs = await this.getProductMetafields(
      productId,
      BUNDLE_METAFIELD_NAMESPACE,
      BUNDLE_MEMBERSHIP_KEY
    );
    if (!mfs.length) return [];
    try {
      const parsed = JSON.parse(mfs[0].value);
      return parsed.bundle_ids || [];
    } catch {
      return [];
    }
  }

  /**
   * Returns the bundle IDs a product is bound to.
   * Add a bundle product ID to a component product's membership list.
   */
  async addBundleMembership(componentProductId, bundleProductId) {
    const current = await this.getBundleMemberships(componentProductId);
    if (!current.includes(bundleProductId)) {
      current.push(bundleProductId);
    }
    await this.upsertProductMetafield(
      componentProductId,
      BUNDLE_METAFIELD_NAMESPACE,
      BUNDLE_MEMBERSHIP_KEY,
      { bundle_ids: current }
    );
  }

  /**
   * Remove a bundle product ID from a component product's membership list.
   */
  async removeBundleMembership(componentProductId, bundleProductId) {
    const current = await this.getBundleMemberships(componentProductId);
    const updated = current.filter((id) => id !== bundleProductId);
    if (updated.length === 0) {
      await this.deleteProductMetafield(
        componentProductId,
        BUNDLE_METAFIELD_NAMESPACE,
        BUNDLE_MEMBERSHIP_KEY
      );
    } else {
      await this.upsertProductMetafield(
        componentProductId,
        BUNDLE_METAFIELD_NAMESPACE,
        BUNDLE_MEMBERSHIP_KEY,
        { bundle_ids: updated }
      );
    }
  }
}

module.exports = {
  BigCommerceClient,
  BUNDLE_METAFIELD_NAMESPACE,
  BUNDLE_CONFIG_KEY,
  BUNDLE_MEMBERSHIP_KEY,
};
