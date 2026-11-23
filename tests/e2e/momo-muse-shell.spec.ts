// MoMo's page shell and Chat laid out as Muse's (#2139), on the fake Claude Code harness: an invited account with setup
// done opens MoMo; the sidebar column holds MoMo's own navigation (a way back, Chat, Memory, Settings), the
// page has no title or tabs, and Chat is a full-height chat with MoMo's identity floating at the top center, a narrow
// transcript and Muse's one-row pill composer pinned at the bottom (+, "Message MoMo", the brain chip, mic, send; no
// permission picker; #2338 leaves the coding chrome out), growing in place for a longer message. A message is answered; a coding chat's
// composer is unchanged; screenshots of Chat (and Memory's title and Settings › MoMo › Routines) in light and dark, at a normal window and at 1024×682.
import { test, expect } from './fixtures/app';
import { sizeRealWindow } from './fixtures/window';
import { expectNoMomoTabs, goToMomoSettings, goToMomoView, momoChat, momoNav, momoReply, openMomo } from './fixtures/momo';

const nav = momoNav;

for (const theme of ['light', 'dark'] as const) {
  test.describe(`MoMo's Chat, ${theme}`, () => {
    test.use({
      harnesses: 'claude',
      env: { MOPILOT_MOMO_DEV: '1' },
      seed: { uiState: { prefs: { theme, momo: { onboarding: { done: true, step: 0 } } } } },
    });

    test('MoMo’s own nav, no page title or tabs, the floating identity over a full-height chat', async ({ page, harness }) => {
      // the runner's screen is small: 1024×682 is a real window, the normal size is the page emulated at 1440×900
      await sizeRealWindow(page, harness, 1024, 682);
      // the MoMo row shows once main says the account was invited
      await openMomo(page);
      for (const name of ['Chat', 'Memory', 'Settings']) await expect(nav(page).getByRole('button', { name, exact: true })).toBeVisible();
      await expect(nav(page).getByRole('button', { name: 'Chat', exact: true })).toHaveAttribute('aria-current', 'page');
      await expect(page.getByRole('button', { name: 'Back to chats' })).toBeVisible();
      await expectNoMomoTabs(page);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

      const chat = momoChat(page);
      const box = chat.getByRole('textbox', { name: 'Message', exact: true });
      await expect(box).toBeVisible({ timeout: 20_000 });
      // Muse's composer: "Message MoMo", the brain chip as harness · model (its account is in its menu), no permission
      // picker, in one row while the message is one line
      const chip = chat.getByRole('button', { name: "MoMo's brain" });
      await expect(chip).toBeVisible();
      await expect(chip).toHaveText(/^Claude Code · [^·]+$/);
      await expect(box).toHaveAttribute('data-placeholder', 'Message MoMo');
      await expect(chat.getByRole('button', { name: 'Change permissions' })).toHaveCount(0);
      const composerHeight = () => chat.locator('.composer').evaluate((el) => Math.round(el.getBoundingClientRect().height));
      expect(await composerHeight()).toBeLessThanOrEqual(48);
      for (const text of ['hello MoMo', 'what is on my calendar tomorrow?']) {
        await box.fill(text);
        await chat.getByRole('button', { name: 'Send', exact: true }).click();
        await expect(chat.getByText(momoReply('fake-claude', text))).toBeVisible({ timeout: 20_000 });
      }
      // the turn is over: the identity says Active; the pointer leaves the sidebar's rows
      await expect(chat.locator('header [role=status]')).toHaveText('Active', { timeout: 20_000 });
      await page.mouse.move(700, 300);
      // the chat's own scroller scrolls; the page and the composer stay put
      const layout = async () =>
        page.evaluate(() => {
          const r = (s: string) => document.querySelector(s)!.getBoundingClientRect();
          const main = r('.main-content');
          const chat = r('section[aria-label="Chat"]');
          const identity = r('section[aria-label="Chat"] > header > div');
          return {
            composerBottomGap: Math.round(main.bottom - r('.thread-composer-area').bottom),
            columnWidth: Math.round(r('.thread-column').width),
            identityCenter: Math.round(identity.left + identity.width / 2 - (chat.left + chat.width / 2)),
            pageScrolls: document.querySelector('.main-content')!.scrollHeight > document.querySelector('.main-content')!.clientHeight,
          };
        });
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      const shot = async (size: string) => {
        const box = await layout();
        expect(box.composerBottomGap).toBeLessThanOrEqual(1);
        // the transcript column shares the composer's width (--composer-w, 736px; momo-composer-width.spec.ts)
        expect(box.columnWidth).toBeLessThanOrEqual(736);
        expect(Math.abs(box.identityCenter)).toBeLessThanOrEqual(2);
        expect(box.pageScrolls).toBe(false);
        await page.screenshot({ path: test.info().outputPath(`momo-chat-${theme}-${size}.png`) });
      };
      await shot('1024');
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1440);
      await shot('1440');
      // a longer message grows the pill in place, its controls at its foot
      await box.click();
      await page.keyboard.type('Plan my Saturday:');
      for (const line of ['dinner near the hotel', 'a walk after']) {
        await page.keyboard.press('Shift+Enter');
        await page.keyboard.type(line);
      }
      expect(await composerHeight()).toBeGreaterThan(60);
      await page.screenshot({ path: test.info().outputPath(`momo-chat-${theme}-1440-multiline.png`) });
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.press('Backspace');
      await cdp.send('Emulation.clearDeviceMetricsOverride');

      await goToMomoView(page, 'Memory');
      await page.screenshot({ path: test.info().outputPath(`momo-memory-${theme}-1024.png`) });
      await goToMomoSettings(page, 'Routines');
      await expect(page.getByRole('heading', { name: 'Routines', level: 2, exact: true })).toBeVisible();
      await page.screenshot({ path: test.info().outputPath(`momo-routines-${theme}-1024.png`) });
      // ⌘. comes back to MoMo from Settings
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Period' : 'Control+Period');
      await expect(momoNav(page)).toBeVisible();
      await page.getByRole('button', { name: 'Back to chats' }).click();
      await expect(page.getByRole('complementary', { name: 'MoMo' })).toHaveCount(0);
      // a coding chat's composer is its own again: the permission picker and the coding placeholder
      await expect(page.getByRole('button', { name: 'Change permissions' })).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'Message', exact: true })).not.toHaveAttribute('data-placeholder', 'Message MoMo');
    });
  });
}
