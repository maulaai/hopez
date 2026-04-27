#!/usr/bin/env node
'use strict';

require('dotenv').config();
const pool = require('../src/pool');
const { loadConfig } = require('../src/config');

const cfg = loadConfig();
const s = pool.stats();
console.log('--- HOPEZ.AI Pool Status ---');
console.log(`enabled         : ${cfg.pool.enabled}`);
console.log(`provider        : ${cfg.pool.provider}`);
console.log(`min_size target : ${cfg.pool.min_size}`);
console.log(`cooldown        : ${cfg.pool.cooldown_minutes} min`);
console.log('');
console.log(`total           : ${s.total}`);
console.log(`available       : ${s.available}`);
console.log(`assigned        : ${s.assigned}`);
console.log(`cooling_down    : ${s.cooling_down}`);
console.log(`revoked         : ${s.revoked}`);
console.log(`exhausted       : ${s.exhausted}`);
console.log('');
console.log(`healthy         : ${s.total >= cfg.pool.min_size ? 'YES' : 'NO (below min_size)'}`);
