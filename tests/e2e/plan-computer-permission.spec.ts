// A chat saved as Full access shows its active Plan restriction, then recovers after leaving Plan mode and retrying the same computer step.
import { test, expect } from './fixtures/app';
import { remoteFlags } from './fixtures/flags';

test.skip(process.platform !== 'darwin', 'the harness reaches desktop tools through the macOS helper channel');
test.use({
  harnesses: 'claude',
  computerHelper: true,
  seed: {
    files: remoteFlags({ 'native.codex.enabled': false }),
    uiState: { summaryOpen: true, prefs: { permission: 'full-access', fontSize: 24, zoomLevel: 0 } },
  },
});

test('Plan-mode computer refusal and permission picker agree, then retry runs with the saved Full access setting', async ({
  page,
  harness,
}, info) => {
  await page.setViewportSize({ width: 1024, height: 682 });
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  const permission = page.getByRole('button', { name: 'Change permissions' });
  const call = (name: string, args: object) => `CUCALL mcp__mopilot_computer__${name} ${JSON.stringify(args)}`;
  const send = async (lines: string[]) => {
    await composer.fill([...lines, 'CUSTEPS'].join('\n'));
    await page.getByRole('button', { name: 'Send', exact: true }).click();
  };
  await send([call('request_access', { apps: ['TextEdit'], reason: 'Inspect the toolbar' })]);
  await page
    .locator('.sage-approval')
    .getByRole('button', { name: /^Allow in this chat/ })
    .click();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  await expect(permission).toHaveText('Full access');
  await page.getByRole('button', { name: 'Add files and more' }).click();
  await page.locator('.add-panel').getByText('Plan mode', { exact: true }).click();
  const steps = [call('app_screenshot', { app: 'TextEdit' }), call('app_click', { app: 'TextEdit', element_index: 1 })];
  await send(steps);
  const warning = page.locator('.blocked-strip');
  await expect(warning).toContainText('Plan mode is on: computer use can only look.');
  await expect(permission).toHaveText('Plan mode');
  await expect(page.locator('.fa-banner')).toHaveCount(0);
  expect(harness.helper!.log.filter((m) => m.method === 'app.press')).toHaveLength(0);
  await warning.getByRole('button', { name: 'Change mode' }).click();
  await expect(page.locator('.perm-menu')).toContainText('Your permission choice applies after Plan mode ends.');
  await page.locator('.perm-item.full-access').click();
  await expect(permission).toHaveText('Plan mode');
  await expect(warning).toBeVisible();
  await page.screenshot({ path: info.outputPath('plan-permission-at-1024-font-24.png') });
  await page.locator('.plan-chip').click();
  await send(steps);
  await expect(permission).toHaveText('Full access');
  await expect(warning).toHaveCount(0);
  await expect.poll(() => harness.helper!.log.filter((m) => m.method === 'app.press').length).toBe(1);
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
});
