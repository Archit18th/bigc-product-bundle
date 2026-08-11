/**
 * Lists the BigCommerce webhooks currently registered for the store, so we can
 * confirm the inventory-sync webhooks exist and are active.
 *
 * Usage: node scripts/check-webhooks.js
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { BigCommerceClient } = require('../services/bigcommerce');

async function main() {
  const prisma = new PrismaClient();
  const store = process.env.STORE_HASH
    ? await prisma.store.findUnique({ where: { storeHash: process.env.STORE_HASH } })
    : await prisma.store.findFirst();
  if (!store) throw new Error('No store found in the DB.');

  const client = new BigCommerceClient(store.storeHash, store.accessToken);
  const hooks = await client.listWebhooks();

  console.log(`Store: ${store.storeHash}`);
  console.log(`App URL (env): ${process.env.APP_URL}\n`);
  if (!hooks.length) {
    console.log('No webhooks registered.');
  } else {
    for (const h of hooks) {
      console.log(`- ${h.scope}`);
      console.log(`    destination: ${h.destination}`);
      console.log(`    active: ${h.is_active}`);
    }
  }
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Check failed:', err.message);
  process.exit(1);
});
