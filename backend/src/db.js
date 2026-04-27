'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'hopez.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    credits INTEGER NOT NULL DEFAULT 100,
    plan TEXT NOT NULL DEFAULT 'free',
    role TEXT NOT NULL DEFAULT 'user',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    key_prefix TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    monthly_quota INTEGER NOT NULL DEFAULT 0,
    revoked INTEGER NOT NULL DEFAULT 0,
    one_time_use INTEGER NOT NULL DEFAULT 0,
    consumed INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER,
    backend_key_id INTEGER,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    api_key_id INTEGER NOT NULL,
    period TEXT NOT NULL,        -- YYYY-MM
    requests INTEGER NOT NULL DEFAULT 0,
    UNIQUE(api_key_id, period),
    FOREIGN KEY(api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS password_resets (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    plan TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    credits_added INTEGER NOT NULL,
    provider TEXT NOT NULL,
    provider_ref TEXT,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  -- 1:1 dedicated upstream key pool (encrypted at rest).
  CREATE TABLE IF NOT EXISTS backend_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL DEFAULT 'openai',
    label TEXT,
    ciphertext BLOB NOT NULL,
    iv BLOB NOT NULL,
    auth_tag BLOB NOT NULL,
    fingerprint TEXT NOT NULL UNIQUE,         -- sha256(plaintext) for dedupe
    status TEXT NOT NULL DEFAULT 'available', -- available|assigned|cooling_down|revoked|exhausted
    assigned_to INTEGER,                       -- api_keys.id
    assigned_at INTEGER,
    released_at INTEGER,
    request_count INTEGER NOT NULL DEFAULT 0,
    last_used_at INTEGER,
    monthly_quota INTEGER,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(assigned_to) REFERENCES api_keys(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS key_bindings_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    api_key_id INTEGER NOT NULL,
    backend_key_id INTEGER NOT NULL,
    action TEXT NOT NULL,    -- bound|released|rotated|revoked|one_time_consumed
    reason TEXT,
    created_at INTEGER NOT NULL
  );
`);

// --- Lightweight migrations for upgrades from older schema ---
const userCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
if (!userCols.includes('credits')) db.exec("ALTER TABLE users ADD COLUMN credits INTEGER NOT NULL DEFAULT 100");
if (!userCols.includes('plan')) db.exec("ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'free'");
if (!userCols.includes('role')) db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");

const apiKeyCols = db.prepare("PRAGMA table_info(api_keys)").all().map(c => c.name);
if (!apiKeyCols.includes('one_time_use'))   db.exec("ALTER TABLE api_keys ADD COLUMN one_time_use INTEGER NOT NULL DEFAULT 0");
if (!apiKeyCols.includes('consumed'))       db.exec("ALTER TABLE api_keys ADD COLUMN consumed INTEGER NOT NULL DEFAULT 0");
if (!apiKeyCols.includes('expires_at'))     db.exec("ALTER TABLE api_keys ADD COLUMN expires_at INTEGER");
if (!apiKeyCols.includes('backend_key_id')) db.exec("ALTER TABLE api_keys ADD COLUMN backend_key_id INTEGER");

// Indexes that enforce the 1:1 invariant at the storage layer.
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_backend_keys_assigned_unique
    ON backend_keys(assigned_to) WHERE assigned_to IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_backend_unique
    ON api_keys(backend_key_id) WHERE backend_key_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_backend_keys_status ON backend_keys(status);
`);

module.exports = db;
