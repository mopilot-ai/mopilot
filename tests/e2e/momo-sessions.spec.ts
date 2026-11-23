// MoMo's Sessions pane (M6, `momo.sessions` with `momo.shell`), on fake harnesses for an invited account (MOPILOT_MOMO_DEV=1), clicking every control in the real renderer: three coding chats on two harnesses are left in three states (a Claude Code chat waiting on an approval, a Claude Code chat running a long turn, a Codex chat that finished unseen), then the third button at the top right opens the pane with each chat in the design's group (Needs input, Working, Can wait) with its harness and "This Mac"; the design's two controls show their states; Show other chats off says "Other chats are hidden." and lists nothing, on again brings the rows back; the pane is one of three (Tasks, Files, Sessions: never two), and the same button, Close and Esc close it. A second account with no chats shows "No open chats right now." Pictures of each state are attached. No Mac-only API: it runs on Linux and macOS.
import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';
import { codexCliLogin } from './fixtures/codexAccounts';
import { openHarnessList } from './fixtures/harnessPicker';
import { openMomo } from './fixtures/momo';
import { standaloneNewChat } from './fixtures/sidebar';

const seed = {
  files: (d: Parameters<typeof codexCliLogin>[0]) => codexCliLogin(d),
  uiState: {
    prefs: {
      momo: {
        onboarding: { done: true, step: 0 },
        routines: { proactivity: 'default', quietHours: null },
        shell: true,
        tasksPanel: true,
        sessions: true,
      },
    },
  },
};

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const card = (page: Page) => page.locator('.approval-card');
/** The sidebar's status marks on chat rows (ThreadIndicators). */
const status = (page: Page, name: string) => page.getByRole('complementary').locator('.thread-row').getByRole('img', { name, exact: true });

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await expect(composer(page)).toHaveText(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}
async function newChatOn(page: Page, who: 'Codex' | 'Claude Code', model: string) {
  await standaloneNewChat(page).click();
  await expect(home(page)).toBeVisible();
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: who }).click();
  await page.locator('.hp-models .menu-item', { hasText: model }).click();
  await page.keyboard.press('Escape');
}

/** The shell's own controls, scoped to it: the sidebar has a Tasks button of its own. */
const parts = (page: Page) => {
  const shell = page.locator('[data-momo-shell]');
  const region = (name: string) => shell.getByRole('region', { name, exact: true });
  return {
    shell,
    tasksButton: shell.getByRole('button', { name: 'Tasks', exact: true }),
    filesButton: shell.getByRole('button', { name: 'Files', exact: true }),
    sessionsButton: shell.getByRole('button', { name: 'Sessions', exact: true }),
    tasks: region('Tasks'),
    files: region('Files'),
    sessions: region('Sessions'),
  };
};

/** A picture of the page, with the part named scrolled into view, attached to the report. */
async function picture(page: Page, name: string, scrollTo: Locator) {
  await scrollTo.scrollIntoViewIfNeeded();
  const file = test.info().outputPath(`${name}.png`);
  await page.screenshot({ path: file });
  await test.info().attach(name, { path: file, contentType: 'image/png' });
}

