'use strict';

const http = require('http');
const express = require('express');

const { load: loadConfig } = require('./lib/config');
const { createLogger } = require('./lib/logger');
const { createUploads } = require('./lib/uploads');
const { attachRealtime } = require('./lib/rooms');

/** Browser hardening. YouTube's player needs its own origins whitelisted. */
function securityHeaders(config) {
  const csp = [
    "default-src 'self'",
    "script-src 'self' https://www.youtube.com https://s.ytimg.com",
    "style-src 'self'",
    "img-src 'self' data: https://i.ytimg.com",
    "media-src 'self' blob:",
    'frame-src https://www.youtube.com https://www.youtube-nocookie.com',
    "connect-src 'self' ws: wss:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join('; ');

  return (_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    // YouTube embeds fail (error 153) without a referrer, so don't use "no-referrer".
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (config.csp) res.setHeader('Content-Security-Policy', csp);
    next();
  };
}

function createApp(overrides = {}) {
  const config = { ...loadConfig(), ...overrides };
  const log = createLogger({ silent: config.silent });

  const app = express();
  const server = http.createServer(app);

  // `realtime` is created below; uploads only calls this lazily.
  const uploads = createUploads({ config, log, isInUse: (url) => realtime.isFileInUse(url) });
  const realtime = attachRealtime({ server, config, log, uploads });

  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);
  app.use(securityHeaders(config));

  app.get('/healthz', (_req, res) => res.json({ ok: true, uptime: Math.round(process.uptime()) }));
  app.get('/api/config', (_req, res) =>
    res.json({ maxUploadBytes: config.maxUploadBytes, extensions: uploads.EXTENSIONS }),
  );

  app.use('/uploads', uploads.serve); // static handler supports Range requests, so seeking works
  app.post('/upload', ...uploads.post);
  app.use(express.static(config.publicDir));

  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    log.error('request failed', { message: err.message });
    if (res.headersSent) return res.destroy();
    res.status(err.status || 500).json({ error: 'Something went wrong.' });
  });

  function start() {
    // Node's default 5-minute request timeout would cut off large uploads on slow links.
    server.requestTimeout = config.uploadTimeoutMs;
    server.headersTimeout = 60_000;
    server.keepAliveTimeout = 65_000;

    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ port: config.port, host: config.host }, () => {
        uploads.startSweeper();
        const { port } = server.address();
        log.info(`Watch Together running on http://localhost:${port}`);
        resolve(port);
      });
    });
  }

  function stop() {
    uploads.stop();
    realtime.close();
    return new Promise((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
      setTimeout(() => server.closeAllConnections(), 2000).unref();
    });
  }

  return { config, log, server, start, stop };
}

module.exports = { createApp };

if (require.main === module) {
  const app = createApp();

  app.start().catch((err) => {
    app.log.error('could not start', { message: err.message });
    process.exit(1);
  });

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    app.log.info(`${signal} received, shutting down`);
    setTimeout(() => process.exit(1), 10_000).unref();
    await app.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => app.log.error('unhandled rejection', { reason: String(reason) }));
}
