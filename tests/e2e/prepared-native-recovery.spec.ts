// A cancelled native allocation is restored through real preload IPC and human composer input while any old Git cleanup is held.
// A successful second same-parent start proves the first serialized start body settled; no sleep or missing-marker guess is evidence.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { threadHash } from '../../shared/deepLink.mjs';
import type { Page } from '@playwright/test';
import { test, expect, type Dirs, type Harness } from './fixtures/app';
import { openHarnessList } from './fixtures/harnessPicker';
import { nodeCommand, withPath } from './fixtures/nodeCommand';

// the machine's own Git, which the wrapper runs: `which` on macOS and Linux, `where` (its first match) on Windows
const realGit = execFileSync(process.platform === 'win32' ? 'where.exe' : '/usr/bin/which', ['git'], { encoding: 'utf8' })
  .split(/\r?\n/)[0]
  .trim();
const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'prepared-git-bin-'));
nodeCommand(bin, 'git', path.join(__dirname, 'fixtures', 'prepared-git-wrapper.cjs'));
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const background =
  'This separate task belongs to the current user request. Preserve its own scope and report the outcome without changing the parent checkout.';
const call = (args: object) => `CUCALL start_session ${JSON.stringify(args)}`;
function read(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function seed(d: Dirs) {
  const repo = path.join(d.home, 'work', 'prepared-recovery');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'README.md'), 'Prepared native recovery fixture\n');
  const git = (...args: string[]) => execFileSync(realGit, args, { cwd: repo, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('-c', 'user.name=e2e', '-c', 'user.email=e2e@example.test', 'commit', '-q', '-m', 'init');
  fs.writeFileSync(
    `${path.dirname(d.home)}/fake-codex.jsonl.prepared-start.json`,
    JSON.stringify({ root: path.join(d.home, '.mopilot', 'worktrees') }),
  );
}

function secondStarted(harness: Harness) {
  for (const entry of harness.claudeLog() as any[]) {
    if (entry.kind !== 'cu' || entry.tool !== 'start_session') continue;
    try {
      const result = JSON.parse(entry.text);
      if (result.status === 'started' && result.title === 'Serial completion witness') return result;
    } catch {
      // The deliberately stopped first tool call says interrupted instead of returning a start result.
    }
  }
  return null;
}

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  // the draft is the chat's own: a chat view that mounts after the fill would start empty and offer no Send
  // innerText keeps the draft's line breaks, which textContent drops ("CUSTEPS\nCUCALL" read as "CUSTEPSCUCALL")
  await expect(composer(page)).toHaveText(text, { useInnerText: true });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

test.use({
  harnesses: 'both',
  shellPath: [bin],
  env: { PATH: withPath([bin]), MOPILOT_TEST_REAL_GIT: realGit },
  seed: { files: seed },
});
test.afterAll(() => fs.rmSync(bin, { recursive: true, force: true }));

test('a restored native child keeps its clean worktree when the cancelled start settles', async ({ page, harness }, testInfo) => {
  test.setTimeout(60_000);
  const log = path.join(harness.dir, 'fake-codex.jsonl');
  const repo = path.join(harness.dir, 'home', 'work', 'prepared-recovery');
  const root = path.join(harness.dir, 'home', '.mopilot', 'worktrees');
  try {
    await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
    await openHarnessList(page);
    await page.locator('.hp-harnesses .hp-row', { hasText: 'Claude Code' }).click();
    await page.locator('.hp-models .menu-item', { hasText: 'Fake Sonnet' }).click();
    await harness.app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as any;
    }, repo);
    await page.getByRole('complementary').getByRole('button', { name: 'Add a project folder' }).click();
    await expect(page.locator('.ctxbar')).toContainText('prepared-recovery');
    const worktreeSwitch = page.locator('label.ctx-check', { hasText: 'Worktree' });
    if (await worktreeSwitch.locator('input').isChecked()) await worktreeSwitch.click();
    await expect(worktreeSwitch.locator('input')).not.toBeChecked();
    await send(page, 'Prepare the native recovery scenario');
    await expect(page.getByRole('main').getByText('fake-claude: Prepare the native recovery scenario', { exact: true })).toBeVisible();
    const parentPids = new Set(
      harness
        .claudeLog()
        .filter(
          (entry: any) =>
            entry.kind === 'in' &&
            entry.msg?.origin?.kind === 'human' &&
            JSON.stringify(entry.msg.message.content).includes('Prepare the native recovery scenario'),
        )
        .map((entry) => entry.pid),
    );
    const parentProcesses = harness.claudeLog().filter((entry) => entry.kind === 'argv' && parentPids.has(entry.pid));
    expect(parentProcesses).toHaveLength(1);
    expect((parentProcesses[0] as any).cwd).toBe(repo);
    await send(
      page,
      `Start a separate Codex session in its own worktree CUSTEPS\n${call({
        initiation: 'user_asked',
        context: 'fresh',
        use_worktree: true,
        harness: 'codex',
        title: 'Cancelled native allocation',
        prompt: 'The cancelled brief must never be sent',
        background,
      })}`,
    );
    await expect.poll(() => read(`${log}.prepared-start.entered`)).toBeTruthy();
    const allocation = read(`${log}.prepared-start.entered`) as { id: string; cwd: string };
    expect(allocation.id).toBeTruthy();
    expect(allocation.cwd.startsWith(`${root}${path.sep}`)).toBe(true);
    expect(fs.existsSync(path.join(allocation.cwd, '.git'))).toBe(true);
    // The real native notification made this identity available before the held creation RPC returned.
    await expect(
      page
        .getByRole('complementary')
        .locator(`[data-sidebar-chat=${JSON.stringify(allocation.id)}]`)
        .first(),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
    await send(
      page,
      `Start another separate task here CUSTEPS\n${call({
        initiation: 'user_asked',
        context: 'fresh',
        use_worktree: false,
        title: 'Serial completion witness',
        prompt: 'Confirm the second start really ran',
        background,
      })}`,
    );
    fs.writeFileSync(`${log}.prepared-start.release`, '');
    await expect
      .poll(() => page.evaluate(async (id) => (await window.native.chats.snapshot()).chats[id]?.meta.archived, allocation.id))
      .toBeTruthy();
    await expect
      .poll(() => (fs.existsSync(`${log}.prepared-git.entered`) ? 'git' : secondStarted(harness) ? 'second' : 'waiting'), {
        timeout: 30_000,
      })
      .not.toBe('waiting');
    const oldCleanupEntered = fs.existsSync(`${log}.prepared-git.entered`);

    // The normal Unarchive action uses these production handlers; the native zero-turn fake is intentionally absent from archive lists.
    const restored = await page.evaluate(
      async ({ id, cwd, root, repo }) => {
        await window.native.codex.api('threadUnarchive', [id]);
        const worktree = await window.native.git.worktreeRestore(cwd, root, repo, null);
        const visible = await window.native.chats.patchMeta(id, { archived: null });
        return { worktree, visible };
      },
      { ...allocation, root, repo },
    );
    expect(restored.worktree).toEqual({ ok: true, restored: false });
    expect(restored.visible).toBe(true);
    // Open by the production window route: the fake list omits zero-turn chats, while opening reads/upserts this exact native id.
    const opened = harness.app.waitForEvent('window');
    await page.evaluate((hash) => window.native.win.open(hash), threadHash(allocation.id));
    page = await opened;
    await expect(page.locator(`.thread-view[data-thread-id=${JSON.stringify(allocation.id)}]`)).toBeVisible();
    await expect(composer(page)).toBeVisible();
    await send(page, 'Human recovery is reading this worktree SLOW');
    await expect
      .poll(
        () =>
          harness
            .codexLog()
            .filter(
              (entry) =>
                entry.method === 'turn/start' &&
                entry.params.threadId === allocation.id &&
                JSON.stringify(entry.params.input).includes('Human recovery is reading this worktree'),
            ).length,
      )
      .toBe(1);
    await expect
      .poll(() => page.evaluate(async (id) => (await window.native.session.snapshot(id)).activeTurn?.human, allocation.id))
      .toBe(true);
    if (oldCleanupEntered) {
      const removal = read(`${log}.prepared-git.entered`);
      expect(removal.args).toEqual(['worktree', 'remove', allocation.cwd]);
      expect(removal.cwd).toBe(repo);
      fs.writeFileSync(`${log}.prepared-git.release`, '');
      await expect.poll(() => read(`${log}.prepared-git.done`)).toBeTruthy();
      expect(read(`${log}.prepared-git.done`).status).toBe(0);
    }
    // This successful distinct start could not pass the per-parent serial boundary until the first body and cleanup settled.
    await expect.poll(() => secondStarted(harness)).toBeTruthy();
    const witness = secondStarted(harness);
    expect(witness.chat_id).not.toBe(allocation.id);
    expect(witness.worktree).toBe(false);
    const cwdExists = fs.existsSync(allocation.cwd);
    const gitFileExists = fs.existsSync(path.join(allocation.cwd, '.git'));
    const worktrees = execFileSync(realGit, ['worktree', 'list', '--porcelain'], { cwd: repo, encoding: 'utf8' });
    const gitEntered = read(`${log}.prepared-git.entered`);
    const gitDone = read(`${log}.prepared-git.done`);
    const nativeState = await page.evaluate((id) => window.native.session.snapshot(id), allocation.id);
    await testInfo.attach('prepared-native-recovery', {
      body: JSON.stringify({
        allocation,
        witness,
        worktrees,
        oldCleanupEntered,
        cwdExists,
        gitFileExists,
        gitEntered,
        gitDone,
        nativeState,
      }),
      contentType: 'application/json',
    });
    expect(cwdExists).toBe(true);
    expect(gitFileExists).toBe(true);
    // Git lists a Windows worktree with forward slashes
    expect(worktrees.split(/\r?\n/)).toContain(`worktree ${allocation.cwd.replaceAll(path.sep, '/')}`);
    expect(fs.existsSync(`${log}.prepared-git.entered`)).toBe(false);
    expect(
      harness
        .codexLog()
        .filter(
          (entry) =>
            entry.method === 'turn/start' &&
            entry.params.threadId === allocation.id &&
            JSON.stringify(entry.params.input).includes('The cancelled brief must never be sent'),
        ),
    ).toHaveLength(0);
    await page.screenshot({ path: testInfo.outputPath('restored-native-worktree-still-running.png') });
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
  } finally {
    try {
      const chats = await page.evaluate(() => window.native.chats.snapshot()).catch((error) => ({ error: String(error) }));
      await testInfo.attach('prepared-native-protocol-diagnostic', {
        body: JSON.stringify({
          chats,
          claude: harness
            .claudeLog()
            .filter((entry: any) => ['cu', 'turn', 'in'].includes(entry.kind))
            .slice(-40),
          codex: harness
            .codexLog()
            .filter((entry) => /^(thread|turn)\//.test(entry.method))
            .slice(-30),
          allocation: read(`${log}.prepared-start.entered`),
          gitEntered: read(`${log}.prepared-git.entered`),
          gitDone: read(`${log}.prepared-git.done`),
        }),
        contentType: 'application/json',
      });
    } finally {
      fs.writeFileSync(`${log}.prepared-start.release`, '');
      fs.writeFileSync(`${log}.prepared-git.release`, '');
    }
  }
});
