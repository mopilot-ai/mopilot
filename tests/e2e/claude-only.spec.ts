import { archiveSidebarChat } from './fixtures/sidebar';
// A user with only Claude Code installed (no Codex at all): every page and feature that doesn't need
// Codex renders and works against the fake Claude CLI, and what does need Codex says so inline with the
// one action that fixes it. Terminal, file search, worktrees and projects have their own
// Claude-only specs (terminal, file-search, worktrees, projects).
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';
import { createdTaskText } from './fixtures/tasks';
import { openSettingsSection } from './fixtures/settings';

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const sidebar = (page: Page) => page.getByRole('complementary');
const main = (page: Page) => page.getByRole('main');

test.use({ harnesses: 'claude' });

async function pickFolder(h: Harness, rel: string) {
  const folder = path.join(h.dir, 'home', rel);
  fs.mkdirSync(folder, { recursive: true });
  await h.app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as any;
  }, folder);
  return folder;
}

async function menu(h: Harness, label: string) {
  await h.app.evaluate(({ Menu }, label) => {
    const find = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const i of items) {
        if (i.label === label) return i;
        const sub = i.submenu && find(i.submenu.items);
        if (sub) return sub;
      }
    };
    find(Menu.getApplicationMenu()!.items)!.click();
  }, label);
}

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

test('Scheduled: create a task, it runs with Claude Code, Run now starts a chat', async ({ page, harness }) => {
  await expect(composer(page)).toBeVisible();
  await page.getByRole('button', { name: 'Scheduled' }).first().click();
  await expect(page.getByText('This page needs Codex')).toHaveCount(0);
  await page.getByRole('button', { name: 'New task' }).click();
  const dialog = page.getByRole('dialog', { name: 'Schedule a task' });
  await dialog.getByPlaceholder('Instructions...').fill('summarize the repo nightly');
  // a new task defaults to the harness that works
  await dialog.getByRole('button', { name: 'Advanced' }).click();
  await expect(dialog.getByRole('button', { name: 'Run with' })).toContainText('Claude Code');
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByText('Scheduled task saved')).toBeVisible();

  // Claude tasks are stored in MoPilot's automation folder without a Codex app-server.
  const automations = path.join(harness.dir, 'home', '.mopilot', 'automations');
  await expect.poll(() => createdTaskText(automations, 'summarize the repo nightly')).toContain('harness = "claude"');

  await page.locator('.sched-row', { hasText: 'summarize the repo nightly' }).click();
  await page.getByRole('button', { name: 'Run now' }).click();
  await expect(main(page).getByText('fake-claude: summarize the repo nightly', { exact: true })).toBeVisible();
  expect(harness.codexLog()).toEqual([]);
});

test('Files panel: the tree reads the folder without Codex', async ({ page, harness }) => {
  await expect(composer(page)).toBeVisible();
  const folder = await pickFolder(harness, 'work/tree');
  fs.mkdirSync(path.join(folder, 'src'));
  fs.writeFileSync(path.join(folder, 'src', 'inner-file.ts'), 'export {};\n');
  fs.writeFileSync(path.join(folder, 'top-file.md'), '# top\n');
  await sidebar(page).getByRole('button', { name: 'Add a project folder' }).click();
  await expect(sidebar(page).locator('.project-row', { hasText: 'tree' })).toBeVisible();
  await sidebar(page).locator('.project-row', { hasText: 'tree' }).click();
  await menu(harness, 'Toggle Navigation Panel');
  const tree = page.locator('.pane-tab-body:visible');
  await expect(tree.getByText('top-file.md', { exact: true })).toBeVisible();
  await tree.locator('.file-node.dir', { hasText: 'src' }).dispatchEvent('click');
  await expect(tree.getByText('inner-file.ts', { exact: true })).toBeVisible();
});

