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

  async getProduct(productId) {
    const res = await this.v3.get(`/catalog/products/${productId}`, {
      params: { include: 'variants' },
    });
    return res.data.data;
  }

  async createProduct(data) {
    const res = await this.v3.post('/catalog/products', data);
    return res.data.data;
  }

  async updateProduct(productId, data) {
    const res = await this.v3.put(`/catalog/products/${productId}`, data);
    return res.data.data;
  }

  async deleteProduct(productId) {
    await this.v3.delete(`/catalog/products/${productId}`);
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
    if (product.inventory_tracking === 'product') {
      return product.inventory_level ?? 0;
    }
    if (product.inventory_tracking === 'variant') {
      return (product.variants || []).reduce(
        (sum, v) => sum + (v.inventory_level ?? 0),
        0
      );
    }
    return product.inventory_level ?? 0;
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
