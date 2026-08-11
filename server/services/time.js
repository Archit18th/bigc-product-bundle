/**
 * Time helpers.
 *
 * istNow() returns the current instant shifted to IST (UTC+5:30). When stored
 * in a UTC DateTime column, the wall-clock numbers read as Indian Standard Time
 * in MySQL / Prisma Studio.
 *
 * NOTE: intentionally non-standard (we normally store UTC). Used for the
 * human-facing timestamp columns where the merchant expects Indian time.
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function istNow() {
  return new Date(Date.now() + IST_OFFSET_MS);
}

module.exports = { istNow, IST_OFFSET_MS };
