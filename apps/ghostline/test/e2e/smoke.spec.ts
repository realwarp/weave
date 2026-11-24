import { expect, test } from '@playwright/test';

/** Two browser devices exchange a request and a claim through the relay. */
test('two devices share a request and a claim through the relay', async ({ browser }) => {
  const alice = await (await browser.newContext()).newPage();
  const bob = await (await browser.newContext()).newPage();
  const run = Date.now().toString(36);
  await alice.goto(`/?device=alice${run}`);
  await bob.goto(`/?device=bob${run}`);
  await expect(alice.getByRole('status')).toContainText('Offline-ready');

  // Alice asks for help while "offline" (nothing synced yet).
  await alice.getByPlaceholder('What is needed?').fill('Sandbags for the river path');
  await alice.getByPlaceholder('Tags, comma separated').fill('flood, urgent');
  await alice.getByRole('button', { name: 'Ask for help' }).click();
  await expect(alice.locator('#requests li')).toContainText(['Sandbags for the river path']);
  await expect(bob.locator('#requests li')).toHaveCount(0);

  await alice.getByRole('button', { name: 'Sync' }).click();
  await expect(alice.getByRole('status')).toHaveText('Synced.');
  await bob.getByRole('button', { name: 'Sync' }).click();
  await expect(bob.getByRole('status')).toHaveText('Synced.');
  await expect(bob.locator('#requests li')).toContainText(['Sandbags for the river path']);

  await bob.locator('#requests li').getByRole('button', { name: 'Claim' }).click();
  await bob.getByRole('button', { name: 'Sync' }).click();
  await expect(bob.getByRole('status')).toHaveText('Synced.');
  await alice.getByRole('button', { name: 'Sync' }).click();
  await expect(alice.locator('#requests li .meta')).toContainText(`claimed by bob${run}`);
  await expect(alice.locator('#requests .tag')).toHaveText(['flood', 'urgent']);

  // [ADV] 0.2.0 (T5.9): both tap "me too" before syncing; both taps count on both devices.
  await alice
    .locator('#requests li')
    .getByRole('button', { name: /^Me too/ })
    .click();
  await bob
    .locator('#requests li')
    .getByRole('button', { name: /^Me too/ })
    .click();
  await expect(alice.locator('#requests li').getByRole('button', { name: /^Me too/ })).toHaveText(
    'Me too (1)',
  );
  for (const page of [alice, bob, alice]) {
    await page.getByRole('button', { name: 'Sync' }).click();
    await expect(page.getByRole('status')).toHaveText('Synced.');
  }
  for (const page of [alice, bob])
    await expect(page.locator('#requests li').getByRole('button', { name: /^Me too/ })).toHaveText(
      'Me too (2)',
    );
});
