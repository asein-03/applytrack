import { test, expect } from '@playwright/test';

test('demo dashboard is separate, searchable, and opens full records', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Explore demo', exact: true }).click();
  await expect(page.locator('.demo-banner')).toContainText('sample applications');
  await expect(page.getByRole('heading', { name: 'Needs attention' })).toBeVisible();
  const search = page.getByRole('textbox', { name: 'Search applications' });
  await search.pressSequentially('Northstar', { delay: 50 });
  await expect(search).toBeFocused();
  await expect(search).toHaveValue('Northstar');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await page.getByRole('button', { name: 'Northstar', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Product Designer');
  await page.getByRole('tab', { name: 'Evidence' }).click();
  await expect(page.getByRole('heading', { name: 'Confirmation sources' })).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('Confirmation email received');
  await page.getByRole('button', { name: 'Close application' }).click();
  await page.getByRole('button', { name: 'Go to my workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Track your first application' })).toBeVisible();
});

test('create, edit, add a task and reload persist through the API', async ({ page, request }) => {
  const company = `Browser Test ${Date.now()}`;
  let id: string | undefined;
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Add application', exact: true }).first().click();
    const editor = page.getByRole('dialog');
    await editor.getByRole('textbox', { name: 'Company', exact: true }).fill(company);
    await editor.getByRole('textbox', { name: 'Role', exact: true }).fill('Product Engineer');
    await editor.getByRole('button', { name: 'Add application', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('Product Engineer');
    const data = await (await request.get('/api/applications')).json();
    id = data.applications.find((app: { company: string }) => app.company === company)?.id;
    expect(id).toBeTruthy();
    await page.getByRole('button', { name: 'Edit application', exact: true }).click();
    const edit = page.getByRole('dialog', { name: 'Edit application' });
    await edit.getByRole('textbox', { name: 'Role', exact: true }).fill('Senior Product Engineer');
    await edit.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('dialog').getByRole('heading', { name: 'Senior Product Engineer' })).toBeVisible();
    await page.getByRole('button', { name: 'Add task', exact: true }).click();
    await page.getByRole('textbox', { name: 'Task', exact: true }).fill('Prepare interview questions');
    await page.locator('form.inline-task-form').getByRole('button', { name: 'Add task', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('Prepare interview questions');
    await page.reload();
    await page.getByRole('button', { name: company, exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('Senior Product Engineer');
    await expect(page.getByRole('dialog')).toContainText('Prepare interview questions');
  } finally { if (id) await request.delete(`/api/applications/${id}`); }
});

test('connections show setup truthfully and allow an unmatched email to be reviewed', async ({ page, request }) => {
  const text = `Subject: Application confirmation ${Date.now()}\nWe received your application. Thank you for applying.`;
  await page.goto('/');
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Email accounts' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect Gmail' })).toBeDisabled();
  await page.getByRole('button', { name: 'Import email', exact: true }).click();
  await page.getByRole('textbox', { name: 'Email text' }).fill(text);
  await page.getByRole('dialog').getByRole('button', { name: 'Import email', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Emails to review/ })).toBeVisible();
  const data = await (await request.get('/api/email/review')).json();
  for (const item of data.items.filter((item: { body: string }) => item.body === text)) await request.delete(`/api/email/review/${item.id}`);
});

test('small screens keep primary navigation and controls reachable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Explore demo', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connections', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
