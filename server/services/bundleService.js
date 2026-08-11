/**
 * Bundle Service
 *
 * All bundle business logic lives here:
 *  - createBundle   — create a BC product + set metafields on all parties
 *  - updateBundle   — update product + re-sync metafields
 *  - deleteBundle   — remove product + clean up memberships
 *  - listBundles    — find all bundle products in the store
 *  - syncBundleFromInventory — recalculate availability when stock changes
 *  - getBundlesForProduct  — find bundles that contain a given product
 */

const { BigCommerceClient, BUNDLE_METAFIELD_NAMESPACE, BUNDLE_CONFIG_KEY } = require('./bigcommerce');
const tokenStore = require('./tokenStore'); // BUG-23: use service module, not route module

const BUNDLE_MARKER_KEY = 'is_bundle'; // metafield on bundle products

/**
 * Build a BigCommerceClient from storeHash + accessToken.
 */
function bc(storeHash, accessToken) {
  return new BigCommerceClient(storeHash, accessToken);
}

/**
 * Returns the system category ID, creating it if needed, with deduplication
 * to prevent a race condition creating duplicate system categories (BUG-05).
 *
 * Uses a per-store in-flight promise so concurrent first calls share one
 * getOrCreateSystemCategory request rather than each firing independently.
 */
async function ensureSystemCategory(client, storeHash) {
  const cached = tokenStore.getSystemCategoryId(storeHash);
  if (cached) return cached;

  // Deduplicate concurrent calls for the same store
  if (tokenStore.inFlightCategories.has(storeHash)) {
    return tokenStore.inFlightCategories.get(storeHash);
  }

  const promise = client.getOrCreateSystemCategory().then((id) => {
    tokenStore.setSystemCategoryId(storeHash, id);
    tokenStore.inFlightCategories.delete(storeHash);
    return id;
  }).catch((err) => {
    tokenStore.inFlightCategories.delete(storeHash);
    throw err;
  });

  tokenStore.inFlightCategories.set(storeHash, promise);
  return promise;
}

// ─── Create Bundle ─────────────────────────────────────────────────────────────

/**
 * @param {string} storeHash
 * @param {string} accessToken
 * @param {Object} bundleData
 * @param {string} bundleData.name
 * @param {string} bundleData.description
 * @param {number} bundleData.price         — merchant-set bundle price
 * @param {number[]} bundleData.category_ids — categories for this bundle
 * @param {Array<{product_id, qty}>} bundleData.products
 * @returns {Object} created bundle product + resolved component info
 */
async function createBundle(storeHash, accessToken, bundleData) {
  const client = bc(storeHash, accessToken);

  // 1. Ensure the hidden system category exists (created once per store)
  const systemCatId = await ensureSystemCategory(client, storeHash);

  // 2. Resolve each component product to get its current stock
  const components = await resolveComponents(client, bundleData.products);

  // 3. Calculate availability
  const { minStock, available } = calcAvailability(components);

  // 4. Build the full category list:
  //    - System category (hidden, used for reliable listing/filtering)
  //    - Plus any visible categories the merchant selected
  const allCategoryIds = [
    systemCatId,
    ...((bundleData.category_ids || []).filter((id) => id !== systemCatId)),
  ];

  // 5. Create the bundle product in BigCommerce.
  //    This is a real catalog product — it appears in the Products admin,
  //    storefront search, BC reports, and Google Analytics just like any
  //    other product. The system category keeps it identifiable as a bundle.
  const newProduct = await client.createProduct({
    name: bundleData.name,
    type: 'physical',
    description: bundleData.description || '',
    price: bundleData.price,
    categories: allCategoryIds,
    availability: available ? 'available' : 'disabled',
    inventory_tracking: 'product',
    inventory_level: available ? minStock : 0,
    is_visible: true,
    custom_fields: [{ name: 'bundle_type', value: 'bc-bundle' }],
  });

  const bundleProductId = newProduct.id;

  // 4. Write config metafield on the bundle product
  const configValue = {
    is_bundle: true,
    products: components.map((c) => ({
      product_id: c.product_id,
      name: c.name,
      qty: c.qty,
      sku: c.sku,
      thumbnail: c.thumbnail,
    })),
  };
  await client.upsertProductMetafield(
    bundleProductId,
    BUNDLE_METAFIELD_NAMESPACE,
    BUNDLE_CONFIG_KEY,
    configValue
  );

  // Mark as bundle (easier lookup)
  await client.upsertProductMetafield(
    bundleProductId,
    BUNDLE_METAFIELD_NAMESPACE,
    BUNDLE_MARKER_KEY,
    'true'
  );

  // 5. Write membership metafields on each component product
  await Promise.all(
    components.map((c) =>
      client.addBundleMembership(c.product_id, bundleProductId)
    )
  );

  return { bundle: newProduct, config: configValue, components };
}

