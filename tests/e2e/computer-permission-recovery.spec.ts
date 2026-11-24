// Effective permission failures keep a retryable guide with the same recovery for the model, chat and Settings.
import { test, expect } from './fixtures/app';
import { remoteFlags } from './fixtures/flags';
import { settingsEntry } from './fixtures/settings';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

for (const family of [
  { name: 'Codex', harnesses: 'codex', call: (name: string, args: object) => `MCPCU ${name} ${JSON.stringify(args)}`, steps: 'go' },
  {
    name: 'Claude Code',
    harnesses: 'claude',
    call: (name: string, args: object) => `CUCALL mcp__mopilot_computer__${name.replace(/^desktop_/, '')} ${JSON.stringify(args)}`,
    steps: 'CUSTEPS',
  },
] as const) {
  test.describe(`Unavailable permission on ${family.name}`, () => {
    test.use({
      harnesses: family.harnesses,
      computerHelper: true,
      seed: {
        files: remoteFlags({ 'native.codex.enabled': false }),
        uiState: { summaryOpen: true, prefs: { fontSize: 24, zoomLevel: 0 } },
      },
    });

    test('offers recovery for an enabled but ineffective grant, then clears only after effective access returns', async ({
      page,
      harness,
    }, info) => {
      await page.setViewportSize({ width: 1024, height: 682 });
      const helper = harness.helper!;
      helper.permissions.accessibility = false;
      helper.enforcePermissions = true;
      await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
      const composer = page.getByRole('textbox', { name: 'Message', exact: true });
      const lines = [
        family.call('desktop_request_access', { apps: ['Notes'], reason: 'Check the note', screenControl: true }),
        family.call('desktop_key', { text: 'a' }),
        family.steps,
      ];
      await composer.fill(lines.join('\n'));
      await expect(composer).toHaveText(lines.join(''));
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await page
        .locator('.sage-approval')
        .getByRole('button', { name: /^Allow in this chat/ })
        .click();
      const guide = page.locator('.cu-permission');
      await expect(guide).toHaveAttribute('data-permission', 'accessibility');
      const inViewport = (el: Element) => {
        const rect = el.getBoundingClientRect();
        return rect.height > 0 && rect.top >= 0 && rect.bottom <= window.innerHeight;
      };
      await expect.poll(() => composer.evaluate(inViewport)).toBe(true);
      // The call waits for the grant while the card is up; Try again that still finds it off ends the wait.
      await guide.getByRole('button', { name: 'Try again', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
      // The real shared tool failure reaches the fake model, rather than just a renderer-only hint.
      await expect(
        page
          .getByRole('main')
          .getByText(/macOS reports.*cannot use Accessibility yet/)
          .last(),
      ).toBeVisible();
      const hint = guide.locator('.cu-permission-still');
      await expect(hint).toContainText('macOS still reports Accessibility unavailable');
      await expect(hint).toContainText('select "MoPilot", remove it with −');
      await expect(hint).toContainText('restart your Mac before trying again');
      const recovery = await hint.textContent();
      await expect.poll(() => composer.evaluate((el) => getComputedStyle(el).fontSize)).toBe('24px');
      await expect.poll(() => guide.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      await expect.poll(() => composer.evaluate(inViewport)).toBe(true);
      const draft = Array.from({ length: 24 }, (_, i) => `Keep draft line ${i + 1}`).join('\n');
      await composer.fill(draft);
      await expect.poll(() => composer.evaluate((el) => (el as HTMLElement).innerText)).toBe(draft);
      await expect.poll(() => composer.evaluate(inViewport)).toBe(true);
      await expect.poll(() => guide.getByRole('button', { name: 'Try again', exact: true }).evaluate(inViewport)).toBe(true);
      await page.screenshot({ path: info.outputPath('permission-recovery-start-narrow-large-font.png') });
      const text = guide.locator('.cu-guide-text');
      await expect.poll(() => text.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
      await text.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      await expect
        .poll(() => hint.evaluate((el) => el.getBoundingClientRect().bottom <= el.parentElement!.getBoundingClientRect().bottom + 1))
        .toBe(true);
      await expect.poll(() => guide.getByRole('button', { name: 'Try again', exact: true }).evaluate(inViewport)).toBe(true);
      await page.screenshot({ path: info.outputPath('permission-recovery-narrow-large-font.png') });
      // Recovery text does not grant access, reset macOS, or replay the refused action.
      expect(helper.permissions.accessibility).toBe(false);
      expect(helper.log.filter((m) => m.method === 'input.key')).toHaveLength(1);
      helper.permissions.accessibility = true;
      await guide.getByRole('button', { name: 'Try again', exact: true }).click();
      await expect(guide).toHaveCount(0);
      await expect.poll(() => composer.evaluate((el) => (el as HTMLElement).innerText)).toBe(draft);
      expect(helper.log.filter((m) => m.method === 'input.key')).toHaveLength(1);

      // Settings uses the same guidance for a request whose effective permission remains unavailable.
      helper.permissions.accessibility = false;
      await page.locator('.sidebar-title').first().click();
      await settingsEntry(page).click();
      await page.locator('.side-row', { hasText: 'Computer use' }).click();
      await page.getByRole('button', { name: 'Request Accessibility permission', exact: true }).click();
      await expect(page.locator('.cu-permission-still')).toHaveText(recovery!);
    });

    test('request access alone, with Screen Recording off, shows the card its answer points to', async ({ page, harness }, info) => {
      const helper = harness.helper!;
      helper.permissions.screenRecording = false;
      helper.enforcePermissions = true;
      await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
      const composer = page.getByRole('textbox', { name: 'Message', exact: true });
      // no action follows: the access request is the only call that can raise the card (#5577)
      const lines = [family.call('desktop_request_access', { apps: ['Notes'], reason: 'Read the note' }), family.steps];
      await composer.fill(lines.join('\n'));
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await page
        .locator('.sage-approval')
        .getByRole('button', { name: /^Allow in this chat/ })
        .click();
      const guide = page.locator('.cu-permission');
      await expect(guide).toHaveAttribute('data-permission', 'screenRecording');
      await expect(guide.getByRole('button', { name: 'Request', exact: true })).toBeVisible();
      await page.screenshot({ path: info.outputPath('request-access-permission-card.png') });
      // the grant lands while the call waits: the card goes by itself and the turn carries on to its end
      helper.permissions.screenRecording = true;
      await expect(guide).toHaveCount(0, { timeout: 30_000 });
      await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
      await expect(page.getByRole('main').getByText(/permission card in this chat/)).toHaveCount(0);
    });
  });
}
