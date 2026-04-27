# HOPEZ.AI — Upgraded Plan: 1:1 Dedicated Backend Key Pool (300+ Users)

Below is the **upgraded architecture plan** that satisfies your requirement:

> **Every frontend-issued API key is backed by its own dedicated, never-shared backend API key.** A pool of ≥300 real upstream (OpenAI) API keys is maintained, and each one is assigned exclusively to a single frontend user/key. No backend key is ever multiplexed across users.

---

## 1. Core Concept Change

### ❌ Old model
- `OPENAI_API_KEY` (single key in `.env`) used by `proxy.js` for **all** users.
- Frontend keys are just auth tokens; backend uses one shared upstream key.

### ✅ New model
- A **`backend_keys` pool table** holds 300+ real upstream provider keys (OpenAI / Azure / Anthropic, etc.).
- Each pool key has a status: `available`, `assigned`, `cooling_down`, `revoked`, `exhausted`.
- When a user generates a frontend key, the system **atomically leases** one backend key from the pool and **binds it 1:1** to that frontend key.
- The proxy looks up the frontend key → finds its **dedicated** backend key → forwards the request using that exact upstream key.
- **One-time-use mode** (optional per key): after first successful request OR after TTL expiry, the frontend key auto-revokes and its backend key is released back to the pool (or quarantined).

---

## 2. Updated Repo Structure

```
hopez/
├── backend/
│   ├── config/
│   │   ├── hopez.conf
│   │   └── backend-keys.pool.json       # 🆕 encrypted pool seed file (300+ keys)
│   ├── src/
│   │   ├── server.js
│   │   ├── config.js
│   │   ├── auth.js
│   │   ├── proxy.js                     # ✏️ rewritten — uses dedicated key per request
│   │   ├── plans.js
│   │   ├── keys.js                      # ✏️ frontend key issue/revoke
│   │   ├── pool.js                      # 🆕 backend-key pool manager (lease/release)
│   │   ├── binding.js                   # 🆕 1:1 binding service
│   │   ├── crypto.js                    # 🆕 AES-GCM encryption for stored upstream keys
│   │   ├── admin.js                     # 🆕 admin routes for pool management
│   │   └── db.js                        # ✏️ new tables + migrations
│   ├── scripts/
│   │   ├── smoke-test.js
│   │   ├── seed-pool.js                 # 🆕 import 300+ upstream keys into pool
│   │   ├── pool-status.js               # 🆕 CLI: show pool health
│   │   └── rotate-key.js                # 🆕 CLI: rotate a single pool key
│   └── package.json
│
├── frontend/
│   ├── public/
│   │   ├── dashboard.html               # ✏️ shows "one-time key" toggle + binding info
│   │   └── admin.html                   # 🆕 pool dashboard (admin only)
│   └── ...
└── ...
```

---

## 3. Database Schema Additions (SQLite)

```sql name=backend/src/db.schema.sql
-- Pool of REAL upstream provider API keys (OpenAI etc.)
CREATE TABLE IF NOT EXISTS backend_keys (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  provider        TEXT NOT NULL DEFAULT 'openai',     -- openai|azure|anthropic
  label           TEXT,                                -- e.g. "pool-key-001"
  ciphertext      BLOB NOT NULL,                       -- AES-GCM encrypted upstream key
  iv              BLOB NOT NULL,
  auth_tag        BLOB NOT NULL,
  fingerprint     TEXT NOT NULL UNIQUE,                -- sha256(plaintext) — dedupe
  status          TEXT NOT NULL DEFAULT 'available',
                  -- available | assigned | cooling_down | revoked | exhausted
  assigned_to     INTEGER,                             -- frontend api_keys.id (nullable)
  assigned_at     DATETIME,
  released_at     DATETIME,
  request_count   INTEGER NOT NULL DEFAULT 0,
  last_used_at    DATETIME,
  monthly_quota   INTEGER,                             -- optional per-key cap
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (assigned_to) REFERENCES api_keys(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_backend_keys_assigned
  ON backend_keys(assigned_to) WHERE assigned_to IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_backend_keys_status ON backend_keys(status);

-- Frontend keys gain extra columns
ALTER TABLE api_keys ADD COLUMN one_time_use   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE api_keys ADD COLUMN consumed       INTEGER NOT NULL DEFAULT 0;
ALTER TABLE api_keys ADD COLUMN expires_at     DATETIME;
ALTER TABLE api_keys ADD COLUMN backend_key_id INTEGER UNIQUE
  REFERENCES backend_keys(id) ON DELETE SET NULL;     -- enforces 1:1 at DB level

-- Audit trail
CREATE TABLE IF NOT EXISTS key_bindings_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  api_key_id      INTEGER NOT NULL,
  backend_key_id  INTEGER NOT NULL,
  action          TEXT NOT NULL,    -- bound | released | rotated | revoked
  reason          TEXT,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

The **`UNIQUE` constraint on `backend_key_id`** in `api_keys` is what physically prevents two frontend keys from ever sharing one backend key.

---

## 4. Pool Manager (`pool.js`) — Atomic Lease / Release

```javascript name=backend/src/pool.js
// Core invariant: one backend_keys row -> at most one api_keys row, ever.
// All lease/release operations run inside a SQLite IMMEDIATE transaction
// so two concurrent signups can never grab the same pool key.

