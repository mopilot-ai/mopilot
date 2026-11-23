// Forking a chat whose managed worktree and holder were removed still restores its kept branch before the next message.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test, expect, type Harness } from './fixtures/app';
import { writeTo } from './fixtures/scriptLine';
import { deleteWorktree } from './fixtures/worktreeDelete';

const codex = '019b0000-0000-7000-8000-000000000001';
const claude = '11111111-1111-4111-8111-111111111111';
const workspace = '.mopilot/worktrees/a1b2/repo';
const git = (repo: string, ...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

test.use({
  harnesses: 'both',
  seed: {
    codexThreads: [{ id: codex, cwd: workspace, name: 'Codex recovery parent', turns: ['Original task'] }],
    claudeSessions: [{ id: claude, cwd: workspace, title: 'Claude recovery parent', turns: ['Original task'] }],
    files: ({ home }) => {
      const repo = path.join(home, 'work', 'repo');
      fs.mkdirSync(path.join(repo, '.codex', 'environments'), { recursive: true });
      fs.writeFileSync(path.join(repo, 'kept.txt'), 'Kept branch contents\n');
      fs.writeFileSync(
        path.join(repo, '.codex', 'environments', 'environment.toml'),
        `[setup]\nscript = "${writeTo('echo restored', 'setup-ran.txt')}"\n`,
      );
      git(repo, 'init', '-q', '-b', 'main');
      git(repo, 'add', '.');
      git(repo, '-c', 'user.name=e2e', '-c', 'user.email=e2e@example.test', 'commit', '-qm', 'initial');
      git(repo, 'worktree', 'add', '-q', '-b', 'mopilot/a1b2', path.join(home, workspace));
    },
  },
});

async function journey(harness: Harness, chatId: string, title: string, fake: string, legacy = false) {
  let { page } = harness;
  await page.setViewportSize({ width: 1024, height: 682 });
  const repo = path.join(harness.dir, 'home', 'work', 'repo');
  const cwd = path.join(harness.dir, 'home', workspace);
  await page.getByRole('complementary').getByText(title, { exact: true }).first().click();
  await expect(page.locator('.thread-view').first()).toHaveAttribute('data-thread-id', chatId);
  expect(await page.evaluate(({ id, repo }) => window.native.chats.patchMeta(id, { worktreeOf: repo }), { id: chatId, repo })).toBe(true);
  deleteWorktree(repo, cwd);
  fs.rmSync(path.dirname(cwd), { recursive: true, force: true });
  expect(fs.existsSync(path.dirname(cwd))).toBe(false);

  await page.getByRole('button', { name: 'Chat actions' }).click();
  await page.locator('.menu-item', { hasText: /^Fork$/ }).click();
  await page.locator('.menu-item', { hasText: 'Fork into new chat' }).click();
  await expect(page.getByText('Forked into a new chat')).toBeVisible();
  await expect(page.locator('.thread-view').first()).not.toHaveAttribute('data-thread-id', chatId);
  const fork = await page.locator('.thread-view').first().getAttribute('data-thread-id');
  expect(fork).toBeTruthy();
  expect(fork).not.toBe(chatId);
  if (legacy) {
    expect(await page.evaluate((id) => window.native.chats.patchMeta(id!, { worktreeOf: null }), fork)).toBe(true);
    await harness.relaunch();
    page = harness.page;
    await page
      .getByRole('complementary')
      .locator(`[data-sidebar-chat=${JSON.stringify(fork)}]`)
      .first()
      .click();
    await expect(page.locator('.thread-view').first()).toHaveAttribute('data-thread-id', fork!);
    expect(await page.evaluate(async (id) => (await window.native.chats.snapshot()).chats[id!]?.meta.worktreeOf, fork)).toBeNull();
  }
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('pls continue');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('main').getByText(`${fake}: pls continue`, { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(async (id) => (await window.native.chats.snapshot()).chats[id!]?.meta.worktreeOf, fork)).toBe(repo);
  expect(fs.readFileSync(path.join(cwd, 'kept.txt'), 'utf8')).toBe('Kept branch contents\n');
  expect(git(cwd, 'branch', '--show-current')).toBe('mopilot/a1b2');
  expect(fs.readFileSync(path.join(cwd, 'setup-ran.txt'), 'utf8').trim()).toBe('restored');
  await page.screenshot({ path: test.info().outputPath('fork-restored-and-continued.png') });
}

test('Codex: fork a deleted workspace and continue on its kept branch', async ({ harness }) => {
  await journey(harness, codex, 'Codex recovery parent', 'fake-codex');
});

test('Claude Code: fork a deleted workspace and continue on its kept branch', async ({ harness }) => {
  await journey(harness, `claude:${claude}`, 'Claude recovery parent', 'fake-claude');
});

test('Codex: an older fork without its own repository link recovers after restart', async ({ harness }) => {
  await journey(harness, codex, 'Codex recovery parent', 'fake-codex', true);
});

test('Claude Code: an older fork without its own repository link recovers after restart', async ({ harness }) => {
  await journey(harness, `claude:${claude}`, 'Claude recovery parent', 'fake-claude', true);
});
