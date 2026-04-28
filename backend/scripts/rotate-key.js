'use strict';

/**
 * Rotate a single backend pool key.
 *   node scripts/rotate-key.js <id> <new-raw-key>
 */

require('dotenv').config();
const db = require('../src/db');
const pool = require('../src/pool');

(async () => {
  try {
    const id = parseInt(process.argv[2], 10);
    const newKey = process.argv[3];
    if (!id || !newKey) {
      console.error('Usage: node scripts/rotate-key.js <id> <new-key>');
      process.exit(1);
    }
    await db.init();
    await pool.rotateKey(id, newKey);
    console.log(`[rotate-key] backend_key #${id} rotated.`);
    process.exit(0);
  } catch (e) {
    console.error('[rotate-key] FAILED:', e.message);
    process.exit(1);
  }
})();