// ─── Update Bundle ─────────────────────────────────────────────────────────────

async function updateBundle(storeHash, accessToken, bundleProductId, updates) {
  // BUG-03: guard against missing products array before any API calls
  if (!updates.products || updates.products.length < 2) {
    throw new Error('products array with at least 2 items is required.');
  }

  const client = bc(storeHash, accessToken);

  // Ensure system category is available
  const systemCatId = await ensureSystemCategory(client, storeHash);

  // Read current config
  const currentConfig = await client.getBundleConfig(bundleProductId);
  const oldComponentIds = (currentConfig?.products || []).map(
    (p) => p.product_id
  );

  // Resolve new components
  const components = await resolveComponents(client, updates.products);
  const newComponentIds = components.map((c) => c.product_id);

  const { minStock, available } = calcAvailability(components);

  // Update the product itself.
  // Always re-inject the system category so it can't be accidentally removed.
  const productUpdates = {};
  if (updates.name !== undefined) productUpdates.name = updates.name;
  if (updates.description !== undefined) productUpdates.description = updates.description;
  if (updates.price !== undefined) productUpdates.price = updates.price;
  if (updates.category_ids !== undefined) {
    productUpdates.categories = [
      systemCatId,
      ...((updates.category_ids || []).filter((id) => id !== systemCatId)),
    ];
  }
  productUpdates.availability = available ? 'available' : 'disabled';
  productUpdates.inventory_level = available ? minStock : 0;

  const updatedProduct = await client.updateProduct(bundleProductId, productUpdates);

  // Update config metafield
  const configValue = {
    is_bundle: true,
    products: components.map((c) => ({
      product_id: c.product_id,
      name: c.name,
      qty: c.qty,
      sku: c.sku,
      thumbnail: c.thumbnail,
    })),
  };
  await client.upsertProductMetafield(
    bundleProductId,
    BUNDLE_METAFIELD_NAMESPACE,
    BUNDLE_CONFIG_KEY,
    configValue
  );

  // Remove membership from products no longer in bundle
  const removed = oldComponentIds.filter((id) => !newComponentIds.includes(id));
  const added = newComponentIds.filter((id) => !oldComponentIds.includes(id));

  await Promise.all([
    ...removed.map((id) => client.removeBundleMembership(id, bundleProductId)),
    ...added.map((id) => client.addBundleMembership(id, bundleProductId)),
  ]);

  return { bundle: updatedProduct, config: configValue, components };
}

// ─── Delete Bundle ─────────────────────────────────────────────────────────────

async function deleteBundle(storeHash, accessToken, bundleProductId) {
  const client = bc(storeHash, accessToken);

  // BUG-13: verify this product is actually a bundle before deleting
  const config = await client.getBundleConfig(bundleProductId);
  if (!config) {
    throw new Error(`Product ${bundleProductId} is not a bundle — refusing to delete.`);
  }

  const componentIds = config.products.map((p) => p.product_id);

  // Remove membership metafields from all components
  await Promise.all(
    componentIds.map((id) => client.removeBundleMembership(id, bundleProductId))
  );

  // Delete the bundle product from BigCommerce
  await client.deleteProduct(bundleProductId);
}

// ─── List Bundles ──────────────────────────────────────────────────────────────

/**
 * List all bundle products for a store.
 *
 * Bundles are identified by membership in the hidden "Bundle Manager (System)"
 * category — a reliable BC-native filter that the v3 products API supports
 * via the `categories` query param.
 *
 * NOTE: The BC v3 API does NOT support filtering products by custom_field
 * values, so that approach (which was here before) silently returns all
 * products. This category-based approach is the correct method.
 */
