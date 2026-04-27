'use strict';

const crypto = require('crypto');

/**
 * AES-256-GCM at-rest encryption for upstream provider keys.
 *
 * The master key is sourced from process.env (never the .conf file).
 * Encoding: 32 raw bytes, base64.  Generate one with:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 */

const ALG = 'aes-256-gcm';

function getMasterKey(envName = 'HOPEZ_POOL_MASTER_KEY') {
  const raw = process.env[envName];
  if (!raw) {
    throw new Error(
      `Missing ${envName}. Generate one with:\n` +
      `  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
    );
  }
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) {
    throw new Error(`${envName} must decode to 32 bytes (AES-256). Got ${buf.length}.`);
  }
  return buf;
}

function encrypt(plaintext, masterKey = getMasterKey()) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALG, masterKey, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext: ct, iv, auth_tag: tag };
}

function decrypt({ ciphertext, iv, auth_tag }, masterKey = getMasterKey()) {
  const decipher = crypto.createDecipheriv(ALG, masterKey, iv);
  decipher.setAuthTag(auth_tag);
  const pt = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return pt.toString('utf8');
}

function fingerprint(plaintext) {
  return crypto.createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

module.exports = { encrypt, decrypt, fingerprint, getMasterKey };
