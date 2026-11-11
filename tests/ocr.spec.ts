import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';

const policy = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; img-src 'self'; style-src 'none'; object-src 'none'; base-uri 'none'";
const html = '<!doctype html><html lang="en"><head><meta charset="UTF-8"><title>Local OCR verification</title></head><body><button>Read sample image</button><output aria-live="polite">Ready</output><canvas width="1400" height="320"></canvas><pre></pre><script src="/fixture.js"></script></body></html>';
let server: Server, temporary: string, origin: string;
const assetRequests: string[] = [];
test.beforeAll(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'apply-ocr-test-'));
  await build({ entryPoints: [resolve('tests/fixtures/ocr.ts')], outfile: join(temporary, 'fixture.js'), bundle: true, platform: 'browser', format: 'iife', define: { 'import.meta.env.BASE_URL': JSON.stringify('/') }, logLevel: 'silent' });
  server = createServer(async (request, response) => {
    response.setHeader('Content-Security-Policy', policy);
    const pathname = new URL(request.url!, 'http://localhost').pathname;
    try {
      if (pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end(html); return; }
      const root = pathname === '/fixture.js' ? temporary : resolve('public');
      const path = pathname === '/fixture.js' ? join(root, 'fixture.js') : resolve(root, `.${pathname}`);
      if (!path.startsWith(root + sep) || (!pathname.startsWith('/ocr/') && pathname !== '/fixture.js')) { response.writeHead(404).end(); return; }
      assetRequests.push(pathname);
      response.setHeader('Content-Type', path.endsWith('.js') ? 'application/javascript' : path.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream');
      response.end(await readFile(path));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
test.afterAll(async () => {
  if (server) await new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); });
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

test('real OCR recognizes a local image with self-only script, worker and connection policies', async ({ page, context }) => {
  test.setTimeout(60000);
  const requests: string[] = [], violations: string[] = [];
  context.on('request', request => requests.push(request.url()));
  page.on('console', message => { if (/Content Security Policy|Refused to|violates.*policy/i.test(message.text())) violations.push(message.text()); });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
  const response = await page.goto(origin);
  expect(response!.headers()['content-security-policy']).toBe(policy);
  await page.getByRole('button', { name: 'Read sample image' }).click();
  await expect(page.locator('output')).toHaveText('Confirmation recognized', { timeout: 45000 });
  await expect(page.locator('pre')).toContainText('Example Labs');
  await expect(page.locator('pre')).toContainText('Product Designer');
  expect(requests.every(url => new URL(url).origin === origin)).toBe(true);
  expect(assetRequests.some(path => path.endsWith('/worker.min.js'))).toBe(true);
  expect(assetRequests.some(path => /\/core\/tesseract-core.*\.wasm\.js$/.test(path))).toBe(true);
  expect(assetRequests.some(path => path.endsWith('/lang/eng.traineddata.gz'))).toBe(true);
  expect(violations).toEqual([]);
});