async function listBundles(storeHash, accessToken, params = {}) {
  const client = bc(storeHash, accessToken);

  // Ensure (and cache) the system category ID
  const systemCatId = await ensureSystemCategory(client, storeHash);

  const res = await client.v3.get('/catalog/products', {
    params: {
      // BUG-08: correct BC v3 filter param is 'categories:in', not 'categories'
      'categories:in': systemCatId,
      include: 'custom_fields,images,primary_image',
      limit: params.limit || 50,
      page: params.page || 1,
    },
  });

  const products = res.data.data;
  const pagination = res.data.meta?.pagination;

  // Enrich with bundle config metafields.
  // BUG-12: strip the system category from each bundle's categories array so
  // the client never sees or accidentally re-submits it.
  const bundles = await Promise.all(
    products.map(async (p) => {
      const config = await client.getBundleConfig(p.id);
      return {
        ...p,
        categories: (p.categories || []).filter((id) => id !== systemCatId),
        bundle_config: config,
      };
    })
  );

  return { bundles, pagination, systemCategoryId: systemCatId };
}

// ─── Get Single Bundle ─────────────────────────────────────────────────────────

async function getBundle(storeHash, accessToken, bundleProductId) {
  const client = bc(storeHash, accessToken);
  const [product, config, systemCatId] = await Promise.all([
    client.getProduct(bundleProductId),
    client.getBundleConfig(bundleProductId),
    ensureSystemCategory(client, storeHash),
  ]);
  if (!config) throw new Error('Product is not a bundle');

  // Enrich each stored component with its CURRENT stock and availability so the
  // edit form shows live status instead of '—'. Falls back to the stored config
  // if a component can no longer be resolved (e.g. it was deleted).
  let enrichedProducts = config.products || [];
  if (enrichedProducts.length) {
    try {
      const resolved = await resolveComponents(client, config.products);
      enrichedProducts = resolved.map((c) => ({
        product_id: c.product_id,
        name: c.name,
        qty: c.qty,
        sku: c.sku,
        thumbnail: c.thumbnail,
        // Infinity (untracked) isn't JSON-friendly — send null to mean "untracked".
        stock: c.stock === Infinity ? null : c.stock,
        availability: c.productAvailability,
      }));
    } catch (err) {
      console.warn(`[getBundle] Could not resolve live component stock: ${err.message}`);
    }
  }

  return {
    ...product,
    // Strip the hidden system category so EditBundle never receives it in
    // category_ids — keeps the form state clean and avoids confusion.
    categories: (product.categories || []).filter((id) => id !== systemCatId),
    bundle_config: { ...config, products: enrichedProducts },
  };
}

// ─── Get Bundles For Product (storefront API) ──────────────────────────────────

/**
 * Returns lightweight bundle info for the storefront script.
 * Reads the membership metafield from the component product,
 * then fetches basic info for each bundle.
 */
async function getBundlesForProduct(storeHash, accessToken, productId) {
  const client = bc(storeHash, accessToken);

  const bundleIds = await client.getBundleMemberships(productId);
  if (!bundleIds.length) return [];

  const bundles = await Promise.all(
    bundleIds.map(async (bid) => {
      try {
        const product = await client.getProduct(bid);
        return {
          id: product.id,
          name: product.name,
          price: product.price,
          sale_price: product.sale_price,
          calculated_price: product.calculated_price,
          availability: product.availability,
          url: product.custom_url?.url || `/product.php?productId=${product.id}`,
          thumbnail:
            product.images?.[0]?.url_thumbnail ||
            product.primary_image?.url_thumbnail ||
            null,
        };
      } catch {
        return null;
      }
    })
  );

  return bundles.filter(Boolean).filter((b) => b.availability === 'available');
}

// ─── Sync Bundle from Inventory Change ─────────────────────────────────────────

/**
 * Called when a product's inventory OR availability changes (two webhooks).
 * Finds all bundles that contain this product and recalculates their
 * availability and stock level from scratch.
 *
 * Safe to call for bundle products themselves: bundle products do not have a
 * 'bundle_memberships' metafield, so getBundleMemberships returns [] and this
 * function exits immediately — no circular update loop.
 */
