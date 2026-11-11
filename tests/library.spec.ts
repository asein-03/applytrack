import { test, expect, type Page } from '@playwright/test';
import type { LibraryDocument } from '../shared/library';
import type { Application } from '../shared/types';

const baseApplication = (id: string, company: string): Application => ({ id, company, role: 'Product Designer', workspace: 'personal', stage: 'applied', location: 'New York', workMode: 'Hybrid', salary: '', url: '', jobId: '', description: '', email: '', resumeName: 'Resume.pdf', coverLetterName: '', recruiterName: '', recruiterEmail: '', notes: '', priority: 'normal', appliedAt: '2026-11-10T14:00:00Z', createdAt: '2026-11-10T13:00:00Z', updatedAt: '2026-11-10T14:00:00Z', documents: [], tasks: [], evidence: [], timeline: [] });
const documentsFixture = (): LibraryDocument[] => [{
  id: `resume-file-${'a'.repeat(64)}`, kind: 'resume', label: '', name: 'Resume.pdf', names: ['Product-design.pdf', 'Resume.pdf'], size: 153600, mimeType: 'application/pdf', sha256: 'a'.repeat(64), firstDetectedAt: '2026-11-08T13:00:00Z', lastDetectedAt: '2026-11-10T14:00:00Z', stored: true,
  usages: [
    { applicationId: 'application-1', documentId: 'document-1', company: 'Northstar', role: 'Product Designer', name: 'Resume.pdf', status: 'submitted', detectedAt: '2026-11-10T14:00:00Z', submittedAt: '2026-11-10T14:05:00Z', stored: true, current: true },
    { applicationId: 'application-2', documentId: 'document-2', company: 'Studio', role: 'Design Engineer', name: 'Product-design.pdf', status: 'replaced', detectedAt: '2026-11-08T13:00:00Z', submittedAt: null, stored: true, current: false },
  ],
}, {
  id: `cover_letter-file-${'b'.repeat(64)}`, kind: 'cover_letter', label: 'Studio cover letter', name: 'Cover-letter.txt', names: ['Cover-letter.txt'], size: 512, mimeType: 'text/plain', sha256: 'b'.repeat(64), firstDetectedAt: '2026-11-07T13:00:00Z', lastDetectedAt: '2026-11-07T13:00:00Z', stored: true,
  usages: [{ applicationId: 'application-2', documentId: 'document-text', company: 'Studio', role: 'Design Engineer', name: 'Cover-letter.txt', status: 'selected', detectedAt: '2026-11-07T13:00:00Z', submittedAt: null, stored: true, current: true }],
}, {
  id: `resume-record-${'c'.repeat(64)}`, kind: 'resume', label: '', name: 'Resume-draft.docx', names: ['Resume-draft.docx'], size: 12288, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', sha256: null, firstDetectedAt: '2026-11-06T13:00:00Z', lastDetectedAt: '2026-11-06T13:00:00Z', stored: false,
  usages: [{ applicationId: 'application-1', documentId: 'document-draft', company: 'Northstar', role: 'Product Designer', name: 'Resume-draft.docx', status: 'removed', detectedAt: '2026-11-06T13:00:00Z', submittedAt: null, stored: false, current: false }],
}];

function pdfFixture() {
  const stream = 'BT /F1 20 Tf 50 740 Td (Product Designer) Tj 0 -36 Td /F1 12 Tf (Synthetic resume preview) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let value = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(value)); value += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const start = Buffer.byteLength(value);
  value += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return value;
}

async function openLibrary(page: Page, initial = documentsFixture()) {
  let documents = initial;
  await page.addInitScript(() => localStorage.setItem('apply.workspace', 'personal'));
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === '/api/cloud/config') return route.fulfill({ json: { enabled: false, configured: false } });
    if (path === '/api/applications') return route.fulfill({ json: { applications: [baseApplication('application-1', 'Northstar'), baseApplication('application-2', 'Studio')] } });
    if (path === '/api/settings') return route.fulfill({ json: { gmailConfigured: false, inboxes: [], extensionToken: 'test-pair-token', session: null } });
    if (path === '/api/email/review') return route.fulfill({ json: { items: [] } });
    if (path === '/api/reminders') return route.fulfill({ json: { preferences: { enabled: false, leadMinutes: 1440, timeZone: null, dateOnlyTime: '09:00' }, items: [], serverTime: '2026-11-10T14:00:00Z' } });
    if (path === '/api/documents') return route.fulfill({ json: { documents: url.searchParams.get('workspace') === 'demo' ? [] : documents } });
    if (path.startsWith('/api/documents/')) {
      const id = decodeURIComponent(path.split('/').at(-1)!); const label = route.request().postDataJSON().label;
      documents = documents.map(document => document.id === id ? { ...document, label } : document);
      return route.fulfill({ json: documents.find(document => document.id === id) });
    }
    if (path.endsWith('/file')) return route.fulfill({ contentType: 'application/octet-stream', body: path.includes('document-text') ? '<script>window.untrustedDocumentRan=true</script>\nCover letter text.' : pdfFixture() });
    return route.fulfill({ json: {} });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Documents', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Documents', exact: true })).toBeVisible();
  return { getDocuments: () => documents };
}

