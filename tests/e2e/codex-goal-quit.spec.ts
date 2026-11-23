// Codex goals across quit and restart (WP5-4, A3, A20): quitting pauses an active goal and stops its
// turn; the chat shows it paused at quit after the restart and nothing carries on by itself. A goal a
// crashed run left active is paused before its thread is loaded again.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';
import { expectGoalRunning, goalCard } from './fixtures/goal';

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
const sidebar = (page: Page) => page.getByRole('complementary');

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await expect(composer(page)).toHaveText(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}
const goalStore = (h: Harness) => JSON.parse(fs.readFileSync(path.join(h.dir, 'userData', 'codex-goals.json'), 'utf8'));

test('codex-goal-quit: quitting pauses the goal and stops its turn; after a restart it shows paused at quit', async ({ page, harness }) => {
  await expect(home(page)).toBeVisible();
  await send(page, '/goal keep at it SLOW');
  await expect(transcript(page).getByText('fake-codex: keep at it SLOW', { exact: true })).toBeVisible();
  await expectGoalRunning(page);
  const threadId = harness.codexLog().find((e) => e.method === 'thread/goal/set')!.params.threadId as string;

  await harness.quit();
  const log = harness.codexLog();
  const paused = log.findIndex((e) => e.method === 'thread/goal/set' && e.params.status === 'paused');
  const interrupt = log.findIndex((e) => e.method === 'turn/interrupt');
  expect(paused).toBeGreaterThanOrEqual(0);
  expect(log[paused].params.threadId).toBe(threadId);
  expect(interrupt).toBeGreaterThan(paused);
  expect(goalStore(harness)[threadId]).toMatchObject({ status: 'paused', reason: 'quit', objective: 'keep at it SLOW' });

  await harness.relaunch();
  const p = harness.page;
  const before = harness.codexLog().length;
  await sidebar(p)
    .getByText(/^(keep at it SLOW|Fake chat title)$/)
    .first()
    .click();
  await expect(await goalCard(p)).toContainText('Paused when MoPilot quit');
  await expect((await goalCard(p)).getByRole('button', { name: 'Resume' })).toBeVisible();
  // nothing set it going again
  await p.waitForTimeout(500);
  const after = harness.codexLog().slice(before);
  expect(after.some((e) => e.method === 'thread/goal/set' && e.params.status === 'active')).toBe(false);
  expect(after.some((e) => e.method === 'turn/start')).toBe(false);

  // resuming by hand is a plain resume; the quit note goes
  await (await goalCard(p)).getByRole('button', { name: 'Resume' }).click();
  await expectGoalRunning(p);
  await expect.poll(() => goalStore(harness)[threadId]?.reason ?? null).toBe(null);
});

test.describe('a goal a crashed run left active', () => {
  test.use({
    seed: {
      codexThreads: [
        { id: 'goal-thread', name: 'Left running', turns: ['start it'], goal: { objective: 'carry on alone', status: 'active' } },
      ],
      userData: { 'codex-goals.json': { 'goal-thread': { status: 'active', objective: 'carry on alone' } } },
    },
  });

  test('codex-goal-quit: is paused before its thread is resumed, so it never carries on by itself', async ({ page, harness }) => {
    await sidebar(page).getByText('Left running', { exact: true }).click();
    await expect(await goalCard(page)).toContainText('Paused when MoPilot quit');
    // a new message loads the thread for writing: the goal is already paused, so only the message runs
    await send(page, 'next step');
    await expect(transcript(page).getByText('fake-codex: next step', { exact: true })).toBeVisible();
    await page.waitForTimeout(300);
    await expect(transcript(page).getByText('fake-codex: carry on alone', { exact: true })).toHaveCount(0);
    const log = harness.codexLog();
    const paused = log.findIndex(
      (e) => e.method === 'thread/goal/set' && e.params.threadId === 'goal-thread' && e.params.status === 'paused',
    );
    const resumed = log.findIndex((e) => e.method === 'thread/resume' && e.params.threadId === 'goal-thread');
    expect(paused).toBeGreaterThanOrEqual(0);
    expect(resumed).toBeGreaterThan(paused);
  });
});
