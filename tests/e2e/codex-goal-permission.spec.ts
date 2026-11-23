// A Codex goal runs with the chat's permission (#3502): a thread loaded again falls back to Codex's default sandbox, so a
// Full access chat's goal, set or resumed, has the chat's permission applied before it starts (fake-codex-settings.mjs).
// A permission picked in the composer while the goal runs reaches the round Codex continues with by itself.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';
import { expectGoalRunning, goalCard } from './fixtures/goal';

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
const sidebar = (page: Page) => page.getByRole('complementary');
/** Lets the fake Codex's held (SLOW) turn finish. */
const releaseTurn = (harness: Harness) => fs.writeFileSync(path.join(harness.dir, 'fake-codex.jsonl.release'), '');

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await expect(composer(page)).toHaveText(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

/** The settings each goal run started on, and where the permission update went relative to the goal. */
async function goalRuns(harness: Harness, threadId: string) {
  await expect.poll(() => harness.codexLog().filter((e) => e.method === 'fake/goalRun').length).toBeGreaterThan(0);
  const log = harness.codexLog();
  const update = log.findIndex((e) => e.method === 'thread/settings/update' && e.params.threadId === threadId);
  const goal = log.findIndex((e) => e.method === 'thread/goal/set' && e.params.threadId === threadId && e.params.status === 'active');
  return { runs: log.filter((e) => e.method === 'fake/goalRun').map((e) => e.params), update, goal };
}

test.describe('a Full access chat whose thread Codex loads again', () => {
  test.use({
    seed: {
      uiState: { prefs: { permission: 'full-access' } },
      codexThreads: [
        { id: 'full-thread', name: 'Full access chat', turns: ['earlier work'] },
        { id: 'paused-thread', name: 'Paused goal chat', turns: ['started'], goal: { objective: 'pick it up', status: 'paused' } },
      ],
    },
  });

  test('codex-goal-permission: a goal set in it runs with full access, not the default sandbox', async ({ page, harness }) => {
    await sidebar(page).getByText('Full access chat', { exact: true }).click();
    await send(page, '/goal check the sandbox');
    await expect(transcript(page).getByText('fake-codex: check the sandbox', { exact: true })).toBeVisible();
    const { runs, update, goal } = await goalRuns(harness, 'full-thread');
    expect(update).toBeGreaterThanOrEqual(0);
    expect(update).toBeLessThan(goal);
    expect(runs).toEqual([{ threadId: 'full-thread', sandbox: 'dangerFullAccess', approval: 'never' }]);
  });

  test('codex-goal-permission: a paused goal resumed from its card runs with full access', async ({ page, harness }) => {
    await sidebar(page).getByText('Paused goal chat', { exact: true }).click();
    await (await goalCard(page)).getByRole('button', { name: 'Resume' }).click();
    await expectGoalRunning(page);
    const { runs, update, goal } = await goalRuns(harness, 'paused-thread');
    expect(update).toBeGreaterThanOrEqual(0);
    expect(update).toBeLessThan(goal);
    expect(runs).toEqual([{ threadId: 'paused-thread', sandbox: 'dangerFullAccess', approval: 'never' }]);
  });
});

test.describe('a goal running in an Ask for approval chat', () => {
  test.use({
    seed: {
      uiState: { prefs: { permission: 'default' } },
      codexThreads: [{ id: 'goal-thread', name: 'Running goal chat', turns: ['earlier work'] }],
    },
  });

  test('codex-goal-permission: Full access picked while it runs reaches the round Codex continues with', async ({ page, harness }) => {
    await sidebar(page).getByText('Running goal chat', { exact: true }).click();
    // SLOW holds each round until released; CONTINUE has Codex start a second round by itself
    await send(page, '/goal SLOW CONTINUE push the branch');
    await expectGoalRunning(page);
    const runs = () =>
      harness
        .codexLog()
        .filter((e) => e.method === 'fake/goalRun')
        .map((e) => e.params);
    await expect.poll(() => runs().length).toBe(1);
    await page.getByRole('button', { name: 'Change permissions' }).click();
    await page.locator('.perm-menu .perm-item.full-access').click();
    // applied to the thread while the first round still runs, not at the next message (the chat's choice and the default
    // permission both changed, so it may be sent twice)
    const updates = () =>
      harness
        .codexLog()
        .filter((e) => e.method === 'thread/settings/update' && e.params.threadId === 'goal-thread')
        .map((e) => e.params.sandboxPolicy?.type);
    await expect.poll(() => updates().at(-1)).toBe('dangerFullAccess');
    expect(updates()[0]).toBe('workspaceWrite');
    releaseTurn(harness);
    await expect.poll(() => runs().length).toBe(2);
    expect(runs()).toEqual([
      { threadId: 'goal-thread', sandbox: 'workspaceWrite', approval: 'on-request' },
      { threadId: 'goal-thread', sandbox: 'dangerFullAccess', approval: 'never' },
    ]);
    releaseTurn(harness);
  });
});
