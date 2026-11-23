// A Claude chat shows one running line (#2332), in the real app against tests/e2e/fixtures/fake-claude.mjs: the user
// sends messages while a turn runs a command, and at no moment does a second running row, status line or clock show.
// The active group moves its one row below the task list, keeping its traces collapsed until opened.
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/app';
import { commandStepName, runningCommandName } from './fixtures/commandStep';
import { openCompletedTurnWork } from './fixtures/turnWork';

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
/** every running line on screen: a running group's row and the status line under the task list */
const RUNNING_LINES = '.claude-activity';
/** Count across both containers as well: one row per container can still duplicate the same turn. */
const ONCE = {
  all: RUNNING_LINES,
  rows: '.work .claude-activity',
  status: '.turn-status-slot .claude-activity',
  clocks: '.claude-activity-time',
};
type Seen = Record<keyof typeof ONCE, { max: number; texts: string[] }>;

test.use({ harnesses: 'claude' });

/** Count the visible rows, status lines and clocks every 50 ms in the page, keeping the most of each seen at once and what they read. */
async function watchRunningLines(page: Page) {
  await page.evaluate((once) => {
    const w = window as unknown as { __lines: Record<string, { max: number; texts: string[] }> };
    w.__lines = Object.fromEntries(Object.keys(once).map((k) => [k, { max: 0, texts: [] }]));
    setInterval(() => {
      for (const [kind, selector] of Object.entries(once)) {
        const shown = [...document.querySelectorAll<HTMLElement>(selector)].filter((e) => e.offsetParent !== null);
        if (shown.length > w.__lines[kind].max)
          w.__lines[kind] = { max: shown.length, texts: shown.map((e) => e.innerText.replace(/\s+/g, ' ')) };
      }
    }, 50);
  }, ONCE);
  return () => page.evaluate(() => (window as unknown as { __lines: Seen }).__lines);
}

/** At most one of each at any moment. */
const atMostOnce = (seen: Seen) =>
  expect(Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, v.max <= 1])), `most at once: ${JSON.stringify(seen)}`).toEqual({
    all: true,
    rows: true,
    status: true,
    clocks: true,
  });

async function sendNow(page: Page, text: string) {
  await composer(page).fill(text);
  await expect(composer(page)).toHaveText(text);
  await composer(page).press('Enter');
}

