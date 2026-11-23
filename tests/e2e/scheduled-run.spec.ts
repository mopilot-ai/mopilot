// A scheduled task in the real app (WP7-18, A19): Run with Claude Code, the run goes through the same
// function as the scheduler, computer control stays off unless the task allows it, and the page says
// where it runs. Against the fake Codex (which holds the task file) and the fake Claude CLI.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';

const task = (o: { computer: boolean }) =>
  [
    'version = 1',
    'id = "daily-check"',
    'kind = "cron"',
    'name = "Daily check"',
    'prompt = \'CUCALL computer_click {"x":10,"y":20}\'',
    'status = "ACTIVE"',
    'rrule = "FREQ=DAILY;BYHOUR=9;BYMINUTE=0"',
    'harness = "claude"',
    `computer_control = ${o.computer}`,
    'on_approval = "skip"',
    `updated_at = ${Date.now()}`,
    '',
  ].join('\n');

const VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8')).version;
// The fake CLI calls the computer_* tools on the sage server. With the default switches the desktop_* tools
// (on their own server) replace them (PR #348, #351), so this profile's flags cache turns that parity off.
const COMPUTER_TOOLS = { 'shared.computerUse.parityTools': false, 'native.codex.enabled': false };

const seedTask = (o: { computer: boolean }) => ({
  files: ({ codexHome, userData }: { codexHome: string; userData: string }) => {
    const dir = path.join(codexHome, 'automations', 'daily-check');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'automation.toml'), task(o));
    fs.writeFileSync(
      path.join(userData, 'flags.json'),
      JSON.stringify({ fetchedAt: Date.now(), channel: 'stable', version: VERSION, flags: COMPUTER_TOOLS }),
    );
  },
});

// computer use is the macOS helper's, off in a Windows build (shared/flagDefs.mjs NOT_ON_WINDOWS): the computer-control
// tests skip there, and the task dialog's still runs
const NO_COMPUTER_USE = 'computer use is off in a Windows build (shared/flagDefs.mjs NOT_ON_WINDOWS)';

async function openTask(page: Page) {
  await page.getByRole('button', { name: 'Scheduled' }).first().click();
  await page.locator('.sched-row', { hasText: 'Daily check' }).click();
}

test.describe('computer control off', () => {
  test.skip(process.platform === 'win32', NO_COMPUTER_USE);
  test.use({ harnesses: 'both', computerHelper: true, seed: seedTask({ computer: false }) });

  test('Run now starts a Claude chat marked as a scheduled run; computer tools are refused', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
    await openTask(page);
    await expect(page.getByText('Runs on this Mac')).toBeVisible();
    await expect(page.locator('.task-detail')).toContainText('Claude Code');
    await page.getByRole('button', { name: 'Run now' }).click();
    const main = page.getByRole('main');
    await expect(main.getByText(/fake-claude: CUCALL computer_click/)).toBeVisible();
    await expect(main.getByText(/off for this scheduled task/)).toBeVisible();
    // the run's chat carries the task's settings
    const snap = await page.evaluate(async () => {
      const chats = Object.keys((await (window as any).native.chats.snapshot()).chats);
      const all = await Promise.all(chats.map((c) => (window as any).native.session.snapshot(c)));
      return all.find((x) => x?.scheduled) ?? null;
    });
    expect(snap?.scheduled).toEqual({ unattended: false, computer: false, onApproval: 'skip' });
  });
});

test.describe('computer control on', () => {
  test.skip(process.platform === 'win32', NO_COMPUTER_USE);
  test.use({ harnesses: 'both', computerHelper: true, seed: seedTask({ computer: true }) });

  test('the same task with computer control allowed reaches the policy, which still refuses an unattended new grant', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
    await openTask(page);
    await page.getByRole('button', { name: 'Run now' }).click();
    await expect(page.getByRole('main').getByText(/needs the user's OK/)).toBeVisible();
    await expect(page.getByRole('main').getByText(/off for this scheduled task/)).toHaveCount(0);
  });
});

test.describe('the task dialog', () => {
  test.use({ harnesses: 'both', seed: seedTask({ computer: false }) });

  test('Run with lists the available harnesses with their hosting notes; computer control and approval handling are task fields', async ({
    page,
  }) => {
    await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
    await openTask(page);
    await page.getByRole('button', { name: 'Task actions' }).click();
    await page.getByRole('menuitem', { name: 'Edit' }).click();
    const dialog = page.getByRole('dialog', { name: 'Schedule a task' });
    await dialog.getByRole('button', { name: 'Advanced' }).click();
    await dialog.getByRole('button', { name: 'Run with' }).click();
    // each harness by its title, with where else the task runs as the item's hint
    const items = page.getByRole('menuitemcheckbox').filter({ has: page.locator('.menu-title', { hasText: /^(Codex|Claude Code)$/ }) });
    await expect(items).toHaveCount(2);
    await expect(items.locator('.menu-hint')).toHaveText(['Also runs in the Codex app', 'Also runs in Claude Desktop']);
    await expect(
      page
        .getByRole('menuitemcheckbox')
        .or(page.getByRole('menuitem'))
        .filter({ hasText: /Gemini|Goose|Kimi|Cursor|Copilot|Qwen|opencode/i }),
    ).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(dialog.getByRole('switch', { name: 'Allow computer control' })).toHaveAttribute('aria-checked', 'false');
    await expect(dialog.getByRole('button', { name: 'When approval is needed' })).toContainText('Skip this run');
  });
});