async function leaseBackendKey(db, apiKeyId, { provider = 'openai' } = {}) {
  return db.transaction(() => {
    const row = db.prepare(`
      SELECT id FROM backend_keys
       WHERE status = 'available' AND provider = ?
       ORDER BY id ASC LIMIT 1
    `).get(provider);

    if (!row) throw new Error('POOL_EXHAUSTED');

    db.prepare(`
      UPDATE backend_keys
         SET status='assigned', assigned_to=?, assigned_at=CURRENT_TIMESTAMP, released_at=NULL
       WHERE id=? AND status='available'
    `).run(apiKeyId, row.id);

    db.prepare(`UPDATE api_keys SET backend_key_id=? WHERE id=?`).run(row.id, apiKeyId);

    db.prepare(`INSERT INTO key_bindings_log (api_key_id, backend_key_id, action)
                VALUES (?,?, 'bound')`).run(apiKeyId, row.id);
    return row.id;
  })();
}

async function releaseBackendKey(db, apiKeyId, reason = 'revoked') {
  return db.transaction(() => {
    const link = db.prepare(`SELECT backend_key_id FROM api_keys WHERE id=?`).get(apiKeyId);
    if (!link?.backend_key_id) return;
    db.prepare(`
      UPDATE backend_keys
         SET status='cooling_down', assigned_to=NULL, released_at=CURRENT_TIMESTAMP
       WHERE id=?
    `).run(link.backend_key_id);
    db.prepare(`UPDATE api_keys SET backend_key_id=NULL WHERE id=?`).run(apiKeyId);
    db.prepare(`INSERT INTO key_bindings_log (api_key_id, backend_key_id, action, reason)
                VALUES (?,?, 'released', ?)`).run(apiKeyId, link.backend_key_id, reason);
  })();
}

