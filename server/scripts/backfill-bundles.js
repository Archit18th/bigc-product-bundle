/**
 * One-off backfill: copy existing BigCommerce bundles into the local `bundles`
 * table. Bundles are discovered via bundleService.listBundles (the system-
 * category filter), then saved through bundleStore (IST timestamps).
 *
 * Run from server/:  node scripts/backfill-bundles.js
 */

require('dotenv').config();
const tokenStore = require('../services/tokenStore');
const bundleService = require('../services/bundleService');
const bundleStore = require('../services/bundleStore');

const STORE_HASH = process.argv[2] || 'vtc0o6t1vd';

(async () => {
  const token = await tokenStore.getAccessToken(STORE_HASH);
  if (!token) {
    console.error(`No access token for store ${STORE_HASH}.`);
    process.exit(1);
  }

  let page = 1;
  let saved = 0;
  while (true) {
    const { bundles, pagination } = await bundleService.listBundles(
      STORE_HASH,
      token,
      { limit: 50, page }
    );

    for (const b of bundles) {
      const config = b.bundle_config || {};
      await bundleStore.saveBundle(STORE_HASH, {
        bundleProductId: b.id,
        name: b.name,
        price: Number(b.price) || 0,
        salePrice: Number(b.sale_price) || 0,
        discountPercent: Number(config.discount_percent) || 0,
        inventoryLevel: b.inventory_level ?? 0,
        available: b.availability === 'available',
        components: config.products || [],
        url: b.custom_url?.url || null,
      });
      saved++;
      console.log(`  • saved bundle ${b.id} — ${b.name}`);
    }

    if (!pagination || page >= (pagination.total_pages || 1)) break;
    page++;
  }

  console.log(`\nBackfill complete: ${saved} bundle(s) saved for ${STORE_HASH}.`);
  process.exit(0);
})().catch((e) => {
  console.error('Backfill failed:', e.response?.data || e.message);
  process.exit(1);
});
