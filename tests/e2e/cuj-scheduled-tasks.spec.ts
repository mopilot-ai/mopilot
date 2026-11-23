// CUJ scheduled-tasks on both harnesses: open Scheduled, start from a template, write a task with a repeat rule and a
// harness, save it (the automation file the fake Codex holds), Run now starts the chat with the prompt on that harness
// and lists the run, Pause and Resume, and edit the saved task.
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';
import { createdTaskText } from './fixtures/tasks';

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const transcript = (page: Page) => page.getByRole('main');

const taskText = (h: Harness, name: string, key: 'codex' | 'claude') =>
  createdTaskText(path.join(h.dir, 'home', key === 'codex' ? '.codex' : '.mopilot', 'automations'), name);

async function pick(page: Page, label: string, option: string) {
  await page
    .getByRole('dialog', { name: /Schedule a task|Edit task/ })
    .getByRole('button', { name: label })
    .click();
  // matched by its title: a Run with item also carries where else the task runs ("Also runs in the Codex app")
  await page
    .getByRole('menuitemcheckbox')
    .filter({ has: page.locator('.menu-title', { hasText: new RegExp(`^${option}$`) }) })
    .or(page.getByRole('menuitemcheckbox', { name: option, exact: true }))
    .click();
}

async function journey(page: Page, harness: Harness, who: 'Codex' | 'Claude Code', fake: string, key: 'codex' | 'claude') {
  await expect(home(page)).toBeVisible();
  await page.getByRole('button', { name: 'Scheduled' }).first().click();
  await expect(page.getByText('No scheduled tasks')).toBeVisible();

  // start from a template: the dialog opens filled in
  await page.locator('.sched-template', { hasText: 'Weekly finances update' }).click();
  const dialog = page.getByRole('dialog', { name: 'Schedule a task' });
  await expect(dialog.getByPlaceholder('Instructions...')).toHaveValue(/Review my recent spending/);
  await expect(dialog.getByRole('button', { name: 'Repeat schedule' })).toContainText('Weekly');

  // make it ours: the template's name stays, the instructions change, repeat daily, and the harness to run with
  await dialog.getByPlaceholder('Instructions...').fill('tidy up the notes folder');
  await pick(page, 'Repeat schedule', 'Daily');
  await dialog.getByRole('button', { name: 'Advanced' }).click();
  await pick(page, 'Run with', who);
  await dialog.getByRole('switch', { name: 'Start each run in new chat' }).click();
  await dialog
    .getByRole('button', { name: /^Save|Create|Schedule$/ })
    .last()
    .click();
  await expect(page.getByText('Scheduled task saved')).toBeVisible();

  // The saved task is listed and stored in its harness's automation folder.
  const row = page.locator('.sched-row', { hasText: 'Weekly finances update' });
  await expect(row).toBeVisible();
  await expect(page.locator('.task-detail')).toContainText(who);
  await expect(page.locator('.task-detail')).toContainText('Every day');
  await expect.poll(() => taskText(harness, 'Weekly finances update', key)).toContain(`harness = "${key}"`);
  expect(taskText(harness, 'Weekly finances update', key)).toContain('FREQ=DAILY');

  // Run now starts a chat with the prompt on that harness
  await page.getByRole('button', { name: 'Run now' }).click();
  await expect(transcript(page).getByText(`${fake}: tidy up the notes folder`, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Scheduled' }).first().click();
  await row.click();
  await expect(page.locator('.task-detail').getByText('Fake chat title')).toBeVisible();

  // Pause, then Resume
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(row.getByText('Paused')).toBeVisible();
  await expect.poll(() => taskText(harness, 'Weekly finances update', key)).toContain('status = "PAUSED"');
  await page.getByRole('button', { name: 'Resume' }).click();
  await expect.poll(() => taskText(harness, 'Weekly finances update', key)).toContain('status = "ACTIVE"');

  // edit: the dialog has the saved values, and a change is saved to the same file
  await page.getByRole('button', { name: 'Task actions' }).click();
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  const edit = page.getByRole('dialog', { name: 'Schedule a task' });
  await expect(edit.getByPlaceholder('Instructions...')).toHaveValue('tidy up the notes folder');
  await edit.getByPlaceholder('Instructions...').fill('tidy up the notes folder and the downloads');
  await edit.getByRole('button', { name: /^Save/ }).last().click();
  await expect.poll(() => taskText(harness, 'Weekly finances update', key)).toContain('downloads');
  expect(taskText(harness, 'Weekly finances update', key)).toContain(`harness = "${key}"`);
}

test.use({ harnesses: 'both' });

test('scheduled-tasks on Codex: template, new task, Run now, Pause and Resume, edit', async ({ page, harness }) => {
  await journey(page, harness, 'Codex', 'fake-codex', 'codex');
});

test('scheduled-tasks on Claude Code: template, new task, Run now, Pause and Resume, edit', async ({ page, harness }) => {
  await journey(page, harness, 'Claude Code', 'fake-claude', 'claude');
});
