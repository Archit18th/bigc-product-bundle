require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { BigCommerceClient } = require('../services/bigcommerce');

(async () => {
  const prisma = new PrismaClient();
  const store = await prisma.store.findFirst();
  const client = new BigCommerceClient(store.storeHash, store.accessToken);

  console.log(`Store: ${store.storeHash}\nFetching all products from BigCommerce...`);
  let pages = 0;
  const products = await client.getAllProducts((info) => { pages = info.totalPages; });
  console.log(`  fetched: ${products.length} products across ${pages} pages`);

  // duplicate ids?
  const ids = new Set();
  let dupes = 0;
  for (const p of products) { if (ids.has(p.id)) dupes++; ids.add(p.id); }
  console.log(`  unique product ids: ${ids.size}  (duplicates: ${dupes})`);

  // values that would overflow the schema
  const longName = products.filter((p) => (p.name ?? '').length > 255);
  const longSku  = products.filter((p) => (p.sku ?? '').length > 100);
  console.log(`  names  > 255 chars: ${longName.length}`);
  console.log(`  skus   > 100 chars: ${longSku.length}`);
  for (const p of [...longName.slice(0,5), ...longSku.slice(0,5)]) {
    console.log(`    - id ${p.id}: nameLen=${(p.name??'').length} skuLen=${(p.sku??'').length}`);
  }

  const dbCount = await prisma.product.count({ where: { storeHash: store.storeHash } });
  console.log(`\n  rows currently in Prisma DB: ${dbCount}`);

  await prisma.$disconnect();
})().catch((e) => { console.error('DIAG ERROR:', e.message); process.exit(1); });
