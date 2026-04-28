'use strict';

/**
 * Postgres data layer for HOPEZ.AI.
 *
 * - Uses `pg` Pool with optional IAM authentication tokens (15-minute TTL).
 *   Tokens are minted lazily per new connection via the pool's `password`
 *   callback, so long-lived idle connections rotate cleanly.
 * - SSL is required (RDS enforces it). For convenience the bundled root CA
 *   verification is opt-in via RDS_SSL_VERIFY=true.
 * - Helpers translate `?` placeholders to `$N` so call-site SQL can stay
 *   close to the SQLite original.
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

let signer;
try { signer = require('@aws-sdk/rds-signer'); } catch { /* optional, only needed when RDS_IAM_AUTH=true */ }

const RDS_IAM_AUTH = (process.env.RDS_IAM_AUTH || 'false') === 'true';
const RDS_HOST = process.env.RDS_HOST;
const RDS_PORT = parseInt(process.env.RDS_PORT || '5432', 10);
const RDS_DB = process.env.RDS_DB || 'postgres';
const RDS_USER = process.env.RDS_USER || 'postgres';
const RDS_REGION = process.env.AWS_REGION || process.env.RDS_REGION || 'ap-southeast-1';
const RDS_SSL_VERIFY = (process.env.RDS_SSL_VERIFY || 'false') === 'true';

if (!RDS_HOST && !process.env.DATABASE_URL) {
  console.error('[db] FATAL: neither RDS_HOST nor DATABASE_URL is set in env');
  process.exit(1);
}

if (RDS_IAM_AUTH && !signer) {
  console.error('[db] FATAL: RDS_IAM_AUTH=true requires `@aws-sdk/rds-signer` to be installed');
  process.exit(1);
}

let sslConfig;
if (RDS_SSL_VERIFY) {
  // Caller is expected to provide /opt/hopez/config/rds-global-bundle.pem
  // (download from https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem)
  const caPath = process.env.RDS_CA_BUNDLE
    || path.join(__dirname, '..', 'config', 'rds-global-bundle.pem');
  if (!fs.existsSync(caPath)) {
    console.error(`[db] FATAL: RDS_SSL_VERIFY=true but CA bundle missing: ${caPath}`);
    process.exit(1);
  }
  sslConfig = { rejectUnauthorized: true, ca: fs.readFileSync(caPath, 'utf8') };
} else {
  sslConfig = { rejectUnauthorized: false };
}

async function generateIamToken() {
  const s = new signer.Signer({
    hostname: RDS_HOST,
    port: RDS_PORT,
    username: RDS_USER,
    region: RDS_REGION,
  });
  return await s.getAuthToken();
}

const pool = new Pool({
  host: RDS_HOST,
  port: RDS_PORT,
  database: RDS_DB,
  user: RDS_USER,
  password: RDS_IAM_AUTH ? generateIamToken : process.env.RDS_PASSWORD,
  ssl: sslConfig,
  max: parseInt(process.env.PG_POOL_MAX || '10', 10),
  idleTimeoutMillis: 10 * 60 * 1000, // evict idle conns before IAM token would expire
  connectionTimeoutMillis: 30_000,   // signing + SSL + handshake on cold start
  application_name: 'hopez-api',
});

pool.on('error', (err) => {
  console.error('[db] idle client error:', err.message);
});

// --- Helpers ---------------------------------------------------------------

/** Translate `?` placeholders to `$1, $2, ...` while preserving them inside string literals. */
function rewritePlaceholders(sql) {
  if (!sql.includes('?')) return sql;
  let i = 0;
  let inSingle = false;
  let out = '';
  for (let k = 0; k < sql.length; k++) {
    const ch = sql[k];
    if (ch === "'" && sql[k - 1] !== '\\') inSingle = !inSingle;
    if (ch === '?' && !inSingle) { out += '$' + (++i); continue; }
    out += ch;
  }
  return out;
}

function makeRunner(executor) {
  return {
    async query(sql, params = []) {
      return await executor.query(rewritePlaceholders(sql), params);
    },
    async one(sql, params = []) {
      const r = await executor.query(rewritePlaceholders(sql), params);
      return r.rows[0];
    },
    async all(sql, params = []) {
      const r = await executor.query(rewritePlaceholders(sql), params);
      return r.rows;
    },
    /** Returns { rowCount, lastInsertRowid? } — use ` ... RETURNING id` to get the id. */
    async run(sql, params = []) {
      const r = await executor.query(rewritePlaceholders(sql), params);
      return {
        rowCount: r.rowCount,
        changes: r.rowCount, // alias for SQLite parity
        lastInsertRowid: r.rows[0]?.id ?? null,
        rows: r.rows,
      };
    },
  };
}

const root = makeRunner(pool);

/** Run `fn(client)` inside a single transaction. Auto-rolls back on throw. */
async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const wrapped = makeRunner(client);
    const out = await fn(wrapped);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  } finally {
    client.release();
  }
}

// --- Schema ----------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  credits INTEGER NOT NULL DEFAULT 100,
  plan TEXT NOT NULL DEFAULT 'free',
  role TEXT NOT NULL DEFAULT 'user',
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  monthly_quota INTEGER NOT NULL DEFAULT 0,
  revoked SMALLINT NOT NULL DEFAULT 0,
  one_time_use SMALLINT NOT NULL DEFAULT 0,
  consumed SMALLINT NOT NULL DEFAULT 0,
  expires_at BIGINT,
  backend_key_id BIGINT,
  created_at BIGINT NOT NULL,
  last_used_at BIGINT
);

CREATE TABLE IF NOT EXISTS usage (
  id BIGSERIAL PRIMARY KEY,
  api_key_id BIGINT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  period TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  UNIQUE(api_key_id, period)
);

CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at BIGINT NOT NULL,
  used SMALLINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS payments (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  credits_added INTEGER NOT NULL,
  provider TEXT NOT NULL,
  provider_ref TEXT,
  status TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS backend_keys (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'openai',
  label TEXT,
  ciphertext BYTEA NOT NULL,
  iv BYTEA NOT NULL,
  auth_tag BYTEA NOT NULL,
  fingerprint TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'available',
  assigned_to BIGINT,
  assigned_at BIGINT,
  released_at BIGINT,
  request_count INTEGER NOT NULL DEFAULT 0,
  last_used_at BIGINT,
  monthly_quota INTEGER,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS key_bindings_log (
  id BIGSERIAL PRIMARY KEY,
  api_key_id BIGINT NOT NULL,
  backend_key_id BIGINT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT,
  created_at BIGINT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_backend_keys_assigned_unique
  ON backend_keys(assigned_to) WHERE assigned_to IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_backend_unique
  ON api_keys(backend_key_id) WHERE backend_key_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_backend_keys_status ON backend_keys(status);
`;

async function init() {
  // ping first so a bad config dies loudly
  const ping = await pool.query('SELECT current_database() AS db, version() AS v');
  console.log(`[db] connected to ${ping.rows[0].db} (${ping.rows[0].v.split(',')[0]})`);
  await pool.query(SCHEMA);
}

module.exports = {
  ...root,
  withTx,
  init,
  pool, // raw pg Pool (for advanced callers / tests)
};