test('messages sent while a Claude turn runs a command never show a second running line', async ({ page, harness }) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  const seen = await watchRunningLines(page);
  await sendNow(page, 'RUNCMDSTREAM go');
  await page
    .locator('.approval-card')
    .getByRole('button', { name: /Allow once/ })
    .click();
  // the command keeps running (fake-claude holds it): the user writes twice meanwhile
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await sendNow(page, 'also check the tests');
  await expect(transcript(page).getByText('also check the tests', { exact: true })).toBeVisible();
  await sendNow(page, 'and the docs');
  await expect(transcript(page).getByText('and the docs', { exact: true })).toBeVisible();
  // long enough for both clocks the bug showed (the row's from 5 s, the status line's from 2 s)
  await page.waitForTimeout(7000);
  await page.screenshot({ path: test.info().outputPath('while-running.png') });
  // The lower status owns the one row and clock; the transcript has no copy.
  await expect(page.locator(`${ONCE.all}:visible`)).toHaveCount(1);
  await expect(page.locator(`${ONCE.rows}:visible`)).toHaveCount(0);
  await expect(page.locator(`${ONCE.status}:visible`)).toHaveCount(1);
  await expect(page.locator(`${ONCE.clocks}:visible`)).toHaveCount(1);
  await expect(page.locator(`${ONCE.status} ${ONCE.clocks}`)).toBeVisible();

  harness.releaseClaudeCommand();
  await expect(transcript(page).getByText('fake-claude: and the docs', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  atMostOnce(await seen());
});

test.describe('a recent transcript tail whose writer has ended', () => {
  test.use({
    seed: {
      files: ({ home, claudeHome }) => {
        const sessionId = '23322332-1111-4222-8333-444444444444';
        const cwd = path.join(home, 'recent-chat');
        const folder = path.join(claudeHome, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
        fs.mkdirSync(cwd, { recursive: true });
        fs.mkdirSync(folder, { recursive: true });
        const records = [
          { type: 'custom-title', sessionId, customTitle: 'Recent chat' },
          {
            type: 'user',
            uuid: '23322332-1111-4222-8333-555555555555',
            parentUuid: null,
            sessionId,
            cwd,
            isSidechain: false,
            timestamp: new Date().toISOString(),
            message: { role: 'user', content: 'also check the tests' },
          },
          {
            type: 'assistant',
            uuid: '23322332-1111-4222-8333-666666666666',
            parentUuid: '23322332-1111-4222-8333-555555555555',
            sessionId,
            cwd,
            isSidechain: false,
            timestamp: new Date().toISOString(),
            // The writer is explicitly done; an empty reply still leaves the renderer's recent-tail heuristic open.
            message: { id: 'msg-ended', role: 'assistant', content: [{ type: 'text', text: '' }], stop_reason: 'end_turn' },
          },
        ];
        fs.writeFileSync(path.join(folder, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
      },
    },
  });

  test('opening an idle chat closes its recent tail before the next command runs', async ({ page, harness }) => {
    await page.getByRole('complementary').getByRole('button', { name: 'Recent chat', exact: true }).first().click();
    await expect(transcript(page).getByText('also check the tests', { exact: true })).toBeVisible();
    await expect(page.locator(`${RUNNING_LINES}:visible`)).toHaveCount(0);
    const seen = await watchRunningLines(page);
    await sendNow(page, 'RUNCMDSTREAM go');
    await page
      .locator('.approval-card')
      .getByRole('button', { name: /Allow once/ })
      .click();
    await expect(page.locator(`${ONCE.rows}:visible`)).toHaveCount(0);
    await expect(page.locator(`${ONCE.status}:visible`)).toHaveCount(1);
    await page.waitForTimeout(7000);
    await page.screenshot({ path: test.info().outputPath('reopened-tail.png') });
    atMostOnce(await seen());
    harness.releaseClaudeCommand();
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
    await expect(page.locator(`${RUNNING_LINES}:visible`)).toHaveCount(0);
  });
});

test.describe('between-tools activity at 24px', () => {
  test.use({ seed: { uiState: { summaryOpen: true, prefs: { fontSize: 24, zoomLevel: 0 } } } });

  test('between tools the lower row keeps the last step without a duplicate thinking line', async ({ page, harness }, info) => {
    await page.setViewportSize({ width: 1024, height: 682 });
    await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
    const composer = page.getByRole('textbox', { name: 'Message', exact: true });
    await composer.fill('start BGTASK auth');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByRole('main').getByText('fake-claude: start BGTASK auth', { exact: true })).toBeVisible();
    await expect(page.locator('.tasks-count')).toHaveText('1 running task');
    await composer.fill('RUNCMD AFTERTOOLHOLD go');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page
      .locator('.approval-card')
      .getByRole('button', { name: /Allow once/ })
      .click();
    const transcript = page.getByRole('main');
    const row = transcript.locator('.turn-status-slot .claude-activity');
    await expect(row).toHaveCount(1);
    await expect(row.locator('.working-mark')).toHaveAttribute('data-activity', 'think');
    await expect(row.locator('.claude-activity-label')).toHaveText(runningCommandName('npm test'));
    await expect(row.locator('.claude-activity-time')).toBeVisible();
    await expect(row).toBeInViewport();
    await expect(transcript.locator('.claude-activity')).toHaveCount(1);
    await expect(transcript.locator('.claude-activity-time')).toHaveCount(1);
    await expect(transcript.locator('.work .claude-activity')).toHaveCount(0);
    await expect(transcript.locator('.work .claude-activity-thinking')).toHaveCount(0);
    await expect(page.getByText(/Still waiting on/)).toHaveCount(0);
    const count = transcript.locator('.claude-step-head > .tasks-count-inline .tasks-count');
    await expect(count).toHaveText('1 running task');
    await expect(count).toBeInViewport();
    await expect(row.locator('.tasks-count')).toHaveCount(0);
    await row.click();
    await expect(row).toHaveAttribute('aria-expanded', 'true');
    await expect(transcript.getByRole('button', { name: commandStepName('Ran npm test') })).toBeVisible();
    await count.click();
    await expect(page.locator('.task-card.running', { hasText: 'Explore auth' })).toBeVisible();
    await page.screenshot({ path: info.outputPath('one-running-line.png') });
    harness.releaseClaudeCommand();
    await expect(transcript.getByText(/fake-claude: RUNCMD AFTERTOOLHOLD go \[command: ran\]/)).toBeVisible();
    await expect(transcript.locator('.claude-activity')).toHaveCount(0);
    const completed = await openCompletedTurnWork(page, 'RUNCMD AFTERTOOLHOLD go');
    await expect(completed.getByRole('button', { name: commandStepName('Ran npm test') })).toBeVisible();
  });
});
