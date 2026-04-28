'use strict';

require('dotenv').config();
const db = require('../src/db');
const pool = require('../src/pool');

(async () => {
  try {
    await db.init();
    const stats = await pool.stats();
    console.log('Pool stats:');
    console.log('  total          =', stats.total);
    console.log('  available      =', stats.available);
    console.log('  assigned       =', stats.assigned);
    console.log('  cooling_down   =', stats.cooling_down);
    console.log('  exhausted      =', stats.exhausted);
    console.log('  revoked        =', stats.revoked);

    const recent = await db.all(
      `SELECT id, label, status, assigned_to, request_count, last_used_at
         FROM backend_keys
         ORDER BY id DESC LIMIT 20`
    );
    console.log('\nRecent 20 backend keys:');
    for (const r of recent) {
      console.log(`  #${r.id} [${r.status.padEnd(13)}] ${r.label || ''} assigned_to=${r.assigned_to || '-'} reqs=${r.request_count}`);
    }
    process.exit(0);
  } catch (e) {
    console.error('[pool-status] FAILED:', e);
    process.exit(1);
  }
})();
