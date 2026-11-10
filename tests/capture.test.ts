import test from 'node:test';
import assert from 'node:assert/strict';
import { matchVisualConfirmation } from '../src/capture';
import type { Application } from '../shared/types';

const application = (id: string, company: string, role: string) => ({ id, company, role }) as Application;
const jobs = [
  application('northstar-product', 'Northstar', 'Product Designer'),
  application('northstar-engineer', 'Northstar', 'Software Engineer'),
  application('orbit-product', 'Orbit', 'Product Designer'),
];

test('a submit button is not visual confirmation', () => {
  assert.equal(matchVisualConfirmation('Northstar Product Designer Submit application', jobs), null);
});

test('an explicit failure overrides a generic thank-you message', () => {
  assert.equal(matchVisualConfirmation('Northstar Product Designer Thank you for applying. Your application could not be submitted.', jobs), null);
});

test('instructions about a future confirmation are not submission evidence', () => {
  for (const text of [
    'Once your application has been submitted, you will receive an email.',
    'If your application was received, we will contact you.',
    'Check whether we have received your application.',
  ]) assert.equal(matchVisualConfirmation(`Northstar Product Designer ${text}`, jobs), null);
});

test('visual success requires matching both company and role', () => {
  const finding = matchVisualConfirmation('Northstar\nProduct Designer\nYour application has been submitted.', jobs);
  assert.equal(finding?.application?.id, 'northstar-product');
});

test('company alone does not select one of several applications', () => {
  const finding = matchVisualConfirmation('Northstar\nThank you for applying.', jobs);
  assert.equal(finding?.application, null);
});

test('a screen containing several matching jobs is ambiguous', () => {
  const finding = matchVisualConfirmation('Northstar Product Designer Software Engineer\nWe have received your application.', jobs);
  assert.equal(finding?.application, null);
});

test('duplicate roles at the same employer remain ambiguous', () => {
  const duplicateJobs = [...jobs, application('northstar-product-2', 'Northstar', 'Product Designer')];
  assert.equal(matchVisualConfirmation('Northstar Product Designer Thank you for applying', duplicateJobs)?.application, null);
});

test('name matches respect boundaries and whitespace', () => {
  const finding = matchVisualConfirmation('Orbital\nProduct   Designer\nApplication submitted successfully', jobs);
  assert.equal(finding?.application, null);
});
