require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { BigCommerceClient } = require('../services/bigcommerce');
(async () => {
  const prisma = new PrismaClient();
  const store = await prisma.store.findFirst();
  const client = new BigCommerceClient(store.storeHash, store.accessToken);
  const res = await client.v3.get('/catalog/products', { params: { keyword: 'LPHB3SQPHB26', limit: 10 } });
  for (const p of res.data.data) {
    console.log(`id=${p.id}  name="${p.name}"  inv=${p.inventory_level}  avail=${p.availability}`);
  }
  await prisma.$disconnect();
})().catch(e => { console.error(e.message); process.exit(1); });
