// Extensions (WP7-13): Claude Code's MCP form runs `claude mcp add --scope user` after showing it,
// plugins open the CLI in a terminal, hooks are listed read-only; the Plugins page has a tab per harness. Against the fake Claude CLI and the fake Codex.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { settingsEntry } from './fixtures/settings';

async function openSettings(page: Page, item: string, tab: string) {
  await page.locator('.sidebar-title').first().click();
  await settingsEntry(page).click();
  await page.locator('.side-row', { hasText: item }).first().click();
  await page.locator('.settings-tabs').getByText(tab, { exact: true }).click();
}

test.describe('Claude Code', () => {
  test.use({
    harnesses: 'claude',
    seed: {
      files: (d) => {
        fs.mkdirSync(d.claudeHome, { recursive: true });
        fs.writeFileSync(
          path.join(d.claudeHome, 'settings.json'),
          JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './audit.sh' }] }] } }),
        );
      },
    },
  });

  test('MCP form previews the command, then runs it; hooks are listed; plugins open the terminal', async ({ page, harness }) => {
    await openSettings(page, 'Claude Code', 'Extensions');

    await page.getByRole('button', { name: 'Add server' }).first().click();
    await page.getByRole('textbox', { name: 'MCP server name' }).fill('notes');
    const preview = page.getByLabel('Command preview');
    await expect(preview).toContainText('Enter the command to run');
    await page.getByRole('textbox', { name: 'MCP command' }).fill('npx');
    await page.getByRole('textbox', { name: 'MCP arguments' }).fill('-y notes-server');
    await expect(preview).toHaveText('claude mcp add --scope user notes -- npx -y notes-server');
    // nothing ran yet
    expect(harness.claudeLog().some((e) => e.kind === 'argv' && e.argv[0] === 'mcp')).toBe(false);
    await page.getByRole('button', { name: 'Add server' }).last().click();
    await expect
      .poll(() => harness.claudeLog().find((e) => e.kind === 'argv' && e.argv[0] === 'mcp')?.['argv'])
      .toEqual(['mcp', 'add', '--scope', 'user', 'notes', '--', 'npx', '-y', 'notes-server']);

    // hooks from settings.json, read-only, with a way to open the file
    const hooks = page.locator('.settings-group', { hasText: 'Hooks' });
    await expect(hooks).toContainText('PreToolUse');
    await expect(hooks).toContainText('./audit.sh · matcher Bash');
    await expect(hooks.getByRole('button', { name: 'Open settings.json' })).toBeVisible();
    await expect(hooks.getByRole('switch')).toHaveCount(0);

    // plugins: the claude plugin command is typed into the embedded terminal, not run
    await page.getByRole('button', { name: 'Install with claude plugin…' }).click();
    await expect(page.locator('.term-view')).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.body.innerText)).toContain('claude plugin');
  });

  test('Plugins page: All harnesses first, then a tab per harness for its own catalog', async ({ page }) => {
    await page.getByRole('button', { name: 'Plugins' }).first().click();
    const tabs = page.locator('.ext-harness-tabs .segmented button');
    await expect(tabs).toHaveText(['All harnesses', 'Codex', 'Claude Code']);
    await expect(page.locator('.ext-harness-tabs .segmented button.on')).toHaveText('All harnesses');
    await tabs.filter({ hasText: 'Claude Code' }).click();
    await expect(page.locator('.ext-harness-tabs .segmented button.on')).toHaveText('Claude Code');
    await expect(page.getByRole('button', { name: 'Install with claude plugin…' })).toBeVisible();
  });
});
