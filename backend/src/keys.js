'use strict';

const crypto = require('crypto');

// HOPEZ keys look like: hpz_aidfz_<48 hex chars>
function generateApiKey() {
  const raw = crypto.randomBytes(24).toString('hex');
  const key = `hpz_aidfz_${raw}`;
  const prefix = key.slice(0, 16); // hpz_aidfz_xxxxxx
  const hash = hashKey(key);
  return { key, prefix, hash };
}

function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function currentPeriod() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

module.exports = { generateApiKey, hashKey, currentPeriod };
