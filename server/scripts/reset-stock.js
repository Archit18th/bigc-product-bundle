/**
 * One-time stock reset.
 *
 * Fixes inventory drift left over from bundle reserve/return operations that
 * ran before reservation was disabled. Sets each listed product's
 * inventory_level back to its true standalone value.
 *
 * Usage:
 *   node scripts/reset-stock.js                # uses defaults below
 *   node scripts/reset-stock.js LPHB3=10 SQPHB26=10
 *
 * Each arg is SKU=desiredStock. With no args, TARGETS below is used.
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { BigCommerceClient } = require('../services/bigcommerce');

// Default reset targets (SKU -> desired inventory_level).
const TARGETS = {
  LPHB3: 10,
  SQPHB26: 10,
};

function parseArgs() {
  const args = process.argv.slice(2);
  if (!args.length) return TARGETS;
  const out = {};
  for (const a of args) {
    const [sku, val] = a.split('=');
    if (!sku || val === undefined || Number.isNaN(Number(val))) {
      throw new Error(`Bad arg "${a}" — expected SKU=number, e.g. LPHB3=10`);
    }
    out[sku] = Number(val);
  }
  return out;
}

async function main() {
  const targets = parseArgs();
  const prisma = new PrismaClient();

  // Pick the store. If there are multiple, set STORE_HASH in the env to choose.
  const store = process.env.STORE_HASH
    ? await prisma.store.findUnique({ where: { storeHash: process.env.STORE_HASH } })
    : await prisma.store.findFirst();

  if (!store) {
    throw new Error('No store found in the DB. Is the app installed/authed?');
  }
  console.log(`Store: ${store.storeHash}\n`);

  const client = new BigCommerceClient(store.storeHash, store.accessToken);

  for (const [sku, desired] of Object.entries(targets)) {
    // Exact SKU lookup via v3 catalog filter.
    const res = await client.v3.get('/catalog/products', { params: { sku } });
    const product = res.data.data?.[0];
    if (!product) {
      console.log(`✗ ${sku}: not found — skipped`);
      continue;
    }
    if (product.inventory_tracking !== 'product') {
      console.log(
        `! ${sku} (id ${product.id}): inventory_tracking="${product.inventory_tracking}" ` +
          `(not "product") — skipped to avoid touching variant/untracked stock`
      );
      continue;
    }
    const before = product.inventory_level ?? 0;
    if (before === desired) {
      console.log(`= ${sku} (id ${product.id}): already ${desired} — no change`);
      continue;
    }
    await client.updateProduct(product.id, { inventory_level: desired });
    console.log(`✓ ${sku} (id ${product.id}): ${before} → ${desired}`);
  }

  await prisma.$disconnect();
  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Reset failed:', err.message);
  process.exit(1);
});
