'use strict';

const db = require('./db');
const { encrypt, decrypt, fingerprint } = require('./crypto');
const { loadConfig } = require('./config');

const cfg = loadConfig();

/**
 * Backend-key pool manager (Postgres).
 *
 * The 1:1 invariant (one frontend api_key ↔ one backend_key at a time) is
 * enforced by partial UNIQUE indexes on backend_keys.assigned_to and
 * api_keys.backend_key_id. All lease/release runs in a single transaction
 * with FOR UPDATE SKIP LOCKED so concurrent leases never collide.
 */

// ---------- Lease / release ----------

async function leaseBackendKey(apiKeyId, { provider = cfg.pool.provider } = {}) {
  return await db.withTx(async (c) => {
    const row = await c.one(
      `SELECT id FROM backend_keys
        WHERE status = 'available' AND provider = ?
        ORDER BY id ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED`,
      [provider]
    );
    if (!row) {
      const e = new Error('POOL_EXHAUSTED'); e.code = 'POOL_EXHAUSTED'; throw e;
    }
    const upd = await c.run(
      `UPDATE backend_keys
          SET status='assigned', assigned_to=?, assigned_at=?, released_at=NULL
        WHERE id=? AND status='available'`,
      [apiKeyId, Date.now(), row.id]
    );
    if (upd.rowCount !== 1) {
      const e = new Error('POOL_RACE'); e.code = 'POOL_RACE'; throw e;
    }
    await c.run('UPDATE api_keys SET backend_key_id=? WHERE id=?', [row.id, apiKeyId]);
    await c.run(
      `INSERT INTO key_bindings_log (api_key_id, backend_key_id, action, created_at)
       VALUES (?,?,?,?)`,
      [apiKeyId, row.id, 'bound', Date.now()]
    );
    return row.id;
  });
}

async function releaseBackendKey(apiKeyId, reason = 'revoked') {
  return await db.withTx(async (c) => {
    const link = await c.one('SELECT backend_key_id FROM api_keys WHERE id=?', [apiKeyId]);
    if (!link?.backend_key_id) return null;
    await c.run(
      `UPDATE backend_keys
          SET status='cooling_down', assigned_to=NULL, released_at=?
        WHERE id=?`,
      [Date.now(), link.backend_key_id]
    );
    await c.run('UPDATE api_keys SET backend_key_id=NULL WHERE id=?', [apiKeyId]);
    await c.run(
      `INSERT INTO key_bindings_log (api_key_id, backend_key_id, action, reason, created_at)
       VALUES (?,?,?,?,?)`,
      [apiKeyId, link.backend_key_id, 'released', reason || null, Date.now()]
    );
    return link.backend_key_id;
  });
}

// ---------- Decryption + accounting ----------

async function getDecryptedKey(backendKeyId) {
  const row = await db.one(
    'SELECT ciphertext, iv, auth_tag, status FROM backend_keys WHERE id = ?',
    [backendKeyId]
  );
  if (!row) throw new Error('backend_key_not_found');
  if (row.status === 'revoked' || row.status === 'exhausted') {
    const e = new Error('backend_key_unusable'); e.code = 'BACKEND_KEY_UNUSABLE'; throw e;
  }
  return decrypt({ ciphertext: row.ciphertext, iv: row.iv, auth_tag: row.auth_tag });
}

async function recordBackendUsage(backendKeyId) {
  await db.run(
    'UPDATE backend_keys SET request_count = request_count + 1, last_used_at = ? WHERE id = ?',
    [Date.now(), backendKeyId]
  );
}

// ---------- Import / rotate / revoke ----------

async function importKey({ provider = cfg.pool.provider, label, key, monthly_quota = null } = {}) {
  if (!key || typeof key !== 'string') throw new Error('key_required');
  const fp = fingerprint(key);
  const existing = await db.one('SELECT id FROM backend_keys WHERE fingerprint = ?', [fp]);
  if (existing) return { id: existing.id, dedup: true };
  const enc = encrypt(key);
  const info = await db.run(
    `INSERT INTO backend_keys
       (provider, label, ciphertext, iv, auth_tag, fingerprint, status, monthly_quota, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'available', ?, ?)
     RETURNING id`,
    [provider, label || null, enc.ciphertext, enc.iv, enc.auth_tag, fp, monthly_quota, Date.now()]
  );
  return { id: info.lastInsertRowid, dedup: false };
}

async function rotateKey(backendKeyId, newPlaintext) {
  if (!newPlaintext) throw new Error('key_required');
  const fp = fingerprint(newPlaintext);
  const enc = encrypt(newPlaintext);
  await db.withTx(async (c) => {
    const upd = await c.run(
      `UPDATE backend_keys
          SET ciphertext = ?, iv = ?, auth_tag = ?, fingerprint = ?
        WHERE id = ?`,
      [enc.ciphertext, enc.iv, enc.auth_tag, fp, backendKeyId]
    );
    if (upd.rowCount !== 1) throw new Error('not_found');
    await c.run(
      `INSERT INTO key_bindings_log (api_key_id, backend_key_id, action, created_at)
       VALUES (0, ?, ?, ?)`,
      [backendKeyId, 'rotated', Date.now()]
    );
  });
  return { id: backendKeyId };
}

async function revokePoolKey(backendKeyId, reason = 'manual') {
  await db.withTx(async (c) => {
    const link = await c.one('SELECT assigned_to FROM backend_keys WHERE id = ?', [backendKeyId]);
    if (link?.assigned_to) {
      await c.run(
        'UPDATE api_keys SET backend_key_id = NULL, revoked = 1 WHERE id = ?',
        [link.assigned_to]
      );
    }
    await c.run(
      `UPDATE backend_keys
          SET status = 'revoked', assigned_to = NULL, released_at = ?
        WHERE id = ?`,
      [Date.now(), backendKeyId]
    );
    await c.run(
      `INSERT INTO key_bindings_log (api_key_id, backend_key_id, action, reason, created_at)
       VALUES (?,?,?,?,?)`,
      [link?.assigned_to || 0, backendKeyId, 'revoked', reason, Date.now()]
    );
  });
}

// ---------- Cooldown sweep ----------

async function sweepCooldown() {
  const cutoff = Date.now() - cfg.pool.cooldown_minutes * 60 * 1000;
  const r = await db.run(
    `UPDATE backend_keys
        SET status = 'available', released_at = NULL
      WHERE status = 'cooling_down' AND released_at <= ?`,
    [cutoff]
  );
  return r.rowCount;
}

let sweepTimer = null;
function startCooldownSweeper() {
  if (sweepTimer) return;
  sweepTimer = setInterval(async () => {
    try {
      const promoted = await sweepCooldown();
      if (promoted > 0) console.log(`[pool] promoted ${promoted} key(s) cooling_down -> available`);
    } catch (e) { console.error('[pool] sweep error:', e); }
  }, cfg.pool.cooldown_sweep_ms);
  sweepTimer.unref?.();
}

// ---------- Stats ----------

async function stats() {
  const rows = await db.all(
    "SELECT status, COUNT(*)::int AS n FROM backend_keys GROUP BY status"
  );
  const out = { total: 0, available: 0, assigned: 0, cooling_down: 0, revoked: 0, exhausted: 0 };
  for (const r of rows) { out[r.status] = r.n; out.total += r.n; }
  return out;
}

module.exports = {
  leaseBackendKey,
  releaseBackendKey,
  getDecryptedKey,
  recordBackendUsage,
  importKey,
  rotateKey,
  revokePoolKey,
  sweepCooldown,
  startCooldownSweeper,
  stats
};