// A scheduled job promotes 'cooling_down' -> 'available' after N minutes
// to avoid immediate reuse of a freshly-released key.
```

---

## 5. Proxy — Per-Request Dedicated Key Lookup

```javascript name=backend/src/proxy.js
// /v1/* — OpenAI-compatible passthrough using the user's DEDICATED backend key
router.all('/v1/*', async (req, res) => {
  const presented = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!presented) return res.status(401).json({ error: 'missing_api_key' });

  const apiKey = await keys.lookupByPlaintext(presented); // hashed compare
  if (!apiKey || apiKey.revoked) return res.status(401).json({ error: 'invalid_api_key' });

  // One-time-use enforcement
  if (apiKey.one_time_use && apiKey.consumed)
    return res.status(401).json({ error: 'key_already_used' });
  if (apiKey.expires_at && new Date(apiKey.expires_at) < new Date())
    return res.status(401).json({ error: 'key_expired' });

  if (!apiKey.backend_key_id)
    return res.status(503).json({ error: 'no_backend_key_bound' });

  // Decrypt the dedicated upstream key (NEVER shared)
  const upstream = await pool.getDecryptedKey(apiKey.backend_key_id);

  const upstreamRes = await fetch(`https://api.openai.com${req.path.replace(/^\/v1/, '/v1')}`, {
    method: req.method,
    headers: {
      'Authorization': `Bearer ${upstream}`,
      'Content-Type': 'application/json',
    },
    body: ['GET','HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body),
  });

  // Mark consumed for one-time keys + update counters
  await keys.recordUsage(apiKey.id, { oneTime: apiKey.one_time_use });
  await pool.incrementUsage(apiKey.backend_key_id);

  // Auto-release if one-time
  if (apiKey.one_time_use) {
    await keys.revoke(apiKey.id);
    await pool.releaseBackendKey(db, apiKey.id, 'one_time_consumed');
  }

  res.status(upstreamRes.status);
  upstreamRes.body.pipe(res);
});
```

---

## 6. New / Changed REST Endpoints

| Method | Path | Description |
|---|---|---|
| POST | `/api/auth/keys` | ✏️ Now leases a pool key. Body: `{ oneTimeUse: bool, ttlMinutes?: number }`. Returns `{ key, expiresAt, boundBackendKeyLabel }`. Fails with `503 POOL_EXHAUSTED` if no pool key available. |
| DELETE | `/api/auth/keys/:id` | ✏️ Also releases the bound backend key back to pool (`cooling_down`). |
| GET | `/api/auth/keys` | ✏️ Includes `boundBackendKeyLabel`, `oneTimeUse`, `consumed`, `expiresAt`. |
| **🆕 GET** | `/api/admin/pool` | Pool stats: total / available / assigned / cooling / revoked. |
| **🆕 POST** | `/api/admin/pool/import` | Bulk import upstream keys (admin-only, multipart). |
| **🆕 POST** | `/api/admin/pool/:id/rotate` | Replace ciphertext, keep binding. |
| **🆕 POST** | `/api/admin/pool/:id/revoke` | Mark exhausted/revoked, release any binding. |
| **🆕 GET** | `/api/admin/bindings` | Full audit log with filters. |

All `/api/admin/*` routes require `users.role = 'admin'`.

---

## 7. Encryption at Rest (`crypto.js`)

- Algorithm: **AES-256-GCM**.
- Master key from `HOPEZ_POOL_MASTER_KEY` env var (32-byte base64). Never in `.conf`.
- Each backend_key row stores its own random 12-byte IV + 16-byte auth tag.
- Plaintext upstream key is decrypted **in-memory only**, per request, and zero-filled after use.
- Optional: pluggable KMS provider (AWS KMS / GCP KMS / HashiCorp Vault) via `pool.driver` config.

---

## 8. Capacity & Concurrency (300+ users)

| Concern | Solution |
|---|---|
| **Pool exhaustion** | Background metric + alert when `available < 10%`. Admin endpoint to bulk-import more. Signup gracefully returns `503` with “waitlist” message. |
| **Race conditions** | SQLite `BEGIN IMMEDIATE` transaction + partial unique index on `assigned_to` guarantees only one user can lease a given key. |
| **Cooldown** | Released keys sit in `cooling_down` for `pool.cooldown_minutes` (default 10) before becoming `available` — prevents accidental cross-user request bleed. |
| **Per-key rate limit** | Each backend key carries its own per-minute and monthly quota; proxy short-circuits with `429` before hitting upstream. |
| **Hot scaling** | Pool table is the single source of truth; multiple backend instances behind a load balancer remain consistent because the DB enforces the unique binding. |
| **Health checks** | `scripts/pool-status.js` + `/api/admin/pool` show live counts; CI smoke test asserts ≥300 keys present and ≥1 available. |

---

## 9. Configuration Additions

```ini name=backend/config/hopez.conf
[pool]
provider              = openai
min_size              = 300         ; alert if pool drops below
cooldown_minutes      = 10          ; before released keys are reusable
auto_release_on_revoke= true
default_one_time_use  = false       ; users can opt in per key
default_ttl_minutes   = 1440        ; 24h, 0 = never

[crypto]
master_key_env        = HOPEZ_POOL_MASTER_KEY
algorithm             = aes-256-gcm

[admin]
bootstrap_email       = admin@hopez.ai
```

`.env.example` additions:

```bash name=backend/.env.example
# 32 random bytes, base64-encoded — REQUIRED in production
HOPEZ_POOL_MASTER_KEY=

# Optional: path to JSON file with [{ "provider":"openai","key":"sk-..." }, ...]
HOPEZ_POOL_SEED_FILE=./config/backend-keys.pool.json
```

---

## 10. Seeding 300+ Keys

```bash
# 1. Prepare a JSON list (never commit this file)
cat > backend/config/backend-keys.pool.json <<'EOF'
[
  { "provider": "openai", "label": "pool-001", "key": "sk-..." },
  { "provider": "openai", "label": "pool-002", "key": "sk-..." },
  ...300+ entries...
]
EOF

# 2. Encrypt + insert
node backend/scripts/seed-pool.js

# 3. Verify
node backend/scripts/pool-status.js
# → total: 312  available: 312  assigned: 0  cooling: 0  revoked: 0
```

---

## 11. Updated Frontend Dashboard

- New **“Generate Key”** modal with toggles:
  - ☑ One-time use (auto-revokes after first request)
  - 🕒 TTL: 1h / 24h / 7d / never
- Keys table shows: `Key (masked) • Status • One-time? • Bound backend label • Expires • Last used`.
- New **Admin** page (`/admin.html`) with pool gauge: 🟢 available / 🟡 cooling / 🔴 assigned / ⚫ revoked + bulk import dropzone.

---

## 12. Updated Security Notes (replaces section in README)

- Upstream provider keys are **AES-256-GCM encrypted** at rest with a master key sourced only from env/KMS.
- **1:1 invariant** enforced at the database layer (unique partial index) — not just application code.
- One-time-use frontend keys are revoked after their first successful proxied request.
- Backend keys go through a **cooldown** state before reuse to prevent residual-token bleed.
- All bind/release/rotate/revoke actions are recorded in `key_bindings_log` (immutable audit trail).
- Admin endpoints require `role=admin` + a fresh re-auth check.

---

## 13. Migration Plan (existing deployments)

1. Deploy code with new tables (additive migration — no breaking changes).
2. Run `seed-pool.js` to load ≥300 upstream keys.
3. Run one-shot `backfill-bindings.js` to lease a pool key for every existing active frontend key.
4. Flip `proxy.js` from “shared `OPENAI_API_KEY`” to “dedicated lookup” mode via `pool.enabled=true`.
5. Remove `OPENAI_API_KEY` from `.env` once all frontend keys have a `backend_key_id`.

---

✅ **Result:** 300+ users, each holding a frontend key that maps to **exactly one** dedicated backend upstream key. No multiplexing, ever. One-time-use mode supported. Fully audited, encrypted, and admin-manageable.

---
