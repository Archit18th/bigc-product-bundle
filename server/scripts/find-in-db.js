require('dotenv').config();
const prisma = require('../services/prisma');
(async () => {
  const term = process.argv[2] || 'LPHB3';
  const rows = await prisma.product.findMany({
    where: { OR: [ { sku: { contains: term } }, { name: { contains: term } } ] },
  });
  console.log(`Matches for "${term}" in products table: ${rows.length}\n`);
  for (const r of rows) {
    console.log(`productId=${r.productId}  sku=${r.sku}  inv=${r.inventoryLevel}  tracking=${r.inventoryTracking}  avail=${r.availability}  name="${r.name}"`);
  }
  await prisma.$disconnect();
})().catch(e => { console.error(e.message); process.exit(1); });
