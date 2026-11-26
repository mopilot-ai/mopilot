// Mobile Remote Settings opt-in and offline recovery in the isolated fake-based app.
// e2e-covers: src/components/pages/settings/MobileRemote.tsx src/components/pages/settings/phoneSeen.ts electron/app/ipc/remoteSettings.cjs src/components/pages/settings/ConnectPhone.tsx src/components/pages/settings/GetTheApp.tsx src/lib/phoneApp.ts
import { createHash } from 'node:crypto';
import { test, expect } from './fixtures/app';
import { settingsEntry } from './fixtures/settings';
import { fakeRelayPort, startFakeRelay } from './fixtures/fakeRelay';

const account = {
  userData: {
    'mopilot-auth.json': {
      v: 1,
      enc: 'plain',
      data: Buffer.from(
        JSON.stringify({
          refreshToken: 'fake',
          gatewayKey: 'fake',
          user: { id: 'test-user', email: 'user@example.test' },
          deviceId: 'test-device',
        }),
      ).toString('base64'),
    },
  },
};

async function openConnections(page: import('@playwright/test').Page) {
  await page.locator('.sidebar-title').first().click();
  await settingsEntry(page).click();
  await page.locator('.side-row', { hasText: 'Connections' }).click();
}

test.describe('Mobile Remote is open to a signed-in account with no invite', () => {
  test.use({ harnesses: 'codex', seed: account });
  test('the entry shows for an account the server invited to nothing', async ({ page }) => {
    await openConnections(page);
    await expect(page.getByRole('heading', { name: 'Devices that can control this Mac' })).toHaveCount(1);
  });
});

test.describe('Mobile Remote is hidden while its switch is off', () => {
  test.use({ harnesses: 'codex', seed: account, env: { MOPILOT_FLAGS: 'remote.enabled=0' } });
  test('the entry is absent for every account', async ({ page }) => {
    await openConnections(page);
    await expect(page.getByRole('heading', { name: 'Devices that can control this Mac' })).toHaveCount(0);
  });
});

test.describe('Mobile Remote restores local consent', () => {
  test.use({
    harnesses: 'codex',
    seed: { ...account, uiState: { prefs: { mobileRemoteOwner: JSON.stringify(['test-user', 'test-device']) } } },
    // the phone's own flow: pairing by code (on in development) would ask Phone or Computer first
    env: { MOPILOT_FLAGS: 'remote.enabled=1,host.codePair=0', MOPILOT_PHONE_DEV: '1', MOPILOT_RELAY_URL: 'ws://127.0.0.1:9' },
  });
  test('the saved opt-in starts the service without toggling it again', async ({ page }) => {
    await openConnections(page);
    const section = page.locator('section.settings-group', {
      has: page.getByRole('heading', { name: 'Devices that can control this Mac' }),
    });
    await expect(section.getByRole('switch', { name: 'Allow connections' })).toHaveAttribute('aria-checked', 'true');
  });
});

test.describe('Mobile Remote with its switch enabled', () => {
  test.use({
    harnesses: 'codex',
    seed: account,
    // the phone's own flow: pairing by code (on in development) would ask Phone or Computer first
    env: { MOPILOT_FLAGS: 'remote.enabled=1,host.codePair=0', MOPILOT_PHONE_DEV: '1', MOPILOT_RELAY_URL: 'ws://127.0.0.1:9' },
  });
  test('local opt-in offers the dialog, and an unavailable relay says so there', async ({ page }, testInfo) => {
    await openConnections(page);
    const section = page.locator('section.settings-group', {
      has: page.getByRole('heading', { name: 'Devices that can control this Mac' }),
    });
    await expect(section).toBeVisible();
    const toggle = section.getByRole('switch', { name: 'Allow connections' });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await section.getByRole('button', { name: 'Add' }).click();
    const dialog = page.locator('.dialog', { hasText: 'Connect your phone' });
    await expect(dialog.getByRole('alert')).toBeVisible({ timeout: 20_000 });
    const screenshot = testInfo.outputPath('connect-phone-no-relay.png');
    await dialog.screenshot({ path: screenshot });
    await testInfo.attach('Connect your phone, relay down', { path: screenshot, contentType: 'image/png' });
    await dialog.getByRole('button', { name: 'Close', exact: true }).first().click();
    await page.setViewportSize({ width: 640, height: 800 });
    const narrow = await section.boundingBox();
    expect(narrow && narrow.x >= 0 && narrow.x + narrow.width <= 640).toBeTruthy();
    // turning it off says what it does first
    await toggle.click();
    const ask = page.getByRole('alertdialog', { name: 'Turn off connections?' });
    await expect(ask).toContainText('connected now are disconnected');
    await ask.getByRole('button', { name: 'Turn off' }).click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
  });
});

