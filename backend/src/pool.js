'use strict';

const db = require('./db');
const { encrypt, decrypt, fingerprint } = require('./crypto');
const { loadConfig } = require('./config');

const cfg = loadConfig();

/**
 * Backend-key pool manager.
 *
 * Core invariant: at most one api_keys row may reference any given backend_keys
 * row at a time. Enforced by:
 *   - UNIQUE partial index on backend_keys.assigned_to
 *   - UNIQUE partial index on api_keys.backend_key_id
 *   - All lease/release paths run inside a SQLite IMMEDIATE transaction.
 */

// ---------- Lease / release ----------

const txLease = db.transaction((apiKeyId, provider) => {
  const row = db.prepare(`
    SELECT id FROM backend_keys
     WHERE status = 'available' AND provider = ?
     ORDER BY id ASC
     LIMIT 1
  `).get(provider);

  if (!row) {
    const e = new Error('POOL_EXHAUSTED');
    e.code = 'POOL_EXHAUSTED';
    throw e;
  }

  // Conditional update so a parallel transaction cannot grab the same row.
  const upd = db.prepare(`
    UPDATE backend_keys
       SET status='assigned', assigned_to=?, assigned_at=?, released_at=NULL
     WHERE id=? AND status='available'
  `).run(apiKeyId, Date.now(), row.id);

  if (upd.changes !== 1) {
    const e = new Error('POOL_RACE'); e.code = 'POOL_RACE'; throw e;
  }

  db.prepare('UPDATE api_keys SET backend_key_id=? WHERE id=?').run(row.id, apiKeyId);

  db.prepare(
    'INSERT INTO key_bindings_log (api_key_id, backend_key_id, action, created_at) VALUES (?,?,?,?)'
  ).run(apiKeyId, row.id, 'bound', Date.now());

  return row.id;
});

function leaseBackendKey(apiKeyId, { provider = cfg.pool.provider } = {}) {
  // .immediate() takes the write lock BEFORE the SELECT so two concurrent
  // leases can't both see the same row as 'available'.
  return txLease.immediate(apiKeyId, provider);
}

const txRelease = db.transaction((apiKeyId, reason) => {
  const link = db.prepare('SELECT backend_key_id FROM api_keys WHERE id=?').get(apiKeyId);
  if (!link?.backend_key_id) return null;

  db.prepare(`
    UPDATE backend_keys
       SET status='cooling_down', assigned_to=NULL, released_at=?
     WHERE id=?
  `).run(Date.now(), link.backend_key_id);

  db.prepare('UPDATE api_keys SET backend_key_id=NULL WHERE id=?').run(apiKeyId);

  db.prepare(
    'INSERT INTO key_bindings_log (api_key_id, backend_key_id, action, reason, created_at) VALUES (?,?,?,?,?)'
  ).run(apiKeyId, link.backend_key_id, 'released', reason || null, Date.now());

  return link.backend_key_id;
});

function releaseBackendKey(apiKeyId, reason = 'revoked') {
  return txRelease.immediate(apiKeyId, reason);
}

// ---------- Decryption + accounting ----------

function getDecryptedKey(backendKeyId) {
  const row = db.prepare(
    'SELECT ciphertext, iv, auth_tag, status FROM backend_keys WHERE id = ?'
  ).get(backendKeyId);
  if (!row) throw new Error('backend_key_not_found');
  if (row.status === 'revoked' || row.status === 'exhausted') {
    const e = new Error('backend_key_unusable'); e.code = 'BACKEND_KEY_UNUSABLE'; throw e;
  }
  return decrypt({ ciphertext: row.ciphertext, iv: row.iv, auth_tag: row.auth_tag });
}

function recordBackendUsage(backendKeyId) {
  db.prepare(
    'UPDATE backend_keys SET request_count = request_count + 1, last_used_at = ? WHERE id = ?'
  ).run(Date.now(), backendKeyId);
}

// ---------- Import / rotate / revoke ----------

function importKey({ provider = cfg.pool.provider, label, key, monthly_quota = null } = {}) {
  if (!key || typeof key !== 'string') throw new Error('key_required');
  const fp = fingerprint(key);
  const existing = db.prepare('SELECT id FROM backend_keys WHERE fingerprint = ?').get(fp);
  if (existing) return { id: existing.id, dedup: true };
  const enc = encrypt(key);
  const info = db.prepare(`
    INSERT INTO backend_keys (provider, label, ciphertext, iv, auth_tag, fingerprint, status, monthly_quota, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'available', ?, ?)
  `).run(provider, label || null, enc.ciphertext, enc.iv, enc.auth_tag, fp, monthly_quota, Date.now());
  return { id: info.lastInsertRowid, dedup: false };
}

function rotateKey(backendKeyId, newPlaintext) {
  if (!newPlaintext) throw new Error('key_required');
  const fp = fingerprint(newPlaintext);
  const enc = encrypt(newPlaintext);
  const tx = db.transaction(() => {
    const upd = db.prepare(`
      UPDATE backend_keys
         SET ciphertext = ?, iv = ?, auth_tag = ?, fingerprint = ?
       WHERE id = ?
    `).run(enc.ciphertext, enc.iv, enc.auth_tag, fp, backendKeyId);
    if (upd.changes !== 1) throw new Error('not_found');
    db.prepare(
      'INSERT INTO key_bindings_log (api_key_id, backend_key_id, action, created_at) VALUES (0, ?, ?, ?)'
    ).run(backendKeyId, 'rotated', Date.now());
  });
  tx.immediate();
  return { id: backendKeyId };
}

function revokePoolKey(backendKeyId, reason = 'manual') {
  const tx = db.transaction(() => {
    const link = db.prepare('SELECT assigned_to FROM backend_keys WHERE id = ?').get(backendKeyId);
    if (link?.assigned_to) {
      db.prepare('UPDATE api_keys SET backend_key_id = NULL, revoked = 1 WHERE id = ?').run(link.assigned_to);
    }
    db.prepare(`
      UPDATE backend_keys
         SET status = 'revoked', assigned_to = NULL, released_at = ?
       WHERE id = ?
    `).run(Date.now(), backendKeyId);
    db.prepare(
      'INSERT INTO key_bindings_log (api_key_id, backend_key_id, action, reason, created_at) VALUES (?,?,?,?,?)'
    ).run(link?.assigned_to || 0, backendKeyId, 'revoked', reason, Date.now());
  });
  tx.immediate();
}

// ---------- Cooldown sweep ----------

function sweepCooldown() {
  const cutoff = Date.now() - cfg.pool.cooldown_minutes * 60 * 1000;
  const r = db.prepare(`
    UPDATE backend_keys
       SET status = 'available', released_at = NULL
     WHERE status = 'cooling_down' AND released_at <= ?
  `).run(cutoff);
  return r.changes;
}

let sweepTimer = null;
function startCooldownSweeper() {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    try {
      const promoted = sweepCooldown();
      if (promoted > 0) console.log(`[pool] promoted ${promoted} key(s) cooling_down -> available`);
    } catch (e) { console.error('[pool] sweep error:', e); }
  }, cfg.pool.cooldown_sweep_ms).unref?.();
}

// ---------- Stats ----------

function stats() {
  const rows = db.prepare(
    "SELECT status, COUNT(*) AS n FROM backend_keys GROUP BY status"
  ).all();
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
