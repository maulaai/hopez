'use strict';

const path = require('path');
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { loadConfig } = require('./config');

const cfg = loadConfig();
const app = express();

// Reverse-proxy API/auth/proxy traffic to the backend so cookies stay first-party in dev.
const apiProxy = createProxyMiddleware({
  target: cfg.backend.api_url,
  changeOrigin: true,
  xfwd: true,
  pathFilter: (pathname) =>
    pathname.startsWith('/api/') ||
    pathname.startsWith('/v1/') ||
    pathname === '/health'
});

app.use(apiProxy);

app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

// Static site
app.use(express.static(path.join(__dirname, '..', 'public'), {
  extensions: ['html'],
  index: 'index.html'
}));

// 404 fallback
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, '..', 'public', '404.html'), (err) => {
    if (err) res.send('Not found');
  });
});

app.listen(cfg.server.port, () => {
  console.log(`[hopez-web] listening on http://localhost:${cfg.server.port}`);
  console.log(`[hopez-web] proxying /api, /v1 -> ${cfg.backend.api_url}`);
});
