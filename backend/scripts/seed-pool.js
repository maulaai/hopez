#!/usr/bin/env node
'use strict';

/**
 * Seeds the backend_keys pool from a JSON file.
 *
 * File format:
 *   [
 *     { "provider": "openai", "label": "pool-001", "key": "sk-...", "monthly_quota": 50000 },
 *     ...
 *   ]
 *
 * Usage:
 *   HOPEZ_POOL_MASTER_KEY=... node scripts/seed-pool.js [path/to/file.json]
 *
 * Defaults to HOPEZ_POOL_SEED_FILE env var, then ./config/backend-keys.pool.json.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../src/pool');
const { loadConfig } = require('../src/config');

const cfg = loadConfig();
const argPath = process.argv[2];
const filePath = path.resolve(
  argPath ||
  process.env.HOPEZ_POOL_SEED_FILE ||
  path.join(__dirname, '..', 'config', 'backend-keys.pool.json')
);

if (!fs.existsSync(filePath)) {
  console.error(`Seed file not found: ${filePath}`);
  process.exit(1);
}

let items;
try {
  items = JSON.parse(fs.readFileSync(filePath, 'utf8'));
} catch (e) {
  console.error('Invalid JSON:', e.message);
  process.exit(1);
}
if (!Array.isArray(items)) {
  console.error('Seed file must be a JSON array.');
  process.exit(1);
}

let added = 0, dedup = 0, skipped = 0;
for (const it of items) {
  if (!it?.key || typeof it.key !== 'string') { skipped++; continue; }
  try {
    const r = pool.importKey({
      provider: it.provider || cfg.pool.provider,
      label: it.label || null,
      key: it.key,
      monthly_quota: it.monthly_quota || null
    });
    if (r.dedup) dedup++; else added++;
  } catch (e) {
    skipped++;
    console.error(`  ! skip ${it.label || '(no label)'}: ${e.message}`);
  }
}

const stats = pool.stats();
console.log(`Seed complete: added=${added}, dedup=${dedup}, skipped=${skipped}`);
console.log(`Pool now: total=${stats.total} available=${stats.available} assigned=${stats.assigned} cooling_down=${stats.cooling_down} revoked=${stats.revoked} exhausted=${stats.exhausted}`);
if (stats.total < cfg.pool.min_size) {
  console.warn(`WARNING: pool size ${stats.total} is below min_size ${cfg.pool.min_size}.`);
}
