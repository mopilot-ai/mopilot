// The account footer's real layout: compact hover, distinct surface, and working menu at narrow widths and large type.
import { test, expect } from './fixtures/app';
import { sizeRealWindow } from './fixtures/window';

test.use({ harnesses: 'both' });

test('account hover stays compact and the menu remains usable in a narrow window', async ({ page, harness }) => {
  await sizeRealWindow(page, harness, 1024, 682);
  const account = page.getByRole('button', { name: 'Open profile menu' });
  const bug = page.getByRole('button', { name: 'Report a bug', exact: true });
  await expect(account).toBeVisible();
  await expect(account.locator('.account-btn-meta')).toHaveText('Plus · Claude Max');
  // The label is this machine's account name: "runner" on the macOS and Linux runners, "runneradmin" on Windows ones,
  // which made the button 8 px wider than the compact check allows (win-e2e run 43610383130). One fixed name, so the
  // check measures the layout, not the runner; the long-name case is stressed below. A real label must be there first, so
  // an empty one still fails.
  const label = account.locator('.side-row-label');
  await expect(label).not.toBeEmpty();
  await label.evaluate((el) => {
    el.textContent = 'runner';
  });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  for (const size of [14, 24]) {
    await page.evaluate((px) => document.documentElement.style.setProperty('--fs-chat', `${px}px`), size);
    await expect(account).toHaveCSS('height', size === 14 ? '32px' : '40px');
    const before = (await account.boundingBox())!;
    await account.hover();
    expect(await account.boundingBox()).toEqual(before);
    const row = (await page.locator('.account-row').boundingBox())!;
    const report = (await bug.boundingBox())!;
    expect(before.width).toBeLessThanOrEqual(row.width - report.width - 8);
    if (size === 14) expect(before.width).toBeLessThan(row.width - report.width - 16);
    expect(before.x + before.width).toBeLessThanOrEqual(report.x - 8);
    const surfaces = await page.locator('.sidebar-footer').evaluate((el) => ({
      footer: getComputedStyle(el).backgroundColor,
      list: getComputedStyle(el.closest('.sidebar')!).backgroundColor,
      separator: getComputedStyle(el).borderTopWidth,
    }));
    expect(surfaces.footer).not.toBe(surfaces.list);
    expect(Number.parseFloat(surfaces.separator)).toBeGreaterThan(0);
    await account.click();
    await expect(account).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('menuitem', { name: 'Accounts & billing' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(account).toHaveAttribute('aria-expanded', 'false');
    await page.screenshot({ path: test.info().outputPath(`account-footer-${size}.png`) });
  }
  // Stress the rendered identity slots without depending on the runner's OS account name or real logins.
  await page.evaluate(() => document.documentElement.style.setProperty('--fs-chat', '14px'));
  await account.locator('.side-row-label').evaluate((el) => {
    el.textContent = 'Bin';
  });
  await account.locator('.account-btn-meta').evaluate((el) => {
    el.textContent = '3 accounts';
  });
  expect(await account.locator('.account-btn-meta').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.evaluate(() => document.documentElement.style.setProperty('--fs-chat', '24px'));
  await account.locator('.side-row-label').evaluate((el) => {
    el.textContent = 'A very long account name that must truncate';
  });
  await account.locator('.account-btn-meta').evaluate((el) => {
    el.textContent = 'Many accounts with a very long subscription summary';
  });
  const stressed = (await account.boundingBox())!;
  const report = (await bug.boundingBox())!;
  expect(stressed.x + stressed.width).toBeLessThanOrEqual(report.x - 8);
  await expect(account.locator('.account-chevron')).toBeVisible();
  await expect(bug).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('account-footer-long-name.png') });
});
