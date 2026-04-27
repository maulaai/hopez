'use strict';

const express = require('express');
const db = require('./db');
const pool = require('./pool');
const { adminRequired } = require('./auth');
const { loadConfig } = require('./config');

const router = express.Router();
const cfg = loadConfig();

// All admin routes require role=admin.
router.use(adminRequired);

// --- Pool overview ---
router.get('/pool', (req, res) => {
  const stats = pool.stats();
  res.json({
    stats,
    config: {
      enabled: cfg.pool.enabled,
      provider: cfg.pool.provider,
      min_size: cfg.pool.min_size,
      cooldown_minutes: cfg.pool.cooldown_minutes,
      default_one_time_use: cfg.pool.default_one_time_use,
      default_ttl_minutes: cfg.pool.default_ttl_minutes
    },
    healthy: stats.total >= cfg.pool.min_size
  });
});

// --- Pool listing (no plaintext keys, ever) ---
router.get('/pool/keys', (req, res) => {
  const status = req.query.status;
  const where = status ? 'WHERE status = ?' : '';
  const params = status ? [status] : [];
  const rows = db.prepare(`
    SELECT id, provider, label, status, assigned_to, assigned_at, released_at,
           request_count, last_used_at, monthly_quota, created_at
      FROM backend_keys ${where}
      ORDER BY id ASC
  `).all(...params);
  res.json({ keys: rows });
});

// --- Import (bulk) ---
router.post('/pool/import', (req, res) => {
  const items = Array.isArray(req.body?.keys) ? req.body.keys : null;
  if (!items) return res.status(400).json({ error: 'keys_array_required' });
  let added = 0, dedup = 0;
  for (const it of items) {
    if (!it?.key) continue;
    const r = pool.importKey({
      provider: it.provider || cfg.pool.provider,
      label: it.label || null,
      key: it.key,
      monthly_quota: it.monthly_quota || null
    });
    if (r.dedup) dedup++; else added++;
  }
  res.json({ ok: true, added, dedup });
});

// --- Rotate one upstream key (binding preserved) ---
router.post('/pool/:id/rotate', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const newKey = req.body?.key;
  if (!newKey) return res.status(400).json({ error: 'key_required' });
  try {
    pool.rotateKey(id, newKey);
    res.json({ ok: true, id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- Revoke (kills binding, marks frontend key revoked) ---
router.post('/pool/:id/revoke', (req, res) => {
  const id = parseInt(req.params.id, 10);
  pool.revokePoolKey(id, req.body?.reason || 'admin_revoked');
  res.json({ ok: true });
});

// --- Audit log ---
router.get('/bindings', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000);
  const rows = db.prepare(`
    SELECT id, api_key_id, backend_key_id, action, reason, created_at
      FROM key_bindings_log
      ORDER BY id DESC
      LIMIT ?
  `).all(limit);
  res.json({ bindings: rows });
});

module.exports = router;
