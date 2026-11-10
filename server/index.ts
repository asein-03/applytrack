import express from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp, apiErrorHandler } from './app.js';
import { attachEmailRoutes } from './email.js';
import { extensionArchive } from './archive.js';

const dataDir = resolve(process.env.DATA_DIR ?? 'data');
const port = Number(process.env.PORT ?? 4318);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be between 1024 and 65535.');
const production = process.argv.includes('--production');
if (production && !existsSync(resolve('dist/index.html'))) throw new Error('Run npm run build before npm start.');
if (production && !process.env.APP_ORIGIN) process.env.APP_ORIGIN = `http://127.0.0.1:${port}`;
const { app, store, close } = createApp();
const email = attachEmailRoutes(app, store, { dataDir });

app.get('/api/extension/download', (_req, res) => {
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="apply-extension.zip"');
  res.send(extensionArchive(resolve('extension')));
});
app.use('/api', (_req, res) => res.status(404).json({ error: 'Endpoint not found.' }));
const dist = resolve('dist');
if (existsSync(resolve(dist, 'index.html'))) {
  app.use(express.static(dist));
  app.get('/{*path}', (_req, res) => res.sendFile(resolve(dist, 'index.html')));
}
app.use(apiErrorHandler);
const server = app.listen(port, '127.0.0.1', () => console.info(`Apply API: http://127.0.0.1:${port}`));
const shutdown = () => {
  email.stop();
  server.close(() => { close(); process.exit(0); });
  setTimeout(() => process.exit(0), 3000).unref();
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
