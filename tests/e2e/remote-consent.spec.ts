// Consent is main-owned and reaches disk before the Settings action acknowledges it.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/app';

const owner = JSON.stringify(['test-user', 'test-device']);
const auth = {
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
};
const env = { MOPILOT_FLAGS: 'remote.enabled=1', MOPILOT_PHONE_DEV: '1', MOPILOT_RELAY_URL: 'ws://127.0.0.1:9' };

test.describe('consent receipt', () => {
  test.use({ harnesses: 'codex', seed: { userData: { 'mopilot-auth.json': auth } }, env });
  test('generic prefs are refused and explicit consent is on disk before acknowledgment', async ({ page, harness }) => {
    const file = path.join(harness.dir, 'userData', 'ui-state.json');
    expect(await page.evaluate(() => window.native.prefs.patch({ mobileRemoteOwner: 'forged' }, []))).toBe(false);
    expect(await page.evaluate(() => window.native.prefs.patch({}, ['mobileRemoteOwner']))).toBe(false);
    expect(await page.evaluate(() => window.native.prefs.patch({}, [['mobileRemoteOwner']] as unknown as string[]))).toBe(false);
    expect(await page.evaluate(() => window.native.remoteSettings.setEnabled(true))).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).prefs.mobileRemoteOwner).toBe(owner);
    expect(await page.evaluate(() => window.native.remoteSettings.setEnabled(false))).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).prefs.mobileRemoteOwner).toBeNull();
  });
});

test.describe('newer state schema', () => {
  test.use({
    harnesses: 'codex',
    seed: { userData: { 'mopilot-auth.json': auth }, uiState: { stateVersion: 999999, prefs: { mobileRemoteOwner: owner } } },
    env,
  });
  test('saved consent is unavailable and explicit opt-in is refused', async ({ page }) => {
    const state = await page.evaluate(() => window.native.remoteSettings.state());
    expect(state.visible && state.enabled).toBe(false);
    await expect(page.evaluate(() => window.native.remoteSettings.setEnabled(true))).rejects.toThrow();
    const failed = await page.evaluate(() => window.native.remoteSettings.state());
    expect(failed.visible && failed.enabled).toBe(false);
    expect(failed.visible && failed.consentWarning).toBe(true);
  });
});
