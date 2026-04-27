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

function maybePromoteAdmin(email, userId) {
  if (ADMIN_BOOTSTRAP_EMAIL && email.toLowerCase() === ADMIN_BOOTSTRAP_EMAIL) {
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ? AND role != 'admin'").run(userId);
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
  authRequired(req, res, () => {
    const u = db.prepare('SELECT role FROM users WHERE id = ?').get(req.user.uid);
    if (!u || u.role !== 'admin') return res.status(403).json({ error: 'admin_only' });
    next();
  });
}

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

// --- Auth ---
router.post('/signup', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password || password.length < 8) {
    return res.status(400).json({ error: 'email and password (min 8 chars) required' });
  }
  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (exists) return res.status(409).json({ error: 'email_taken' });

  const hash = bcrypt.hashSync(password, BCRYPT_COST);
  const free = getPlan('free');
  const info = db.prepare(
    'INSERT INTO users (email, password_hash, credits, plan, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(email.toLowerCase(), hash, free.credits, 'free', Date.now());

  const user = { id: info.lastInsertRowid, email: email.toLowerCase() };
  maybePromoteAdmin(user.email, user.id);
  const token = signToken(user);
  res.cookie('hopez_token', token, { httpOnly: true, sameSite: 'lax' });
  res.json({ ok: true, user });
});

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'missing_credentials' });
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
  if (!row) return res.status(401).json({ error: 'invalid_credentials' });
  if (!bcrypt.compareSync(password, row.password_hash)) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  maybePromoteAdmin(row.email, row.id);
  const token = signToken(row);
  res.cookie('hopez_token', token, { httpOnly: true, sameSite: 'lax' });
  res.json({ ok: true, user: { id: row.id, email: row.email } });
});

router.post('/logout', (req, res) => {
  res.clearCookie('hopez_token');
  res.json({ ok: true });
});

router.get('/me', authRequired, (req, res) => {
  const u = db.prepare(
    'SELECT id, email, credits, plan, role, created_at FROM users WHERE id = ?'
  ).get(req.user.uid);
  res.json({ user: u });
});

// --- Password reset ---
router.post('/forgot', (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email_required' });
  const u = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());

  // Always respond ok to avoid account enumeration.
  if (u) {
    const token = crypto.randomBytes(32).toString('hex');
    const expires = Date.now() + RESET_TTL_MS
    db.prepare(
      'INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)'
    ).run(sha256(token), u.id, expires);

    const link = `${APP_URL}/reset.html?token=${token}`;
    // Stub: log the link to the server console. Wire up real email (SMTP/SendGrid) in production.
    console.log(`[password-reset] ${email} -> ${link}`);
  }
  res.json({ ok: true, message: 'If that email exists, a reset link has been sent.' });
});

router.post('/reset', (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password || password.length < 8) {
    return res.status(400).json({ error: 'token and new password (min 8 chars) required' });
  }
  const row = db.prepare(
    'SELECT * FROM password_resets WHERE token_hash = ? AND used = 0'
  ).get(sha256(token));
  if (!row || row.expires_at < Date.now()) {
    return res.status(400).json({ error: 'invalid_or_expired_token' });
  }
  const hash = bcrypt.hashSync(password, BCRYPT_COST);
  const tx = db.transaction(() => {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, row.user_id);
    db.prepare('UPDATE password_resets SET used = 1 WHERE token_hash = ?').run(row.token_hash);
  });
  tx.immediate();
  res.json({ ok: true });
});

router.post('/change-password', authRequired, (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (!current_password || !new_password || new_password.length < 8) {
    return res.status(400).json({ error: 'invalid_input' });
  }
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.uid);
  if (!u || !bcrypt.compareSync(current_password, u.password_hash)) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .run(bcrypt.hashSync(new_password, BCRYPT_COST), u.id);
  res.json({ ok: true });
});

// --- API keys ---
router.get('/keys', authRequired, (req, res) => {
  const rows = db.prepare(`
    SELECT k.id, k.name, k.key_prefix, k.monthly_quota, k.revoked,
           k.one_time_use, k.consumed, k.expires_at,
           k.backend_key_id, b.label AS backend_key_label, b.status AS backend_key_status,
           k.created_at, k.last_used_at,
           COALESCE(u.requests, 0) AS requests_this_period
    FROM api_keys k
    LEFT JOIN backend_keys b ON b.id = k.backend_key_id
    LEFT JOIN usage u
      ON u.api_key_id = k.id
     AND u.period = strftime('%Y-%m','now')
    WHERE k.user_id = ?
    ORDER BY k.created_at DESC
  `).all(req.user.uid);
  res.json({ keys: rows });
});

