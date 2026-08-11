/**
 * Token Store — Prisma-backed persistence (MySQL)
 *
 * Stores per-store OAuth tokens and system category IDs in MySQL via Prisma.
 * Data survives process restarts, deployments, and dyno recycles, and — unlike
 * the previous single-file SQLite store — supports concurrent writes from
 * multiple app instances, so the server can scale horizontally.
 *
 * CONNECTION:
 *   Configured by DATABASE_URL (see .env / .env.example). Schema lives in
 *   prisma/schema.prisma (model Store → table `stores`).
 *
 * NOTE: These functions are ASYNC (Prisma is promise-based). Callers must
 * await them. The previous better-sqlite3 implementation was synchronous.
 */

const prisma = require('./prisma');

// ── In-flight deduplication (ephemeral, per-process) ─────────────────────────
// Tracks in-progress getOrCreateSystemCategory promises to prevent duplicate
// system categories when two requests race on first install. Intentionally
// in-memory — it only spans the lifetime of a single request.
const inFlightCategories = new Map();

// ── Public interface ──────────────────────────────────────────────────────────

async function setStore(storeHash, data) {
  await prisma.store.upsert({
    where: { storeHash },
    create: {
      storeHash,
      accessToken: data.accessToken,
      userJson: data.user || {},
      systemCategoryId: data.systemCategoryId ?? null,
    },
    update: {
      accessToken: data.accessToken,
      userJson: data.user || {},
      // Preserve an existing category id when the caller passes null/undefined.
      ...(data.systemCategoryId != null
        ? { systemCategoryId: data.systemCategoryId }
        : {}),
    },
  });
}

async function getStore(storeHash) {
  const row = await prisma.store.findUnique({ where: { storeHash } });
  if (!row) return null;
  return {
    accessToken: row.accessToken,
    user: row.userJson || {},
    systemCategoryId: row.systemCategoryId ?? null,
  };
}

async function deleteStore(storeHash) {
  // deleteMany never throws if the row is absent (delete() would).
  await prisma.store.deleteMany({ where: { storeHash } });
}

async function getAccessToken(storeHash) {
  const row = await prisma.store.findUnique({
    where: { storeHash },
    select: { accessToken: true },
  });
  return row ? row.accessToken : null;
}

async function getSystemCategoryId(storeHash) {
  const row = await prisma.store.findUnique({
    where: { storeHash },
    select: { systemCategoryId: true },
  });
  return row ? (row.systemCategoryId ?? null) : null;
}

async function setSystemCategoryId(storeHash, categoryId) {
  await prisma.store.update({
    where: { storeHash },
    data: { systemCategoryId: categoryId },
  });
}

module.exports = {
  setStore,
  getStore,
  deleteStore,
  getAccessToken,
  getSystemCategoryId,
  setSystemCategoryId,
  inFlightCategories,
};
