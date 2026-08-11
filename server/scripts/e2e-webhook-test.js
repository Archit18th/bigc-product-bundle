require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { BigCommerceClient } = require('../services/bigcommerce');

const COMPONENT = 4920;   // LPHB3
const BUNDLE = 4983;      // LPHB3SQPHB26
const NEW_STOCK = Number(process.argv[2] ?? 8);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const prisma = new PrismaClient();
  const store = await prisma.store.findFirst();
  const client = new BigCommerceClient(store.storeHash, store.accessToken);

  const before = await client.getProduct(BUNDLE);
  console.log(`Bundle before: inv=${before.inventory_level}, avail=${before.availability}`);
  console.log(`\nSetting LPHB3 (${COMPONENT}) stock -> ${NEW_STOCK} via API (this fires the webhook)...\n`);
  await client.updateProduct(COMPONENT, { inventory_level: NEW_STOCK });

  for (let i = 1; i <= 8; i++) {
    await sleep(2000);
    const b = await client.getProduct(BUNDLE);
    console.log(`  +${i * 2}s  bundle inv=${b.inventory_level}, avail=${b.availability}`);
    const expected = Math.max(0, Math.floor((NEW_STOCK - 1) / 6));
    if (b.inventory_level === expected && (expected > 0 ? b.availability === 'available' : b.availability === 'disabled')) {
      console.log(`\n✓ Webhook auto-updated the bundle to the expected value (${expected}). Pipeline works end-to-end.`);
      break;
    }
  }
  await prisma.$disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
