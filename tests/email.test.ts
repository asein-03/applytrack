import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyEmail, explicitDeadline, matchEmail, type IncomingEmail } from '../server/email-parser.js';
import { createVault } from '../server/vault.js';
import type { Application } from '../shared/types.js';
const mail = (body: string): IncomingEmail => ({ id: 'test', subject: '', body, from: '', receivedAt: '2026-11-10T17:00:00Z', workspace: 'personal' });
test('assessment invitation is distinct from completion and interview', () => {
  assert.equal(classifyEmail(mail('Please complete your numerical assessment.')).kind, 'assessment_requested');
  assert.equal(classifyEmail(mail('You have completed your assessment.')).kind, 'assessment_completed');
  assert.equal(classifyEmail(mail('We would like to schedule an interview.')).kind, 'interview');
});
test('quoted history cannot turn a new message into rejection', () => {
  const result = classifyEmail(mail('Could you confirm your availability?\nOn Tuesday, recruiter wrote:\nWe are not moving forward.'));
  assert.equal(result.kind, 'note');
  assert.equal(result.requiresReview, true);
});
test('conditional instructions cannot confirm submission or a hiring outcome', () => {
  for (const text of [
    'Once your application has been received, we will contact you.',
    'If we are not moving forward, you will receive an email.',
    'When we offer you the position, we will send the paperwork.',
  ]) {
    const result = classifyEmail(mail(text));
    assert.equal(result.kind, 'note');
    assert.equal(result.requiresReview, true);
  }
});
test('only explicit valid deadlines are extracted', () => {
  assert.equal(explicitDeadline('Complete your test by Friday at 5.'), null);
  assert.equal(explicitDeadline('Deadline: 2026-11-14'), '2026-11-14');
  assert.equal(explicitDeadline('Due: 2026-02-30'), null);
  assert.equal(explicitDeadline('Deadline: 2026-11-14T17:00:00-05:00'), '2026-11-14T17:00:00-05:00');
});
test('company-only or ambiguous roles cannot silently match', () => {
  const records = [
    { id: '1', company: 'Northstar', role: 'Data Analyst', workspace: 'personal', jobId: '', email: '' },
    { id: '2', company: 'Northstar', role: 'Product Analyst', workspace: 'personal', jobId: '', email: '' },
  ] as Application[];
  assert.equal(matchEmail(mail('Thanks for applying to Northstar.'), records), null);
  assert.equal(matchEmail(mail('Northstar Data Analyst application received.'), records)?.id, '1');
  assert.equal(matchEmail(mail('Northstar Data Analyst and Product Analyst applications.'), records), null);
});
test('short reference numbers must be corroborated by the employer', () => {
  const records = [{ id: 'one', company: 'Northstar', role: 'Data Analyst', workspace: 'personal', jobId: '1234', email: '' }] as Application[];
  assert.equal(matchEmail(mail('Invoice 1234 is ready to download.'), records), null);
  assert.equal(matchEmail(mail('Your application to Northstar, reference 1234, has been received.'), records)?.id, 'one');
});
test('tokens survive reload encrypted and reject tampering', () => {
  const dir = mkdtempSync(join(tmpdir(), 'apply-vault-'));
  try {
    const encrypted = createVault(dir).encrypt({ refresh_token: 'private-test-value' });
    assert.equal(encrypted.includes('private-test-value'), false);
    assert.deepEqual(createVault(dir).decrypt(encrypted), { refresh_token: 'private-test-value' });
    const tampered = Buffer.from(encrypted, 'base64'); tampered[tampered.length - 1] ^= 1;
    assert.throws(() => createVault(dir).decrypt(tampered.toString('base64')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
