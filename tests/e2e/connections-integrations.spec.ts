// Settings → Connections offers the optional GitHub connector (off until turned on) and no Quick Actions in an app that is not an installed .app; and the new-chat-link command (a mopilot:// link from a Quick Action) opens a new chat with its text drafted, unsent.
import { test, expect, type Harness } from './fixtures/app';
import { openSettingsSection, settingsEntry } from './fixtures/settings';

test.use({ harnesses: 'both' });

test('Connections lists the GitHub connector, off, and hides Quick Actions where they cannot be installed', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 682 });
  await page.locator('.sidebar-title').first().click();
  await settingsEntry(page).click();
  await openSettingsSection(page, 'connectors');
  const row = page.locator('.settings-row', { hasText: 'GitHub' });
  // the connector ships for macOS and Linux only (electron/platform/builtinConnectors.cjs GITHUB_ASSETS): Windows says so
  if (process.platform === 'win32') {
    await expect(row).toContainText('Not available on this computer yet');
  } else {
    await expect(row).toContainText('signed in with your gh login');
    await expect(row.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  }
  await expect(page.locator('.settings-row', { hasText: 'Quick Actions' })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('connections.png') });
});

const send = (h: Harness, arg: unknown) =>
  h.app.evaluate(({ BrowserWindow }, a) => BrowserWindow.getAllWindows()[0].webContents.send('app:command', 'new-chat-link', a), arg);

test('a link opens a new chat with its text drafted, not sent', async ({ page, harness }) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  await send(harness, { folder: null, text: 'Summarize the selected text' });
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await expect(composer).toHaveText('Summarize the selected text');
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
});
