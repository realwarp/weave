import { expect, test } from '@playwright/test';

/** Two workers: one records an inspection, the other gets it and both set a status concurrently. */
test('two workers share an inspection; the more advanced status wins', async ({ browser }) => {
  const run = Date.now().toString(36);
  const ana = await (await browser.newContext()).newPage();
  const ben = await (await browser.newContext()).newPage();
  await ana.goto(`/?device=ana${run}`);
  await ben.goto(`/?device=ben${run}`);
  await expect(ana.getByRole('status')).toContainText('saved on this device');

  await ana.getByPlaceholder('Inspection title').fill('Culvert 7');
  await ana.getByPlaceholder('Site').fill('Riverside');
  await ana.getByPlaceholder('Zone').fill('C2');
  await ana.getByRole('button', { name: 'New inspection' }).click();
  await expect(ana.locator('#inspections tr')).toContainText(['Culvert 7']);
  await ana.getByPlaceholder('Observation').fill('Debris at inlet');
  await ana.getByRole('radio', { name: 'Severity 2' }).check();
  await ana.getByRole('button', { name: 'Add observation' }).click();
  await expect(ana.locator('#observations li')).toContainText(['Debris at inlet']);
  await expect(ana.locator('#observations li')).toContainText(['Severity 2']);

  // A malformed reading is refused beside the field, and nothing is written.
  await ana.getByPlaceholder('Observation').fill('Water level');
  await ana.getByPlaceholder('e.g. 0.7').fill('1,5');
  await ana.getByRole('button', { name: 'Add observation' }).click();
  await expect(ana.locator('#reading-err')).toHaveText('Use a dot for decimals, for example 1.5.');
  await expect(ana.locator('#observations li')).toHaveCount(1);
  await ana.getByPlaceholder('e.g. 0.7').fill('1.5');
  await ana.getByRole('button', { name: 'Add observation' }).click();
  await expect(ana.locator('#observations li')).toHaveCount(2);
  await expect(ana.locator('#observations li', { hasText: 'Water level' })).toContainText(
    'Reading 1.5',
  );

  await ana.getByRole('button', { name: 'Sync' }).click();
  await expect(ana.getByRole('status')).toHaveText('Up to date.');
  await ben.getByRole('button', { name: 'Sync' }).click();
  await expect(ben.getByRole('status')).toHaveText('Up to date.');
  await expect(ben.locator('#inspections tr')).toContainText(['Culvert 7']);

  // Concurrent status edits: ana in review, ben closed.
  await ana.getByRole('button', { name: 'Mark in review' }).click();
  await ben
    .locator('#inspections tr')
    .getByRole('button', { name: /Culvert 7/ })
    .click();
  await ben.getByRole('button', { name: 'Mark closed' }).click();
  for (const page of [ana, ben, ana]) {
    await page.getByRole('button', { name: 'Sync' }).click();
    await expect(page.getByRole('status')).toHaveText('Up to date.');
  }
  await expect(ana.locator('#inspections tr')).toContainText(['Closed']);
  await expect(ana.locator('#conflicts tr')).toContainText(['status']);
});
