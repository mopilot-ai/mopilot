// CUJ terminal-run on both harnesses: the agent runs a command in the user's Terminal panel with run_in_terminal (a card shows the exact line and the folder, Allow once), the shell prints its output, and read_terminal gives it back to the agent; a denied line types nothing.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';
import { openHarnessList } from './fixtures/harnessPicker';

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
const sidebar = (page: Page) => page.getByRole('complementary');
const card = (page: Page) => page.locator('.sage-approval');

interface Way {
  who: 'Codex' | 'Claude Code';
  model: string;
}
const CODEX: Way = { who: 'Codex', model: 'Fake Model One' };
const CLAUDE: Way = { who: 'Claude Code', model: 'Fake Sonnet' };

async function send(page: Page, lines: string[]) {
  await composer(page).fill(lines.join('\n'));
  await expect(composer(page)).toContainText(lines[lines.length - 1]);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}
async function pick(page: Page, w: Way) {
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: w.who }).click();
  await page.locator('.hp-models .menu-item', { hasText: w.model }).click();
  await page.keyboard.press('Escape');
}
const expectIdle = (page: Page) => expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);

async function addProject(h: Harness) {
  const folder = path.join(h.dir, 'home', 'work', 'demo');
  fs.mkdirSync(folder, { recursive: true });
  await h.app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [f] })) as any;
  }, folder);
  await sidebar(h.page).getByRole('button', { name: 'Add new project' }).click();
  await expect(sidebar(h.page).locator('.project-row', { hasText: 'demo' })).toBeVisible();
  return folder;
}

async function journey(page: Page, harness: Harness, w: Way) {
  await expect(home(page)).toBeVisible();
  const folder = await addProject(harness);
  await expect(page.getByRole('button', { name: 'Change project: demo' })).toBeVisible();
  await pick(page, w);

  // 1. the card names the exact line and the folder; Allow once types it into a new Terminal tab
  // the line the agent asks for, in the terminal's own shell: PowerShell on Windows (src/lib/platform.ts defaultShell)
  const command = process.platform === 'win32' ? 'echo W6_$(20+22)' : 'echo W6_$((20+22))';
  await send(page, [`CUCALL run_in_terminal ${JSON.stringify({ command })}`]);
  await expect(card(page)).toHaveAttribute('data-kind', 'terminalTab');
  await expect(card(page)).toContainText(`Allow ${w.who} to run this in a terminal?`);
  await expect(card(page).locator('code').first()).toHaveText(command);
  await expect(card(page)).toContainText(`in ${folder}`);
  await expect(card(page).getByRole('button', { name: /^Allow in this chat/ })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('terminal-command-card.png') });
  await card(page)
    .getByRole('button', { name: /^Allow once/ })
    .click();
  await expect(transcript(page)).toContainText('Typed the command into terminal tab');
  await expectIdle(page);

  // 2. the shell ran it; the agent reads the output back
  await send(page, ['CUCALL read_terminal {"wait_for_output_ms":4000}']);
  await expect(transcript(page)).toContainText('W6_42');
  await expectIdle(page);

  // 3. a denied line types nothing, and the agent is told so
  await send(page, [
    `CUCALL run_in_terminal ${JSON.stringify({ command: process.platform === 'win32' ? 'echo DENIED_$(1+1)' : 'echo DENIED_$((1+1))' })}`,
  ]);
  await expect(card(page)).toHaveAttribute('data-kind', 'terminalTab');
  await card(page).getByRole('button', { name: /^Deny/ }).click();
  await expect(transcript(page)).toContainText('declined to run that command');
  await expectIdle(page);
  await send(page, ['CUCALL read_terminal {}']);
  await expect(transcript(page)).not.toContainText('DENIED_2');
  await expectIdle(page);
}

test.use({ harnesses: 'both' });

test('terminal-run on Codex: the card names the line and folder, Allow once runs it, read_terminal returns the output; Deny types nothing', async ({
  page,
  harness,
}) => {
  await journey(page, harness, CODEX);
});

test('terminal-run on Claude Code: the card names the line and folder, Allow once runs it, read_terminal returns the output; Deny types nothing', async ({
  page,
  harness,
}) => {
  await journey(page, harness, CLAUDE);
});
