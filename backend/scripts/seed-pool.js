'use strict';

/**
 * Seed the backend pool with mock keys (dev only) or real keys from env.
 *   node scripts/seed-pool.js            # 305 mock keys
 *   node scripts/seed-pool.js --real     # comma-separated POOL_SEED_KEYS env var
 */

require('dotenv').config();
const db = require('../src/db');
const pool = require('../src/pool');
const { loadConfig } = require('../src/config');

(async () => {
  try {
    await db.init();
    const cfg = loadConfig();
    const real = process.argv.includes('--real');

    let keys = [];
    if (real) {
      const raw = process.env.POOL_SEED_KEYS || '';
      keys = raw.split(',').map(s => s.trim()).filter(Boolean).map((k, i) => ({
        provider: cfg.pool.provider, label: `real#${i + 1}`, key: k
      }));
      if (!keys.length) {
        console.error('No POOL_SEED_KEYS set. Set env var POOL_SEED_KEYS=k1,k2,...');
        process.exit(1);
      }
    } else {
      const N = 305;
      for (let i = 1; i <= N; i++) {
        keys.push({
          provider: cfg.pool.provider,
          label: `mock#${i}`,
          key: `sk-mock-${i.toString().padStart(4, '0')}-${require('crypto').randomBytes(12).toString('hex')}`
        });
      }
    }

    let added = 0, dedup = 0;
    for (const k of keys) {
      const r = await pool.importKey(k);
      if (r.dedup) dedup++; else added++;
    }
    const stats = await pool.stats();
    console.log(`[seed-pool] added=${added} dedup=${dedup}`);
    console.log(`[seed-pool] pool stats:`, stats);
    process.exit(0);
  } catch (e) {
    console.error('[seed-pool] FAILED:', e);
    process.exit(1);
  }
})();
