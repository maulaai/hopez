'use strict';

const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');
const { generateApiKey } = require('./keys');
const { PLANS, getPlan } = require('./plans');
const { loadConfig } = require('./config');
const pool = require('./pool');

const router = express.Router();
const cfg = loadConfig();
const ADMIN_BOOTSTRAP_EMAIL = cfg.admin.bootstrap_email;

async function maybePromoteAdmin(email, userId) {
  if (ADMIN_BOOTSTRAP_EMAIL && email.toLowerCase() === ADMIN_BOOTSTRAP_EMAIL) {
    await db.run("UPDATE users SET role = 'admin' WHERE id = ? AND role != 'admin'", [userId]);
  }
}

const JWT_SECRET = cfg.auth.jwt_secret;
const JWT_TTL = cfg.auth.jwt_ttl;
const BCRYPT_COST = cfg.auth.bcrypt_cost;
const RESET_TTL_MS = cfg.auth.reset_ttl_minutes * 60 * 1000;
const DEFAULT_QUOTA = cfg.billing.default_monthly_quota;
const APP_URL = cfg.server.app_url;

function signToken(user) {
  return jwt.sign({ uid: user.id, email: user.email }, JWT_SECRET, { expiresIn: JWT_TTL });
}

function authRequired(req, res, next) {
  const token = req.cookies?.hopez_token || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }
}

function adminRequired(req, res, next) {
  authRequired(req, res, async () => {
    try {
      const u = await db.one('SELECT role FROM users WHERE id = ?', [req.user.uid]);
      if (!u || u.role !== 'admin') return res.status(403).json({ error: 'admin_only' });
      next();
    } catch (e) { next(e); }
  });
}

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

// --- Auth ---
router.post('/signup', async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password || password.length < 8) {
      return res.status(400).json({ error: 'email and password (min 8 chars) required' });
    }
    const exists = await db.one('SELECT id FROM users WHERE email = ?', [email.toLowerCase()]);
    if (exists) return res.status(409).json({ error: 'email_taken' });

    const hash = bcrypt.hashSync(password, BCRYPT_COST);
    const free = getPlan('free');
    const info = await db.run(
      `INSERT INTO users (email, password_hash, credits, plan, created_at)
       VALUES (?, ?, ?, ?, ?) RETURNING id`,
      [email.toLowerCase(), hash, free.credits, 'free', Date.now()]
    );

    const user = { id: info.lastInsertRowid, email: email.toLowerCase() };
    await maybePromoteAdmin(user.email, user.id);
    const token = signToken(user);
    res.cookie('hopez_token', token, { httpOnly: true, sameSite: 'lax' });
    res.json({ ok: true, user });
  } catch (e) { next(e); }
});

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'missing_credentials' });
    const row = await db.one('SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);
    if (!row) return res.status(401).json({ error: 'invalid_credentials' });
    if (!bcrypt.compareSync(password, row.password_hash)) {
      return res.status(401).json({ error: 'invalid_credentials' });
    }
    await maybePromoteAdmin(row.email, row.id);
    const token = signToken(row);
    res.cookie('hopez_token', token, { httpOnly: true, sameSite: 'lax' });
    res.json({ ok: true, user: { id: row.id, email: row.email } });
  } catch (e) { next(e); }
});

router.post('/logout', (req, res) => {
  res.clearCookie('hopez_token');
  res.json({ ok: true });
});

router.get('/me', authRequired, async (req, res, next) => {
  try {
    const u = await db.one(
      'SELECT id, email, credits, plan, role, created_at FROM users WHERE id = ?',
      [req.user.uid]
    );
    res.json({ user: u });
  } catch (e) { next(e); }
});

// --- Password reset ---
router.post('/forgot', async (req, res, next) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email_required' });
    const u = await db.one('SELECT id FROM users WHERE email = ?', [email.toLowerCase()]);
    if (u) {
      const token = crypto.randomBytes(32).toString('hex');
      const expires = Date.now() + RESET_TTL_MS;
      await db.run(
        'INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)',
        [sha256(token), u.id, expires]
      );
      const link = `${APP_URL}/reset.html?token=${token}`;
      console.log(`[password-reset] ${email} -> ${link}`);
    }
    res.json({ ok: true, message: 'If that email exists, a reset link has been sent.' });
  } catch (e) { next(e); }
});

