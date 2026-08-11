/**
 * Debug a single bundle's live availability calculation and (optionally) apply
 * the sync. Shows each component's live stock, qty, and buildable count, then
 * what inventory_level the bundle WOULD/DID get.
 *
 * Usage:
 *   node scripts/debug-bundle.js <bundleProductId>          # dry run (read only)
 *   node scripts/debug-bundle.js <bundleProductId> --apply  # run the real sync
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { BigCommerceClient } = require('../services/bigcommerce');
const bundleService = require('../services/bundleService');

async function main() {
  const bundleId = Number(process.argv[2]);
  const apply = process.argv.includes('--apply');
  if (!bundleId) throw new Error('Pass a bundle product id, e.g. node scripts/debug-bundle.js 4982');

  const prisma = new PrismaClient();
  const store = process.env.STORE_HASH
    ? await prisma.store.findUnique({ where: { storeHash: process.env.STORE_HASH } })
    : await prisma.store.findFirst();
  if (!store) throw new Error('No store found in the DB.');

  const client = new BigCommerceClient(store.storeHash, store.accessToken);

  // Current state of the bundle product itself.
  const bundleProduct = await client.getProduct(bundleId);
  console.log(`Bundle ${bundleId} "${bundleProduct.name}"`);
  console.log(`  current inventory_level: ${bundleProduct.inventory_level}`);
  console.log(`  current availability:    ${bundleProduct.availability}\n`);

  // Component breakdown (mirrors calcAvailability).
  const config = await client.getBundleConfig(bundleId);
  if (!config) throw new Error('No bundle config metafield — is this a bundle?');

  console.log('Components (live stock):');
  let minBuildable = Infinity;
  for (const item of config.products) {
    const p = await client.getProduct(item.product_id);
    const stock = p.inventory_level ?? 0;
    const qty = item.qty || 1;
    const buildable = Math.max(0, Math.floor((stock - 1) / qty));
    minBuildable = Math.min(minBuildable, buildable);
    console.log(
      `  - ${p.sku} (id ${item.product_id}): stock=${stock}, qty/bundle=${qty}, ` +
        `buildable=floor((${stock}-1)/${qty})=${buildable}` +
        (p.availability === 'disabled' ? '  [PRODUCT DISABLED]' : '')
    );
  }
  console.log(`\n  => bundle buildable (min) = ${minBuildable === Infinity ? 'unlimited' : minBuildable}`);
  console.log(`  => expected: inventory_level ${minBuildable > 0 ? minBuildable : 0}, ` +
    `availability ${minBuildable > 0 ? 'available' : 'disabled'}\n`);

  if (apply) {
    // Run the REAL sync path, keyed off the first component (as a webhook would).
    const changed = config.products[0].product_id;
    console.log(`Applying real syncBundleFromInventory (changed product ${changed})...`);
    const results = await bundleService.syncBundleFromInventory(
      store.storeHash,
      store.accessToken,
      changed
    );
    console.log('  result:', JSON.stringify(results));
    const after = await client.getProduct(bundleId);
    console.log(`  bundle now: inventory_level=${after.inventory_level}, availability=${after.availability}`);
  } else {
    console.log('(dry run — pass --apply to actually update the bundle)');
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Debug failed:', err.message);
  process.exit(1);
});
