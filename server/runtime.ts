import express from 'express';
import type { Server } from 'node:http';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp, apiErrorHandler } from './app.js';
import { attachEmailRoutes } from './email.js';
import { extensionArchive } from './archive.js';
import { scopedRuntime } from './cloud.js';

export async function startServer(options: { rootDir?: string; dataDir?: string; port?: number; uiPort?: number; production?: boolean; protectRuntime?: boolean } = {}) {
  const root = options.rootDir ?? process.cwd();
  const dataDir = options.dataDir ?? resolve(process.env.DATA_DIR ?? 'data');
  const port = options.port ?? Number(process.env.PORT ?? 4318);
  const ports = [...new Set([port, ...(options.uiPort ? [options.uiPort] : [])])];
  if (ports.some(value => !Number.isInteger(value) || value < 1024 || value > 65535)) throw new Error('App ports must be between 1024 and 65535.');
  const dist = resolve(root, 'dist');
  if (options.production && !existsSync(resolve(dist, 'index.html'))) throw new Error('The application files are missing. Reinstall ApplyTrack.');
  process.env.DATA_DIR = dataDir;
  process.env.PORT = String(port);
  if (options.production && !process.env.APP_ORIGIN) process.env.APP_ORIGIN = `http://localhost:${options.uiPort ?? port}`;
  const services = createApp({ protectRuntime: options.protectRuntime });
  const { app, store, cloud, repository } = services;
  const email = attachEmailRoutes(app, store, { dataDir, cloud, repository });
  app.get('/api/extension/download', (_req, res) => {
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="apply-extension.zip"');
    res.send(extensionArchive(resolve(root, 'extension')));
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Endpoint not found.' }));
  if (existsSync(resolve(dist, 'index.html'))) {
    app.use((_req, res, next) => {
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
      if (options.production) res.setHeader('Content-Security-Policy', [
        "default-src 'self'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'", "object-src 'none'",
        "script-src 'self' 'wasm-unsafe-eval'", "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:", "font-src 'self' data:", "worker-src 'self'",
        "frame-src 'self' blob:", `connect-src 'self' ${cloud.url || ''} `,
      ].join('; '));
      next();
    });
    app.use(express.static(dist));
    app.get('/{*path}', (_req, res) => res.sendFile(resolve(dist, 'index.html')));
  }
  app.use(apiErrorHandler);
  const servers: Server[] = [];
  const stopTracking = () => {
    store.stopSession();
    const activeUser = store.getMeta<string>('activeCloudUser');
    if (activeUser) scopedRuntime(store, activeUser).stopSession();
  };
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    stopTracking(); email.stop();
    await Promise.all(servers.map(server => new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); })));
    services.close();
  };
  try {
    for (const value of ports) await new Promise<void>((done, reject) => {
      const server = app.listen(value, '127.0.0.1', () => done());
      servers.push(server); server.once('error', reject);
    });
  } catch (error) { await stop(); throw error; }
  return { ...services, servers, stop, stopTracking, origin: `http://localhost:${options.uiPort ?? port}` };
}
