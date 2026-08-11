/**
 * One-off backfill: copy the old SQLite `stores` table into the new
 * MySQL tables (Store + User) via Prisma.
 *
 * Old schema (better-sqlite3):
 *   stores(store_hash, access_token, user_json, system_category_id, updated_at)
 * The user_json blob held the BigCommerce user payload ({ id, email, ... }).
 *
 * Run from server/:  node scripts/backfill-from-sqlite.js
 */

require('dotenv').config();
const path = require('path');
const Database = require('better-sqlite3');
const tokenStore = require('../services/tokenStore');
const userStore = require('../services/userStore');

const DB_PATH =
  process.env.DB_PATH ||
  path.join(__dirname, '..', '..', 'data', 'bundles.db');

(async () => {
  const db = new Database(DB_PATH, { readonly: true });
  const rows = db.prepare('SELECT * FROM stores').all();
  console.log(`Found ${rows.length} store row(s) in ${DB_PATH}`);

  let storesDone = 0;
  let usersDone = 0;

  for (const row of rows) {
    let user = {};
    try {
      user = JSON.parse(row.user_json || '{}');
    } catch {
      user = {};
    }

    // 1. Store row (token + system category)
    await tokenStore.setStore(row.store_hash, {
      accessToken: row.access_token,
      user,
      systemCategoryId: row.system_category_id ?? null,
    });
    storesDone++;

    // 2. User row (id, email, token) — only if there's a user payload
    if (user && (user.id != null || user.email)) {
      await userStore.upsertUser(row.store_hash, user, row.access_token);
      usersDone++;
    }

    console.log(
      `  • store ${row.store_hash} → user id=${user.id ?? '—'}, email=${user.email ?? '—'}`
    );
  }

  db.close();
  console.log(`\nBackfill complete: ${storesDone} store(s), ${usersDone} user(s).`);
  process.exit(0);
})().catch((e) => {
  console.error('Backfill failed:', e);
  process.exit(1);
});
