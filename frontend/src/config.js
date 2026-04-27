'use strict';

const fs = require('fs');
const path = require('path');

function parseIni(text) {
  const out = { _root: {} };
  let section = '_root';
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

function loadConfig() {
  const confPath = process.env.HOPEZ_WEB_CONF
    || path.join(__dirname, '..', 'config', 'hopez-web.conf');

  let ini = { server: {}, backend: {}, branding: {} };
  if (fs.existsSync(confPath)) ini = { ...ini, ...parseIni(fs.readFileSync(confPath, 'utf8')) };

  return {
    server: {
      port: parseInt(process.env.PORT || ini.server.port || '5173', 10),
      public_url: process.env.PUBLIC_URL || ini.server.public_url || 'http://localhost:5173'
    },
    backend: {
      api_url: process.env.API_URL || ini.backend.api_url || 'http://localhost:4000'
    },
    branding: {
      product_name: ini.branding.product_name || 'HOPEZ.AI',
      support_email: ini.branding.support_email || 'support@hopez.ai'
    }
  };
}

module.exports = { loadConfig };
