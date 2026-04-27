#!/usr/bin/env node
'use strict';

/**
 * Rotate one upstream key in place. Existing api_keys binding is preserved.
 *
 * Usage:
 *   HOPEZ_POOL_MASTER_KEY=... node scripts/rotate-key.js <backend_key_id> <new-plaintext-key>
 */

require('dotenv').config();
const pool = require('../src/pool');

const id = parseInt(process.argv[2], 10);
const newKey = process.argv[3];

if (!id || !newKey) {
  console.error('Usage: rotate-key.js <backend_key_id> <new-key>');
  process.exit(1);
}

try {
  pool.rotateKey(id, newKey);
  console.log(`Rotated backend_key ${id}.`);
} catch (e) {
  console.error('Rotation failed:', e.message);
  process.exit(1);
}
