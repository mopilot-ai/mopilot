// A turn that fails because the plan doesn't include the chat's model (onboarding audit #3518): the error says so in
// plain words and offers the harness's default model in one click, which retries the turn on it. NOMODEL is
// fixtures/fake-codex-trouble.mjs: the first turn fails as Codex does for Fake Model Two, the retry answers.
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { openHarnessList } from './fixtures/harnessPicker';

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
const modelButton = (page: Page) => page.getByRole('button', { name: 'Select model' });

test.use({ harnesses: 'both' });

test('model-unavailable: "Your plan doesn\'t include" with Use the default model, which retries the turn on it', async ({
  page,
  harness,
}, testInfo) => {
  await openHarnessList(page);
  await page.locator('.hp-models .menu-item', { hasText: 'Fake Model Two' }).click();
  await page.keyboard.press('Escape');
  await expect(modelButton(page)).toContainText('Fake Model Two');
  await composer(page).fill('NOMODEL hello');
  await page.getByRole('button', { name: 'Send', exact: true }).click();

  const error = transcript(page).locator('.turn-error');
  await expect(error).toContainText("Your plan doesn't include Fake Model Two");
  const use = error.getByRole('button', { name: 'Use Fake Model One', exact: true });
  await expect(use).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('model-unavailable.png'), animations: 'disabled' });
  await use.click();
  await expect(transcript(page).getByText('fake-codex: NOMODEL hello', { exact: true })).toBeVisible();
  await expect(modelButton(page)).toContainText('Fake Model One');
  const starts = harness.codexLog().filter((e) => e.method === 'turn/start' && e.params.input?.[0]?.text === 'NOMODEL hello');
  expect(starts.at(-1)?.params.model).toBe('fake-model-1');
});
