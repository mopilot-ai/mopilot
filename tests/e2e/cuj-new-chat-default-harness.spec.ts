// CUJ new-chat-default-harness on both harnesses: the default harness (and model) for new chats is a setting; picking another
// harness in a new chat runs that chat there and leaves the default alone, and later new chats follow the last used
// until Settings says to start from the default; a project decides the chat's folder; a
// temporary chat (from the menu) is not kept. (Mini and the tray are in mini.spec.)
import { standaloneNewChat } from './fixtures/sidebar';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';
import { savedDefaultHarness } from './fixtures/defaultHarness';
import { openSettingsSelect, settingsEntry } from './fixtures/settings';

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
const sidebar = (page: Page) => page.getByRole('complementary');
const modelButton = (page: Page) => page.getByRole('button', { name: 'Select model' });

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await expect(composer(page)).toHaveText(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}
async function pickModel(page: Page, harness: 'Codex' | 'Claude Code', model: string) {
  await modelButton(page).click();
  // the picker opens on the effort pane; its title row leads to the harness list
  await page.getByRole('button', { name: 'Select harness and model' }).click();
  await page.locator('.hp-harnesses .hp-row', { hasText: harness }).click();
  await page.locator('.hp-models .menu-item', { hasText: model }).click();
  // a pick returns to the effort pane: close the picker
  await expect(page.locator('.effort-pop')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.effort-pop')).toBeHidden();
}
const menuItem = (h: Harness, label: string) =>
  h.app.evaluate(({ Menu }, label) => {
    const find = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const i of items) {
        if (i.label === label) return i;
        const sub = i.submenu && find(i.submenu.items);
        if (sub) return sub;
      }
    };
    find(Menu.getApplicationMenu()!.items)!.click();
  }, label);

test.use({ harnesses: 'both' });

test('new-chat-default-harness: the default is a setting; picking a harness in a new chat runs it there and leaves the default alone', async ({
  page,
  harness,
}) => {
  await expect(home(page)).toBeVisible();
  await expect(modelButton(page)).toContainText('Fake Model One');

  // Settings → Harnesses → All harnesses → New chats use (the row's title since #1385)
  await page.locator('.sidebar-title').first().click();
  await settingsEntry(page).click();
  await page.locator('.side-row', { hasText: 'All agents' }).first().click();
  // the choice is a model, which names its harness
  await (await openSettingsSelect(page, 'New chats use', 'Claude Code · Fake Sonnet')).click();
  await expect(() => expect(savedDefaultHarness(harness)).toBe('claude')).toPass({ timeout: 10_000 });
  await page.locator('.side-row', { hasText: 'Back to app' }).click();

  // a new chat now starts on Claude Code
  await expect(home(page)).toBeVisible();
  await expect(modelButton(page)).toContainText('Fake');
  await expect(modelButton(page)).not.toContainText('Fake Model');
  await send(page, 'first on the new default');
  await expect(transcript(page).getByText('fake-claude: first on the new default', { exact: true })).toBeVisible();
  expect(harness.codexLog().filter((e) => e.method === 'turn/start')).toHaveLength(0);

  // New chat, and pick Codex in the model menu: this chat runs on Codex, and leaves the saved default alone; new chats
  // follow the last used, so the following one starts on Codex too
  await standaloneNewChat(page).click();
  await expect(home(page)).toBeVisible();
  await pickModel(page, 'Codex', 'Fake Model One');
  await page.keyboard.press('Escape');
  await send(page, 'this one on codex');
  await expect(transcript(page).getByText('fake-codex: this one on codex', { exact: true })).toBeVisible();
  expect(savedDefaultHarness(harness)).toBe('claude');
  await standaloneNewChat(page).click();
  await expect(home(page)).toBeVisible();
  await expect(modelButton(page)).toContainText('Fake Model One');

  // New chats start with the default above: the next new chat starts on the saved default again
  await page.locator('.sidebar-title').first().click();
  await settingsEntry(page).click();
  await page.locator('.side-row', { hasText: 'All agents' }).first().click();
  await (await openSettingsSelect(page, 'New chats start with', 'The default above')).click();
  await page.locator('.side-row', { hasText: 'Back to app' }).click();
  await standaloneNewChat(page).click();
  await expect(home(page)).toBeVisible();
  await expect(modelButton(page)).toContainText('Fake Sonnet');
});

