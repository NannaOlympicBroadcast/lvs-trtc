'use strict';
const http = require('http');
const express = require('express');
const config = require('./config');
const { migrate } = require('./db/migrate');
const { ensureBuckets } = require('./lib/minio');
const { setupGateway } = require('./ws/gateway');
const errorHandler = require('./middleware/error');

async function main() {
  await migrate();
  await ensureBuckets();

  const app = express();
  app.set('trust proxy', true);
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/keys', require('./routes/apikeys'));
  app.use('/api/me/webhooks', require('./routes/webhooks'));
  app.use('/api/users', require('./routes/users'));
  app.use('/api/chat', require('./routes/chat'));
  app.use('/api/videos/:videoId/comments', require('./routes/comments'));
  app.use('/api/videos/:videoId/subtitles', require('./routes/subtitles'));
  app.use('/api/videos', require('./routes/videos'));
  app.use('/api/collections', require('./routes/collections'));
  app.use('/api/reports', require('./routes/reports'));
  app.use('/api/live', require('./routes/live'));
  app.use('/api/admin', require('./routes/admin'));
  app.use('/api/cdn', require('./routes/cdn'));

  app.use(errorHandler);

  const server = http.createServer(app);
  setupGateway(server);

  server.listen(config.port, () => {
    console.log(`[api] LAN Video Station backend listening on :${config.port}`);
  });
}

main().catch((e) => {
  console.error('[fatal]', e);
  process.exit(1);
});
