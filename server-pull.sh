#!/usr/bin/env bash
set -e
REPO=https://github.com/maulaai/hopez.git
TARGET=/opt/hopez

cd "$TARGET"

# Backup current .env + pool seed (those live only on the server)
cp -a backend/.env /tmp/hopez.env.bak
cp -a backend/config/backend-keys.pool.json /tmp/hopez.pool.json.bak 2>/dev/null || true

# If not already a git checkout, convert in-place
if [ ! -d .git ]; then
  git init -q
  git remote add origin "$REPO"
  git fetch -q origin main
  git checkout -q -f -t origin/main
else
  git fetch -q origin main
  git reset -q --hard origin/main
fi

# Restore secrets that are gitignored
cp -a /tmp/hopez.env.bak backend/.env
[ -f /tmp/hopez.pool.json.bak ] && cp -a /tmp/hopez.pool.json.bak backend/config/backend-keys.pool.json || true
mkdir -p backend/data

# Install only top-level deps (workspaces hoist) — production
npm install --omit=dev --no-audit --no-fund 2>&1 | tail -3

# Reload services
pm2 reload ecosystem.config.js
pm2 save
sleep 2
pm2 ls
echo '--- /health ---'
curl -sS http://127.0.0.1/health
echo
echo '--- pool ---'
node backend/scripts/pool-status.js | head -10
