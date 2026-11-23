// Settings › MoMo › Sources › Coding tools (#2999 C0): a stdio MCP server configured for Claude Code (tests/fixtures/mcp/notes-server.cjs in the run's .claude.json) is listed and off; Allow starts it as MoMo's own client and lists its tools: the one that says it only reads is on, the change is off and marked as asking each time; a tool turned on and off; Remove takes it back out. Each state is saved as a screenshot (coding-tools-<n>-<state>.png) in the test's output folder. MoMo calling the tools is the unit tests' (tests/momoMcpProxy.test.ts).
import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { goToMomoSettings, momoSetupDone, openMomo } from './fixtures/momo';

const SERVER = path.resolve(__dirname, '../fixtures/mcp/notes-server.cjs');
const card = (page: Page): Locator => page.getByRole('region', { name: 'notes', exact: true });
const status = (c: Locator) => c.locator('[data-status]');

test.describe('Settings › MoMo › Sources › Coding tools', () => {
  test.use({ harnesses: 'claude', env: { MOPILOT_MOMO_DEV: '1' }, seed: { ...momoSetupDone } });

  test('a Claude Code MCP server is allowed into MoMo, its tools set, and removed', async ({ page, harness }, testInfo) => {
    let n = 0;
    const shot = (state: string) =>
      page.screenshot({ path: testInfo.outputPath(`coding-tools-${String(++n).padStart(2, '0')}-${state}.png`) });
    // the run's Claude Code config folder (the app reads its .claude.json there, as the CLI does)
    const claudeHome = harness.env.CLAUDE_CONFIG_DIR;
    expect(claudeHome).toBeTruthy();
    const config = path.join(claudeHome!, '.claude.json');
    const prior = fs.existsSync(config) ? JSON.parse(fs.readFileSync(config, 'utf8')) : {};
    fs.mkdirSync(claudeHome!, { recursive: true });
    fs.writeFileSync(config, JSON.stringify({ ...prior, mcpServers: { notes: { command: process.execPath, args: [SERVER], env: {} } } }));
    await openMomo(page);
    await goToMomoSettings(page, 'Sources');
    const notes = card(page);
    await expect(status(notes)).toHaveText('Let MoMo use its tools. Only tools that say they only read start on.', { timeout: 20_000 });
    await notes.getByText('Details').click();
    await expect(notes.getByText('Claude Code', { exact: true })).toBeVisible();
    await shot('off');

    await notes.getByRole('button', { name: 'Allow', exact: true }).click();
    await expect(status(notes)).toHaveText('MoMo can use 2 of its 3 tools.', { timeout: 30_000 });
    await expect(notes.locator('.hp-badge.ok')).toHaveText('Allowed');
    const tools = notes.getByRole('list', { name: 'notes tools' });
    await expect(tools.getByRole('listitem')).toHaveCount(3);
    await expect(tools.getByRole('checkbox', { name: /notes_list/ })).toBeChecked();
    await expect(tools.getByRole('checkbox', { name: /notes_add/ })).not.toBeChecked();
    await expect(tools.getByRole('listitem').filter({ hasText: 'notes_add' })).toContainText('asks each time');
    await expect(tools.getByRole('listitem').filter({ hasText: 'notes_list' })).toContainText('says it only reads');
    await shot('allowed');

    // the switch shows main's state: it flips once the list is read again, so click and wait for it
    await tools.getByRole('checkbox', { name: /notes_add/ }).click();
    await expect(tools.getByRole('checkbox', { name: /notes_add/ })).toBeChecked();
    await expect(status(notes)).toHaveText('MoMo can use 3 of its 3 tools.');
    await tools.getByRole('checkbox', { name: /notes_list/ }).click();
    await expect(tools.getByRole('checkbox', { name: /notes_list/ })).not.toBeChecked();
    await expect(status(notes)).toHaveText('MoMo can use 2 of its 3 tools.');
    await shot('tools-set');

    await notes.getByRole('button', { name: 'Remove from MoMo', exact: true }).click();
    await expect(status(notes)).toHaveText('Let MoMo use its tools. Only tools that say they only read start on.');
    await expect(notes.getByRole('button', { name: 'Allow', exact: true })).toBeVisible();
    await shot('removed');
  });
});