test.describe('with chats in three states', () => {
  test.use({ harnesses: 'both', env: { MOPILOT_MOMO_DEV: '1' }, seed });

  test('the pane lists them in the design’s groups, the two controls work, one pane at a time, and it closes every way', async ({
    page,
    harness,
  }: {
    page: Page;
    harness: Harness;
  }) => {
    test.setTimeout(300_000);
    await expect(home(page)).toBeVisible();

    // a Codex chat runs a long turn; a Claude Code chat waits on an approval
    await newChatOn(page, 'Codex', 'Fake Model One');
    await send(page, 'SLOW codex work');
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
    await newChatOn(page, 'Claude Code', 'Fake Sonnet');
    await send(page, 'RUNCMD claude work');
    await expect(card(page)).toContainText('Allow Claude Code to run this command?', { timeout: 30_000 });
    // the Codex turn finishes while the user is on the Claude Code chat: unread
    fs.writeFileSync(path.join(harness.dir, 'fake-codex.jsonl.release'), '');
    await expect(status(page, 'Unread result')).toHaveCount(1, { timeout: 30_000 });
    // a second Claude Code chat runs a long turn and keeps running
    await newChatOn(page, 'Claude Code', 'Fake Sonnet');
    await send(page, 'SLOW claude work');
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
    await expect(status(page, 'Working')).toHaveCount(1);
    await expect(status(page, 'Awaiting approval')).toHaveCount(1);

    await openMomo(page);
    const { shell, tasksButton, filesButton, sessionsButton, tasks, files, sessions } = parts(page);
    const none = async () => {
      await expect(tasks).toHaveCount(0);
      await expect(files).toHaveCount(0);
      await expect(sessions).toHaveCount(0);
      await expect(shell.locator('aside')).toHaveCount(0);
    };

    // the third button at the top right, after Tasks and Files
    for (const button of [tasksButton, filesButton, sessionsButton]) await expect(button).toHaveCount(1);
    const left = async (button: Locator) => (await button.boundingBox())!.x;
    expect(await left(tasksButton)).toBeLessThan(await left(filesButton));
    expect(await left(filesButton)).toBeLessThan(await left(sessionsButton));
    await none();
    await expect(sessionsButton).toHaveAttribute('aria-pressed', 'false');

    // 1. the pane, 420 pt, with every chat in its group
    await sessionsButton.click();
    await expect(sessions).toBeVisible();
    await expect(sessions).toHaveCSS('width', '420px');
    await expect(sessionsButton).toHaveAttribute('aria-pressed', 'true');
    await expect(shell.locator('aside')).toHaveCount(1);
    await expect(sessions.locator('[data-session-row]')).toHaveCount(3);
    await expect(sessions.locator('h3')).toHaveText(['Needs input', 'Working', 'Can wait']);
    const group = (name: string) => sessions.getByRole('region', { name, exact: true });
    for (const name of ['Needs input', 'Working', 'Can wait']) {
      await expect(group(name)).toHaveCount(1);
      await expect(group(name).locator('[data-session-row]')).toHaveCount(1);
    }
    await expect(group('Needs input').locator('[data-session-row]')).toContainText('Claude Code · This Mac');
    await expect(group('Working').locator('[data-session-row]')).toContainText('Claude Code · This Mac');
    await expect(group('Can wait').locator('[data-session-row]')).toContainText('Codex · This Mac');
    await picture(page, 'sessions-pane-three-groups', sessions);

    // 2. the design's two controls and their states
    const show = sessions.getByRole('switch', { name: 'Show other chats', exact: true });
    const act = sessions.getByRole('switch', { name: 'Let MoMo answer their requests', exact: true });
    await expect(show).toHaveCount(1);
    await expect(act).toHaveCount(1);
    await expect(show).toHaveAttribute('aria-checked', 'true');
    await expect(act).toHaveAttribute('aria-checked', 'false');
    await expect(sessions.getByText('Money, deleting and sending stay with you.')).toHaveCount(1);
    await picture(page, 'sessions-controls', show);
    await act.click();
    await expect(act).toHaveAttribute('aria-checked', 'true');
    await expect(show).toHaveAttribute('aria-checked', 'true');
    await expect(sessions.locator('[data-session-row]')).toHaveCount(3);
    await picture(page, 'sessions-controls-act-on', act);
    await act.click();
    await expect(act).toHaveAttribute('aria-checked', 'false');

    // 3. Show other chats off: nothing listed, and the words say why
    await show.click();
    await expect(show).toHaveAttribute('aria-checked', 'false');
    await expect(sessions.getByText('Other chats are hidden.')).toHaveCount(1);
    await expect(sessions.locator('[data-session-row]')).toHaveCount(0);
    await expect(sessions.locator('h3')).toHaveCount(0);
    await expect(act).toHaveAttribute('aria-checked', 'false');
    await picture(page, 'sessions-pane-hidden', sessions);
    await show.click();
    await expect(show).toHaveAttribute('aria-checked', 'true');
    await expect(sessions.getByText('Other chats are hidden.')).toHaveCount(0);
    await expect(sessions.locator('[data-session-row]')).toHaveCount(3);

    // one pane at a time: each button replaces the one open
    await tasksButton.click();
    await expect(tasks).toBeVisible();
    await expect(sessions).toHaveCount(0);
    await expect(shell.locator('aside')).toHaveCount(1);
    await expect(sessionsButton).toHaveAttribute('aria-pressed', 'false');
    await filesButton.click();
    await expect(files).toBeVisible();
    await expect(tasks).toHaveCount(0);
    await expect(shell.locator('aside')).toHaveCount(1);
    await sessionsButton.click();
    await expect(sessions).toBeVisible();
    await expect(files).toHaveCount(0);
    await expect(tasks).toHaveCount(0);
    await expect(shell.locator('aside')).toHaveCount(1);
    await expect(sessionsButton).toHaveAttribute('aria-pressed', 'true');
    await expect(filesButton).toHaveAttribute('aria-pressed', 'false');
    await expect(sessions.locator('[data-session-row]')).toHaveCount(3);

    // the same button closes it, so do Close and Esc (and a key that is not Esc leaves it)
    await sessionsButton.click();
    await none();
    await sessionsButton.click();
    await expect(sessions).toBeVisible();
    await sessions.getByRole('button', { name: 'Close', exact: true }).click();
    await none();
    await sessionsButton.click();
    await expect(sessions).toBeVisible();
    await page.keyboard.press('a');
    await expect(sessions).toBeVisible();
    await page.keyboard.press('Escape');
    await none();
  });
});

test.describe('with no chats', () => {
  test.use({ harnesses: 'claude', env: { MOPILOT_MOMO_DEV: '1' }, seed });

  test('the pane says nothing is open, and the two controls are still there', async ({ page }: { page: Page }) => {
    test.setTimeout(120_000);
    await openMomo(page);
    const { shell, sessionsButton, sessions } = parts(page);
    await sessionsButton.click();
    await expect(sessions).toBeVisible();
    await expect(sessions.locator('[data-session-row]')).toHaveCount(0);
    await expect(sessions.locator('h3')).toHaveCount(0);
    await expect(sessions.getByText('No open chats right now.')).toHaveCount(1);
    await expect(sessions.getByText('Other chats are hidden.')).toHaveCount(0);
    await expect(sessions.getByRole('switch')).toHaveCount(2);
    await expect(sessions.getByRole('switch', { name: 'Show other chats', exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect(shell.locator('aside')).toHaveCount(1);
    await picture(page, 'sessions-pane-empty', sessions);
  });
});
