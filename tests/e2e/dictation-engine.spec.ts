// Settings → Voice → Dictation engine, in the real app against a fake computer-use helper (never the
// real microphone or Speech Recognition).
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { openSettingsSelect, settingsSelect, settingsEntry } from './fixtures/settings';

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });

async function openVoiceSettings(page: Page) {
  await expect(home(page)).toBeVisible();
  await page.locator('.sidebar-title').first().click();
  await settingsEntry(page).click();
  await page.locator('.side-row', { hasText: 'Voice' }).click();
}

test.describe('dictation engine', () => {
  test.use({ harnesses: 'codex', computerHelper: true });

  test('Automatic names what it uses; a signed-out cloud pin says why; pinning this Mac asks the helper', async ({ page, harness }) => {
    test.skip(process.platform !== 'darwin', 'local dictation is macOS only');
    await openVoiceSettings(page);
    const row = page.locator('.settings-row', { hasText: 'Dictation engine' });
    const engine = settingsSelect(page, 'Dictation engine');
    await expect(engine).toContainText('Automatic');
    await expect(row).toContainText('Uses This Mac');

    await (await openSettingsSelect(page, 'Dictation engine', 'ChatGPT account')).click();
    await expect(engine).toContainText('ChatGPT account');
    await expect(row).toContainText('Sign in with ChatGPT account to use this dictation service');
    await expect.poll(() => page.evaluate(async () => (await (window as any).native.state.read()).prefs.dictationEngine)).toBe('chatgpt');

    await (await openSettingsSelect(page, 'Dictation engine', 'This Mac')).click();
    await expect(engine).toContainText('This Mac');
    await expect.poll(() => harness.helper!.log.some((m) => m.method === 'speech.request')).toBe(true);
  });
});
