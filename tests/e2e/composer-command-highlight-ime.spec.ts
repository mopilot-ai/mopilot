// A recognized /command stays colored while an input method composes around it, and text it composes is never colored as the command (#5676). Runs against fake-claude.mjs.
// e2e-covers: src/components/composer/ComposerInput.tsx src/components/composer/useCommandHighlight.ts
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const slash = (page: Page) => page.locator('.slash-panel');
const colored = (page: Page) =>
  page.evaluate(() => Array.from(CSS.highlights.get('composer-slash-command')?.values() ?? [], (range) => range.toString()));

test.use({ harnesses: 'claude' });

test('a command keeps its color through an IME composition after it, and composing inside it never colors other text', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  const input = composer(page);
  await input.fill('/code-r');
  await slash(page).getByText('/code-review (/review)', { exact: true }).click();
  await expect(input).toHaveText('/code-review ', { useInnerText: false });
  const cdp = await page.context().newCDPSession(page);

  // phase 1: before composing
  expect(await colored(page), 'phase 1 (before composing)').toEqual(['/code-review']);

  // phase 2: composing pinyin after the token, the way a Chinese user types an argument
  await cdp.send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 });
  await expect(input).toHaveText('/code-review ni', { useInnerText: false });
  expect(await colored(page), 'phase 2 (composing after the token)').toEqual(['/code-review']);
  await cdp.send('Input.imeSetComposition', { text: 'nih', selectionStart: 3, selectionEnd: 3 });
  expect(await colored(page), 'phase 2b (composition updated)').toEqual(['/code-review']);

  // phase 3: after commit
  await cdp.send('Input.insertText', { text: '你好' });
  await expect(input).toHaveText('/code-review 你好', { useInnerText: false });
  expect(await colored(page), 'phase 3 (after commit)').toEqual(['/code-review']);

  // phase 4: composing inside the token: whatever stays colored must be exactly a recognized token
  await input.press('Home');
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowRight');
  await cdp.send('Input.imeSetComposition', { text: 'zz', selectionStart: 2, selectionEnd: 2 });
  await expect(input).toHaveText('/code-zzreview 你好', { useInnerText: false });
  expect(await colored(page), 'phase 4 (composing inside the token)').not.toContain('/code-zzreview');
  for (const text of await colored(page)) expect(text, 'phase 4 colored text').toBe('/code-review');
  await cdp.send('Input.insertText', { text: '之' });
  expect(await colored(page), 'phase 5 (inside-token commit: the draft no longer holds the command)').toEqual([]);
});
