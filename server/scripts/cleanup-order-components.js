/**
 * Undo the $0 bundle-component injection on an order: remove the $0 component
 * line items we added (set their quantity to 0), then delete the tracking
 * metafield. Leaves the bundle line item and all genuinely-purchased items alone.
 *
 * A line is removed only if BOTH are true:
 *   - it is priced at 0 (price_inc_tax == 0 and price_ex_tax == 0), AND
 *   - its product_id is NOT itself a bundle (never remove the bundle line).
 *
 * Usage: node scripts/cleanup-order-components.js <orderId>
 *   e.g. node scripts/cleanup-order-components.js 322
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { BigCommerceClient, BUNDLE_METAFIELD_NAMESPACE } = require('../services/bigcommerce');

async function main() {
  const orderId = Number(process.argv[2]);
  if (!orderId) throw new Error('Usage: node scripts/cleanup-order-components.js <orderId>');

  const prisma = new PrismaClient();
  const store = process.env.STORE_HASH
    ? await prisma.store.findUnique({ where: { storeHash: process.env.STORE_HASH } })
    : await prisma.store.findFirst();
  if (!store) throw new Error('No store found in the DB.');

  const client = new BigCommerceClient(store.storeHash, store.accessToken);

  const items = await client.getOrderProducts(orderId);
  const toRemove = [];
  for (const it of items) {
    const isZero = Number(it.price_inc_tax) === 0 && Number(it.price_ex_tax) === 0;
    if (!isZero) continue;
    // Safety: never remove a bundle line, even if somehow priced 0.
    let isBundle = false;
    try {
      isBundle = !!(await client.getBundleConfig(Number(it.product_id)));
    } catch { /* treat as non-bundle */ }
    if (isBundle) continue;
    toRemove.push(it);
  }

  if (!toRemove.length) {
    console.log(`Order ${orderId}: no $0 component lines to remove.`);
  } else {
    console.log(`Order ${orderId}: removing ${toRemove.length} $0 line item(s):`);
    for (const it of toRemove) console.log(`  - ${it.name} (id=${it.id}, product_id=${it.product_id})`);
    // Setting quantity 0 removes the line item.
    await client.updateOrder(orderId, {
      products: toRemove.map((it) => ({ id: it.id, quantity: 0 })),
    });
  }

  // Delete the tracking metafield so the order is back to a clean state.
  const mf = await client.getOrderMetafield(orderId, BUNDLE_METAFIELD_NAMESPACE, 'components_added');
  if (mf) {
    await client.v3.delete(`/orders/${orderId}/metafields/${mf.id}`);
    console.log('Removed components_added metafield.');
  }

  const after = await client.getOrderProducts(orderId);
  const count = after.reduce((n, it) => n + Number(it.quantity), 0);
  console.log(`\nDone. Order ${orderId} now has ${after.length} line(s), item count = ${count}.`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Cleanup failed:', err.message);
  process.exit(1);
});
