// Settings › MoMo › Sources › Accounts (#2999 C0): the test connector's card (electron/momo/connectors/fake.cjs, registered in E2E runs) through MoMo's real sign-in: Connect opens the provider's page (captured, not opened) with PKCE and a loopback redirect on 127.0.0.1, the test answers that redirect as the provider's page would, and the card turns Connected; Pause and Resume; Disconnect behind Details with its confirm. A sign-in answered with the wrong state is refused and the wait goes on. Each state is saved as a screenshot (connectors-<n>-<state>.png) in the test's output folder.
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { captureExternal } from './fixtures/externalUrls';
import { goToMomoSettings, momoSetupDone, openMomo } from './fixtures/momo';

const card = (page: Page): Locator => page.getByRole('region', { name: 'Test account', exact: true });
const status = (c: Locator) => c.locator('[data-status]');

test.describe('Settings › MoMo › Sources › Accounts', () => {
  test.use({ harnesses: 'claude', env: { MOPILOT_MOMO_DEV: '1' }, seed: { ...momoSetupDone } });

  test('the test account signs in through the loopback, pauses, resumes and disconnects', async ({ page, harness }, testInfo) => {
    let n = 0;
    const shot = (state: string) =>
      page.screenshot({ path: testInfo.outputPath(`connectors-${String(++n).padStart(2, '0')}-${state}.png`) });
    const opened = await captureExternal(harness as any);
    await openMomo(page);
    await goToMomoSettings(page, 'Sources');
    const acct = card(page);
    await expect(status(acct)).toHaveText('Let MoMo use your Test account.');
    await shot('off');

    await acct.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(status(acct)).toHaveText('Finish signing in in your browser…', { timeout: 20_000 });
    await expect.poll(async () => (await opened()).length, { timeout: 20_000 }).toBeGreaterThan(0);
    const url = new URL((await opened()).at(-1)!);
    expect(url.origin + url.pathname).toBe('https://connector.test/authorize');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const redirect = url.searchParams.get('redirect_uri')!;
    expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    await shot('signing-in');

    // a redirect with another state is refused and the sign-in keeps waiting
    expect((await fetch(`${redirect}?code=x&state=not-this-one`)).status).toBe(400);
    await expect(status(acct)).toHaveText('Finish signing in in your browser…');
    const done = await fetch(`${redirect}?code=c1&state=${url.searchParams.get('state')}`);
    expect(done.status).toBe(200);
    expect(await done.text()).toContain('You can close this tab');
    await expect(status(acct)).toHaveText('MoMo can use your Test account.', { timeout: 20_000 });
    await expect(acct.locator('.hp-badge.ok')).toHaveText('Connected');
    await acct.getByText('Details').click();
    await expect(acct.getByText('Read; every change asks you first.')).toBeVisible();
    await shot('connected');

    await acct.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(status(acct)).toHaveText("Paused. MoMo won't use it.");
    await shot('paused');
    await acct.getByRole('button', { name: 'Resume', exact: true }).click();
    await expect(status(acct)).toHaveText('MoMo can use your Test account.');

    await acct.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await expect(acct.getByText('Sign MoMo out of Test account?')).toBeVisible();
    await shot('confirm');
    await acct.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await expect(status(acct)).toHaveText('Let MoMo use your Test account.');
    await expect(acct.getByRole('button', { name: 'Connect', exact: true })).toBeVisible();

    await page.setViewportSize({ width: 520, height: 900 });
    await expect(acct).toBeVisible();
    await shot('narrow');
  });
});
