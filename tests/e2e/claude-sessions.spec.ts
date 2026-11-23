// Claude chats: temporary chats (D-9), edit-and-resend through file checkpoints (D-68) and Fork
// chat from here (D-62). Runs against fake-claude.mjs, whose transcripts the SDK reads and forks.
import type { Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';
import { openCompletedTurnWork } from './fixtures/turnWork';
import { commandStepName, runningCommandName } from './fixtures/commandStep';

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
const sidebar = (page: Page) => page.getByRole('complementary');

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await expect(composer(page)).toHaveText(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(transcript(page).getByText(`fake-claude: ${text}`, { exact: true })).toBeVisible();
}

/** argv of every fake Claude process that ran a chat session. */
const chatArgv = (h: Harness) =>
  h
    .claudeLog()
    .filter((e) => e.kind === 'argv' && e.argv.some((a) => /^--(session-id|resume)=/.test(a)))
    .map((e) => (e as any).argv as string[]);

test.use({
  harnesses: 'claude',
  seed: {
    claudeSessions: [{ id: '5e3d9a8c-1b2f-4c6d-9e7a-0f1e2d3c4b5a', cwd: 'old-project', title: 'Old chat', turns: ['an old message'] }],
  },
});

test('a temporary chat is unpersisted and stays out of the sidebar', async ({ page, harness }) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  await harness.app.evaluate(({ Menu }) => {
    const find = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const i of items) {
        if (i.label === 'New Temporary Chat') return i;
        const sub = i.submenu && find(i.submenu.items);
        if (sub) return sub;
      }
    };
    find(Menu.getApplicationMenu()!.items)!.click();
  });
  await expect(page.getByText('Temporary chat')).toBeVisible();
  await send(page, 'a passing thought');
  const argv = chatArgv(harness);
  expect(argv).toHaveLength(1);
  expect(argv[0]).toContain('--no-session-persistence');
  await expect(sidebar(page).getByText('Fake chat title')).toHaveCount(0);
  await expect(sidebar(page).getByText('a passing thought')).toHaveCount(0);
  // no title was generated for it either
  expect(
    harness
      .claudeLog()
      .some(
        (e) =>
          e.kind === 'in' &&
          e.msg.type === 'user' &&
          /Summarize the request below as a short chat title/.test(JSON.stringify(e.msg.message.content)),
      ),
  ).toBe(false);
});

test('a temporary chat greys every Goal entry with the reason and keeps a typed /goal in the box (D-49)', async ({ page, harness }) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  await harness.app.evaluate(({ Menu }) => {
    const find = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const i of items) {
        if (i.label === 'New Temporary Chat') return i;
        const sub = i.submenu && find(i.submenu.items);
        if (sub) return sub;
      }
    };
    find(Menu.getApplicationMenu()!.items)!.click();
  });
  await expect(page.getByText('Temporary chat')).toBeVisible();
  const reason = "Temporary chats can't have goals";
  const check = async () => {
    // the "+" panel
    await page.getByRole('button', { name: 'Add files and more' }).click();
    const plus = page.locator('.add-panel-item', { hasText: 'Goal' });
    await expect(plus).toHaveAttribute('aria-disabled', 'true');
    await expect(plus).toContainText(reason);
    await plus.click({ force: true });
    await expect(composer(page)).toHaveText('');
    await page.keyboard.press('Escape');
    // the "/" menu
    await composer(page).fill('/goal');
    const slash = page.locator('.slash-panel .add-panel-item', { hasText: 'Goal' });
    await expect(slash).toHaveAttribute('aria-disabled', 'true');
    await expect(slash).toContainText(reason);
    await slash.click({ force: true });
    await expect(composer(page)).toHaveText('/goal');
    // a typed goal is refused and stays in the box
    await composer(page).fill('/goal finish the list');
    await composer(page).press('Enter');
    await expect(page.getByText(reason).first()).toBeVisible();
    await expect(composer(page)).toHaveText('/goal finish the list');
    await composer(page).fill('');
  };
  await check();
  expect(harness.claudeLog().some((e) => e.kind === 'in' && JSON.stringify(e.msg).includes('finish the list'))).toBe(false);
  // and in the temporary chat once it exists
  await send(page, 'a passing thought');
  await check();
  expect(harness.claudeLog().some((e) => e.kind === 'in' && JSON.stringify(e.msg).includes('finish the list'))).toBe(false);
});

