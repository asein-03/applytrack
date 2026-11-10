import { test, expect, type Page } from '@playwright/test';
import type { Application } from '../shared/types';

function applicationFixture(): Application {
  return {
    id: 'document-ui-record', workspace: 'personal', company: 'Document test', role: 'Product Designer',
    stage: 'in_progress', location: '', workMode: '', salary: '', url: '', jobId: '', description: '', email: '',
    resumeName: 'Resume.pdf', coverLetterName: 'Cover-letter.pdf', resumeDocumentId: 'resume-current', coverLetterDocumentId: 'cover-current',
    recruiterName: '', recruiterEmail: '', notes: '', priority: 'normal', appliedAt: null,
    createdAt: '2026-11-10T12:00:00.000Z', updatedAt: '2026-11-10T13:00:00.000Z', tasks: [], evidence: [], timeline: [],
    documents: [
      { id: 'resume-current', kind: 'resume', name: 'Resume.pdf', size: 153600, mimeType: 'application/pdf', lastModified: 1794308400000, sha256: 'b'.repeat(64), detectedAt: '2026-11-10T13:00:00.000Z', status: 'selected', submittedAt: null, stored: true },
      { id: 'cover-current', kind: 'cover_letter', name: 'Cover-letter.pdf', size: 40960, mimeType: 'application/pdf', lastModified: 1794308400000, sha256: 'c'.repeat(64), detectedAt: '2026-11-10T12:30:00.000Z', status: 'submitted', submittedAt: '2026-11-10T12:40:00.000Z', stored: false },
      { id: 'resume-previous', kind: 'resume', name: 'Resume.pdf', size: 102400, mimeType: 'application/pdf', lastModified: 1794304800000, sha256: 'a'.repeat(64), detectedAt: '2026-11-10T12:00:00.000Z', status: 'replaced', submittedAt: null, stored: true },
    ],
  };
}

async function openApplication(page: Page, getApplication: () => Application) {
  await page.addInitScript(() => localStorage.setItem('apply.workspace', 'personal'));
  await page.route('**/api/applications?workspace=personal', route => route.fulfill({ json: { applications: [getApplication()] } }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Document test', exact: true }).click();
  const documents = page.getByRole('region', { name: 'Documents', exact: true });
  await documents.scrollIntoViewIfNeeded();
  return documents;
}

test('detected files distinguish selection, submission, earlier versions, and saved downloads', async ({ page }) => {
  const application = applicationFixture();
  const documents = await openApplication(page, () => application);
  await expect(documents.getByText('Selected', { exact: true })).toBeVisible();
  await expect(documents.getByText('Detected at submission', { exact: true })).toBeVisible();
  await expect(documents.getByText('150 KB', { exact: true })).toBeVisible();
  await expect(documents.getByText('Version bbbbbbbb', { exact: true })).toBeVisible();
  await expect(documents.getByText('Version aaaaaaaa', { exact: true })).toBeHidden();
  await expect(documents.getByText('No saved copy', { exact: true })).toBeVisible();
  await expect(documents).not.toContainText('b'.repeat(64));
  await documents.getByText('1 previous file', { exact: true }).click();
  await expect(documents.getByText('Version aaaaaaaa', { exact: true })).toBeVisible();
  await expect(documents.getByText('Replaced', { exact: true })).toBeVisible();

  await page.route('**/api/applications/document-ui-record/documents/resume-current/file', route => route.fulfill({
    contentType: 'application/pdf', headers: { 'Content-Disposition': 'attachment; filename="Resume.pdf"' }, body: '%PDF-1.4\nDocument UI test\n%%EOF',
  }));
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    documents.getByRole('button', { name: 'Download Resume.pdf, version bbbbbbbb', exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('Resume.pdf');
  expect(await download.failure()).toBeNull();

  await page.route('**/api/applications/document-ui-record/documents/resume-previous/file', route => route.fulfill({ status: 503, json: { error: 'This copy is temporarily unavailable.' } }));
  const previousDownload = documents.getByRole('button', { name: 'Download Resume.pdf, version aaaaaaaa', exact: true });
  await previousDownload.click();
  await expect(documents.getByRole('alert')).toHaveText('This copy is temporarily unavailable.');
  await expect(previousDownload).toBeEnabled();
});

test('manual filename edits remain references and do not rename a detected copy', async ({ page }) => {
  let application = applicationFixture();
  await openApplication(page, () => application);
  let patchBody: Record<string, unknown> | undefined;
  await page.route('**/api/applications/document-ui-record', async route => {
    patchBody = route.request().postDataJSON();
    application = { ...application, resumeName: String(patchBody?.resumeName), resumeDocumentId: null };
    await route.fulfill({ json: application });
  });
  await page.getByRole('button', { name: 'Edit application', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit application', exact: true });
  await editor.locator('summary').filter({ hasText: 'Documents' }).click();
  await expect(editor.getByText('These names are manual references. Editing them does not rename detected files or saved copies.')).toBeVisible();
  await editor.getByRole('textbox', { name: 'Resume filename reference', exact: true }).fill('Manual-reference.pdf');
  await editor.getByRole('button', { name: 'Save changes', exact: true }).click();
  const documents = page.getByRole('region', { name: 'Documents', exact: true });
  await documents.scrollIntoViewIfNeeded();
  await expect(documents.getByText('Manual-reference.pdf', { exact: true })).toBeVisible();
  await expect(documents.getByText('Filename reference', { exact: true })).toBeVisible();
  expect(patchBody?.resumeName).toBe('Manual-reference.pdf');
  expect(patchBody).not.toHaveProperty('documents');
  expect(patchBody).not.toHaveProperty('resumeDocumentId');
  await documents.getByText('2 previous files', { exact: true }).click();
  await expect(documents.getByRole('button', { name: 'Download Resume.pdf, version bbbbbbbb', exact: true })).toBeVisible();
  await expect(documents.getByRole('button', { name: /Download Manual-reference/ })).toHaveCount(0);
});

test('legacy references and long detected filenames remain readable on a phone', async ({ page }) => {
  const application = applicationFixture();
  application.resumeDocumentId = undefined;
  application.resumeName = 'Manual-resume-reference.pdf';
  application.coverLetterDocumentId = null;
  application.coverLetterName = '';
  application.documents = [{ ...application.documents![0], name: `${'LongResumeFilename'.repeat(12)}.pdf` }];
  await page.setViewportSize({ width: 390, height: 844 });
  const documents = await openApplication(page, () => application);
  await expect(documents.getByText('Manual-resume-reference.pdf', { exact: true })).toBeVisible();
  await expect(documents.getByText(application.documents[0].name, { exact: true })).toBeVisible();
  await expect(documents.getByText('No file detected', { exact: true })).toBeVisible();
  await expect(documents.getByText(/With browser tracking on/)).toBeVisible();
  const dialog = page.getByRole('dialog');
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect(await documents.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
