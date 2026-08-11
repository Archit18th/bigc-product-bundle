/**
 * User Store — Prisma-backed persistence (MySQL)
 *
 * Stores per-store BigCommerce user info (user id, email, access token) in the
 * `users` table. One row per (storeHash, bcUserId) pair — a store can have
 * several users. Populated from the OAuth /auth and /load callbacks.
 *
 * All functions are async (Prisma is promise-based) — callers must await.
 */

const prisma = require('./prisma');
const { istNow } = require('./time');

/**
 * Insert or update a user for a store.
 * Keyed on (storeHash, bcUserId) so re-installs / repeat loads update in place.
 *
 * @param {string} storeHash
 * @param {Object} user                  BigCommerce user payload
 * @param {number} user.id               BC user id
 * @param {string} [user.email]
 * @param {string} [user.locale]
 * @param {string} [accessToken]         OAuth token for this store
 */
async function upsertUser(storeHash, user = {}, accessToken = null) {
  const bcUserId = user.id ?? null;

  // Without a BC user id we can't key the unique pair — just insert a row.
  if (bcUserId == null) {
    return prisma.user.create({
      data: {
        storeHash,
        bcUserId: null,
        email: user.email ?? null,
        accessToken,
        locale: user.locale ?? null,
      },
    });
  }

  return prisma.user.upsert({
    where: { store_user: { storeHash, bcUserId } },
    create: {
      storeHash,
      bcUserId,
      email: user.email ?? null,
      accessToken,
      locale: user.locale ?? null,
    },
    update: {
      email: user.email ?? null,
      // Only overwrite the token when a fresh one is provided.
      ...(accessToken != null ? { accessToken } : {}),
      locale: user.locale ?? null,
    },
  });
}

/**
 * Stamp `catalogLastSync = now` after a product re-index.
 * If bcUserId is given, only that user is stamped; otherwise all of the store's
 * users are updated. Returns the number of rows touched.
 */
async function markCatalogSynced(storeHash, bcUserId = null, when = istNow()) {
  const where = bcUserId != null ? { storeHash, bcUserId } : { storeHash };
  const result = await prisma.user.updateMany({
    where,
    data: { catalogLastSync: when },
  });
  return result.count;
}

/** Set a user's login status flag (true = logged in). */
async function setUserStatus(storeHash, bcUserId, loggedIn) {
  const result = await prisma.user.updateMany({
    where: { storeHash, bcUserId },
    data: { userStatus: !!loggedIn },
  });
  return result.count;
}

/** All users for a store. */
async function getUsersForStore(storeHash) {
  return prisma.user.findMany({ where: { storeHash } });
}

/** Remove every user belonging to a store (e.g. on uninstall). */
async function deleteUsersForStore(storeHash) {
  await prisma.user.deleteMany({ where: { storeHash } });
}

module.exports = {
  upsertUser,
  markCatalogSynced,
  setUserStatus,
  getUsersForStore,
  deleteUsersForStore,
};