test('a Bash step shows the exit code the CLI reported, and says so when it did not report one (D-68)', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  const allow = async (text: string) => {
    await composer(page).fill(text);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page
      .locator('.approval-card')
      .getByRole('button', { name: /Allow once/ })
      .click();
    await expect(transcript(page).getByText(new RegExp(`fake-claude: ${text} \\[command: ran\\]`))).toBeVisible();
    // the turn's steps sit under "Worked for"
    return openCompletedTurnWork(page, text);
  };
  // exit 0: no exit note
  const fine = await allow('RUNCMD fine');
  await expect(fine.getByRole('button', { name: commandStepName('Ran npm test') })).toBeVisible();
  await expect(fine.getByText(/exit \d|exit code unknown/)).toHaveCount(0);
  // "Exit code 3" in the result is the real exit code; the output no longer starts with that header
  const failed = await allow('RUNCMDFAIL one');
  await expect(failed.getByRole('button', { name: commandStepName('Ran npm test · exit 3') })).toBeVisible();
  await failed.getByRole('button', { name: commandStepName('Ran npm test · exit 3') }).click();
  await expect(failed.locator('.shell-exit')).toHaveText('Exit code 3');
  await expect(failed.locator('.shell-out')).toHaveText('2 failing');
  // a failure with no exit code stated is "unknown", not an invented 1
  const timedOut = await allow('RUNCMDTIMEOUT two');
  await expect(timedOut.getByRole('button', { name: commandStepName('Ran npm test · exit code unknown') })).toBeVisible();
  await expect(timedOut.getByRole('button', { name: commandStepName('Ran npm test · exit 1') })).toHaveCount(0);
});

test('a running Bash command streams its output into the command card until the result lands (D-68)', async ({ page, harness }) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  await composer(page).fill('RUNCMDSTREAM go');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page
    .locator('.approval-card')
    .getByRole('button', { name: /Allow once/ })
    .click();
  // the command is still running (fake-claude holds it): the running group's row names the program, as Claude Desktop's
  // does; opening it shows the lines the command printed so far
  await transcript(page)
    .locator('button.claude-activity.expandable')
    .filter({ has: page.locator('.claude-activity-label').getByText(runningCommandName('npm test')) })
    .click();
  const card = transcript(page).locator('.shell-box');
  await expect(card.locator('.shell-out')).toContainText('running suite B');
  await expect(card.locator('.shell-out')).not.toContainText('all passed');
  harness.releaseClaudeCommand();
  await expect(transcript(page).getByText(/fake-claude: RUNCMDSTREAM go \[command: ran\]/)).toBeVisible();
  const completed = await openCompletedTurnWork(page, 'RUNCMDSTREAM go');
  await completed.getByRole('button', { name: commandStepName('Ran npm test') }).click();
  await expect(completed.locator('.shell-out')).toContainText('all passed');
  await expect(completed.locator('.shell-out')).toContainText('running suite A');
});

test('a running loop is named by the program inside it, never by its shell syntax ("Running for i in 1…")', async ({ page, harness }) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  await composer(page).fill('RUNCMDSTREAM LOOP go');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page
    .locator('.approval-card')
    .getByRole('button', { name: /Allow once/ })
    .click();
  // `for i in 1 2 3; do npm test && break; sleep 1; done` with no description: the row names `npm test`, cut
  const label = transcript(page).locator('button.claude-activity.expandable .claude-activity-label');
  await expect(label).toHaveText(runningCommandName('npm test'));
  await expect(label).toHaveText(/…$/);
  harness.releaseClaudeCommand();
  await expect(transcript(page).getByText(/fake-claude: RUNCMDSTREAM LOOP go \[command: ran\]/)).toBeVisible();
});

test('editing the last message rewinds its files and the conversation; Fork chat from here keeps that turn', async ({ page, harness }) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  await send(page, 'first step');
  await send(page, 'second step');

  page.on('dialog', (d) => d.accept());
  const edit = transcript(page).getByRole('button', { name: 'Edit message' });
  await transcript(page).getByText('second step', { exact: true }).hover();
  await expect(edit).toBeEnabled();
  await edit.click();
  await expect(composer(page)).toHaveText('second step');
  await expect(transcript(page).getByText('fake-claude: second step', { exact: true })).toHaveCount(0);
  const rewinds = harness.claudeLog().filter((e: any) => e.kind === 'rewind') as any[];
  expect(rewinds.map((r) => r.dryRun)).toEqual([true, false]);

  await send(page, 'second step, better');
  // the new process resumed just before the edited message
  const last = chatArgv(harness).at(-1)!;
  expect(last.some((a) => a.startsWith('--resume-session-at'))).toBe(true);
  expect(last.find((a) => a.startsWith('--resume-session-at'))).not.toContain(rewinds[0].uuid);

  // fork from the first reply: the new chat ends with that turn
  await transcript(page).getByText('fake-claude: first step', { exact: true }).hover();
  await transcript(page).getByRole('button', { name: 'Fork chat from here' }).first().click();
  await expect(page.getByText('Forked into a new chat')).toBeVisible();
  await expect(transcript(page).getByText('fake-claude: first step', { exact: true })).toBeVisible();
  await expect(transcript(page).getByText('second step, better')).toHaveCount(0);
});

test('a chat from before checkpoints greys out edit with the reason', async ({ page }) => {
  // listed under its project and in Recents (which lists active chats across projects); either opens it
  await expect(sidebar(page).getByText('Old chat', { exact: true })).toHaveCount(2);
  await sidebar(page).getByText('Old chat', { exact: true }).first().click();
  await expect(transcript(page).getByText('fake-claude: an old message', { exact: true })).toBeVisible();
  await transcript(page).getByText('an old message', { exact: true }).hover();
  await expect(transcript(page).getByRole('button', { name: 'Edit message' })).toBeDisabled();
});
