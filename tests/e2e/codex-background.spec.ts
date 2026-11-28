// Codex background terminals and sub-agents in the real app (WP5-7, A5) against fake-codex.mjs: a
// command left running is listed and stopped by its processId (its osPid is unknown); a spawned
// sub-agent's thread opens beside the chat, read-only.
// e2e-covers: src/components/panels/SummaryBackgroundTasks.tsx src/components/panels/SummaryAgentTranscripts.tsx src/components/tasks/TaskList.tsx
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
// the rail's Background tasks section: a running task's row opens the tasks pane
const exposeTasks = (page: Page) => page.locator('.summary-background-tasks .summary-task .summary-row').first().click();

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await expect(composer(page)).toHaveText(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(transcript(page).getByText(`fake-codex: ${text}`, { exact: true })).toBeVisible();
}

test('codex-background: a background terminal is listed with Stop, and stopping it ends it', async ({ page, harness }) => {
  await expect(home(page)).toBeVisible();
  await send(page, 'start the server BGTERM');
  await exposeTasks(page);
  const running = page.locator('.tasks-tab .task-card.running');
  await expect(running).toContainText('sleep 300');
  await running.getByRole('button', { name: 'Stop sleep 300' }).click();
  await expect(running).toHaveCount(0);
  const stop = harness.codexLog().find((e) => e.method === 'thread/backgroundTerminals/terminate')!;
  expect(stop.params).toMatchObject({ processId: '4242' });
});

test("codex-subagent: a spawned agent's thread opens beside the chat, read-only", async ({ page }) => {
  await expect(home(page)).toBeVisible();
  await send(page, 'check it SPAWN');
  await transcript(page)
    .getByRole('button', { name: /^Worked/ })
    .click();
  // A finished agent folds into "Worked", in its agent group.
  const group = transcript(page).locator('.agent-group-head');
  await expect(group).toBeVisible();
  // a finished agent leaves the rail's Background tasks, as Claude Desktop's; its transcript opens from the conversation
  // The conversation can also open the read-only agent transcript.
  if ((await group.getAttribute('aria-expanded')) !== 'true') await group.click();
  await transcript(page).locator('.agent-row', { hasText: 'look at the tests' }).click();
  await expect(page.locator('.agent-page')).toContainText('fake-codex sub-agent: the tests pass');
  // only the chat's own composer: the sub-agent's thread takes no messages
  await expect(composer(page)).toHaveCount(1);
  await expect(page.getByText('Another Codex app is working on this chat.')).toHaveCount(0);
});
