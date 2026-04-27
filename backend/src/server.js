'use strict';

require('dotenv').config();

const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const { loadConfig } = require('./config');
const { router: authRouter } = require('./auth');
const proxyRouter = require('./proxy');
const adminRouter = require('./admin');
const pool = require('./pool');

const config = loadConfig();
const app = express();
app.set('trust proxy', 1);

app.use(cors({
  origin: config.cors.allowed_origins,
  credentials: true
}));

app.use(express.json({ limit: config.server.body_limit }));
app.use(cookieParser());

const authLimiter = rateLimit({
  windowMs: config.rate_limit.auth_window_ms,
  max: config.rate_limit.auth_max,
  standardHeaders: true,
  legacyHeaders: false
});

const proxyLimiter = rateLimit({
  windowMs: config.rate_limit.proxy_window_ms,
  max: config.rate_limit.proxy_max,
  standardHeaders: true,
  legacyHeaders: false
});

app.get('/health', (req, res) => res.json({ ok: true, service: 'hopez-api' }));

app.use('/api/auth', authLimiter, authRouter);
app.use('/api/admin', authLimiter, adminRouter);
app.use('/v1', proxyLimiter, proxyRouter);

app.use((req, res) => res.status(404).json({ error: { message: 'not_found', path: req.path } }));

const PORT = config.server.port;
app.listen(PORT, () => {
  console.log(`[hopez-api] listening on http://localhost:${PORT}`);
  console.log(`[hopez-api] cors origins: ${config.cors.allowed_origins.join(', ')}`);
  if (config.pool.enabled) {
    pool.startCooldownSweeper();
    const stats = pool.stats();
    console.log(`[hopez-api] pool: total=${stats.total} available=${stats.available} assigned=${stats.assigned} cooling_down=${stats.cooling_down}`);
    if (stats.total < config.pool.min_size) {
      console.warn(`[hopez-api] WARNING: pool size ${stats.total} < min_size ${config.pool.min_size}. Run: npm run seed-pool`);
    }
  }
});
