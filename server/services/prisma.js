/**
 * Shared Prisma client.
 *
 * A single PrismaClient is reused across the whole process (Prisma pools
 * connections internally). Import this module anywhere you need DB access:
 *
 *   const prisma = require('./prisma');
 *   await prisma.store.findUnique({ ... });
 */

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// Close the pool cleanly on shutdown so the process can exit.
process.on('beforeExit', () => {
  prisma.$disconnect();
});

module.exports = prisma;