test('new-chat-default-harness: a project sets the chat folder; a temporary chat is not kept', async ({ page, harness }) => {
  await expect(home(page)).toBeVisible();
  // a project folder from the picker
  const folder = path.join(harness.dir, 'home', 'work', 'demo');
  fs.mkdirSync(folder, { recursive: true });
  await harness.app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [f] })) as any;
  }, folder);
  await sidebar(page).getByRole('button', { name: 'Add new project' }).click();
  await expect(sidebar(page).locator('.project-row', { hasText: 'demo' })).toBeVisible();
  await send(page, 'in the project');
  await expect(transcript(page).getByText('fake-codex: in the project', { exact: true })).toBeVisible();
  const start = harness.codexLog().find((e) => e.method === 'thread/start' && !e.params.ephemeral)!;
  expect(start.params.cwd).toBe(folder);
  await expect(sidebar(page).locator('.project-group', { hasText: 'demo' }).getByText('Fake chat title', { exact: true })).toBeVisible();

  // a chat on Claude Code from the project's own new chat runs in that folder too
  await sidebar(page).locator('.project-row', { hasText: 'demo' }).hover();
  await sidebar(page).getByRole('button', { name: 'New chat in demo' }).click();
  await pickModel(page, 'Claude Code', 'Fake Sonnet');
  await page.keyboard.press('Escape');
  await send(page, 'claude in the project');
  await expect(transcript(page).getByText('fake-claude: claude in the project', { exact: true })).toBeVisible();
  const cwds = harness.claudeLog().flatMap((e) => (e.kind === 'argv' && e.argv.some((a) => a.startsWith('--session-id=')) ? [e.cwd] : []));
  expect(cwds).toContain(folder);

  // a temporary chat on each harness: the menu opens it, it runs unpersisted, and the sidebar never lists it. The two
  // chats so far are each listed in the project and in Recents, which lists every chat since #280
  const listed = () => sidebar(page).getByText('Fake chat title', { exact: true });
  const inProject = () => sidebar(page).locator('.project-group', { hasText: 'demo' }).getByText('Fake chat title', { exact: true });
  await expect(inProject()).toHaveCount(2);
  await expect(listed()).toHaveCount(4);
  // the started chat's pick ended with it: Claude Code is picked again for the temporary chat
  await standaloneNewChat(page).click();
  await pickModel(page, 'Claude Code', 'Fake Sonnet');
  await menuItem(harness, 'New Temporary Chat');
  await expect(page.getByText('Temporary chat')).toBeVisible();
  await send(page, 'a passing thought');
  await expect(transcript(page).getByText('fake-claude: a passing thought', { exact: true })).toBeVisible();
  expect(
    harness
      .claudeLog()
      .some((e) => e.kind === 'argv' && e.argv.includes('--no-session-persistence') && e.argv.some((a) => a.startsWith('--session-id='))),
  ).toBe(true);
  await standaloneNewChat(page).click();
  await pickModel(page, 'Codex', 'Fake Model One');
  await page.keyboard.press('Escape');
  await menuItem(harness, 'New Temporary Chat');
  await expect(page.getByText('Temporary chat')).toBeVisible();
  await send(page, 'a passing codex thought');
  await expect(transcript(page).getByText('fake-codex: a passing codex thought', { exact: true })).toBeVisible();
  expect(harness.codexLog().some((e) => e.method === 'thread/start' && e.params.ephemeral === true)).toBe(true);
  await expect(sidebar(page).getByText(/passing/)).toHaveCount(0);
  await expect(inProject()).toHaveCount(2);
  await expect(listed()).toHaveCount(4);
});
