// Settings → Claude Code: the user-level CLAUDE.md is edited and saved through main, with no Codex installed.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { settingsEntry } from './fixtures/settings';

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });

test.use({ harnesses: 'claude' });

test('edit and save CLAUDE.md in Settings without Codex', async ({ page, harness }) => {
  // CLAUDE_CONFIG_DIR points at <home>/.claude, where the CLI reads it
  const file = path.join(harness.dir, 'home', '.claude', 'CLAUDE.md');
  fs.writeFileSync(file, 'Existing rule.\n');
  await expect(composer(page)).toBeVisible();

  await page.locator('.sidebar-title').first().click();
  await settingsEntry(page).click();
  await page.locator('.side-row', { hasText: 'Claude Code' }).click();
  // CLAUDE.md is on the Overview, its editor behind Edit
  await page.locator('.settings-row', { hasText: 'CLAUDE.md' }).getByRole('button', { name: 'Edit' }).click();
  const editor = page.getByRole('textbox', { name: 'Edit CLAUDE.md' });
  await expect(editor).toHaveValue('Existing rule.\n');
  const save = page.locator('.settings-actions').getByRole('button', { name: 'Save' });
  await expect(save).toBeDisabled();

  await editor.fill('Existing rule.\nPrefer small, reviewable diffs.\n');
  await save.click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  await expect(save).toBeDisabled();
  expect(fs.readFileSync(file, 'utf8')).toBe('Existing rule.\nPrefer small, reviewable diffs.\n');
  await expect(page.getByText("Couldn't connect to Codex")).toHaveCount(0);
});
