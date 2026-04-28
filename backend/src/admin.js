'use strict';

const express = require('express');
const db = require('./db');
const pool = require('./pool');
const { adminRequired } = require('./auth');
const { loadConfig } = require('./config');

const router = express.Router();
const cfg = loadConfig();

router.use(adminRequired);

// --- Pool overview ---
router.get('/pool', async (req, res, next) => {
  try {
    const stats = await pool.stats();
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
  } catch (e) { next(e); }
});

router.get('/pool/keys', async (req, res, next) => {
  try {
    const status = req.query.status;
    const where = status ? 'WHERE status = ?' : '';
    const params = status ? [status] : [];
    const rows = await db.all(
      `SELECT id, provider, label, status, assigned_to, assigned_at, released_at,
              request_count, last_used_at, monthly_quota, created_at
         FROM backend_keys ${where}
         ORDER BY id ASC`,
      params
    );
    res.json({ keys: rows });
  } catch (e) { next(e); }
});

router.post('/pool/import', async (req, res, next) => {
  try {
    const items = Array.isArray(req.body?.keys) ? req.body.keys : null;
    if (!items) return res.status(400).json({ error: 'keys_array_required' });
    let added = 0, dedup = 0;
    for (const it of items) {
      if (!it?.key) continue;
      const r = await pool.importKey({
        provider: it.provider || cfg.pool.provider,
        label: it.label || null,
        key: it.key,
        monthly_quota: it.monthly_quota || null
      });
      if (r.dedup) dedup++; else added++;
    }
    res.json({ ok: true, added, dedup });
  } catch (e) { next(e); }
});

router.post('/pool/:id/rotate', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const newKey = req.body?.key;
    if (!newKey) return res.status(400).json({ error: 'key_required' });
    await pool.rotateKey(id, newKey);
    res.json({ ok: true, id });
  } catch (e) {
    if (e.message === 'not_found') return res.status(404).json({ error: 'not_found' });
    next(e);
  }
});

router.post('/pool/:id/revoke', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    await pool.revokePoolKey(id, req.body?.reason || 'admin_revoked');
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get('/bindings', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000);
    const rows = await db.all(
      `SELECT id, api_key_id, backend_key_id, action, reason, created_at
         FROM key_bindings_log
         ORDER BY id DESC
         LIMIT ?`,
      [limit]
    );
    res.json({ bindings: rows });
  } catch (e) { next(e); }
});

module.exports = router;
