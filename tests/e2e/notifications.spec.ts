// Settings → Notifications in the real app (#59): with Never, a finished turn reaches no OS
// notification; with Always it does. The main process's Notification.show is recorded, not shown.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { chooseSetting, settingsEntry } from './fixtures/settings';

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');

async function setNotifications(page: Page, label: string) {
  await page.locator('.sidebar-title').first().click();
  await settingsEntry(page).click();
  await chooseSetting(page, 'Notifications', label);
  await page.locator('.side-row', { hasText: 'Back to app' }).click();
  // the setting reaches the main process with the next (debounced) save
  await page.waitForTimeout(500);
}

test('notifications: Never shows nothing, Always shows the finished turn', async ({ harness, page }) => {
  await harness.app.evaluate(({ Notification }) => {
    (globalThis as any).__shown = [];
    Notification.prototype.show = function (this: any) {
      (globalThis as any).__shown.push(this.title);
    };
  });
  const shown = () => harness.app.evaluate(() => (globalThis as any).__shown as string[]);
  await expect(home(page)).toBeVisible();

  await setNotifications(page, 'Never');
  await composer(page).fill('first');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(transcript(page).getByText('fake-codex: first', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(await shown()).toEqual([]);

  await setNotifications(page, 'Always');
  await page.getByRole('complementary').getByText('Fake chat title', { exact: true }).click();
  await composer(page).fill('second');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(transcript(page).getByText('fake-codex: second', { exact: true })).toBeVisible();
  await expect.poll(shown).toEqual(['Fake chat title']);
});

test('notifications: a kind switched off in Settings shows nothing, even with Always', async ({ harness, page }) => {
  await harness.app.evaluate(({ Notification }) => {
    (globalThis as any).__shown = [];
    Notification.prototype.show = function (this: any) {
      (globalThis as any).__shown.push(this.title);
    };
  });
  const shown = () => harness.app.evaluate(() => (globalThis as any).__shown as string[]);
  await expect(home(page)).toBeVisible();

  await setNotifications(page, 'Always');
  await page.locator('.sidebar-title').first().click();
  await settingsEntry(page).click();
  const kind = page.locator('.notify-kind', { hasText: 'Task finished' }).getByRole('switch');
  await expect(kind).toHaveAttribute('aria-checked', 'true');
  await kind.click();
  await expect(kind).toHaveAttribute('aria-checked', 'false');
  await page.locator('.side-row', { hasText: 'Back to app' }).click();
  await page.waitForTimeout(500);

  await composer(page).fill('quiet');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(transcript(page).getByText('fake-codex: quiet', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(await shown()).toEqual([]);
});

// 'Turn done' and 'needs approval' come from the ChatController in main, not from a window: a scheduled
// run on Claude Code with every window closed still notifies when it finishes.
test.describe('with no window', () => {
  test.use({
    harnesses: 'both',
    seed: {
      uiState: { prefs: { notifyOnComplete: 'always', runSchedules: true } },
      files: ({ codexHome }: { codexHome: string }) => {
        const dir = path.join(codexHome, 'automations', 'quiet-check');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'automation.toml'),
          [
            'version = 1',
            'id = "quiet-check"',
            'kind = "cron"',
            'name = "Quiet check"',
            "prompt = 'summarize the repo'",
            'status = "ACTIVE"',
            'rrule = "FREQ=MINUTELY;INTERVAL=1"',
            'harness = "claude"',
            `updated_at = ${Date.now()}`,
            '',
          ].join('\n'),
        );
      },
    },
  });

  test('a turn that finishes in main notifies with the last reply', async ({ harness, page }) => {
    test.skip(process.platform !== 'darwin', 'the app stays running with no window on macOS only');
    await harness.app.evaluate(({ Notification }) => {
      (globalThis as any).__shown = [];
      Notification.prototype.show = function (this: any) {
        (globalThis as any).__shown.push({ title: this.title, body: this.body });
      };
    });
    const shown = () => harness.app.evaluate(() => (globalThis as any).__shown as { title: string; body: string }[]);
    await expect(home(page)).toBeVisible();
    await page.close();
    await expect.poll(() => harness.app.windows().length).toBe(0);
    const prompted = () => harness.claudeLog().some((l) => l.kind === 'in' && JSON.stringify(l.msg).includes('summarize the repo'));
    await expect
      .poll(
        async () => {
          if (prompted()) return true;
          await harness.app.evaluate(() => (globalThis as any).__schedulerAdvance(61_000));
          return false;
        },
        { intervals: [3000], timeout: 50_000 },
      )
      .toBe(true);
    await expect
      .poll(async () => (await shown()).some((n) => n.title === 'Claude Code' && n.body === 'fake-claude: summarize the repo'))
      .toBe(true);
    await harness.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length).then((n) => expect(n).toBe(0));
  });
});
