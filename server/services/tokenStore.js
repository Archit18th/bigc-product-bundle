// /**
//  * Token Store — SQLite-backed persistence
//  *
//  * Stores per-store OAuth tokens and system category IDs in a local SQLite
//  * file that survives process restarts, deployments, and dyno recycles.
//  *
//  * WHY SQLite:
//  *   Zero external services — no Redis, no managed database to provision.
//  *   Works on every Node.js host. Single native dependency: better-sqlite3.
//  *
//  * SCALING TO MULTIPLE INSTANCES:
//  *   SQLite is single-file and does not support concurrent writes from
//  *   multiple processes. For horizontal scaling, replace this file with a
//  *   Redis implementation. The exported interface is identical — no other
//  *   file needs to change.
//  *
//  * DATABASE FILE:
//  *   Default: <project-root>/data/bundles.db
//  *   Override via DB_PATH env var (e.g. for a mounted volume on Railway).
//  *   Add data/ to .gitignore — never commit the database file.
//  */

// const Database = require('better-sqlite3');
// const path     = require('path');
// const fs       = require('fs');

// // ── Open database ─────────────────────────────────────────────────────────────

// const DATA_DIR = path.join(__dirname, '..', '..', 'data');
// fs.mkdirSync(DATA_DIR, { recursive: true });

// const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'bundles.db');
// const db = new Database(DB_PATH);

// // WAL mode: better concurrent read performance, safe for single-writer use
// db.pragma('journal_mode = WAL');
// db.pragma('foreign_keys = ON');

// db.exec(`
//   CREATE TABLE IF NOT EXISTS stores (
//     store_hash          TEXT    PRIMARY KEY,
//     access_token        TEXT    NOT NULL,
//     user_json           TEXT    NOT NULL DEFAULT '{}',
//     system_category_id  INTEGER,
//     updated_at          INTEGER NOT NULL DEFAULT (unixepoch())
//   )
// `);

// // ── Prepared statements ───────────────────────────────────────────────────────

// const stmts = {
//   get: db.prepare(
//     'SELECT * FROM stores WHERE store_hash = ?'
//   ),

//   upsert: db.prepare(`
//     INSERT INTO stores (store_hash, access_token, user_json, system_category_id, updated_at)
//     VALUES (@store_hash, @access_token, @user_json, @system_category_id, unixepoch())
//     ON CONFLICT(store_hash) DO UPDATE SET
//       access_token        = @access_token,
//       user_json           = @user_json,
//       system_category_id  = COALESCE(@system_category_id, system_category_id),
//       updated_at          = unixepoch()
//   `),

//   delete: db.prepare(
//     'DELETE FROM stores WHERE store_hash = ?'
//   ),

//   setCategoryId: db.prepare(
//     'UPDATE stores SET system_category_id = ?, updated_at = unixepoch() WHERE store_hash = ?'
//   ),
// };

// // ── In-flight deduplication (ephemeral, per-process) ─────────────────────────
// // Tracks in-progress getOrCreateSystemCategory promises to prevent duplicate
// // system categories when two requests race on first install. Intentionally
// // in-memory — it only spans the lifetime of a single request.
// const inFlightCategories = new Map();

// // ── Public interface ──────────────────────────────────────────────────────────

// function setStore(storeHash, data) {
//   stmts.upsert.run({
//     store_hash:         storeHash,
//     access_token:       data.accessToken,
//     user_json:          JSON.stringify(data.user || {}),
//     system_category_id: data.systemCategoryId || null,
//   });
// }

// function getStore(storeHash) {
//   const row = stmts.get.get(storeHash);
//   if (!row) return null;
//   return {
//     accessToken:      row.access_token,
//     user:             JSON.parse(row.user_json),
//     systemCategoryId: row.system_category_id ?? null,
//   };
// }

// function deleteStore(storeHash) {
//   stmts.delete.run(storeHash);
// }

// function getAccessToken(storeHash) {
//   const row = stmts.get.get(storeHash);
//   return row ? row.access_token : null;
// }

// function getSystemCategoryId(storeHash) {
//   const row = stmts.get.get(storeHash);
//   return row ? (row.system_category_id ?? null) : null;
// }

// function setSystemCategoryId(storeHash, categoryId) {
//   stmts.setCategoryId.run(categoryId, storeHash);
// }

// module.exports = {
//   setStore,
//   getStore,
//   deleteStore,
//   getAccessToken,
//   getSystemCategoryId,
//   setSystemCategoryId,
//   inFlightCategories,
// };
