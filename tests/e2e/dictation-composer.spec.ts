// Dictate in a chat's composer, in the real app against a fake computer-use helper and a synthetic microphone (never
// the real microphone or Speech Recognition): a fresh profile dictates with no engine chosen, and the button is hidden
// while no dictation service can be used.
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const mic = (page: Page) => page.locator('.composer button[aria-label="Dictate"]');

/** A test tone as the microphone (Dictation.tsx reads window.__voiceTestStream instead of getUserMedia). */
async function syntheticMicrophone(page: Page) {
  await page.evaluate(() => {
    const ctx = new AudioContext();
    const tone = ctx.createOscillator();
    const out = ctx.createMediaStreamDestination();
    tone.connect(out);
    tone.start();
    (window as any).__voiceTestStream = out.stream;
  });
}

async function dictate(page: Page) {
  await mic(page).click();
  await expect(mic(page)).toHaveClass(/recording/);
  await page.waitForTimeout(600);
  await mic(page).click();
}

test.describe('composer dictation', () => {
  test.use({ harnesses: 'codex', computerHelper: true });

  test('with no engine chosen, a fresh profile dictates on this Mac and the text lands in the draft', async ({ page }) => {
    test.skip(process.platform !== 'darwin', 'local dictation is macOS only');
    await expect(composer(page)).toBeVisible();
    await syntheticMicrophone(page);
    await composer(page).fill('Note:');
    await dictate(page);
    await expect(composer(page)).toHaveText('Note: hello from the fake recognizer');
    // the microphone was given back: a second dictation starts at once
    await dictate(page);
    await expect(composer(page)).toHaveText('Note: hello from the fake recognizer hello from the fake recognizer');
  });

  test('the button is hidden while no service can dictate, and comes back when one can', async ({ page, harness }) => {
    test.skip(process.platform !== 'darwin', 'local dictation is macOS only');
    await expect(composer(page)).toBeVisible();
    await syntheticMicrophone(page);
    // the helper runs once something used it; the availability check never launches it by itself
    await dictate(page);
    await expect(composer(page)).toHaveText('hello from the fake recognizer');
    harness.helper!.speech.onDevice = false;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(mic(page)).toHaveCount(0);
    harness.helper!.speech.onDevice = true;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(mic(page)).toBeVisible();
  });
});

test.describe('composer dictation switched off', () => {
  test.use({ harnesses: 'codex', computerHelper: true, env: { MOPILOT_FLAGS: 'shared.dictation.enabled=0' } });

  test('the remote switch hides the button without starting the speech helper', async ({ page, harness }) => {
    await expect(composer(page)).toBeVisible();
    await page.waitForTimeout(1000);
    await expect(mic(page)).toHaveCount(0);
    expect(harness.helper!.log.some((m) => m.method.startsWith('speech.'))).toBe(false);
  });
});
