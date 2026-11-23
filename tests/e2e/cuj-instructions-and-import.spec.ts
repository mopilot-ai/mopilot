// CUJ instructions-and-import on both harnesses: each harness's user-level instruction file is edited and saved from
// Settings (AGENTS.md for Codex, CLAUDE.md for Claude Code), Claude Code's `/init` goes to the CLI as typed, and Codex
// detects Claude Code's setup and imports it (Claude Code itself has nothing to import: it reads ~/.claude).
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';
import { openHarnessList } from './fixtures/harnessPicker';
import { settingsEntry } from './fixtures/settings';

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });

async function openHarnessTab(page: Page, harness: 'Codex' | 'Claude Code', tab: string) {
  await page.locator('.sidebar-title').first().click();
  await settingsEntry(page).click();
  await page.locator('.side-row', { hasText: harness }).first().click();
  await page.locator('.settings-tabs').getByText(tab, { exact: true }).click();
}
async function editAndSave(page: Page, file: string, name: string, before: string, after: string) {
  const editor = page.getByRole('textbox', { name });
  await expect(editor).toHaveValue(before);
  const save = page.locator('.settings-actions').getByRole('button', { name: 'Save' });
  await expect(save).toBeDisabled();
  await editor.fill(after);
  await save.click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  await expect(save).toBeDisabled();
  expect(fs.readFileSync(file, 'utf8')).toBe(after);
}
const userTexts = (h: Harness) =>
  h
    .claudeLog()
    .filter((e) => e.kind === 'in' && e.msg?.type === 'user')
    .map((e) => {
      const c = (e as any).msg.message.content;
      return typeof c === 'string' ? c : c.map((b: any) => b.text ?? '').join('');
    });

test.use({ harnesses: 'both' });

test('instructions-and-import on Codex: edit and save AGENTS.md, detect Claude Code setup and import it', async ({ page, harness }) => {
  const agents = path.join(harness.dir, 'home', '.codex', 'AGENTS.md');
  await expect(home(page)).toBeVisible();
  fs.writeFileSync(agents, 'Always run the tests.\n');
  // instructions are on the Overview, the editor behind Edit
  await openHarnessTab(page, 'Codex', 'Overview');
  await page.locator('.settings-row', { hasText: 'AGENTS.md' }).getByRole('button', { name: 'Edit' }).click();
  await editAndSave(page, agents, 'Edit AGENTS.md', 'Always run the tests.\n', 'Always run the tests.\nKeep commits small.\n');

  // Extensions → Import: what another app left is offered, and importing it hands the items to Codex
  await page.locator('.settings-tabs').getByText('Extensions', { exact: true }).click();
  const group = page.locator('.settings-group', { hasText: 'Import to Codex' });
  const row = group.locator('.settings-row', { hasText: 'Claude Code' });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Import' }).click();
  await expect(page.getByText('Imported from Claude Code')).toBeVisible();
  await expect(group.getByText('Nothing to import')).toBeVisible();
  const imported = harness.codexLog().filter((e) => e.method === 'externalAgentConfig/import');
  expect(imported).toHaveLength(1);
  expect(imported[0].params.migrationItems).toEqual([expect.objectContaining({ itemType: 'AGENTS_MD' })]);
  // the sync switch now has a source to keep in sync
  await expect(page.locator('.settings-row', { hasText: 'Content to sync' })).toContainText('Syncing one source');
});

test('instructions-and-import on Claude Code: edit and save CLAUDE.md, /init goes to the CLI as typed, nothing to import', async ({
  page,
  harness,
}) => {
  const claudeMd = path.join(harness.dir, 'home', '.claude', 'CLAUDE.md');
  fs.writeFileSync(claudeMd, 'Existing rule.\n');
  await expect(home(page)).toBeVisible();
  await openHarnessTab(page, 'Claude Code', 'Overview');
  await page.locator('.settings-row', { hasText: 'CLAUDE.md' }).getByRole('button', { name: 'Edit' }).click();
  await editAndSave(page, claudeMd, 'Edit CLAUDE.md', 'Existing rule.\n', 'Existing rule.\nPrefer small, reviewable diffs.\n');
  // the Extensions tab has no import: Claude Code reads ~/.claude itself
  await page.locator('.settings-tabs').getByText('Extensions', { exact: true }).click();
  await expect(page.getByText('Import to Codex')).toHaveCount(0);
  await page.locator('.side-row', { hasText: 'Back to app' }).click();

  // /init in a Claude chat is Claude's own command: it reaches the CLI exactly as typed
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: 'Claude Code' }).click();
  await page.locator('.hp-models .menu-item', { hasText: 'Fake Sonnet' }).click();
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill('/init');
  await expect(composer).toHaveText('/init');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => userTexts(harness)).toContain('/init');
  await expect(page.getByRole('main').getByText('fake-claude: /init', { exact: true })).toBeVisible();
});

test('instructions-and-import on Claude Code: /init offers to read an existing AGENTS.md and adds @AGENTS.md to CLAUDE.md after it ran', async ({
  page,
  harness,
}) => {
  const cwd = path.join(harness.dir, 'home');
  fs.writeFileSync(path.join(cwd, 'AGENTS.md'), 'Run npm test.\n');
  fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), '# Project\n');
  await expect(home(page)).toBeVisible();
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: 'Claude Code' }).click();
  await page.locator('.hp-models .menu-item', { hasText: 'Fake Sonnet' }).click();
  const dialogs: string[] = [];
  page.on('dialog', (d) => {
    dialogs.push(d.message());
    void d.accept();
  });
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill('/init');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => userTexts(harness)).toContain('/init');
  await expect(page.getByRole('main').getByText('fake-claude: /init', { exact: true })).toBeVisible();
  expect(dialogs).toEqual(['AGENTS.md exists · Let Claude Code read it too (adds one line to CLAUDE.md)']);
  // the line goes in after the turn, once
  await expect.poll(() => fs.readFileSync(path.join(cwd, 'CLAUDE.md'), 'utf8')).toBe('# Project\n\n@AGENTS.md\n');
});
