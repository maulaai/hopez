'use strict';

const express = require('express');
const { Readable } = require('stream');
const db = require('./db');
const { hashKey, currentPeriod } = require('./keys');
const { loadConfig } = require('./config');
const pool = require('./pool');

const router = express.Router();
const cfg = loadConfig();

const OPENAI_BASE_URL = cfg.openai.base_url;
const SHARED_OPENAI_API_KEY = cfg.openai.api_key; // legacy fallback when pool disabled

const ALLOWED_PATHS = new Set([
  '/chat/completions',
  '/completions',
  '/embeddings',
  '/models',
  '/images/generations',
  '/moderations',
  '/audio/transcriptions',
  '/audio/translations',
  '/audio/speech',
  '/responses'
]);

function authenticateApiKey(req, res, next) {
  const header = req.headers['authorization'] || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  const provided = m ? m[1].trim() : (req.headers['x-api-key'] || '').toString().trim();
  if (!provided) return res.status(401).json({ error: { message: 'Missing API key', type: 'auth_error' } });

  const row = db.prepare('SELECT * FROM api_keys WHERE key_hash = ? AND revoked = 0').get(hashKey(provided));
  if (!row) return res.status(401).json({ error: { message: 'Invalid API key', type: 'auth_error' } });

  if (row.expires_at && Date.now() > row.expires_at) {
    return res.status(401).json({ error: { message: 'API key has expired', type: 'auth_error' } });
  }
  if (row.one_time_use && row.consumed) {
    return res.status(401).json({ error: { message: 'One-time-use key already consumed', type: 'auth_error' } });
  }

  const period = currentPeriod();
  const usage = db.prepare(
    'SELECT requests FROM usage WHERE api_key_id = ? AND period = ?'
  ).get(row.id, period);
  const used = usage?.requests || 0;
  if (row.monthly_quota > 0 && used >= row.monthly_quota) {
    return res.status(429).json({ error: { message: 'Monthly quota exceeded', type: 'rate_limit_error' } });
  }

  if (row.backend_key_id) {
    const bk = db.prepare(
      'SELECT status, request_count, monthly_quota FROM backend_keys WHERE id = ?'
    ).get(row.backend_key_id);
    if (!bk || bk.status === 'revoked' || bk.status === 'exhausted') {
      return res.status(503).json({ error: { message: 'Bound upstream key unavailable', type: 'server_error' } });
    }
    if (bk.monthly_quota && bk.request_count >= bk.monthly_quota) {
      db.prepare("UPDATE backend_keys SET status='exhausted' WHERE id = ?").run(row.backend_key_id);
      return res.status(429).json({ error: { message: 'Upstream key quota exhausted', type: 'rate_limit_error' } });
    }
  }

  const owner = db.prepare('SELECT id, credits FROM users WHERE id = ?').get(row.user_id);
  if (!owner || owner.credits <= 0) {
    return res.status(402).json({
      error: { message: 'Insufficient credits. Upgrade your plan at /pricing.html', type: 'billing_error' }
    });
  }

  req.hopezKey = row;
  req.hopezOwner = owner;
  next();
}

function recordUsage(apiKeyId, userId) {
  const period = currentPeriod();
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO usage (api_key_id, period, requests) VALUES (?, ?, 1)
      ON CONFLICT(api_key_id, period) DO UPDATE SET requests = requests + 1
    `).run(apiKeyId, period);
    db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(Date.now(), apiKeyId);
    db.prepare('UPDATE users SET credits = MAX(credits - 1, 0) WHERE id = ?').run(userId);
  });
  tx.immediate();
}

/** Atomically claim a one-time-use key. True only if THIS request flipped 0 -> 1. */
function claimOneTimeUse(apiKeyId) {
  const r = db.prepare(
    'UPDATE api_keys SET consumed = 1 WHERE id = ? AND consumed = 0 AND one_time_use = 1'
  ).run(apiKeyId);
  return r.changes === 1;
}

router.all('/*', authenticateApiKey, async (req, res) => {
  const subpath = '/' + (req.params[0] || '');
  if (!ALLOWED_PATHS.has(subpath)) {
    return res.status(404).json({ error: { message: `Path ${subpath} not supported`, type: 'invalid_request_error' } });
  }

  let upstreamKey;
  const backendKeyId = req.hopezKey.backend_key_id;

  if (cfg.pool.enabled && backendKeyId) {
    try {
      upstreamKey = pool.getDecryptedKey(backendKeyId);
    } catch (e) {
      console.error('[proxy] decrypt failed:', e.message);
      return res.status(503).json({ error: { message: 'Bound upstream key unavailable', type: 'server_error' } });
    }
  } else if (SHARED_OPENAI_API_KEY) {
    upstreamKey = SHARED_OPENAI_API_KEY; // legacy single-tenant mode
  } else {
    return res.status(500).json({
      error: { message: 'No upstream key bound and no shared OPENAI_API_KEY configured', type: 'server_error' }
    });
  }

  // Atomically claim one-time-use BEFORE upstream call to prevent double-spend.
  if (req.hopezKey.one_time_use) {
    if (!claimOneTimeUse(req.hopezKey.id)) {
      return res.status(401).json({ error: { message: 'One-time-use key already consumed', type: 'auth_error' } });
    }
  }

  const url = OPENAI_BASE_URL.replace(/\/$/, '') + subpath;
  const headers = { ...req.headers };
  delete headers['authorization'];
  delete headers['x-api-key'];
  delete headers['host'];
  delete headers['content-length'];
  delete headers['cookie'];
  headers['authorization'] = `Bearer ${upstreamKey}`;

  try {
    let body;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      body = JSON.stringify(req.body);
      headers['content-type'] = 'application/json';
    }

    const upstream = await fetch(url, { method: req.method, headers, body });

    recordUsage(req.hopezKey.id, req.hopezOwner.id);
    if (backendKeyId) pool.recordBackendUsage(backendKeyId);

    res.status(upstream.status);
    upstream.headers.forEach((value, name) => {
      if (['content-encoding', 'transfer-encoding', 'connection'].includes(name.toLowerCase())) return;
      res.setHeader(name, value);
    });

    if (upstream.body) {
      Readable.fromWeb(upstream.body).pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    console.error('Proxy error:', err);
    return res.status(502).json({ error: { message: 'Upstream request failed', type: 'server_error' } });
  }

  // After a successful one-time-use call: revoke key + release backend lease.
  if (req.hopezKey.one_time_use) {
    try {
      const tx = db.transaction(() => {
        if (cfg.pool.enabled && cfg.pool.auto_release_on_revoke && backendKeyId) {
          pool.releaseBackendKey(req.hopezKey.id, 'one_time_consumed');
        }
        db.prepare('UPDATE api_keys SET revoked = 1 WHERE id = ?').run(req.hopezKey.id);
        db.prepare(
          'INSERT INTO key_bindings_log (api_key_id, backend_key_id, action, created_at) VALUES (?,?,?,?)'
        ).run(req.hopezKey.id, backendKeyId || 0, 'one_time_consumed', Date.now());
      });
      tx.immediate();
    } catch (e) {
      console.error('[proxy] one-time release failed:', e);
    }
  }
});

module.exports = router;
