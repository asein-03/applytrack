import test from 'node:test';
import assert from 'node:assert/strict';
import { externalUrl, isTrustedPage } from '../desktop/security.js';

test('desktop privileges require the exact app origin without credentials', () => {
  const origin = 'http://localhost:5173';
  assert.equal(isTrustedPage(`${origin}/?connected=gmail`, origin), true);
  for (const value of ['https://localhost:5173', 'http://localhost:4318', 'http://localhost:5173.evil.test', 'http://user@localhost:5173', 'file:///tmp/app.html', 'javascript:alert(1)']) assert.equal(isTrustedPage(value, origin), false, value);
});
test('external links cannot open files, app protocols, loopback or credential URLs', () => {
  assert.equal(externalUrl('https://example.com/jobs/42'), 'https://example.com/jobs/42');
  assert.equal(externalUrl('mailto:recruiter@example.com'), 'mailto:recruiter@example.com');
  for (const value of ['file:///etc/passwd', 'javascript:alert(1)', 'apply:quit', 'https://user:password@example.com', 'http://127.0.0.1:4318', 'http://localhost:5173', 'http://[::1]', 'https://example.com/\nsecret']) assert.equal(externalUrl(value), null, value);
});