test('library searches versions, saves a readable label, and opens the associated application', async ({ page }) => {
  const data = await openLibrary(page);
  const versions = page.getByRole('region', { name: 'Document versions' });
  await expect(versions.getByRole('button')).toHaveCount(3);
  await expect(page.getByRole('region', { name: 'Applications using this version' }).getByRole('button')).toHaveCount(2);
  await page.getByRole('button', { name: 'Add a version label' }).click();
  await page.getByRole('textbox', { name: 'Version label' }).fill('Design leadership');
  await page.getByRole('button', { name: 'Save label', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Design leadership', exact: true })).toBeVisible();
  expect(data.getDocuments()[0].names).toEqual(['Product-design.pdf', 'Resume.pdf']);
  await page.getByRole('textbox', { name: 'Search documents' }).fill('design leadership');
  await expect(versions.getByRole('button')).toHaveCount(1);
  await page.getByRole('button', { name: 'Clear document search' }).click();
  await page.getByRole('combobox', { name: 'Document type' }).selectOption('cover_letter');
  await expect(versions.getByRole('button')).toHaveCount(1);
  await page.getByRole('combobox', { name: 'Document type' }).selectOption('all');
  await page.getByRole('region', { name: 'Applications using this version' }).getByRole('button', { name: /Northstar/ }).click();
  await expect(page.getByRole('dialog').getByText('Northstar', { exact: true })).toBeVisible();
});

test('PDF and text previews use fetched copies while downloads preserve original filenames', async ({ page }) => {
  await openLibrary(page);
  await page.screenshot({ path: test.info().outputPath('library-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.getByTitle('PDF preview of Resume.pdf')).toHaveAttribute('src', /^blob:/);
  await page.getByRole('button', { name: 'Close document preview' }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download original' }).click()]);
  expect(download.suggestedFilename()).toBe('Resume.pdf');
  expect(await download.failure()).toBeNull();
  await page.getByRole('region', { name: 'Document versions' }).getByRole('button', { name: /Studio cover letter/ }).click();
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Document preview' }).locator('pre')).toContainText('<script>window.untrustedDocumentRan=true</script>');
  expect(await page.evaluate(() => 'untrustedDocumentRan' in window)).toBe(false);
  await page.getByRole('region', { name: 'Document versions' }).getByRole('button', { name: /Resume-draft.docx/ }).click();
  await expect(page.getByRole('button', { name: 'Preview', exact: true })).toHaveCount(0);
  await expect(page.getByText('The filename was detected, but no copy was saved.', { exact: false })).toBeVisible();
});

test('a failed file request remains recoverable and a mislabeled PDF is never embedded', async ({ page }) => {
  await openLibrary(page);
  await page.route('**/api/applications/application-1/documents/document-1/file', route => route.fulfill({ status: 503, json: { error: 'Saved copy unavailable. Retry shortly.' } }));
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Saved copy unavailable. Retry shortly.');
  await expect(page.getByRole('button', { name: 'Preview', exact: true })).toBeEnabled();
  await page.route('**/api/applications/application-1/documents/document-1/file', route => route.fulfill({ body: '<html><script>alert(1)</script></html>' }));
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('cannot be previewed as a PDF');
  await expect(page.getByTitle('PDF preview of Resume.pdf')).toHaveCount(0);
});

test('phone layout keeps long names readable and switching workspaces clears the library and preview', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const documents = documentsFixture();
  documents[0].name = `${'LongResumeName'.repeat(15)}.pdf`; documents[0].names = [documents[0].name];
  await openLibrary(page, documents);
  await page.getByRole('region', { name: 'Document versions' }).getByRole('button').first().click();
  await expect(page.getByRole('heading', { name: documents[0].name, exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('library-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.getByTitle(`PDF preview of ${documents[0].name}`)).toBeVisible();
  await page.getByRole('combobox', { name: 'Workspace', exact: true }).selectOption('demo');
  await expect(page.getByRole('heading', { name: 'Your documents will appear here' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Document versions' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Document preview' })).toHaveCount(0);
});

test('an unavailable library shows a retry instead of implying there are no files', async ({ page }) => {
  await openLibrary(page, []);
  await expect(page.getByRole('heading', { name: 'Your documents will appear here' })).toBeVisible();
  await page.route('**/api/documents?workspace=personal', route => route.fulfill({ status: 503, json: { error: 'Document service unavailable.' } }));
  await page.getByRole('button', { name: 'Applications', exact: true }).click();
  await page.getByRole('button', { name: 'Documents', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Document service unavailable.');
  await expect(page.getByRole('heading', { name: 'Your documents will appear here' })).toHaveCount(0);
  await page.route('**/api/documents?workspace=personal', route => route.fulfill({ json: { documents: documentsFixture() } }));
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Document versions' })).toBeVisible();
});
