/**
 * Verify the $0 bundle-component injection for a given order.
 *
 * Prints every line item with its price, flags which items are bundles vs plain
 * products, and shows the `components_added` idempotency metafield we write.
 *
 * Usage: node scripts/verify-order-components.js <orderId>
 *   e.g. node scripts/verify-order-components.js 321
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { BigCommerceClient } = require('../services/bigcommerce');
const { BUNDLE_METAFIELD_NAMESPACE } = require('../services/bigcommerce');

async function main() {
  const orderId = Number(process.argv[2]);
  if (!orderId) throw new Error('Usage: node scripts/verify-order-components.js <orderId>');

  const prisma = new PrismaClient();
  const store = process.env.STORE_HASH
    ? await prisma.store.findUnique({ where: { storeHash: process.env.STORE_HASH } })
    : await prisma.store.findFirst();
  if (!store) throw new Error('No store found in the DB.');

  const client = new BigCommerceClient(store.storeHash, store.accessToken);

  const items = await client.getOrderProducts(orderId);
  console.log(`Order ${orderId} — ${items.length} line item(s):\n`);

  for (const it of items) {
    // A product is a bundle iff it has our bundle_components metafield.
    let isBundle = false;
    try {
      isBundle = !!(await client.getBundleConfig(Number(it.product_id)));
    } catch { /* treat as non-bundle */ }

    const price = Number(it.price_inc_tax);
    const tag = isBundle ? 'BUNDLE ' : (price === 0 ? '$0 COMP' : 'PRODUCT');
    console.log(
      `  [${tag}] ${it.name}  ×${it.quantity}  ` +
      `(product_id=${it.product_id}, price_inc_tax=${it.price_inc_tax})`
    );
  }

  const mf = await client.getOrderMetafield(
    orderId,
    BUNDLE_METAFIELD_NAMESPACE,
    'components_added'
  );
  console.log('\ncomponents_added metafield:', mf ? mf.value : '(none — injection has not run)');

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Verify failed:', err.message);
  process.exit(1);
});
