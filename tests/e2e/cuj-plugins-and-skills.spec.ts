// CUJ plugins-and-skills on both harnesses: the Plugins page has a tab per harness. Codex: the catalog offers a plugin,
// Install and Uninstall go through the app-server (and the sidebar lists what is installed), and a personal skill can
// be turned off and on. Claude Code: its installed plugins and skills are listed (installing is the claude CLI's, in a
// terminal) and a skill is used from the chat as the slash command it is.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, type Dirs, type Harness } from './fixtures/app';
import { standaloneNewChat } from './fixtures/sidebar';
import { openHarnessList } from './fixtures/harnessPicker';

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');

const claudeUsers = (h: Harness) =>
  h
    .claudeLog()
    .filter((e) => e.kind === 'in' && e.msg?.type === 'user')
    .map((e) => {
      const c = (e as any).msg.message.content;
      return typeof c === 'string' ? c : c.map((b: any) => b.text ?? '').join('');
    });

// a personal Claude skill on disk: the Skills tab lists it before any Claude session has run
function personalSkill(d: Dirs) {
  const dir = path.join(d.claudeHome, 'skills', 'disk-skill');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: disk-skill\ndescription: from disk\n---\nDo it.');
}

test.use({ harnesses: 'both', seed: { files: personalSkill } });

test('plugins-and-skills on Codex: install and uninstall a plugin, turn a personal skill off and on', async ({ page, harness }) => {
  await expect(home(page)).toBeVisible();
  await page.getByRole('button', { name: 'Plugins' }).first().click();
  // the page starts on MoPilot's store for every harness; Codex's own catalog is its tab
  await expect(page.locator('.ext-harness-tabs .segmented button.on')).toHaveText('All harnesses');
  await page.locator('.ext-harness-tabs .segmented button', { hasText: 'Codex' }).click();
  const row = page.locator('.plugin-row', { hasText: 'Notes Helper' }).first();
  await expect(row).toContainText('Keeps your notes tidy');
  await row.getByRole('button', { name: 'Install' }).click();
  await expect(page.getByText('Installed Notes Helper').first()).toBeVisible();
  const installs = harness.codexLog().filter((e) => e.method === 'plugin/install');
  expect(installs).toHaveLength(1);
  expect(installs[0].params).toMatchObject({ pluginName: 'notes-helper', marketplacePath: '/fake/marketplace' });
  // the sidebar's Installed list has it, and Plugin actions → Uninstall removes it
  await expect(page.getByRole('complementary').getByRole('button', { name: 'Notes Helper' })).toBeVisible();
  await row.getByRole('button', { name: 'Plugin actions' }).click();
  await page.getByRole('menuitem', { name: 'Uninstall' }).click();
  await expect(page.getByText('Removed Notes Helper').first()).toBeVisible();
  await expect(page.getByRole('complementary').getByRole('button', { name: 'Notes Helper' })).toHaveCount(0);
  expect(
    harness
      .codexLog()
      .filter((e) => e.method === 'plugin/uninstall')
      .map((e) => e.params.pluginId),
  ).toEqual(['notes-helper@openai-curated']);

  // Skills: the personal skill is listed enabled; a switch turns it off and on again
  await page.getByRole('complementary').getByRole('button', { name: 'Skills' }).click();
  await expect(page.locator('.page-title')).toHaveText('Skills');
  // Skills opens on All harnesses (#4151); the Codex tab is Codex's own list with its switch
  await expect(page.locator('.ext-harness-tabs .segmented button.on')).toHaveText('All harnesses');
  await page.locator('.ext-harness-tabs .segmented button', { hasText: 'Codex' }).click();
  const skill = page.locator('.plugin-row', { hasText: 'Tidy Notes' }).first();
  await expect(skill).toBeVisible();
  const writes = () =>
    harness
      .codexLog()
      .filter((e) => e.method === 'skills/config/write')
      .map((e) => e.params.enabled);
  await skill.click();
  const detail = page.locator('.skill-detail');
  await detail.getByRole('switch').click();
  await expect.poll(writes).toEqual([false]);
  await expect(detail.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  await detail.getByRole('switch').click();
  await expect.poll(writes).toEqual([false, true]);

  // Try now: back on a new chat with the skill in the message, which goes to Codex as a skill input
  await detail.getByRole('button', { name: 'Try now' }).click();
  await expect(home(page)).toBeVisible();
  // the skill arrives as an inline mention in the composer (#305); type once it is there
  await expect(composer(page).locator('.composer-skill')).toHaveText('Tidy Notes');
  await composer(page).click();
  await page.keyboard.type('tidy it');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(transcript(page).getByText(/fake-codex: .*tidy it/)).toBeVisible();
  const input = harness.codexLog().find((e) => e.method === 'turn/start' && /tidy it/.test(JSON.stringify(e.params.input)))!.params
    .input as any[];
  expect(input.some((i) => i.type === 'skill' && i.name === 'tidy-notes')).toBe(true);
});

test('plugins-and-skills on Claude Code: the Claude tab lists skills and hands plugin installs to the CLI; a skill runs as a slash command', async ({
  page,
  harness,
}) => {
  await expect(home(page)).toBeVisible();
  await page.getByRole('button', { name: 'Plugins' }).first().click();
  await page.locator('.ext-harness-tabs .segmented button', { hasText: 'Claude Code' }).click();
  await expect(page.getByRole('button', { name: 'Install with claude plugin…' })).toBeVisible();

  // Skills tab: what Claude Code found for this project
  await page.getByRole('complementary').getByRole('button', { name: 'Skills' }).click();
  // Skills keeps its own pick: it opens on All harnesses (#4151), so pick Claude Code here too
  await expect(page.locator('.ext-harness-tabs .segmented button.on')).toHaveText('All harnesses');
  await page.locator('.ext-harness-tabs .segmented button', { hasText: 'Claude Code' }).click();
  await expect(page.locator('.ext-harness-tabs .segmented button.on')).toHaveText('Claude Code');
  await expect(page.locator('.plugins-page')).toContainText('Skills Claude Code has found');
  // no Claude session has run yet, and the skill on disk is already listed
  await expect(page.locator('.plugins-page')).toContainText('disk-skill');

  // installing plugins is the CLI's: the button types the claude plugin command into a terminal
  await page.getByRole('complementary').getByRole('button', { name: 'Plugins' }).click();
  await page.getByRole('button', { name: 'Install with claude plugin…' }).click();
  await expect(page.locator('.term-view')).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.body.innerText)).toContain('claude plugin');
  await expect(home(page)).toBeVisible();

  // using it: the skill is in the / menu and goes to the CLI as typed
  await standaloneNewChat(page).click();
  await expect(home(page)).toBeVisible();
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: 'Claude Code' }).click();
  await page.locator('.hp-models .menu-item', { hasText: 'Fake Sonnet' }).click();
  await composer(page).fill('/fake');
  await expect(page.locator('.slash-panel').getByText('/fake-skill')).toBeVisible();
  await composer(page).fill('/fake-skill tidy the notes');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(transcript(page).getByText('fake-claude: /fake-skill tidy the notes', { exact: true })).toBeVisible();
  expect(claudeUsers(harness)).toContain('/fake-skill tidy the notes');
});
