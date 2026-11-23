// Reset-card entry refresh and offer layout through the real settings disclosure, with a held provider IPC response.
import { test, expect } from './fixtures/app';
import { codexCliLogin } from './fixtures/codexAccounts';
import { settingsEntry, openSettingsSection } from './fixtures/settings';

test.use({
  harnesses: 'codex',
  seed: { files: codexCliLogin, uiState: { prefs: { fontSize: 24, zoomLevel: 0, theme: 'system' } } },
});

test('reset cards refresh on page entry, disclosure reopening and return, with retry after failure', async ({ page, harness }, info) => {
  await page.setViewportSize({ width: 1024, height: 682 });
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  await harness.app.evaluate(({ ipcMain }) => {
    const state = { reads: 0, mode: 'ready', title: 'Full reset', pending: [] as ((value: unknown) => void)[] };
    (globalThis as any).__resetEntryCheck = state;
    ipcMain.removeHandler('accounts:resetCredits');
    ipcMain.handle('accounts:resetCredits', () => {
      state.reads++;
      if (state.mode === 'error') return { error: { message: 'Reset offers are offline', code: null } };
      if (state.mode === 'held') return new Promise((resolve) => state.pending.push(resolve));
      return {
        value: {
          rateLimitResetCredits: {
            availableCount: 3,
            credits: [1, 2, 3].map((n) => ({
              id: `offer-${n}`,
              title: state.title,
              description: 'Thanks for using Codex! You have been granted one free rate limit reset.',
              expiresAt: 4e9 + n * 86400,
              status: 'available',
              resetType: 'codexRateLimits',
            })),
          },
        },
      };
    });
  });
  const reads = () => harness.app.evaluate(() => (globalThis as any).__resetEntryCheck.reads as number);
  await page.locator('.sidebar-title').first().click();
  await settingsEntry(page).click();
  await openSettingsSection(page, 'accounts');
  await expect.poll(reads).toBeGreaterThan(0);
  const wallet = page.locator('.provider-resets').filter({ has: page.locator('.usage-resets-toolbar') });
  await wallet.locator('summary').click();
  await expect(wallet.getByRole('button', { name: 'Use reset', exact: true })).toHaveCount(3);
  await expect(wallet.getByRole('button', { name: 'Refresh', exact: true })).toHaveCount(0);
  const first = wallet.locator('.usage-reset-list .settings-row').first();
  const expiry = first.locator('.usage-reset-expiry');
  await expect(expiry).toContainText('Expires');
  await expect(wallet.getByRole('group', { name: 'Reset cards' })).toBeVisible();

  // Use the actual stylesheet at narrow and wide sizes, in both themes, with large text.
  let darkSurface = '';
  for (const [width, theme] of [
    [1024, 'dark'],
    [1440, 'light'],
  ] as const) {
    await page.setViewportSize({ width, height: 682 });
    await harness.app.evaluate(({ nativeTheme }, theme) => {
      nativeTheme.themeSource = theme;
    }, theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    // The app's appearance variables and transition must settle before inspecting the painted colors.
    await page.waitForTimeout(600);
    const surface = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--main'));
    expect(surface.trim()).not.toBe('');
    if (theme === 'dark') darkSurface = surface;
    else expect(surface).not.toBe(darkSurface);
    await first.scrollIntoViewIfNeeded();
    await expect.poll(() => wallet.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    const layout = await first.evaluate((el) => {
      const desc = el.querySelector('.usage-reset-description')!.getBoundingClientRect();
      const expiry = el.querySelector('.usage-reset-expiry')!.getBoundingClientRect();
      const title = el.querySelector('.settings-row-title')!.getBoundingClientRect();
      const action = el.querySelector('button')!.getBoundingClientRect();
      return { separate: expiry.top >= desc.bottom, aligned: Math.abs(title.top - action.top) < 8 };
    });
    expect(layout).toEqual({ separate: true, aligned: true });
    await info.attach(`reset-cards-${width}-${theme}`, { body: await wallet.screenshot(), contentType: 'image/png' });
  }

  // Closing keeps the selected tab and wallet; reopening reads again.
  await wallet.getByRole('button', { name: 'History', exact: true }).click();
  await wallet.locator('summary').click();
  await harness.app.evaluate(() => {
    (globalThis as any).__resetEntryCheck.title = 'Updated reset';
  });
  const beforeOpen = await reads();
  await wallet.locator('summary').click();
  await expect.poll(reads).toBeGreaterThan(beforeOpen);
  await expect(wallet.getByRole('button', { name: 'History', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await wallet.getByRole('button', { name: /^Available/ }).click();
  await expect(first).toContainText('Updated reset');

  // Keep the previous cards visible and actions disabled while a return read is pending.
  await harness.app.evaluate(() => {
    (globalThis as any).__resetEntryCheck.mode = 'held';
  });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(wallet.getByRole('status')).toHaveText('Refreshing…');
  await expect(first).toContainText('Updated reset');
  await expect(first.getByRole('button', { name: 'Use reset', exact: true })).toBeDisabled();
  await harness.app.evaluate(() => {
    const state = (globalThis as any).__resetEntryCheck;
    state.mode = 'error';
    for (const resolve of state.pending.splice(0)) resolve({ value: { rateLimitResetCredits: null } });
  });
  await expect(wallet.getByRole('status')).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(wallet).toContainText('Reset offers are offline');
  await harness.app.evaluate(() => {
    (globalThis as any).__resetEntryCheck.mode = 'ready';
  });
  await wallet.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(first).toContainText('Updated reset');
  await expect(wallet.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);

  const beforePageEntry = await reads();
  await openSettingsSection(page, 'general');
  await openSettingsSection(page, 'accounts');
  await expect.poll(reads).toBeGreaterThan(beforePageEntry);
});
