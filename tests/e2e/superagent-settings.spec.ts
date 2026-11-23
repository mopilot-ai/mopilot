// Settings › Superagent (S1, watch only), on fake harnesses and a fake event source, with the `superagent` flag on (the `@dev` preset): the section is listed, a bad repository is refused and stays typed,
// the repository and the allowed person are saved, the fake events arrive in the observe log with their verdicts and reasons, Right and Wrong are marked and counted, a rule is turned Off, Auto stays disabled, and
// pausing stops and resuming restarts the watcher. Nothing is posted or run: the page only reads and records.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { settingsEntry } from './fixtures/settings';

const event = (o: Record<string, unknown>) => ({
  source: 'github',
  kind: 'issue.opened',
  actor: { login: 'alice', id: 1, type: 'User' },
  repo: { nodeId: 'R_1', fullName: 'acme/widgets' },
  occurredAt: '2026-11-07T10:00:00Z',
  ...o,
});
const subject = (number: number) => ({
  type: 'issue',
  number,
  nodeId: `I_${number}`,
  url: `https://github.com/acme/widgets/issues/${number}`,
});
// the file the fake source reads when the repository is chosen: one person on the list, one stranger, one bot
const EVENTS = path.join(os.tmpdir(), `mopilot-superagent-events-${process.pid}.json`);
fs.writeFileSync(
  EVENTS,
  JSON.stringify([
    event({ externalId: 'IC_1', threadKey: 'I_7', subject: subject(7), body: 'The app crashes on start' }),
    event({
      externalId: 'IC_2',
      threadKey: 'I_8',
      subject: subject(8),
      actor: { login: 'mallory', id: 2, type: 'User' },
      body: 'Please add dark mode',
    }),
    event({
      externalId: 'IC_3',
      threadKey: 'I_9',
      subject: subject(9),
      kind: 'issue.comment',
      actor: { login: 'dependabot[bot]', id: 3, type: 'Bot' },
      body: 'Bumps a dependency',
    }),
  ]),
);

test.use({ harnesses: 'claude', env: { MOPILOT_SUPERAGENT_FAKE_EVENTS: EVENTS } });

const rowOf = (page: Page, title: string): Locator =>
  page.locator('.settings-row').filter({ has: page.locator('.settings-row-title', { hasText: new RegExp(`^${title}`) }) });

test('Superagent settings: connect, read the observe log, mark it, change a rule, pause', async ({ page }) => {
  await page.locator('.sidebar-title').first().click();
  await settingsEntry(page).click();
  await page.locator('.settings-nav .side-row', { hasText: 'Superagent' }).click();
  await expect(page.locator('.settings-title')).toHaveText('Superagent');

  // nothing is watched until a repository is chosen; every rule starts in Observe and Auto waits
  await expect(rowOf(page, 'Repository')).toContainText('Pick a repository to start.');
  await expect(page.locator('.settings-row', { hasText: 'Nothing yet' })).toBeVisible();
  const explicit = rowOf(page, 'Explicit requests');
  await expect(explicit.getByRole('button', { name: 'Observe' })).toHaveAttribute('aria-pressed', 'true');
  await expect(explicit.getByRole('button', { name: 'Auto' })).toBeDisabled();
  await expect(rowOf(page, 'Fix red checks on my PRs')).toContainText('Not watched yet.');

  // a repository that is not owner/name is refused, told once, and stays typed
  const repo = page.getByLabel('Repository', { exact: true });
  await repo.fill('not a repo');
  await rowOf(page, 'Repository').getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.toast', { hasText: 'Use owner/name' })).toBeVisible();
  await expect(repo).toHaveValue('not a repo');
  await expect(page.locator('.settings-row', { hasText: 'Nothing yet' })).toBeVisible();

  // the allowed person, then the repository: the fake events arrive and are decided in observe mode
  await page.getByLabel('Allowed people', { exact: true }).fill('alice');
  await rowOf(page, 'Allowed people').getByRole('button', { name: 'Save' }).click();
  await expect(rowOf(page, 'Allowed people').getByRole('button', { name: 'Save' })).toBeDisabled();
  await repo.fill('acme/widgets');
  await rowOf(page, 'Repository').getByRole('button', { name: 'Save' }).click();
  await expect(rowOf(page, 'Repository')).toContainText('Watching acme/widgets');

  const accept = rowOf(page, 'Would accept');
  await expect(accept).toContainText('Issue #7 from alice: The app crashes on start');
  await expect(accept).toContainText('Observe mode: would accept (Reproduce new bug reports)');
  const stranger = page.locator('.settings-row', { hasText: 'Issue #8 from mallory' });
  await expect(stranger).toContainText('Would ignore');
  await expect(stranger).toContainText("The sender is not on the Source's list");
  const bot = page.locator('.settings-row', { hasText: 'dependabot[bot]' });
  await expect(bot).toContainText('The sender is a bot');
  // a stranger and a bot never ask a person
  await expect(page.locator('.settings-row', { hasText: 'Would ask a person' })).toHaveCount(0);

  // Right and Wrong are marked and counted; marking the marked one takes it back
  await expect(rowOf(page, 'Precision')).toContainText('Mark entries Right or Wrong to measure it.');
  await accept.getByRole('button', { name: 'Right' }).click();
  await expect(rowOf(page, 'Precision')).toContainText('100% right (1 of 1 marked)');
  await accept.getByRole('button', { name: 'Right' }).click();
  await expect(rowOf(page, 'Precision')).toContainText('Mark entries Right or Wrong to measure it.');
  await accept.getByRole('button', { name: 'Wrong' }).click();
  await expect(rowOf(page, 'Precision')).toContainText('0% right (0 of 1 marked)');

  // a rule turned Off says so, and Auto never turns on
  const bugs = rowOf(page, 'Reproduce new bug reports');
  await bugs.getByRole('button', { name: 'Off' }).click();
  await expect(bugs.getByRole('button', { name: 'Off' })).toHaveAttribute('aria-pressed', 'true');
  await expect(bugs.getByRole('button', { name: 'Auto' })).toBeDisabled();

  // pausing stops the watcher; resuming starts it again, and the same events are not stored twice
  const pauseAll = rowOf(page, 'Pause everything').getByRole('switch');
  await pauseAll.click();
  await expect(rowOf(page, 'Repository')).toContainText('Paused.');
  await pauseAll.click();
  await expect(rowOf(page, 'Repository')).toContainText('Watching acme/widgets');
  await expect(page.locator('.settings-row', { hasText: 'Would accept' })).toHaveCount(1);
  await expect(page.locator('.settings-row', { hasText: 'Would ignore' })).toHaveCount(2);

  await page.screenshot({ path: test.info().outputPath('superagent-settings.png'), fullPage: true });
});