test('Archive: archive a Claude chat, then find it in Settings → Archived chats', async ({ page, harness }) => {
  await expect(composer(page)).toBeVisible();
  await send(page, 'chat to archive');
  await expect(main(page).getByText('fake-claude: chat to archive', { exact: true })).toBeVisible();
  const row = sidebar(page).getByText('Fake chat title', { exact: true });
  await row.hover();
  await archiveSidebarChat(page, sidebar(page));
  await expect(row).toHaveCount(0);

  await page.getByRole('button', { name: 'Open profile menu' }).click();
  await page.getByRole('menuitem', { name: /^Settings/ }).click();
  await page.locator('.side-row', { hasText: 'Archived chats' }).click();
  await expect(page.getByText('Fake chat title').first()).toBeVisible();
  expect(harness.codexLog()).toEqual([]);
});

test('Plugins: the Claude Code tab lists what Claude Code has; the Codex tab says it needs Codex', async ({ page }) => {
  await expect(composer(page)).toBeVisible();
  await page.getByRole('button', { name: 'Plugins' }).first().click();
  await expect(page.getByText('This page needs Codex')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Plugins', level: 1 })).toBeVisible();
  await page.locator('.ext-harness-tabs').getByRole('button', { name: 'Codex' }).click();
  const note = page.getByRole('status').filter({ hasText: 'Needs Codex' });
  await expect(note.getByRole('button', { name: 'Install Codex' })).toBeVisible();
});

test('Code Review page: pull requests list needs no Codex, and the review runs as a Claude Code chat', async ({ page, harness }) => {
  await expect(composer(page)).toBeVisible();
  await page.getByRole('button', { name: 'Code Review', exact: true }).click();
  await expect(page.getByText('This page needs Codex')).toHaveCount(0);
  await expect(page.getByText(/or review local changes in /)).toBeVisible();
  await page.getByRole('button', { name: /Uncommitted changes/ }).click();
  await page.getByRole('button', { name: 'Start review', exact: true }).click();
  // the sent command, not the "Reviewing with /code-review" step that can still be showing
  await expect(main(page).getByText('/code-review', { exact: true })).toBeVisible();
  expect(harness.codexLog()).toEqual([]);
});

test('Dictate is offered without installing or opening another harness, and voice conversation is not', async ({ page, harness }) => {
  await expect(composer(page)).toBeVisible();
  // dictation is macOS only: the button is hidden where no speech service exists (Linux CI)
  if (process.platform === 'darwin') await expect(page.getByRole('button', { name: 'Dictate', exact: true })).toBeVisible();
  // Claude Code has no native voice conversation: its place holds Send, disabled while the draft is empty
  await expect(page.getByRole('button', { name: 'Voice conversation', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await expect(page.locator('.voice-bar')).toHaveCount(0);
  expect(harness.codexLog()).toEqual([]);
});

test('Settings → Codex: what needs the app-server says so, and the runtime path stays editable', async ({ page }) => {
  await expect(composer(page)).toBeVisible();
  await page.getByRole('button', { name: 'Open profile menu' }).click();
  await page.getByRole('menuitem', { name: /^Settings/ }).click();
  await openSettingsSection(page, 'codex');
  const tabs = page.locator('.settings-tabs');
  const note = main(page).getByRole('status').filter({ hasText: 'Needs Codex' });
  await tabs.getByText('Extensions').click();
  await expect(note).toContainText('plugins, skills, MCP servers and hooks');
  await expect(note.getByRole('button', { name: 'Install Codex' })).toBeVisible();
  await tabs.getByText('Overview').click();
  await expect(note).toContainText('Codex’s models, memory and configuration');
  await expect(main(page).getByText('AGENTS.md', { exact: true })).toBeVisible();
  await tabs.getByText('Advanced').click();
  // which codex runs, and choosing another, is the Version row's menu
  await expect(main(page).getByRole('button', { name: 'Codex CLI options' })).toBeVisible();
  await expect(note).toContainText('configuration and cloud settings');
});