router.post('/reset', async (req, res, next) => {
  try {
    const { token, password } = req.body || {};
    if (!token || !password || password.length < 8) {
      return res.status(400).json({ error: 'token and new password (min 8 chars) required' });
    }
    const row = await db.one(
      'SELECT * FROM password_resets WHERE token_hash = ? AND used = 0',
      [sha256(token)]
    );
    if (!row || Number(row.expires_at) < Date.now()) {
      return res.status(400).json({ error: 'invalid_or_expired_token' });
    }
    const hash = bcrypt.hashSync(password, BCRYPT_COST);
    await db.withTx(async (c) => {
      await c.run('UPDATE users SET password_hash = ? WHERE id = ?', [hash, row.user_id]);
      await c.run('UPDATE password_resets SET used = 1 WHERE token_hash = ?', [row.token_hash]);
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/change-password', authRequired, async (req, res, next) => {
  try {
    const { current_password, new_password } = req.body || {};
    if (!current_password || !new_password || new_password.length < 8) {
      return res.status(400).json({ error: 'invalid_input' });
    }
    const u = await db.one('SELECT * FROM users WHERE id = ?', [req.user.uid]);
    if (!u || !bcrypt.compareSync(current_password, u.password_hash)) {
      return res.status(401).json({ error: 'invalid_credentials' });
    }
    await db.run(
      'UPDATE users SET password_hash = ? WHERE id = ?',
      [bcrypt.hashSync(new_password, BCRYPT_COST), u.id]
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// --- API keys ---
router.get('/keys', authRequired, async (req, res, next) => {
  try {
    const rows = await db.all(
      `SELECT k.id, k.name, k.key_prefix, k.monthly_quota, k.revoked,
              k.one_time_use, k.consumed, k.expires_at,
              k.backend_key_id, b.label AS backend_key_label, b.status AS backend_key_status,
              k.created_at, k.last_used_at,
              COALESCE(u.requests, 0) AS requests_this_period
         FROM api_keys k
         LEFT JOIN backend_keys b ON b.id = k.backend_key_id
         LEFT JOIN usage u
           ON u.api_key_id = k.id
          AND u.period = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM')
        WHERE k.user_id = ?
        ORDER BY k.created_at DESC`,
      [req.user.uid]
    );
    res.json({ keys: rows });
  } catch (e) { next(e); }
});

router.post('/keys', authRequired, async (req, res, next) => {
  try {
    const u = await db.one('SELECT plan FROM users WHERE id = ?', [req.user.uid]);
    if (u.plan === 'free') {
      const r = await db.one(
        'SELECT COUNT(*)::int AS c FROM api_keys WHERE user_id = ? AND revoked = 0',
        [req.user.uid]
      );
      if ((r?.c || 0) >= 1) {
        return res.status(403).json({
          error: 'free_plan_one_key',
          message: 'Free plan allows only 1 active key. Upgrade or revoke an existing key.'
        });
      }
    }

    const name = (req.body?.name || 'default').toString().slice(0, 64);
    const quota = Number.isInteger(req.body?.monthly_quota) ? req.body.monthly_quota : DEFAULT_QUOTA;
    const oneTime = req.body?.one_time_use === true || req.body?.oneTimeUse === true || cfg.pool.default_one_time_use;
    const ttlMin = Number.isInteger(req.body?.ttl_minutes) ? req.body.ttl_minutes
                 : Number.isInteger(req.body?.ttlMinutes) ? req.body.ttlMinutes
                 : cfg.pool.default_ttl_minutes;
    const expiresAt = ttlMin > 0 ? Date.now() + ttlMin * 60 * 1000 : null;

    const { key, prefix, hash } = generateApiKey();

    let insertedId, backendKeyId, backendLabel;
    try {
      insertedId = (await db.run(
        `INSERT INTO api_keys (user_id, name, key_prefix, key_hash, monthly_quota,
                               one_time_use, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        [req.user.uid, name, prefix, hash, quota, oneTime ? 1 : 0, expiresAt, Date.now()]
      )).lastInsertRowid;

      if (cfg.pool.enabled) {
        backendKeyId = await pool.leaseBackendKey(insertedId);
        const lbl = await db.one('SELECT label FROM backend_keys WHERE id = ?', [backendKeyId]);
        backendLabel = lbl?.label || ('pool#' + backendKeyId);
      }
    } catch (e) {
      if (e.code === 'POOL_EXHAUSTED') {
        if (insertedId) await db.run('DELETE FROM api_keys WHERE id = ?', [insertedId]).catch(() => {});
        return res.status(503).json({
          error: 'pool_exhausted',
          message: 'No upstream API keys available. Please try again later.'
        });
      }
      throw e;
    }

    res.json({
      ok: true,
      key,
      id: insertedId,
      name,
      key_prefix: prefix,
      monthly_quota: quota,
      one_time_use: !!oneTime,
      expires_at: expiresAt,
      bound_backend_key_id: backendKeyId || null,
      bound_backend_key_label: backendLabel || null,
      notice: 'Store this key now. It will not be shown again.'
    });
  } catch (e) { next(e); }
});

router.delete('/keys/:id', authRequired, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const row = await db.one(
      'SELECT * FROM api_keys WHERE id = ? AND user_id = ?',
      [id, req.user.uid]
    );
    if (!row) return res.status(404).json({ error: 'not_found' });

    if (cfg.pool.enabled && cfg.pool.auto_release_on_revoke && row.backend_key_id) {
      await pool.releaseBackendKey(id, 'user_revoked');
    }
    await db.run('UPDATE api_keys SET revoked = 1 WHERE id = ?', [id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// --- Billing ---
router.get('/plans', (req, res) => {
  res.json({ plans: PLANS });
});

router.post('/subscribe', authRequired, async (req, res, next) => {
  try {
    const planId = (req.body?.plan_id || '').toString();
    const plan = getPlan(planId);
    if (!plan) return res.status(400).json({ error: 'invalid_plan' });
    if (plan.price_cents > 0) {
      return res.status(402).json({ error: 'payment_required', message: 'Use /checkout for paid plans.' });
    }
    await db.run('UPDATE users SET plan = ? WHERE id = ?', [plan.id, req.user.uid]);
    const u = await db.one('SELECT credits, plan FROM users WHERE id = ?', [req.user.uid]);
    res.json({ ok: true, plan: u.plan, credits: u.credits });
  } catch (e) { next(e); }
});

router.get('/payments', authRequired, async (req, res, next) => {
  try {
    const rows = await db.all(
      `SELECT id, plan, amount_cents, credits_added, provider, status, created_at
         FROM payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
      [req.user.uid]
    );
    res.json({ payments: rows });
  } catch (e) { next(e); }
});

/**
 * MOCK CHECKOUT. Replace with Stripe / Razorpay / PayPal in production.
 */
router.post('/checkout', authRequired, async (req, res, next) => {
  try {
    const planId = (req.body?.plan_id || '').toString();
    const plan = getPlan(planId);
    if (!plan || plan.id === 'free') {
      return res.status(400).json({ error: 'invalid_plan' });
    }

    await db.withTx(async (c) => {
      await c.run(
        'UPDATE users SET credits = credits + ?, plan = ? WHERE id = ?',
        [plan.credits, plan.id, req.user.uid]
      );
      await c.run(
        `INSERT INTO payments (user_id, plan, amount_cents, credits_added, provider, provider_ref, status, created_at)
         VALUES (?, ?, ?, ?, 'mock', ?, 'succeeded', ?)`,
        [
          req.user.uid, plan.id, plan.price_cents, plan.credits,
          'mock_' + crypto.randomBytes(8).toString('hex'),
          Date.now()
        ]
      );
    });

    const u = await db.one('SELECT credits, plan FROM users WHERE id = ?', [req.user.uid]);
    res.json({
      ok: true,
      plan: plan.id,
      credits: u.credits,
      message: 'Payment succeeded (mock). Replace /api/auth/checkout with Stripe in production.'
    });
  } catch (e) { next(e); }
});

module.exports = { router, authRequired, adminRequired };
