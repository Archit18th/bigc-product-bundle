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
const tokenStore = require('./tokenStore'); 
const productIndex = require('./productIndex'); 
const bundleStore = require('./bundleStore');

const BUNDLE_MARKER_KEY = 'is_bundle'; // metafield on bundle products


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
  const cached = await tokenStore.getSystemCategoryId(storeHash);
  if (cached) return cached;

  // Deduplicate concurrent calls for the same store
  if (tokenStore.inFlightCategories.has(storeHash)) {
    return tokenStore.inFlightCategories.get(storeHash);
  }

  const promise = client.getOrCreateSystemCategory().then(async (id) => {
    await tokenStore.setSystemCategoryId(storeHash, id);
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
 * Generate the next auto SKU for a new bundle, e.g. "bundle-8".
 *
 * The number is max(highest existing "bundle-N" SKU, current bundle count) + 1:
 *   - the count term makes the FIRST auto-SKU pick up after existing bundles
 *     (7 bundles → "bundle-8") even if they don't yet follow the pattern;
 *   - the max term keeps it monotonic and collision-free afterwards, since BC
 *     requires unique SKUs and a deleted bundle's number must not be reused.
 * Bundles are the products in the hidden system category, so we page through it.
 */
async function nextBundleSku(client, systemCatId) {
  let maxNum = 0;
  let count = 0;
  let page = 1;
  let totalPages = 1;
  do {
    const res = await client.v3.get('/catalog/products', {
      params: {
        'categories:in': systemCatId,
        include_fields: 'sku',
        limit: 250,
        page,
      },
    });
    const rows = res.data.data || [];
    count = res.data.meta?.pagination?.total ?? count + rows.length;
    for (const p of rows) {
      const m = /^bundle-(\d+)$/i.exec(String(p.sku || '').trim());
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > maxNum) maxNum = n;
      }
    }
    totalPages = res.data.meta?.pagination?.total_pages || 1;
    page += 1;
  } while (page <= totalPages);
  return `bundle-${Math.max(maxNum, count) + 1}`;
}

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

  // 1b. Auto-assign a sequential SKU ("bundle-8") unless one was provided.
  const bundleSku = bundleData.sku || (await nextBundleSku(client, systemCatId));

  // 2. Resolve each component product to get its current stock
  const components = await resolveComponents(client, bundleData.products);

  // 3. Calculate availability
  const { minStock, available } = calcAvailability(components);

  // 3b. Calculate price from component prices + optional % discount.
  //     subtotal = Σ(price × qty); salePrice = subtotal − discount%.
  const { subtotal, salePrice, discountPercent } = calcPrice(
    components,
    bundleData.discount_percent
  );

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
    sku: bundleSku,
    // Mirror the SKU into search_keywords so the storefront search returns the
    // bundle when a shopper types its SKU (BC storefront search indexes
    // search_keywords; it does not reliably match the raw SKU field).
    search_keywords: bundleSku,
    type: 'physical',
    // BigCommerce requires `weight` for physical products (422 otherwise).
    // The create form doesn't collect it, so default to 0 — shipping is driven
    // by the real component products, not the bundle wrapper product.
    weight: bundleData.weight ?? 0,
    description: bundleData.description || '',
    // price = full component total (regular price). sale_price = discounted
    // price the customer pays (0 = no sale when there's no discount).
    price: subtotal,
    sale_price: discountPercent > 0 ? salePrice : 0,
    categories: allCategoryIds,
    availability: available ? 'available' : 'disabled',
    inventory_tracking: 'product',
    inventory_level: available ? minStock : 0,
    // Hidden from the storefront when it can't be built (out of stock on create).
    is_visible: available,
    custom_fields: [{ name: 'bundle_type', value: 'bc-bundle' }],
  });

  const bundleProductId = newProduct.id;

  // 5b. Assign the bundle to storefront channels so it's actually visible.
  //     v3 API-created products aren't auto-assigned to any channel, which
  //     leaves them invisible on every storefront. Mirror the components'
  //     channels (so the bundle appears wherever its parts do); fall back to
  //     channel 1 (the default storefront) if components have no assignments.
  const componentChannels = await client.getProductChannelAssignments(
    components.map((c) => c.product_id)
  );
  const channelIds = [...new Set(componentChannels.map((a) => a.channel_id))];
  await client.assignProductToChannels(
    bundleProductId,
    channelIds.length ? channelIds : [1]
  );

  // 4. Write config metafield on the bundle product
  const configValue = {
    is_bundle: true,
    discount_percent: discountPercent, // stored so EditBundle can show it
    // Whether purchases of this bundle expand into $0 component line items on the
    // order (toggled from the bundle list "Modify" action). Off by default.
    expand_on_order: false,
    products: components.map((c) => ({
      product_id: c.product_id,
      name: c.name,
      qty: c.qty,
      sku: c.sku,
      price: c.price,
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

  // 6. Reservation DISABLED. We no longer deduct component inventory when a
  //    bundle is created — component products keep their full BigCommerce stock
  //    (e.g. 10 stays 10) even though the bundle's own inventory_level is set to
  //    the buildable count (minStock). Original reserve logic kept for reference:
  const bundleStock = available ? minStock : 0;
  // if (bundleStock > 0) {
  //   await Promise.all(
  //     components.map((c) =>
  //       client.adjustProductInventory(c.product_id, -(bundleStock * c.qty))
  //     )
  //   );
  // }

  // Mirror the bundle into the local MySQL table (best-effort; BC is the source
  // of truth). Timestamps stored in IST.
  try {
    await bundleStore.saveBundle(storeHash, {
      bundleProductId,
      name: bundleData.name,
      price: subtotal,
      salePrice,
      discountPercent,
      inventoryLevel: bundleStock,
      available,
      components,
      url: newProduct.custom_url?.url || null,
    });
  } catch (err) {
    console.warn('[bundleStore] saveBundle (create) failed:', err.message);
  }

  return { bundle: newProduct, config: configValue, components };
}

// ─── Update Bundle SKU ───────────────────────────────────────────────────────

/**
 * Update just the SKU of a bundle (inline edit from the list). Verifies the
 * product is actually a bundle first, then patches the SKU on the BC product.
 * BigCommerce enforces SKU uniqueness across the catalog and surfaces a 409 if
 * the value is already taken — that error propagates to the caller.
 */
async function updateBundleSku(storeHash, accessToken, bundleProductId, sku) {
  const clean = String(sku || '').trim();
  if (!clean) throw new Error('SKU cannot be empty.');

  const client = bc(storeHash, accessToken);
  const config = await client.getBundleConfig(bundleProductId);
  if (!config) throw new Error('Product is not a bundle');

  // Keep search_keywords in sync with the SKU so storefront search finds the
  // bundle by its (new) SKU. Overwriting is intentional: for bundles this field
  // is app-managed and mirrors the SKU, so the previous SKU shouldn't linger.
  const updated = await client.updateProduct(bundleProductId, {
    sku: clean,
    search_keywords: clean,
  });
  return { id: updated.id, sku: updated.sku };
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

  // Reservation DISABLED: nothing was deducted on create, so there is nothing
  // to return here. (If we returned stock now without ever having reserved it,
  // component inventory would be inflated on every edit.) Kept for reference:
  // const currentBundle = await client.getProduct(bundleProductId);
  // const oldRemaining = currentBundle.inventory_level ?? 0;
  // if (oldRemaining > 0) {
  //   await Promise.all(
  //     (currentConfig?.products || []).map((p) =>
  //       client.adjustProductInventory(p.product_id, oldRemaining * (p.qty || 1))
  //     )
  //   );
  // }

  // Resolve new components (now reflects the returned stock)
  const components = await resolveComponents(client, updates.products);
  const newComponentIds = components.map((c) => c.product_id);

  const { minStock, available } = calcAvailability(components);

  // Recalculate price from the new components + discount. If the request omits
  // discount_percent, keep the bundle's existing discount.
  const effectiveDiscount =
    updates.discount_percent !== undefined
      ? updates.discount_percent
      : currentConfig?.discount_percent || 0;
  const { subtotal, salePrice, discountPercent } = calcPrice(
    components,
    effectiveDiscount
  );

  // Update the product itself.
  // Always re-inject the system category so it can't be accidentally removed.
  const productUpdates = {};
  if (updates.name !== undefined) productUpdates.name = updates.name;
  if (updates.description !== undefined) productUpdates.description = updates.description;
  // Price is now derived from components + discount, not taken from the client.
  productUpdates.price = subtotal;
  productUpdates.sale_price = discountPercent > 0 ? salePrice : 0;
  if (updates.category_ids !== undefined) {
    productUpdates.categories = [
      systemCatId,
      ...((updates.category_ids || []).filter((id) => id !== systemCatId)),
    ];
  }
  productUpdates.availability = available ? 'available' : 'disabled';
  productUpdates.inventory_level = available ? minStock : 0;
  // Keep storefront visibility in sync with buildability on every edit.
  productUpdates.is_visible = available;

  const updatedProduct = await client.updateProduct(bundleProductId, productUpdates);

  // Update config metafield
  const configValue = {
    is_bundle: true,
    discount_percent: discountPercent,
    // Preserve the "expand on order" toggle across edits.
    expand_on_order: !!currentConfig?.expand_on_order,
    products: components.map((c) => ({
      product_id: c.product_id,
      name: c.name,
      qty: c.qty,
      sku: c.sku,
      price: c.price,
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

  // Reservation DISABLED: do not deduct component inventory on update. The
  // bundle's own inventory_level still reflects the buildable count, but
  // component products keep their full stock. Kept for reference:
  const newBundleStock = available ? minStock : 0;
  // if (newBundleStock > 0) {
  //   await Promise.all(
  //     components.map((c) =>
  //       client.adjustProductInventory(c.product_id, -(newBundleStock * c.qty))
  //     )
  //   );
  // }

  // Update the local MySQL mirror (best-effort). Timestamps stored in IST.
  try {
    await bundleStore.saveBundle(storeHash, {
      bundleProductId,
      name: updatedProduct.name,
      price: subtotal,
      salePrice,
      discountPercent,
      inventoryLevel: newBundleStock,
      available,
      components,
      url: updatedProduct.custom_url?.url || null,
    });
  } catch (err) {
    console.warn('[bundleStore] saveBundle (update) failed:', err.message);
  }

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

  // Reservation DISABLED: nothing was ever deducted from components for this
  // bundle, so there is nothing to return on delete. Kept for reference:
  // const bundleProduct = await client.getProduct(bundleProductId);
  // const remaining = bundleProduct.inventory_level ?? 0;
  // if (remaining > 0) {
  //   await Promise.all(
  //     config.products.map((p) =>
  //       client.adjustProductInventory(p.product_id, remaining * (p.qty || 1))
  //     )
  //   );
  // }

  // Remove membership metafields from all components
  await Promise.all(
    componentIds.map((id) => client.removeBundleMembership(id, bundleProductId))
  );

  // Delete the bundle product from BigCommerce
  await client.deleteProduct(bundleProductId);

  // Remove the local MySQL mirror (best-effort).
  try {
    await bundleStore.removeBundle(storeHash, bundleProductId);
  } catch (err) {
    console.warn('[bundleStore] removeBundle failed:', err.message);
  }
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

  // Backfill component thumbnails for the bundle-list collage. Bundles created
  // before thumbnails were stored in the config have thumbnail: null, so fetch
  // each unique missing component once (deduped across all bundles) and fill it
  // in. This only mutates the in-memory response, not the stored metafield.
  const missingIds = new Set();
  for (const b of bundles) {
    for (const c of b.bundle_config?.products || []) {
      if (!c.thumbnail && c.product_id) missingIds.add(c.product_id);
    }
  }
  if (missingIds.size) {
    const thumbById = {};
    await Promise.all(
      [...missingIds].map(async (id) => {
        try {
          const p = await client.getProduct(id);
          thumbById[id] =
            p.images?.[0]?.url_thumbnail ||
            p.primary_image?.url_thumbnail ||
            null;
        } catch {
          thumbById[id] = null;
        }
      })
    );
    for (const b of bundles) {
      for (const c of b.bundle_config?.products || []) {
        if (!c.thumbnail && thumbById[c.product_id]) {
          c.thumbnail = thumbById[c.product_id];
        }
      }
    }
  }

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

 
  let enrichedProducts = config.products || [];
  if (enrichedProducts.length) {
    try {
      
      const resolved = await resolveComponents(client, config.products, {
        preferIndex: true,
      });
      enrichedProducts = resolved.map((c) => ({
        product_id: c.product_id,
        name: c.name,
        qty: c.qty,
        sku: c.sku,
        price: c.price, // live unit price — lets the form recompute the subtotal
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

// ─── Get Bundle Contents (storefront API) ──────────────────────────────────────

/**
 * Returns the component products INSIDE a bundle, for the storefront script to
 * list on the bundle product's own page ("This bundle includes…").
 * Reads the bundle_config metafield on the bundle product itself. Returns [] if
 * the product isn't a bundle.
 */
async function getBundleContents(storeHash, accessToken, productId) {
  const mapItem = (p) => ({
    product_id: p.product_id,
    name: p.name,
    qty: p.qty,
    sku: p.sku,
    thumbnail: p.thumbnail || null,
  });

  // DB-first: the bundle's component snapshot is mirrored locally on every
  // create/update, so a shopper page view needs zero BigCommerce calls.
  const row = await bundleStore.getByProductId(storeHash, productId);
  if (row && Array.isArray(row.components) && row.components.length) {
    return row.components.map(mapItem);
  }

  // Fallback: bundle not mirrored yet (e.g. created before mirroring, or never
  // backfilled) — read the bundle_config metafield live from BigCommerce.
  const client = bc(storeHash, accessToken);
  const config = await client.getBundleConfig(productId);
  if (!config || !Array.isArray(config.products)) return [];
  return config.products.map(mapItem);
}

// ─── Add a bundle to the cart (storefront API) ─────────────────────────────────

/**
 * Add a bundle to the shopper's cart. ONLY the bundle product is added — as a
 * single normal (priced) line item. The component breakdown is shown by the
 * storefront cart script (which fetches it from /storefront/bundle-contents),
 * NOT by adding components as cart lines. This keeps the cart's item count equal
 * to the number of bundles added (components don't inflate it) and the total
 * driven solely by the bundle product's price.
 *
 * @param {string} storeHash
 * @param {string} accessToken
 * @param {{bundleProductId:number, quantity?:number, cartId?:string, channelId?:number}} opts
 * @returns {Promise<{cartId:string, cartUrl:string|null, isBundle:boolean}>}
 */
async function addBundleToCart(storeHash, accessToken, opts = {}) {
  const client = bc(storeHash, accessToken);
  const bundleProductId = Number(opts.bundleProductId);
  const quantity = opts.quantity && opts.quantity > 0 ? Math.floor(opts.quantity) : 1;

  const config = await client.getBundleConfig(bundleProductId);
  if (!config || !Array.isArray(config.products) || config.products.length === 0) {
    return { cartId: null, cartUrl: null, isBundle: false };
  }

  const lineItems = [{ product_id: bundleProductId, quantity }];

  // Add to the shopper's existing cart when we have its id; otherwise create one.
  if (opts.cartId) {
    const cart = await client.addCartItems(opts.cartId, { lineItems });
    let cartUrl = null;
    try {
      cartUrl = (await client.getCartRedirectUrls(cart.id)).cart_url || null;
    } catch {
      cartUrl = null; // existing-cart path can just reload /cart.php
    }
    return { cartId: cart.id, cartUrl, isBundle: true };
  }

  const cart = await client.createCart({
    lineItems,
    channelId: opts.channelId,
  });
  const cartUrl = cart.redirect_urls?.cart_url || null;
  return { cartId: cart.id, cartUrl, isBundle: true };
}

// ─── Get Bundles For Product (storefront API) ──────────────────────────────────

/**
 * Returns lightweight bundle info for the storefront script — runs on every
 * shopper product-page view, so it is served from the local DB mirror.
 *
 * DB path (default once any bundle is mirrored): find the available bundles whose
 * component list contains this product, read their thumbnails from the local
 * product index, and build the storefront's pretty product URL — all with ZERO
 * BigCommerce calls.
 *
 * Live fallback (only when the store has no mirrored bundles yet, e.g. a fresh
 * install before the backfill runs): read the membership metafield + each
 * bundle product from BigCommerce, the original behaviour.
 */
async function getBundlesForProduct(storeHash, accessToken, productId) {
  // Is the local mirror populated for this store? If so, trust it.
  const mirrored = await bundleStore.count(storeHash);

  if (mirrored > 0) {
    const rows = await bundleStore.findAvailableContaining(storeHash, productId);
    if (!rows.length) return [];

    // Bundle product thumbnails come from the local product index (DB, no API).
    // Missing thumbnails just render the storefront's placeholder.
    const thumbs = await productIndex.getProducts(
      storeHash,
      rows.map((r) => r.bundleProductId)
    );

    // Use the stored SEO url. For any bundle not yet backfilled (url null), fetch
    // its custom_url live ONCE so the storefront link never 404s. After a backfill
    // this path makes zero BigCommerce calls.
    const client = bc(storeHash, accessToken);

    return Promise.all(
      rows.map(async (b) => {
        const price = Number(b.price) || 0;
        const sale = Number(b.salePrice) || 0;
        const onSale = sale > 0 && sale < price;
        const indexed = thumbs.get(b.bundleProductId);

        let url = b.url || null;
        if (!url) {
          try {
            url = (await client.getProduct(b.bundleProductId)).custom_url?.url || null;
          } catch {
            url = null;
          }
        }

        return {
          id: b.bundleProductId,
          name: b.name,
          price,
          sale_price: onSale ? sale : null,
          calculated_price: onSale ? sale : price,
          availability: b.available ? 'available' : 'disabled',
          url: url || `/product.php?productId=${b.bundleProductId}`,
          thumbnail: (indexed && indexed.thumbnail) || null,
        };
      })
    );
  }

  // ── Live fallback: store not mirrored yet ───────────────────────────────────
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

// ─── Annotate Order with Bundle Contents ───────────────────────────────────────

// Marker fencing off the section of staff_notes we manage, so re-runs are
// idempotent (BC may deliver store/order/created more than once) and any notes
// a human added before it are preserved.
const ORDER_NOTE_MARKER = '[Bundle Contents]';

/**
 * When an order is created, look at every line item, find the ones that are
 * bundle products, and write a breakdown of each bundle's component products +
 * quantities into the order's staff_notes — so it's visible on the admin order
 * page.
 *
 * Frozen per order: the breakdown is written once at order creation and is not
 * rewritten when the bundle is later edited, so historical orders keep what they
 * contained at purchase time. Does NOT touch inventory (read-only on config).
 *
 * Idempotent: everything from ORDER_NOTE_MARKER onward is rewritten each run, so
 * a re-delivered webhook never duplicates the breakdown.
 *
 * @returns {{updated:boolean, bundles:number}}
 */
async function annotateOrderWithBundleContents(storeHash, accessToken, orderId) {
  const client = bc(storeHash, accessToken);

  const items = await client.getOrderProducts(orderId);
  if (!items.length) return { updated: false, bundles: 0 };

  // Resolve each line item's product to its bundle config (null when not a
  // bundle). De-dupe lookups by product_id in case a bundle appears twice.
  const uniqueProductIds = [
    ...new Set(items.map((i) => Number(i.product_id)).filter(Boolean)),
  ];
  const configById = new Map();
  await Promise.all(
    uniqueProductIds.map(async (pid) => {
      try {
        configById.set(pid, await client.getBundleConfig(pid));
      } catch {
        configById.set(pid, null);
      }
    })
  );

  // Build a breakdown block per bundle line item.
  const blocks = [];
  for (const item of items) {
    const config = configById.get(Number(item.product_id));
    if (!config || !Array.isArray(config.products) || !config.products.length) continue;

    const orderedQty = Number(item.quantity) || 1;
    const lines = config.products.map((c) => {
      // per-bundle qty × how many of the bundle were ordered
      const totalQty = (Number(c.qty) || 1) * orderedQty;
      const sku = c.sku ? ` (SKU: ${c.sku})` : '';
      return `   • ${totalQty} × ${c.name}${sku}`;
    });

    const header =
      orderedQty > 1 ? `${item.name} ×${orderedQty} contains:` : `${item.name} contains:`;
    blocks.push([header, ...lines].join('\n'));
  }

  if (!blocks.length) return { updated: false, bundles: 0 };

  const managedSection = `${ORDER_NOTE_MARKER}\n${blocks.join('\n\n')}`;

  // Preserve any notes a human wrote before our marker.
  const order = await client.getOrder(orderId);
  const existing = (order?.staff_notes || '').trim();
  const markerIdx = existing.indexOf(ORDER_NOTE_MARKER);
  const preserved = markerIdx >= 0 ? existing.slice(0, markerIdx).trim() : existing;
  const staff_notes = preserved ? `${preserved}\n\n${managedSection}` : managedSection;

  // Skip the write if nothing changed (avoids needless API calls on re-delivery).
  if ((order?.staff_notes || '').trim() === staff_notes.trim()) {
    return { updated: false, bundles: blocks.length };
  }

  await client.updateOrder(orderId, { staff_notes });
  return { updated: true, bundles: blocks.length };
}

// ─── Order Bundle Composition (storefront display) ─────────────────────────────

/**
 * Return the bundle composition for an order, for the storefront order-
 * confirmation / order-details page. For each bundle line item, returns the
 * bundle name, how many were ordered, and the component products + quantities.
 *
 * Returns ONLY display data (names, quantities, component thumbnails/SKUs) — no
 * prices, addresses or other order PII — so it's safe to serve on the public
 * (CORS-open) storefront API.
 *
 * @returns {Array<{name, quantity, products: Array<{name, qty, sku, thumbnail}>}>}
 */
async function getOrderBundleComposition(storeHash, accessToken, orderId) {
  const client = bc(storeHash, accessToken);

  const items = await client.getOrderProducts(orderId);
  if (!items.length) return [];

  const uniqueProductIds = [
    ...new Set(items.map((i) => Number(i.product_id)).filter(Boolean)),
  ];
  const configById = new Map();
  await Promise.all(
    uniqueProductIds.map(async (pid) => {
      try {
        configById.set(pid, await client.getBundleConfig(pid));
      } catch {
        configById.set(pid, null);
      }
    })
  );

  // Backfill thumbnails missing from the stored config (bundles created before
  // thumbnails were captured) from the local product index — DB-first, no API.
  const componentIds = new Set();
  for (const cfg of configById.values()) {
    for (const c of cfg?.products || []) {
      if (!c.thumbnail && c.product_id) componentIds.add(Number(c.product_id));
    }
  }
  const thumbIndex = componentIds.size
    ? await productIndex.getProducts(storeHash, [...componentIds])
    : new Map();

  const bundles = [];
  for (const item of items) {
    const config = configById.get(Number(item.product_id));
    if (!config || !Array.isArray(config.products) || !config.products.length) continue;
    bundles.push({
      name: item.name || '',
      quantity: Number(item.quantity) || 1,
      products: config.products.map((c) => ({
        name: c.name,
        qty: Number(c.qty) || 1,
        sku: c.sku || null,
        thumbnail:
          c.thumbnail ||
          thumbIndex.get(Number(c.product_id))?.thumbnail ||
          null,
      })),
    });
  }
  return bundles;
}

// ─── Component Inventory on Purchase / Cancel ───────────────────────────────────

// Order metafield holding the inventory-adjustment record:
//   { state: 'deducted' | 'restored', adjustments: [{ product_id, units }] }
// Storing the exact units deducted makes the operation idempotent (a re-delivered
// webhook is a no-op) AND lets us restore precisely on cancel/refund even if the
// bundle was edited in between.
const ORDER_INVENTORY_KEY = 'inventory_adjusted';

// BC order status_ids that mean the order is reversed → restore component stock.
//   4 Refunded · 5 Cancelled · 6 Declined
const RESTORE_STATUS_IDS = new Set([4, 5, 6]);

/** Read the inventory-adjustment record from the order, or null. */
async function readInventoryRecord(client, orderId) {
  const mf = await client.getOrderMetafield(
    orderId,
    BUNDLE_METAFIELD_NAMESPACE,
    ORDER_INVENTORY_KEY
  );
  if (!mf) return null;
  try {
    return JSON.parse(mf.value);
  } catch {
    return null;
  }
}

/** Recalculate one bundle's availability + inventory_level from current
 *  component stock (same logic syncBundleFromInventory applies per bundle). */
async function resyncBundleInventory(client, bundleId) {
  const config = await client.getBundleConfig(bundleId);
  if (!config) return;
  const components = await resolveComponents(client, config.products);
  const { minStock, available } = calcAvailability(components);
  await client.updateProduct(bundleId, {
    availability: available ? 'available' : 'disabled',
    inventory_level: available ? minStock : 0,
    // Hide from storefront listings when unbuildable; re-list on restock.
    is_visible: available,
  });
}

/** Resolve the bundle line items of an order → [{ bundleProductId, orderedQty,
 *  components: [{ product_id, qty }] }]. Non-bundle line items are ignored. */
async function getOrderBundleLines(client, orderId) {
  const items = await client.getOrderProducts(orderId);
  if (!items.length) return [];

  const uniqueIds = [...new Set(items.map((i) => Number(i.product_id)).filter(Boolean))];
  const configById = new Map();
  await Promise.all(
    uniqueIds.map(async (pid) => {
      try {
        configById.set(pid, await client.getBundleConfig(pid));
      } catch {
        configById.set(pid, null);
      }
    })
  );

  const lines = [];
  for (const item of items) {
    const config = configById.get(Number(item.product_id));
    if (!config || !Array.isArray(config.products) || !config.products.length) continue;
    lines.push({
      bundleProductId: Number(item.product_id),
      orderedQty: Number(item.quantity) || 1,
      // Whether this bundle is flagged to expand into $0 component lines on orders.
      expandOnOrder: !!config.expand_on_order,
      components: config.products.map((c) => ({
        product_id: c.product_id,
        qty: Number(c.qty) || 1,
      })),
    });
  }
  return lines;
}

/**
 * Turn the "expand on order" flag on/off for a bundle. When ON, purchases of this
 * bundle get their component products added to the order as $0 line items (by the
 * order webhook). Stored inside the bundle_config metafield so listBundles sees it.
 *
 * @returns {{enabled:boolean}}
 */
async function setBundleExpandFlag(storeHash, accessToken, bundleProductId, enabled) {
  const client = bc(storeHash, accessToken);
  const config = await client.getBundleConfig(bundleProductId);
  if (!config) throw new Error('Product is not a bundle');

  await client.upsertProductMetafield(
    bundleProductId,
    BUNDLE_METAFIELD_NAMESPACE,
    BUNDLE_CONFIG_KEY,
    { ...config, expand_on_order: !!enabled }
  );
  return { enabled: !!enabled };
}

/**
 * Deduct component inventory for the bundles in a newly-created order.
 *
 * For each bundle line item, every component is deducted by
 * (component qty × quantity ordered), then each affected bundle is re-synced so
 * its buildable count reflects the new component stock — keeping the bundle list
 * AND the edit screen consistent.
 *
 * Idempotent: writes a record of exactly what was deducted to an order
 * metafield and refuses to run twice. Returns a summary.
 *
 * Note: only product-tracked components are adjusted; variant- and non-tracked
 * components are skipped by adjustProductInventory (and therefore not recorded
 * or restored).
 */
async function deductOrderBundleInventory(storeHash, accessToken, orderId) {
  const client = bc(storeHash, accessToken);

  const record = await readInventoryRecord(client, orderId);
  if (record?.state) return { skipped: true, reason: `already ${record.state}` };

  const lines = await getOrderBundleLines(client, orderId);
  if (!lines.length) return { skipped: true, reason: 'no bundles in order' };

  // Sum units per component across all bundle lines (a component may appear in
  // more than one bundle on the same order).
  const unitsByProduct = new Map();
  for (const line of lines) {
    for (const c of line.components) {
      const units = c.qty * line.orderedQty;
      unitsByProduct.set(c.product_id, (unitsByProduct.get(c.product_id) || 0) + units);
    }
  }

  const adjustments = [];
  for (const [productId, units] of unitsByProduct) {
    const res = await client.adjustProductInventory(productId, -units);
    if (res.adjusted) adjustments.push({ product_id: productId, units });
  }

  // Re-sync every bundle in the order so its count drops in BOTH the bundle list
  // (reads inventory_level) and the edit screen (recomputes from components).
  const bundleIds = [...new Set(lines.map((l) => l.bundleProductId))];
  for (const bid of bundleIds) {
    try {
      await resyncBundleInventory(client, bid);
    } catch (err) {
      console.warn(`[inventory] resync bundle ${bid} failed:`, err.message);
    }
  }

  await client.upsertOrderMetafield(
    orderId,
    BUNDLE_METAFIELD_NAMESPACE,
    ORDER_INVENTORY_KEY,
    { state: 'deducted', adjustments }
  );

  return { mode: 'deduct', adjusted: adjustments.length, bundles: bundleIds.length };
}

/**
 * Restore component inventory for an order that was cancelled/refunded/declined.
 * Adds back EXACTLY what was deducted (from the stored record), so it is correct
 * even if the bundle was edited after purchase. Idempotent: only runs when the
 * order is currently in a deducted state.
 */
async function restoreOrderBundleInventory(storeHash, accessToken, orderId) {
  const client = bc(storeHash, accessToken);

  const record = await readInventoryRecord(client, orderId);
  if (!record || record.state !== 'deducted') {
    return { skipped: true, reason: record ? `state=${record.state}` : 'never deducted' };
  }

  const adjustments = record.adjustments || [];
  for (const a of adjustments) {
    await client.adjustProductInventory(a.product_id, +a.units);
  }

  // Re-sync bundles that contain any restored component.
  const affected = new Set();
  for (const a of adjustments) {
    try {
      (await client.getBundleMemberships(a.product_id)).forEach((b) => affected.add(b));
    } catch { /* ignore */ }
  }
  for (const bid of affected) {
    try {
      await resyncBundleInventory(client, bid);
    } catch (err) {
      console.warn(`[inventory] resync bundle ${bid} failed:`, err.message);
    }
  }

  await client.upsertOrderMetafield(
    orderId,
    BUNDLE_METAFIELD_NAMESPACE,
    ORDER_INVENTORY_KEY,
    { state: 'restored', adjustments }
  );

  return { mode: 'restore', restored: adjustments.length };
}

/**
 * Called from the order status webhook. Restores component stock only when the
 * order has moved into a reversed status (refunded/cancelled/declined).
 */
async function handleOrderStatusForInventory(storeHash, accessToken, orderId) {
  const client = bc(storeHash, accessToken);
  const order = await client.getOrder(orderId);
  if (!order) return { skipped: true, reason: 'order not found' };
  if (!RESTORE_STATUS_IDS.has(Number(order.status_id))) {
    return { skipped: true, reason: `status ${order.status_id} not a reversal` };
  }
  return restoreOrderBundleInventory(storeHash, accessToken, orderId);
}

// ─── Add Bundle Component Line Items at $0 ──────────────────────────────────────

// Order metafield marking that we've injected each bundle's component products
// into this order as $0 line items. Idempotency guard so a re-delivered
// store/order/created webhook doesn't add the components twice.
const ORDER_COMPONENTS_KEY = 'components_added';

/**
 * For each bundle in a newly-created order, add the bundle's component products
 * to the order as ADDITIONAL line items priced at $0.00 — so the order lists
 * exactly what physically ships, while the existing bundle line keeps carrying
 * the price. The original bundle line item is left untouched.
 *
 * Adds via PUT /v2/orders/{id} with a `products` array: each entry has
 * `product_id` + `quantity` and NO `id` (which tells BC to add a new line rather
 * than update an existing one), and overrides BOTH `price_inc_tax` and
 * `price_ex_tax` to 0 (BC requires both or order totals miscalculate).
 *
 * Note: these component lines count toward the order's item total (BC sums line
 * item quantities), so an order for one bundle of 5 components shows as 6 items.
 *
 * Idempotent: writes a marker order metafield and refuses to run twice, so a
 * re-delivered webhook won't duplicate the component lines.
 *
 * @returns {{skipped?:boolean, reason?:string, added?:number, bundles?:number}}
 */
async function addBundleComponentsToOrder(storeHash, accessToken, orderId) {
  const client = bc(storeHash, accessToken);

  // Idempotency guard — bail if we've already injected components for this order.
  const existing = await client.getOrderMetafield(
    orderId,
    BUNDLE_METAFIELD_NAMESPACE,
    ORDER_COMPONENTS_KEY
  );
  if (existing) return { skipped: true, reason: 'already added' };

  // Which line items are bundles, and what are their components? (null-config
  // items — i.e. plain products — are ignored by getOrderBundleLines.)
  const allLines = await getOrderBundleLines(client, orderId);
  if (!allLines.length) return { skipped: true, reason: 'no bundles in order' };

  // Only expand bundles the merchant flagged via the "Modify" action. Bundles
  // with the toggle off are left as a single line item on the order.
  const lines = allLines.filter((l) => l.expandOnOrder);
  if (!lines.length) return { skipped: true, reason: 'no bundles flagged to expand' };

  // Sum quantity per component across all bundle lines (a component may appear
  // in more than one bundle on the same order, and each bundle may be ordered
  // in qty > 1). units = component qty × how many of that bundle were ordered.
  const qtyByProduct = new Map();
  for (const line of lines) {
    for (const c of line.components) {
      const qty = c.qty * line.orderedQty;
      qtyByProduct.set(c.product_id, (qtyByProduct.get(c.product_id) || 0) + qty);
    }
  }

  const products = [...qtyByProduct.entries()].map(([product_id, quantity]) => ({
    product_id,
    quantity,
    price_inc_tax: 0,
    price_ex_tax: 0,
  }));

  await client.updateOrder(orderId, { products });

  // Record what we added so re-deliveries are a no-op.
  await client.upsertOrderMetafield(
    orderId,
    BUNDLE_METAFIELD_NAMESPACE,
    ORDER_COMPONENTS_KEY,
    { state: 'added', products }
  );

  return { added: products.length, bundles: lines.length };
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

      // Reservation DISABLED: the bundle no longer sets aside component stock,
      // so its buildable count is NOT a stored "reserved" value to protect —
      // it must be re-derived LIVE from current component stock every time a
      // component's inventory or availability changes. This is what makes a
      // bundle go out of stock when a component drops below the quantity the
      // bundle needs (e.g. bundle needs 6 of product A, A falls to 5 → the
      // bundle becomes unbuildable → inventory_level 0 + disabled).
      const components = await resolveComponents(client, config.products);
      const { minStock, available } = calcAvailability(components);

      await client.updateProduct(bundleId, {
        availability: available ? 'available' : 'disabled',
        inventory_level: available ? minStock : 0,
        // Hide the bundle from the storefront when it can't be built. Setting
        // is_visible=false removes it from storefront category/search listings
        // (availability=disabled only blocks purchase); BC re-lists it as soon
        // as we flip it back to true on restock.
        is_visible: available,
      });

      // No local-mirror update needed: listBundles reads inventory_level and
      // availability LIVE from BigCommerce, so updating the BC product above is
      // enough for the bundle list and storefront to reflect the new state.
      results.push({ bundleId, available, inventoryLevel: available ? minStock : 0 });
    } catch (err) {
      console.error(`Failed to sync bundle ${bundleId}:`, err.message);
    }
  }

  return results;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Fetch current product data for each component.
 *
 * BUG-10: previously called getProduct + getProductInventory per component,
 * which internally called getProduct again — 2N API calls instead of N.
 * Stock is now computed inline from the product we already fetched.
 *
 * Reading source:
 *  - preferIndex=false (default): read LIVE from the BigCommerce API. Used by
 *    create/update where inventory is RESERVED — stale stock could over-reserve.
 *  - preferIndex=true: read from the local product index (DB) in one batched
 *    query, falling back to a live API fetch for any component not yet indexed.
 *    Used by display paths (e.g. viewing a bundle) for speed / fewer API calls.
 *
 * @param {BigCommerceClient} client
 * @param {Array<{product_id, qty}>} products
 * @param {{preferIndex?: boolean}} [opts]
 */
async function resolveComponents(client, products, { preferIndex = false } = {}) {
  // Build component info straight from a BC product object.
  const fromBC = (item, p) => {
    let stock;
    if (p.inventory_tracking === 'none') {
      stock = Infinity; // unlimited / untracked
    } else if (p.inventory_tracking === 'variant') {
      stock = (p.variants || []).reduce((sum, v) => sum + (v.inventory_level ?? 0), 0);
    } else {
      stock = p.inventory_level ?? 0;
    }
    return {
      product_id: item.product_id,
      qty: item.qty || 1,
      name: p.name,
      sku: p.sku,
      price: Number(p.price) || 0,
      stock,
      productAvailability: p.availability,
      thumbnail:
        p.images?.[0]?.url_thumbnail || p.primary_image?.url_thumbnail || null,
    };
  };

  // Build component info from an indexed (DB) product (already normalized).
  const fromIndex = (item, c) => ({
    product_id: item.product_id,
    qty: item.qty || 1,
    name: c.name,
    sku: c.sku,
    price: Number(c.price) || 0,
    stock: c.stock, // 'none' tracking already mapped to Infinity by the index
    productAvailability: c.availability,
    thumbnail: c.thumbnail || null,
  });

  // Live path: one getProduct per component (original behaviour).
  if (!preferIndex) {
    return Promise.all(
      products.map(async (item) =>
        fromBC(item, await client.getProduct(item.product_id))
      )
    );
  }

  // Index path: one batched DB read, live fallback only for misses.
  const ids = products.map((p) => p.product_id);
  const indexed = await productIndex.getProducts(client.storeHash, ids);

  return Promise.all(
    products.map(async (item) => {
      const cached = indexed.get(item.product_id);
      if (cached) return fromIndex(item, cached);
      // Not in the index yet — fall back to a live fetch (and the index endpoint
      // / webhooks will pick it up on the next sync).
      return fromBC(item, await client.getProduct(item.product_id));
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
 * Bundle inventory_level = the number of COMPLETE bundles that can be built
 * while leaving at least 1 unit of each component in the store, i.e. the
 * minimum of floor((component_stock - 1) / component_qty) across all
 * components. This is the amount the bundle RESERVES from each component.
 * Example: 2 of a product with 20 in stock → floor((20-1)/2) = 9 (leaves 2).
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
    // Reservation model: always leave at least 1 unit of each component in the
    // store, so a bundle never fully empties a product's standalone stock.
    // buildable = floor((stock - 1) / qty). Untracked components (Infinity)
    // never constrain the bundle.
    const buildable =
      c.stock === Infinity ? Infinity : Math.max(0, Math.floor((c.stock - 1) / qty));

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

/**
 * Calculate bundle pricing from component prices and a percentage discount.
 *
 *   subtotal  = Σ (component_unit_price × qty)   — the regular price
 *   salePrice = subtotal × (1 − discountPercent/100)  — what the customer pays
 *
 * The merchant no longer sets a price directly; it is derived from the
 * components, then reduced by an optional discount expressed as a percentage.
 *
 * @param {Array<{price:number, qty:number}>} components
 * @param {number} discountPercent  0–100 (clamped). 0 = no discount.
 * @returns {{subtotal:number, salePrice:number, discountPercent:number}}
 */
function calcPrice(components, discountPercent = 0) {
  const pct = Math.min(100, Math.max(0, Number(discountPercent) || 0));
  const subtotal = components.reduce(
    (sum, c) => sum + (Number(c.price) || 0) * (c.qty && c.qty > 0 ? c.qty : 1),
    0
  );
  const round2 = (n) => Math.round(n * 100) / 100;
  return {
    subtotal: round2(subtotal),
    salePrice: round2(subtotal * (1 - pct / 100)),
    discountPercent: pct,
  };
}

module.exports = {
  createBundle,
  updateBundle,
  updateBundleSku,
  deleteBundle,
  listBundles,
  getBundle,
  getBundlesForProduct,
  getBundleContents,
  addBundleToCart,
  syncBundleFromInventory,
  annotateOrderWithBundleContents,
  getOrderBundleComposition,
  deductOrderBundleInventory,
  addBundleComponentsToOrder,
  setBundleExpandFlag,
  restoreOrderBundleInventory,
  handleOrderStatusForInventory,
  ensureSystemCategory,
  nextBundleSku,
};