async function syncBundleFromInventory(storeHash, accessToken, changedProductId) {
  const client = bc(storeHash, accessToken);

  const bundleIds = await client.getBundleMemberships(changedProductId);
  if (!bundleIds.length) return []; // product is not a bundle component — nothing to do

  const results = [];

  for (const bundleId of bundleIds) {
    try {
      const config = await client.getBundleConfig(bundleId);
      if (!config) continue;

      const components = await resolveComponents(client, config.products);
      const { minStock, available } = calcAvailability(components);

      await client.updateProduct(bundleId, {
        availability: available ? 'available' : 'disabled',
        inventory_level: available ? minStock : 0,
      });

      results.push({ bundleId, available, minStock });
    } catch (err) {
      console.error(`Failed to sync bundle ${bundleId}:`, err.message);
    }
  }

  return results;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Fetch current product data for each component in a single getProduct call.
 *
 * BUG-10: previously called getProduct + getProductInventory per component,
 * which internally called getProduct again — 2N API calls instead of N.
 * Stock is now computed inline from the product we already fetched.
 *
 * @param {BigCommerceClient} client
 * @param {Array<{product_id, qty}>} products
 */
async function resolveComponents(client, products) {
  return Promise.all(
    products.map(async (item) => {
      const p = await client.getProduct(item.product_id);

      // Compute stock from the already-fetched product (no second API call)
      let stock;
      if (p.inventory_tracking === 'none') {
        stock = Infinity; // unlimited / untracked
      } else if (p.inventory_tracking === 'variant') {
        stock = (p.variants || []).reduce(
          (sum, v) => sum + (v.inventory_level ?? 0),
          0
        );
      } else {
        stock = p.inventory_level ?? 0;
      }

      return {
        product_id: item.product_id,
        qty: item.qty || 1,
        name: p.name,
        sku: p.sku,
        stock,
        productAvailability: p.availability, // 'available' | 'disabled' | 'preorder'
        thumbnail:
          p.images?.[0]?.url_thumbnail ||
          p.primary_image?.url_thumbnail ||
          null,
      };
    })
  );
}

/**
 * Calculate bundle availability and inventory level.
 *
 * A bundle is available only when ALL component products satisfy BOTH:
 *   1. availability === 'available'  (product is not manually disabled)
 *   2. enough stock to build at least one full bundle (stock >= qty)
 *
 * Bundle inventory_level = the number of COMPLETE bundles that can be built,
 * i.e. the minimum of floor(component_stock / component_qty) across all
 * components. This correctly accounts for per-component quantities: a bundle
 * that uses 3 of a product with 6 in stock can only be built twice.
 *
 * If a merchant manually disables a component in the BC Products admin (without
 * touching stock), the bundle is disabled on the next product/updated webhook
 * sync — or instantly on create/edit.
 */
function calcAvailability(components) {
  let minBuildable = Infinity;
  let available = true;
  let disabledReason = null;

  for (const c of components) {
    // 'preorder' is purchasable — treat the same as 'available'
    const productEnabled = c.productAvailability !== 'disabled';

    if (!productEnabled) {
      available = false;
      disabledReason = disabledReason || `${c.name} is disabled`;
    }

    const qty = c.qty && c.qty > 0 ? c.qty : 1;
    // Untracked components (stock === Infinity) never constrain the bundle.
    const buildable = c.stock === Infinity ? Infinity : Math.floor(c.stock / qty);

    if (buildable === 0) {
      available = false;
      disabledReason =
        disabledReason ||
        (c.stock === 0
          ? `${c.name} is out of stock`
          : `${c.name} has insufficient stock (${c.stock}) for the required quantity (${qty})`);
    }

    if (buildable < minBuildable) {
      minBuildable = buildable;
    }
  }

  // If all components have unlimited tracking, treat bundle stock as 9999
  if (minBuildable === Infinity) minBuildable = 9999;

  // If bundle is disabled, inventory_level = 0 so BC hides Add to Cart
  return { minStock: available ? minBuildable : 0, available, disabledReason };
}

module.exports = {
  createBundle,
  updateBundle,
  deleteBundle,
  listBundles,
  getBundle,
  getBundlesForProduct,
  syncBundleFromInventory,
  ensureSystemCategory,
};
