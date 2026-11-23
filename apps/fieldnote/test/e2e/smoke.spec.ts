import { expect, test } from '@playwright/test';

/** Two workers: one records an inspection, the other gets it and both set a status concurrently. */
test('two workers share an inspection; the more advanced status wins', async ({ browser }) => {
  const run = Date.now().toString(36);
  const ana = await (await browser.newContext()).newPage();
  const ben = await (await browser.newContext()).newPage();
  await ana.goto(`/?device=ana${run}`);
  await ben.goto(`/?device=ben${run}`);
  await expect(ana.getByRole('status')).toContainText('Offline-ready');

  await ana.getByPlaceholder('Inspection title').fill('Culvert 7');
  await ana.getByPlaceholder('Site').fill('Riverside');
  await ana.getByPlaceholder('Zone').fill('C2');
  await ana.getByRole('button', { name: 'New inspection' }).click();
  await expect(ana.locator('#inspections tr')).toContainText(['Culvert 7']);
  await ana.getByPlaceholder('Observation').fill('Debris at inlet');
  await ana.locator('#obs-form select').selectOption('2');
  await ana.getByRole('button', { name: 'Add observation' }).click();
  await expect(ana.locator('#observations li')).toContainText(['Debris at inlet - severity 2']);

  await ana.getByRole('button', { name: 'Sync' }).click();
  await expect(ana.getByRole('status')).toHaveText('Synced.');
  await ben.getByRole('button', { name: 'Sync' }).click();
  await expect(ben.getByRole('status')).toHaveText('Synced.');
  await expect(ben.locator('#inspections tr')).toContainText(['Culvert 7']);

  // Concurrent status edits: ana in_review, ben closed.
  await ana.getByRole('button', { name: 'Mark in_review' }).click();
  await ben.locator('#inspections tr').getByRole('button', { name: 'Open' }).click();
  await ben.getByRole('button', { name: 'Mark closed' }).click();
  for (const page of [ana, ben, ana]) {
    await page.getByRole('button', { name: 'Sync' }).click();
    await expect(page.getByRole('status')).toHaveText('Synced.');
  }
  await expect(ana.locator('#inspections tr')).toContainText(['closed']);
  await expect(ana.locator('#conflicts tr')).toContainText(['status']);
});
