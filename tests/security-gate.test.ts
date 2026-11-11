import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

test('commit privacy audits the full current history when a rewritten base is unavailable', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'applytrack-commit-privacy-'));
  const script = fileURLToPath(new URL('../scripts/security-gate.mjs', import.meta.url));
  const safeEmail = 'person@users.noreply.github.com';
  const privateEmail = ['person', ['mail', 'com'].join('.')].join('@');
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_COMMITTER_NAME: 'Test', GIT_AUTHOR_EMAIL: safeEmail, GIT_COMMITTER_EMAIL: safeEmail };
  const commit = (author: string) => execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'Test commit'], { cwd, env: { ...env, GIT_AUTHOR_EMAIL: author } });
  const audit = (base: string) => spawnSync(process.execPath, [script, '--email-base', base], { cwd, encoding: 'utf8' });
  try {
    execFileSync('git', ['init', '--quiet'], { cwd });
    commit(safeEmail);
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
    assert.equal(audit('a'.repeat(40)).status, 0);
    commit(privateEmail);
    for (const previous of [base, 'a'.repeat(40)]) {
      const result = audit(previous);
      assert.equal(result.status, 1);
      assert.equal(JSON.parse(result.stdout).findings[0].type, 'public-author-email');
      assert.equal((result.stdout + result.stderr).includes(privateEmail), false);
    }
    assert.equal(audit('--all').status, 1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
