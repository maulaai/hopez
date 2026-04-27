'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Minimal INI-style parser. Supports:
 *   [section]
 *   key = value
 *   ; comment   # comment
 *   Values are trimmed; quotes are stripped; comma-separated values become arrays
 *   when caller asks for `asList()`.
 */
function parseIni(text) {
  const out = {};
  let section = '_root';
  out[section] = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sec = line.match(/^\[(.+?)\]$/);
    if (sec) { section = sec[1].trim(); out[section] = out[section] || {}; continue; }
    const kv = line.match(/^([^=]+?)\s*=\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[section][kv[1].trim()] = v;
  }
  return out;
}

function asList(s) { return (s || '').split(',').map(x => x.trim()).filter(Boolean); }
function asInt(s, d) { const n = parseInt(s, 10); return Number.isFinite(n) ? n : d; }

function loadConfig() {
  const confPath = process.env.HOPEZ_CONF
    || path.join(__dirname, '..', 'config', 'hopez.conf');

  let ini = { _root: {}, server: {}, auth: {}, openai: {}, cors: {}, rate_limit: {}, billing: {}, pool: {}, crypto: {}, admin: {} };
  if (fs.existsSync(confPath)) {
    ini = { ...ini, ...parseIni(fs.readFileSync(confPath, 'utf8')) };
  }

  // Env overrides take precedence over the .conf file.
  return {
    server: {
      port: asInt(process.env.PORT || ini.server.port, 4000),
      body_limit: process.env.BODY_LIMIT || ini.server.body_limit || '2mb',
      app_url: process.env.APP_URL || ini.server.app_url || 'http://localhost:5173'
    },
    auth: {
      jwt_secret: process.env.JWT_SECRET || ini.auth.jwt_secret || 'dev_secret_change_me',
      jwt_ttl: process.env.JWT_TTL || ini.auth.jwt_ttl || '7d',
      reset_ttl_minutes: asInt(process.env.RESET_TTL_MINUTES || ini.auth.reset_ttl_minutes, 30),
      bcrypt_cost: asInt(process.env.BCRYPT_COST || ini.auth.bcrypt_cost, 10)
    },
    openai: {
      api_key: process.env.OPENAI_API_KEY || ini.openai.api_key || '',
      base_url: process.env.OPENAI_BASE_URL || ini.openai.base_url || 'https://api.openai.com/v1'
    },
    cors: {
      allowed_origins: asList(process.env.CORS_ORIGINS || ini.cors.allowed_origins || 'http://localhost:5173')
    },
    rate_limit: {
      auth_window_ms: asInt(ini.rate_limit.auth_window_ms, 15 * 60 * 1000),
      auth_max: asInt(ini.rate_limit.auth_max, 30),
      proxy_window_ms: asInt(ini.rate_limit.proxy_window_ms, 60 * 1000),
      proxy_max: asInt(ini.rate_limit.proxy_max, 120)
    },
    billing: {
      default_monthly_quota: asInt(process.env.DEFAULT_MONTHLY_QUOTA || ini.billing.default_monthly_quota, 1000)
    },
    pool: {
      enabled: (process.env.POOL_ENABLED || ini.pool.enabled || 'true').toString() !== 'false',
      provider: process.env.POOL_PROVIDER || ini.pool.provider || 'openai',
      min_size: asInt(ini.pool.min_size, 300),
      cooldown_minutes: asInt(ini.pool.cooldown_minutes, 10),
      auto_release_on_revoke: (ini.pool.auto_release_on_revoke || 'true') !== 'false',
      default_one_time_use: (ini.pool.default_one_time_use || 'false') === 'true',
      default_ttl_minutes: asInt(ini.pool.default_ttl_minutes, 1440),
      cooldown_sweep_ms: asInt(ini.pool.cooldown_sweep_ms, 60 * 1000)
    },
    crypto: {
      master_key_env: ini.crypto.master_key_env || 'HOPEZ_POOL_MASTER_KEY',
      algorithm: ini.crypto.algorithm || 'aes-256-gcm'
    },
    admin: {
      bootstrap_email: (process.env.ADMIN_BOOTSTRAP_EMAIL || ini.admin.bootstrap_email || '').toLowerCase()
    }
  };
}

module.exports = { loadConfig };
