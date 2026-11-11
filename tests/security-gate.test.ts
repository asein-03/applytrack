import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error The distribution gate is also executed directly by Node in CI.
import { inspectCloudConfig, inspectContent, inspectPath, isPrivateEmail } from '../scripts/security-gate.mjs';

test('distribution gate rejects private files and test payloads without blocking runtime dependencies', () => {
  for (const path of ['.env', 'desktop-dist/.env.production', 'data/apply.sqlite', 'screenshots/application.png', 'backups/export.json', 'node_modules/zod/src/v4/tests/fixture.ts', 'desktop-dist/resume.pdf', 'extension/inbox.json', 'dist/resume.pdf', 'dist/assets/resume.pdf', 'dist/ocr/resume.pdf']) assert.equal(inspectPath(path, true).length, 1, path);
  for (const path of ['desktop-dist/main.cjs', 'dist/index.html', 'dist/ocr/tesseract-6.0.1/core/tesseract-core-simd-lstm.wasm.js', 'node_modules/zod/index.cjs', 'extension/background.js', 'package.json']) assert.deepEqual(inspectPath(path, true), [], path);
  assert.deepEqual(inspectPath('.env.example'), []);
  assert.equal(inspectPath('.env.example', true).length, 1);
});

test('distribution gate permits public client configuration and detects privileged credentials', () => {
  const token = ['sb', 'secret', 'a'.repeat(32)].join('_');
  const publicKey = ['sb', 'publishable', 'a'.repeat(32)].join('_');
  assert.deepEqual(inspectContent('app.js', Buffer.from(publicKey)), []);
  assert.deepEqual(inspectContent('app.js', Buffer.from(token)), [{ path: 'app.js', type: 'supabase-secret-key' }]);
  const jwt = (role: string) => `${Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url')}.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.signature`;
  assert.equal(inspectContent('app.js', Buffer.from(jwt('service_role')))[0].type, 'nonpublic-jwt');
  assert.deepEqual(inspectContent('app.js', Buffer.from(jwt('anon'))), []);
  assert.deepEqual(inspectCloudConfig('cloud-config.json', Buffer.from(JSON.stringify({ url: 'https://project.supabase.co', publishableKey: publicKey }))), []);
  assert.deepEqual(inspectCloudConfig('cloud-config.json', Buffer.from(JSON.stringify({ url: 'https://project.supabase.co', publishableKey: jwt('anon') }))), []);
  assert.equal(inspectCloudConfig('cloud-config.json', Buffer.from(JSON.stringify({ url: 'https://project.supabase.co', publishableKey: jwt('service_role') })))[0].type, 'nonpublic-cloud-key');
  assert.equal(inspectCloudConfig('cloud-config.json', Buffer.from(JSON.stringify({ url: 'https://project.supabase.co', publishableKey: publicKey, clientSecret: 'not-public' })))[0].type, 'unexpected-cloud-config');
});

test('distribution findings report only paths and types, and detect local secret bytes', () => {
  const privateValue = Buffer.from(['synthetic', 'credential', 'bytes'].join('-'));
  const results = inspectContent('bundle.js', privateValue, { knownSecrets: [privateValue] });
  assert.deepEqual(results, [{ path: 'bundle.js', type: 'local-private-value' }]);
  assert.equal(JSON.stringify(results).includes(privateValue.toString()), false);
  assert.equal(isPrivateEmail('person@example.com'), false);
  assert.equal(isPrivateEmail('person@northstar.example'), false);
  assert.equal(isPrivateEmail('person@users.noreply.github.com'), false);
  assert.equal(isPrivateEmail(['person', ['mail', 'com'].join('.')].join('@')), true);
});
