// CUJ configure-mcp on both harnesses: add an MCP server from Settings, see it listed and connected, turn it off and
// on (Codex), change it, and remove it. Codex writes `mcp_servers.<name>` into config.toml through the app-server;
// Claude Code shows the exact `claude mcp add --scope user` command first and runs it only on the button.
import type { Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';
import { settingsEntry } from './fixtures/settings';

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });

async function openExtensions(page: Page, harness: 'Codex' | 'Claude Code') {
  await page.locator('.sidebar-title').first().click();
  await settingsEntry(page).click();
  await page.locator('.side-row', { hasText: harness }).first().click();
  await page.locator('.settings-tabs').getByText('Extensions', { exact: true }).click();
}
/** The config writes the fake Codex got, as [key path, value]. */
const writes = (h: Harness) =>
  h
    .codexLog()
    .filter((e) => e.method === 'config/value/write')
    .map((e) => [e.params.keyPath, e.params.value] as const);
const claudeMcp = (h: Harness) =>
  h
    .claudeLog()
    .filter((e) => e.kind === 'argv' && e.argv[0] === 'mcp')
    .map((e) => (e as any).argv.join(' '));

test.use({ harnesses: 'both' });

test('configure-mcp on Codex: add a STDIO server, see it, turn it off and on, change it, remove it', async ({ page, harness }) => {
  await expect(home(page)).toBeVisible();
  await openExtensions(page, 'Codex');
  await page.locator('.ps-tab', { hasText: 'MCPs' }).click();
  await expect(page.getByText('No MCP servers configured')).toBeVisible();

  // add: name, command and arguments go to config.toml as one table
  await page.getByRole('button', { name: 'Add' }).click();
  await page.getByRole('menuitem', { name: 'Add MCP server' }).click();
  await expect(page.getByRole('heading', { name: 'Connect to a custom MCP' })).toBeVisible();
  const save = page.getByRole('button', { name: 'Save', exact: true });
  await expect(save).toBeDisabled();
  await page.getByPlaceholder('MCP server name').fill('notes');
  await page.getByPlaceholder('openai-dev-mcp serve-sqlite').fill('npx');
  await page.locator('.mcp-field.list', { hasText: 'Arguments' }).locator('input').first().fill('notes-server');
  // the Hooks section below must not cover Save: a real click, which fails if another element is on top
  await save.click();
  await expect(page.getByText('Added notes')).toBeVisible();
  const row = page.locator('.ps-mcp-row', { hasText: 'notes' });
  await expect(row).toBeVisible();
  expect(writes(harness)[0][0]).toBe('mcp_servers."notes"');
  expect(writes(harness)[0][1]).toMatchObject({ command: 'npx', args: ['notes-server'] });
  expect(harness.codexLog().some((e) => e.method === 'config/mcpServer/reload')).toBe(true);

  // off and on again: only the table's `enabled` key is written
  await row.getByRole('switch').click();
  await expect.poll(() => writes(harness).map((w) => w[0])).toContain('mcp_servers."notes".enabled');
  expect(writes(harness).at(-1)).toEqual(['mcp_servers."notes".enabled', false]);
  // the switch shows off and takes clicks again only once the config was read back: the next click turns it on
  await expect(row.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  await expect(row.getByRole('switch')).toBeEnabled();
  await row.getByRole('switch').click();
  await expect.poll(() => writes(harness).at(-1)).toEqual(['mcp_servers."notes".enabled', true]);
  await expect(row.getByRole('switch')).toHaveAttribute('aria-checked', 'true');

  // change it: the editor opens on the saved server, and saving writes the table again
  await row.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Update Notes MCP' })).toBeVisible();
  const update = page.getByRole('button', { name: 'Save', exact: true });
  await update.click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();

  // remove it: the table is written as null after the confirm
  page.on('dialog', (d) => d.accept());
  await row.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Uninstall' }).click();
  await expect(page.getByText('No MCP servers configured')).toBeVisible();
  expect(writes(harness).at(-1)).toEqual(['mcp_servers."notes"', null]);
});

test('configure-mcp on Claude Code: add through the previewed command, see it connected, remove it', async ({ page, harness }) => {
  await expect(home(page)).toBeVisible();
  await openExtensions(page, 'Claude Code');
  await expect(page.getByText('None configured')).toBeVisible();
  await page.getByRole('button', { name: 'Add server' }).first().click();
  await page.getByRole('textbox', { name: 'MCP server name' }).fill('notes');
  await page.getByRole('textbox', { name: 'MCP command' }).fill('npx');
  await page.getByRole('textbox', { name: 'MCP arguments' }).fill('-y notes-server');
  await expect(page.getByLabel('Command preview')).toHaveText('claude mcp add --scope user notes -- npx -y notes-server');
  expect(claudeMcp(harness)).toEqual([]);
  await page.getByRole('button', { name: 'Add server' }).last().click();
  await expect.poll(() => claudeMcp(harness)).toEqual(['mcp add --scope user notes -- npx -y notes-server']);

  // the CLI reports it as a connected server of this user
  const row = page.locator('.settings-row', { hasText: 'notes' }).filter({ hasText: 'connected' });
  await expect(row).toBeVisible();
  page.on('dialog', (d) => d.accept());
  await row.getByRole('button', { name: 'Remove' }).click();
  await expect.poll(() => claudeMcp(harness).at(-1)).toBe('mcp remove --scope user notes');
  await expect(page.getByText('None configured')).toBeVisible();
});
