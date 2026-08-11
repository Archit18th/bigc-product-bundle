/**
 * Register the BigCommerce webhooks this app needs (idempotent), reading the
 * store credentials from the DB and the destination base URL / secret from env.
 *
 * Mirrors registerBundleWebhooks() in routes/api.js — use it to (re)create the
 * webhooks for testing without going through the session-authed API route.
 *
 * Usage: node scripts/register-webhooks.js
 * Requires: APP_URL (public/ngrok base URL) and WEBHOOK_SECRET in env.
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

  if (!process.env.APP_URL) throw new Error('APP_URL is not set in env.');

  const client = new BigCommerceClient(store.storeHash, store.accessToken);

  const hooks = [
    { scope: 'store/product/inventory/updated', destination: `${process.env.APP_URL}/webhooks/inventory` },
    { scope: 'store/product/updated', destination: `${process.env.APP_URL}/webhooks/inventory` },
    { scope: 'store/order/created', destination: `${process.env.APP_URL}/webhooks/order` },
    { scope: 'store/order/statusUpdated', destination: `${process.env.APP_URL}/webhooks/order-status` },
  ];

  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) {
    console.warn('[Webhook] WEBHOOK_SECRET is not set — registering without a verification header.');
  }
  const headers = secret ? { 'X-Bundle-Secret': secret } : undefined;

  console.log(`Store: ${store.storeHash}`);
  console.log(`Destination base: ${process.env.APP_URL}\n`);

  for (const { scope, destination } of hooks) {
    try {
      const result = await client.registerWebhook(scope, destination, headers);
      console.log(`✓ ${scope}  (id=${result.id}, active=${result.is_active})`);
      console.log(`    → ${destination}`);
    } catch (err) {
      console.warn(`✗ ${scope} failed: ${err.message}`);
    }
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Registration failed:', err.message);
  process.exit(1);
});
