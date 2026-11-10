import { test, expect } from '@playwright/test';

test('keyboard users can open an application, move between tabs, and return to its opener', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('apply.workspace', 'demo'));
  await page.goto('/');
  const applicationsNavigation = page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Applications', exact: true });
  await applicationsNavigation.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Applications', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Search applications' }).fill('Northstar');
  await page.getByRole('combobox', { name: 'Filter by stage' }).selectOption('assessment');
  const opener = page.getByRole('button', { name: /^Northstar(?:\s+High priority)?$/ });
  await opener.focus();
  await page.keyboard.press('Enter');
  const detailsTab = page.getByRole('tab', { name: 'Details', exact: true });
  await expect(detailsTab).toHaveAttribute('aria-selected', 'true');
  await detailsTab.focus();
  await page.keyboard.press('ArrowRight');
  const activityTab = page.getByRole('tab', { name: 'Activity', exact: true });
  await expect(activityTab).toBeFocused();
  await expect(activityTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: 'Application timeline' })).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: /^Evidence/ })).toBeFocused();
  await expect(page.getByRole('heading', { name: 'Confirmation sources' })).toBeVisible();
  await page.keyboard.press('Home');
  await expect(detailsTab).toBeFocused();
  await expect(detailsTab).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test('workspace switching remains available on a phone after adding an application', async ({ page, request }) => {
  const response = await request.post('/api/applications', { data: { company: `Mobile workspace test ${Date.now()}`, role: 'Product Analyst' } });
  expect(response.ok()).toBe(true);
  const application = await response.json();
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => localStorage.setItem('apply.workspace', 'personal'));
    await page.goto('/');
    const switcher = page.getByRole('combobox', { name: 'Workspace', exact: true });
    await expect(switcher).toBeVisible();
    await switcher.selectOption('demo');
    await expect(page.getByText(/These are sample applications\./)).toBeVisible();
    await switcher.selectOption('personal');
    await expect(page.getByRole('button', { name: application.company, exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await request.delete(`/api/applications/${application.id}`); }
});

test('all four navigation controls retain accessible names at tablet width', async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 900 });
  await page.addInitScript(() => localStorage.setItem('apply.workspace', 'demo'));
  await page.goto('/');
  const navigation = page.getByRole('navigation', { name: 'Main navigation' });
  for (const name of ['Overview', 'Applications', 'Tasks', 'Connections']) {
    const control = navigation.getByRole('button', { name, exact: true });
    await expect(control).toBeVisible();
    await expect(control).toHaveAccessibleName(name);
  }
});

test('closing a newly created application returns focus to the original Add button', async ({ page, request }) => {
  const company = `Focus restoration test ${Date.now()}`;
  let applicationId: string | undefined;
  try {
    await page.addInitScript(() => localStorage.setItem('apply.workspace', 'personal'));
    await page.goto('/');
    const addButton = page.getByRole('button', { name: 'Add application', exact: true }).first();
    await addButton.click();
    const editor = page.getByRole('dialog', { name: 'Add application', exact: true });
    await editor.getByRole('textbox', { name: 'Company', exact: true }).fill(company);
    await editor.getByRole('textbox', { name: 'Role', exact: true }).fill('Design Researcher');
    const savedResponse = page.waitForResponse(response => response.url().endsWith('/api/applications') && response.request().method() === 'POST');
    await editor.getByRole('button', { name: 'Add application', exact: true }).click();
    applicationId = (await (await savedResponse).json()).id;
    await expect(page.getByRole('dialog').getByRole('heading', { name: 'Design Researcher', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close application', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(addButton).toBeFocused();
  } finally { if (applicationId) await request.delete(`/api/applications/${applicationId}`); }
});

test('a failed initial load explains the error and retries without implying an empty workspace', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('apply.workspace', 'personal'));
  const routePattern = '**/api/applications?workspace=personal';
  await page.route(routePattern, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Test server unavailable.' }) }));
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('Test server unavailable.');
  await expect(page.getByRole('heading', { name: 'Track your first application' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'No applications match' })).toHaveCount(0);
  await page.unroute(routePattern);
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
});

test('an unavailable review queue does not hide empty-workspace setup or Connections', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('apply.workspace', 'personal'));
  await page.route('**/api/applications?workspace=personal', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ applications: [] }) }));
  await page.route('**/api/email/review?workspace=personal', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Review queue temporarily unavailable.' }) }));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Track your first application' })).toBeVisible();
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Connections', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Email accounts', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Browser extension', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Download extension', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy pairing code', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Import email', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('textbox', { name: 'Email text', exact: true })).toBeVisible();
});

test('switching workspaces clears demo records even when the personal applications request fails', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('apply.workspace', 'demo'));
  await page.goto('/');
  await expect(page.getByRole('button', { name: /^Northstar(?:\s+High priority)?$/ })).toBeVisible();
  await page.route('**/api/applications?workspace=personal', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Personal applications temporarily unavailable.' }) }));
  await page.getByRole('combobox', { name: 'Workspace', exact: true }).selectOption('personal');
  await expect(page.getByRole('alert')).toContainText('Personal applications temporarily unavailable.');
  await expect(page.getByRole('button', { name: /^Northstar(?:\s+High priority)?$/ })).toHaveCount(0);
  await expect(page.getByText(/These are sample applications\./)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Track your first application' })).toHaveCount(0);
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Connections', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Email accounts', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Browser extension', exact: true })).toBeVisible();
});

test('long application details remain readable without horizontal page overflow on a phone', async ({ page, request }) => {
  const company = `Long company ${Date.now()} ${'Global research '.repeat(10)}`.slice(0, 190);
  const role = `Senior researcher ${'LongRoleTitleWithoutSpaces'.repeat(10)}`.slice(0, 290);
  const response = await request.post('/api/applications', { data: { company, role, notes: 'Interview notes '.repeat(100), recruiterEmail: `${'research'.repeat(20)}@example.com` } });
  expect(response.ok()).toBe(true);
  const application = await response.json();
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => localStorage.setItem('apply.workspace', 'personal'));
    await page.goto('/');
    await page.getByRole('button', { name: 'Applications', exact: true }).click();
    await page.getByRole('textbox', { name: 'Search applications' }).fill(application.company);
    await page.getByRole('button', { name: application.company, exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: application.role, exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.getByRole('button', { name: 'Close application', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  } finally { await request.delete(`/api/applications/${application.id}`); }
});