router.post('/keys', authRequired, (req, res) => {
  // Free plan: limit to 1 active key
  const u = db.prepare('SELECT plan FROM users WHERE id = ?').get(req.user.uid);
  if (u.plan === 'free') {
    const active = db.prepare(
      'SELECT COUNT(*) AS c FROM api_keys WHERE user_id = ? AND revoked = 0'
    ).get(req.user.uid).c;
    if (active >= 1) {
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

  // Insert frontend key + lease a dedicated backend key in one transaction.
  let inserted, backendKeyId, backendLabel;
  try {
    const tx = db.transaction(() => {
      inserted = db.prepare(`
        INSERT INTO api_keys (user_id, name, key_prefix, key_hash, monthly_quota,
                              one_time_use, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(req.user.uid, name, prefix, hash, quota, oneTime ? 1 : 0, expiresAt, Date.now());
      if (cfg.pool.enabled) {
        backendKeyId = pool.leaseBackendKey(inserted.lastInsertRowid);
        const lbl = db.prepare('SELECT label FROM backend_keys WHERE id = ?').get(backendKeyId);
        backendLabel = lbl?.label || ('pool#' + backendKeyId);
      }
    });
    tx.immediate();
  } catch (e) {
    if (e.code === 'POOL_EXHAUSTED') {
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
    id: inserted.lastInsertRowid,
    name,
    key_prefix: prefix,
    monthly_quota: quota,
    one_time_use: !!oneTime,
    expires_at: expiresAt,
    bound_backend_key_id: backendKeyId || null,
    bound_backend_key_label: backendLabel || null,
    notice: 'Store this key now. It will not be shown again.'
  });
});

router.delete('/keys/:id', authRequired, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT * FROM api_keys WHERE id = ? AND user_id = ?').get(id, req.user.uid);
  if (!row) return res.status(404).json({ error: 'not_found' });
  const tx = db.transaction(() => {
    if (cfg.pool.enabled && cfg.pool.auto_release_on_revoke && row.backend_key_id) {
      pool.releaseBackendKey(id, 'user_revoked');
    }
    db.prepare('UPDATE api_keys SET revoked = 1 WHERE id = ?').run(id);
  });
  tx.immediate();
  res.json({ ok: true });
});

// --- Billing ---
router.get('/plans', (req, res) => {
  res.json({ plans: PLANS });
});

router.post('/subscribe', authRequired, (req, res) => {
  // Free-tier switch only. Paid plans must go through /checkout.
  const planId = (req.body?.plan_id || '').toString();
  const plan = getPlan(planId);
  if (!plan) return res.status(400).json({ error: 'invalid_plan' });
  if (plan.price_cents > 0) {
    return res.status(402).json({ error: 'payment_required', message: 'Use /checkout for paid plans.' });
  }
  db.prepare('UPDATE users SET plan = ? WHERE id = ?').run(plan.id, req.user.uid);
  const u = db.prepare('SELECT credits, plan FROM users WHERE id = ?').get(req.user.uid);
  res.json({ ok: true, plan: u.plan, credits: u.credits });
});

router.get('/payments', authRequired, (req, res) => {
  const rows = db.prepare(
    'SELECT id, plan, amount_cents, credits_added, provider, status, created_at FROM payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 50'
  ).all(req.user.uid);
  res.json({ payments: rows });
});

/**
 * MOCK CHECKOUT.
 * Replace with a real Stripe / Razorpay / PayPal integration in production:
 *   1. Create a Checkout Session server-side and redirect the user.
 *   2. On the provider's `checkout.session.completed` webhook, credit the user.
 * For now this endpoint just credits the account so the full flow is testable.
 */
router.post('/checkout', authRequired, (req, res) => {
  const planId = (req.body?.plan_id || '').toString();
  const plan = getPlan(planId);
  if (!plan || plan.id === 'free') {
    return res.status(400).json({ error: 'invalid_plan' });
  }

  const tx = db.transaction(() => {
    db.prepare('UPDATE users SET credits = credits + ?, plan = ? WHERE id = ?')
      .run(plan.credits, plan.id, req.user.uid);
    db.prepare(`
      INSERT INTO payments (user_id, plan, amount_cents, credits_added, provider, provider_ref, status, created_at)
      VALUES (?, ?, ?, ?, 'mock', ?, 'succeeded', ?)
    `).run(
      req.user.uid, plan.id, plan.price_cents, plan.credits,
      'mock_' + crypto.randomBytes(8).toString('hex'),
      Date.now()
    );
  });
  tx.immediate();

  const u = db.prepare('SELECT credits, plan FROM users WHERE id = ?').get(req.user.uid);
  res.json({
    ok: true,
    plan: plan.id,
    credits: u.credits,
    message: 'Payment succeeded (mock). Replace /api/auth/checkout with Stripe in production.'
  });
});

module.exports = { router, authRequired, adminRequired };

