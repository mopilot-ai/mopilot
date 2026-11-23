// CUJ context-attachments on both harnesses: a PDF and a folder picked with the + menu and a file chosen with @ reach the harness in the form it reads (Codex mention items, Claude Code @paths in the text), and a removed chip is not sent.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';
import { claudeChatMessages, claudeTextOf } from './fixtures/claudeChat';
import { openHarnessList } from './fixtures/harnessPicker';

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
const sidebar = (page: Page) => page.getByRole('complementary');

async function pick(page: Page, who: 'Codex' | 'Claude Code', model: string) {
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: who }).click();
  await page.locator('.hp-models .menu-item', { hasText: model }).click();
  await page.keyboard.press('Escape');
}
/** Files and folders through the + menu (the picker is stubbed to return `paths`). */
async function attach(page: Page, h: Harness, paths: string[]) {
  await h.app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: p })) as any;
  }, paths);
  await page.getByRole('button', { name: 'Add files and more' }).click();
  await page.locator('.add-panel').getByText('Files and folders', { exact: true }).click();
}

/** A project with a spec PDF, a docs folder and a source file to mention. */
async function project(h: Harness) {
  const folder = path.join(h.dir, 'home', 'work', 'demo');
  fs.mkdirSync(path.join(folder, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(folder, 'src'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'spec.pdf'), '%PDF-1.4\n%%EOF\n');
  fs.writeFileSync(path.join(folder, 'docs', 'notes.md'), '# Notes\n');
  fs.writeFileSync(path.join(folder, 'src', 'parser.ts'), 'export const parse = () => 1;\n');
  await h.app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [f] })) as any;
  }, folder);
  await sidebar(h.page).getByRole('button', { name: 'Add new project' }).click();
  await expect(sidebar(h.page).locator('.project-row', { hasText: 'demo' })).toBeVisible();
  return folder;
}

async function compose(page: Page, harness: Harness, who: 'Codex' | 'Claude Code', model: string) {
  await expect(home(page)).toBeVisible();
  const folder = await project(harness);
  // adding a project opens a new chat in it
  await expect(page.getByRole('button', { name: 'Change project: demo' })).toBeVisible();
  await pick(page, who, model);
  const extra = path.join(folder, 'docs', 'notes.md');
  await attach(page, harness, [path.join(folder, 'spec.pdf'), path.join(folder, 'docs'), extra]);
  await expect(page.locator('.attachment.file')).toHaveCount(3);
  // the user takes one back before sending
  await page.locator('.attachment.file', { hasText: 'notes.md' }).getByRole('button', { name: 'Remove' }).click();
  await expect(page.locator('.attachment.file')).toHaveCount(2);
  // @ finds a project file through the app's own search
  await composer(page).click();
  await page.keyboard.type('read @parser');
  await expect(page.locator('.composer-popup .menu-item').first()).toContainText('parser.ts');
  // the next keys come straight after the pick, as a typist's do: they follow the mention (#1719)
  await page.keyboard.press('Enter');
  await page.keyboard.type('and the spec');
  // an @ file sits in the text, not as a chip
  await expect(composer(page)).toContainText('src/parser.ts and the spec');
  await expect(page.locator('.attachment.file')).toHaveCount(2);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  return { folder, extra };
}

test.use({ harnesses: 'both' });

test('context-attachments on Codex: a PDF, a folder and an @ file reach Codex as mentions; a removed one does not', async ({
  page,
  harness,
}) => {
  const { folder, extra } = await compose(page, harness, 'Codex', 'Fake Model One');
  await expect(transcript(page).getByText(/fake-codex: read @/)).toBeVisible();
  const turn = harness
    .codexLog()
    .filter((e) => e.method === 'turn/start' && !/as a short chat title/.test(e.params.input?.[0]?.text ?? ''))
    .at(-1)!;
  const input = turn.params.input as any[];
  const mentions = input.filter((i) => i.type === 'mention').map((i) => i.path);
  // the picked file and folder are mention items; the @ file reaches Codex too (as a mention or in the text)
  expect(mentions).toEqual(expect.arrayContaining([path.join(folder, 'docs'), path.join(folder, 'spec.pdf')]));
  expect(JSON.stringify(input)).toContain('src/parser.ts and the spec');
  expect(JSON.stringify(input)).not.toContain(extra);
});

test('context-attachments on Claude Code: a PDF, a folder and an @ file reach Claude Code as @paths; a removed one does not', async ({
  page,
  harness,
}) => {
  const { folder, extra } = await compose(page, harness, 'Claude Code', 'Fake Sonnet');
  await expect(transcript(page).getByText(/fake-claude: read @/)).toBeVisible();
  const text = claudeTextOf(claudeChatMessages(harness).at(-1));
  for (const p of [path.join(folder, 'spec.pdf'), path.join(folder, 'docs')]) expect(text).toContain(`@${p}`);
  expect(text).toContain('src/parser.ts and the spec');
  expect(text).not.toContain(extra);
});
