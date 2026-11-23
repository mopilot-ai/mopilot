// Help → Join the Community and Settings → About → Join open the shared community link in the default browser (never from a test).
import { test, expect } from './fixtures/app';
import { settingsEntry } from './fixtures/settings';
import { captureExternal } from './fixtures/externalUrls';

const URL = 'https://mopilot.ai/discord';

test('community: the Help menu entry and the About row both open the community link', async ({ page, harness }) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  // every launch records the URLs it is asked to open and opens none (fixtures/no-external.cjs)
  const opened = await captureExternal(harness);
  await harness.app.evaluate(({ Menu }) => {
    const help = Menu.getApplicationMenu()!.items.find((m) => m.role === 'help')!;
    help.submenu!.items.find((i) => i.label === 'Join the Community')!.click();
  });
  await expect.poll(opened).toEqual([URL]);
  await page.locator('.sidebar-title').first().click();
  await settingsEntry(page).click();
  await page.locator('.side-row', { hasText: 'About' }).click();
  await page.locator('.settings-row', { hasText: 'Join the community' }).getByRole('button', { name: 'Join' }).click();
  await expect.poll(opened).toEqual([URL, URL]);
});
