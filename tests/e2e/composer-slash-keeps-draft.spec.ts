// A "/" command typed in front of a draft (Plan mode, by its menu or typed with text) switches the mode and keeps
// the draft in the box, instead of clearing it. Inline skills replace their query and keep their visible baseline.
// e2e-covers: src/components/composer/Composer.tsx src/components/composer/ComposerInput.tsx src/components/composer/useSlashPick.ts src/lib/composerSkills.ts src/styles/app/composer.css
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { sizeRealWindow } from './fixtures/window';

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const DRAFT = 'fix the login bug';

test.use({ harnesses: 'codex' });

test('/plan picked in front of a draft, or typed with text, turns plan mode on and keeps the text', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  await composer(page).fill(DRAFT);
  // the caret back to the start, then the command typed before the draft and picked with Enter
  await composer(page).press('Home');
  await page.keyboard.type('/plan');
  await expect(page.locator('.slash-panel').getByText('Plan mode', { exact: true })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('.plan-chip')).toBeVisible();
  await expect(composer(page)).toHaveText(DRAFT);

  // off again, then typed with its text and sent: the mode switches and the text stays, unsent
  await page.locator('.plan-chip').click();
  await expect(page.locator('.plan-chip')).toHaveCount(0);
  await composer(page).fill(`/plan ${DRAFT}`);
  await page.keyboard.press('Enter');
  await expect(page.locator('.plan-chip')).toBeVisible();
  await expect(composer(page)).toHaveText(DRAFT);
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
});

test.describe('inline skills at a larger chat font size', () => {
  test.use({ seed: { uiState: { prefs: { defaultHarness: 'codex', sendWith: 'enter', fontSize: 24, zoomLevel: 0 } } } });

  test('picking a skill after text keeps the chip inline and typing continues after it', async ({ page, harness }, testInfo) => {
    await sizeRealWindow(page, harness, 1024, 682);
    const input = composer(page);
    const chip = input.locator('.composer-skill');
    await expect(input).toHaveCSS('font-size', '24px');
    await input.click();
    await page.keyboard.insertText('盘一下 notes ');
    await page.keyboard.type('$tidy');
    await expect(page.locator('.slash-panel').getByText('Tidy Notes', { exact: true })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(chip).toHaveText('Tidy Notes');
    await page.keyboard.type(' next');
    await expect(input).toHaveText('盘一下 notes Tidy Notes next', { useInnerText: true });
    await expect
      .poll(() =>
        chip.evaluate((el) => {
          const textTop = (node: Node, start: number, end: number) => {
            const range = document.createRange();
            range.setStart(node, start);
            range.setEnd(node, end);
            return range.getBoundingClientRect().top;
          };
          const prefix = el.previousSibling!;
          return Math.abs(
            textTop(prefix, prefix.textContent!.indexOf('notes'), prefix.textContent!.indexOf('notes') + 5) -
              textTop(el.lastChild!.firstChild!, 0, 4),
          );
        }),
      )
      .toBeLessThan(1);
    await input.screenshot({ path: testInfo.outputPath('inline-skill.png') });
  });
});
