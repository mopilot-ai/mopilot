// The real Add machine renderer keeps a failed install's credential destination when the editable address changes; IPC is faked so no machine or credential is contacted.
import { test, expect } from './fixtures/app';
import { NO_GUI_SESSION } from '../../shared/host/launchd.mjs';

test.use({ harnesses: 'claude', env: { MOPILOT_HOST_DEV: '1' } });

for (const edit of ['before', 'during']) {
  test(`daemon password stays with the failed machine after an address edit ${edit} the prompt`, async ({ page, harness }) => {
    await harness.app.evaluate(({ ipcMain }, reason) => {
      const calls: { destination: string; hasPassword: boolean }[] = [];
      (globalThis as any).__daemonIdentityCalls = calls;
      ipcMain.removeHandler('host:add');
      ipcMain.handle('host:add', (_event, destination, opts) => {
        calls.push({ destination, hasPassword: Boolean(opts?.daemonPassword) });
        // host:add is a bridge call, whose real handler wraps the result in { value }.
        return {
          value: {
            ok: false,
            paired: false,
            id: '',
            error: reason,
            steps: [{ id: 'start', label: 'Start the Host', state: 'failed', output: reason }],
          },
        };
      });
    }, NO_GUI_SESSION);
    // Verify the fake crosses the real preload bridge before testing the renderer journey.
    const probe = await page.evaluate(() => window.native.host.add('probe@fixture'));
    expect(probe).toMatchObject({ ok: false, error: NO_GUI_SESSION, steps: [{ id: 'start' }] });
    await harness.app.evaluate(() => {
      (globalThis as any).__daemonIdentityCalls.length = 0;
    });
    await page.setViewportSize({ width: 1024, height: 682 });
    // the new chat's Run on menu opens the Add a machine sheet in place
    await page.getByRole('button', { name: 'Run on: This Mac, online', exact: true }).click();
    await page
      .getByRole('menu', { name: 'My machines' })
      .getByRole('menuitem', { name: /Add machine/ })
      .click();
    const sheet = page.locator('.dialog').filter({ has: page.locator('.dialog-head', { hasText: 'Add a machine' }) });
    await expect(sheet).toBeVisible();
    const address = sheet.getByLabel('Machine', { exact: true });
    await address.fill('me@mini');
    await sheet.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(sheet.getByText('Nobody is signed in on me@mini', { exact: true })).toBeVisible();
    if (edit === 'before') await address.fill('other@host');
    await sheet.getByRole('button', { name: 'Enter password', exact: true }).click();
    if (edit === 'during') await address.fill('other@host');
    await sheet.getByLabel('Administrator password for me@mini', { exact: true }).fill('fake-test-password');
    await sheet.getByRole('button', { name: 'Turn on', exact: true }).click();
    await expect
      .poll(() => harness.app.evaluate(() => (globalThis as any).__daemonIdentityCalls))
      .toEqual([
        { destination: 'me@mini', hasPassword: false },
        { destination: 'me@mini', hasPassword: true },
      ]);
  });
}
