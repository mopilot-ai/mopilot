// MoMo's first run as it looks (#2607), on fake harnesses only, for an invited account
// (MOPILOT_MOMO_DEV=1), in light and dark: Meet (the big dot, name, five colors, the brain only in a footnote), Notifications (one optional
// row; Calendar and Reminders are not asked for), Setting up, the first Chat
// (MoMo speaks first, three suggestions) and the next open straight to Chat with Active in the header. Screenshots of every screen
// are saved (meet, notifications, setting-up, first-chat, returning).
import { test, expect } from './fixtures/app';
import { meetHeading, momoChat, momoReply, momoRow, notificationsHeading, openMomo } from './fixtures/momo';

for (const theme of ['light', 'dark'] as const) {
  test.describe(`MoMo's first run in ${theme}`, () => {
    test.use({ harnesses: 'claude', env: { MOPILOT_MOMO_DEV: '1' }, seed: { uiState: { prefs: { theme } } } });

    test('Meet, Notifications, Setting up, the first Chat and the next open', async ({ page, harness }) => {
      const shot = (name: string) => page.screenshot({ path: test.info().outputPath(`${name}-${theme}.png`) });
      await openMomo(page, { setup: 'stay' });

      // Meet: a color picked shows on the big dot and the sidebar's, the brain is only a footnote
      await expect(meetHeading(page)).toHaveText('Meet MoMo');
      await expect(page.getByText(/^Thinks with Claude Code · .+\. You can change this in Settings\.$/)).toBeVisible({ timeout: 15_000 });
      await page.getByRole('radio', { name: 'Violet' }).click();
      await expect(page.getByRole('radio', { name: 'Violet' })).toBeChecked();
      // the swatch's ring has finished moving
      await page.waitForTimeout(500);
      await shot('meet');
      await page.getByRole('button', { name: 'Continue', exact: true }).click();

      // Notifications: one optional row, and nothing for Calendar or Reminders
      await expect(notificationsHeading(page)).toBeVisible();
      await expect(page.getByText('Calendar', { exact: true })).toHaveCount(0);
      await shot('notifications');

      // Setting up: its real work is quick, so main's answer to the last step's first save (the starter routines) is held at the IPC boundary to catch the screen
      await harness.app.evaluate(({ ipcMain }) => {
        const channel = 'momoPrefs:set';
        const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers;
        const real = handlers.get(channel)!;
        const gate = { release: () => {}, held: Promise.resolve() };
        gate.held = new Promise<void>((resolve) => (gate.release = resolve));
        (globalThis as unknown as { __momoSetupGate: typeof gate }).__momoSetupGate = gate;
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, async (...args) => {
          await gate.held;
          return real(...args);
        });
      });
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Setting up MoMo', level: 1 })).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText('Picked a brain with room to think')).toBeVisible();
      await expect(page.locator('.momo-progress-steps li[data-mark=active]')).toHaveText('Almost done');
      await shot('setting-up');
      await harness.app.evaluate(() => (globalThis as unknown as { __momoSetupGate: { release: () => void } }).__momoSetupGate.release());

      // the first Chat: MoMo speaks first (a real message, the fake echoing it), in the color picked
      const chat = momoChat(page);
      await expect(chat).toBeVisible({ timeout: 20_000 });
      await expect(chat.getByText(/fake-claude: /).first()).toBeVisible({ timeout: 30_000 });
      await expect(chat.locator('header [role=status]')).toHaveText('Active');
      await page.mouse.move(700, 300);
      await shot('first-chat');

      // the next open goes straight to Chat, after a message was answered
      await chat.getByRole('textbox', { name: 'Message', exact: true }).fill('Remind me every morning at 9');
      await chat.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(chat.getByText(momoReply('fake-claude', 'Remind me every morning at 9'))).toBeVisible({ timeout: 30_000 });
      await page.getByRole('button', { name: 'Back to chats' }).click();
      await momoRow(page).click();
      await expect(chat).toBeVisible();
      await expect(meetHeading(page)).toHaveCount(0);
      await expect(chat.locator('header [role=status]')).toHaveText('Active');
      // the greeting stays the first message; the app's sidebar has given way to MoMo's own
      await expect(chat.getByText(/fake-claude: /).first()).toBeVisible();
      await expect.poll(() => page.locator('aside.sidebar:visible').count()).toBe(1);
      // the page's own transitions (the column sliding in, a message arriving) are over
      await page.waitForTimeout(1500);
      await page.mouse.move(700, 300);
      await shot('returning');
    });
  });
}