test.describe('Mobile Remote with a relay to pair through', () => {
  const port = fakeRelayPort(Number(process.env.TEST_PARALLEL_INDEX ?? 0));
  let relay: Awaited<ReturnType<typeof startFakeRelay>>;
  test.beforeAll(async () => {
    relay = await startFakeRelay(port);
  });
  test.afterAll(() => relay.stop());
  test.use({
    harnesses: 'codex',
    seed: account,
    env: {
      MOPILOT_FLAGS: 'remote.enabled=1',
      MOPILOT_PHONE_DEV: '1',
      MOPILOT_API: `http://127.0.0.1:${port}`,
      MOPILOT_RELAY_URL: `ws://127.0.0.1:${port}/v1/ws`,
    },
  });
  test('the sidebar banner opens the dialog: a QR with no separate opt-in, a code that copies; Later keeps it away', async ({
    page,
    harness,
  }, testInfo) => {
    const banner = page.getByTestId('phone-banner');
    await expect(banner).toBeVisible({ timeout: 20_000 });
    await banner.getByRole('button', { name: 'Connect' }).click();
    const dialog = page.locator('.dialog', { hasText: 'Connect your phone' });
    await expect(dialog.getByRole('img', { name: 'Pairing QR code' })).toBeVisible({ timeout: 20_000 });
    await expect(dialog.getByText('Signed in as user@example.test')).toBeVisible();
    await dialog.getByRole('button', { name: 'Copy code' }).click();
    await expect(page.getByText('Code copied')).toBeVisible();
    const code = JSON.parse(await harness.app.evaluate(({ clipboard }) => clipboard.readText()));
    expect(code.v).toBe(3);
    expect(typeof code.code).toBe('string');
    // the QR names the signed-in account without revealing it: eight bytes of sha256("mopilot-acct-v1:" + user id) and the email with its name masked
    expect(code.acct).toBe(createHash('sha256').update('mopilot-acct-v1:test-user').digest('hex').slice(0, 16));
    expect(code.who).toBe('u***@example.test');
    // the phone app's App Store listing waits behind one click, as a second QR under the pairing one
    await expect(dialog.getByRole('img', { name: 'QR code to get the app' })).toHaveCount(0);
    await dialog.getByRole('button', { name: "Don't have the app?" }).click();
    await expect(dialog.getByRole('img', { name: 'QR code to get the app' })).toBeVisible();
    await expect(dialog.getByRole('img', { name: 'Pairing QR code' })).toBeVisible();
    const screenshot = testInfo.outputPath('connect-phone-qr.png');
    await dialog.screenshot({ path: screenshot });
    await testInfo.attach('Connect your phone, QR', { path: screenshot, contentType: 'image/png' });
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await banner.getByRole('button', { name: 'Later' }).click();
    await expect(banner).toHaveCount(0);
    // the footer menu is the way back
    await page.locator('.sidebar-title').first().click();
    await page.getByRole('menuitem', { name: /^Settings\b/ }).waitFor();
    await page.keyboard.press('Escape');
  });

  test('a phone scans: the Mac asks with the same number, Connect pairs it, and the dialog closes itself with a toast', async ({
    page,
    harness,
  }, testInfo) => {
    await page.getByTestId('phone-banner').getByRole('button', { name: 'Connect' }).click();
    const dialog = page.locator('.dialog', { hasText: 'Connect your phone' });
    await dialog.getByRole('button', { name: 'Copy code' }).click();
    await expect(page.getByText('Code copied')).toBeVisible();
    const qr = await harness.app.evaluate(({ clipboard }) => clipboard.readText());
    const { safetyNumber } = await relay.scan(qr, 'iPhone 18 Pro');
    await expect(dialog.getByText('Connect iPhone 18 Pro?')).toBeVisible({ timeout: 20_000 });
    const grouped = safetyNumber.replace(/(\d{4})(?=\d)/g, '$1 ');
    // the number is a detail on the Mac: folded until someone opens it
    await expect(dialog.locator('details')).not.toHaveAttribute('open', '');
    await dialog.getByText('Safety number', { exact: true }).click();
    await expect(dialog.getByText(`Same number on the phone: ${grouped}`)).toBeVisible();
    const prompt = testInfo.outputPath('connect-phone-prompt.png');
    await dialog.screenshot({ path: prompt });
    await testInfo.attach('Connect your phone, prompt', { path: prompt, contentType: 'image/png' });
    // a stray Escape does not decline a phone
    await page.keyboard.press('Escape');
    await expect(dialog.getByText('Connect iPhone 18 Pro?')).toBeVisible();
    await dialog.getByRole('button', { name: 'Connect', exact: true }).click();
    // no Done: the dialog closes itself and a toast says who connected
    await expect(page.getByText(/^Connected: iPhone 18 Pro/)).toBeVisible({ timeout: 20_000 });
    await expect(dialog).toHaveCount(0);
    const done = testInfo.outputPath('connect-phone-connected.png');
    await page.screenshot({ path: done });
    await testInfo.attach('Connected toast', { path: done, contentType: 'image/png' });
    await expect(page.getByTestId('phone-banner')).toHaveCount(0);
    await openConnections(page);
    const section = page.locator('section.settings-group', {
      has: page.getByRole('heading', { name: 'Devices that can control this Mac' }),
    });
    await expect(section.getByText('iPhone 18 Pro')).toBeVisible();
    await expect(section.getByText(/Paired /)).toBeVisible();
    await expect(section.getByText(/1 connected · 1 paired/)).toBeVisible();
    await expect(section.getByText(/Connected · Paired /)).toBeVisible();
    relay.phoneOnline(false);
    await expect(section.getByText(/0 connected · 1 paired/)).toBeVisible();
    await expect(section.getByText(/Offline · /)).toBeVisible();
    await expect(section.getByText('iPhone 18 Pro')).toBeVisible();
    relay.phoneOnline(true);
    await expect(section.getByText(/1 connected · 1 paired/)).toBeVisible();
    await expect(section.getByRole('button', { name: 'Add' })).toBeVisible();
    await section.getByRole('button', { name: 'Rename' }).click();
    await section.getByRole('textbox', { name: 'Name for iPhone 18 Pro' }).fill('Work phone');
    await section.getByRole('button', { name: 'Save' }).click();
    await expect(section.getByText('Work phone')).toBeVisible();
    await page.setViewportSize({ width: 1024, height: 682 });
    const details = testInfo.outputPath('phone-connection-details.png');
    await section.screenshot({ path: details });
    await testInfo.attach('Phone connection details', { path: details, contentType: 'image/png' });
    // Linux has no login item, so that row is not drawn there
    const rows = ['Keep running in the menu bar', 'Keep this Mac awake', ...(process.platform === 'linux' ? [] : ['Start at login'])];
    for (const name of rows) await expect(page.getByRole('switch', { name })).toHaveAttribute('aria-checked', 'true');
  });
});
