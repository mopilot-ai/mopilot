// e2e-runner: bench
// e2e-covers: src/components/sidebar/projectGroups.ts src/components/sidebar/folderPrefs.ts src/lib/machineProject.ts
// e2e-covers: src/components/sidebar/ProjectGroup.tsx src/components/sidebar/ThreadRow.tsx src/components/sidebar/projectRows.ts
// e2e-covers: src/components/sidebar/projectLabels.ts
// Remote Run audit M45: a new chat on a machine has the Worktree switch and the branch chip of a chat on This Mac, in the real Mac app against a real Host process over real ssh (this runner's sshd and the app's ssh tunnel) that has the repo's fake Claude Code. With the folder on the machine picked, the chip shows the machine's branch and its picker lists the machine's branches; with the Worktree switch on, the Host makes a worktree of the machine's repository on a new branch that starts from the picked one, and the chat starts there, while the repository's own folder stays on its branch. Everything is checked in the Host's own file system.
// It turns on sshd and writes the user's ssh config, so it runs only on a CI runner. Named on the command line only: `node scripts/ci-cuj.mjs --spec tests/e2e/host-machine-worktree.spec.ts`.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from './fixtures/app';
import {
  REMOTE_FOLDER,
  REMOTE_ID,
  type RemoteHost,
  connectRemote,
  machineName,
  sshToSelf,
  startRemoteChat,
  startRemoteHost,
} from './fixtures/remoteHost';

test.skip(process.platform !== 'darwin', 'a basic harness is admitted only with sage-mcp, which builds only on macOS');
test.skip(!process.env.GITHUB_ACTIONS, 'a runner only: it turns on sshd and writes the ssh config');

const HOME = os.homedir();
const WORKTREES = `${REMOTE_FOLDER}.worktrees`;
let remote: RemoteHost;

/** git on the machine's side of the runner (the Host's own file system), with an identity of its own. */
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', '-c', 'init.defaultBranch=main', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();

test.setTimeout(8 * 60_000);
test.beforeAll(async () => {
  fs.rmSync(REMOTE_FOLDER, { recursive: true, force: true });
  fs.rmSync(WORKTREES, { recursive: true, force: true });
  fs.mkdirSync(REMOTE_FOLDER, { recursive: true });
  // a repository with two branches: `main` checked out, `dev` one commit ahead of it
  git(REMOTE_FOLDER, 'init', '-q');
  fs.writeFileSync(path.join(REMOTE_FOLDER, 'a.txt'), 'main\n');
  git(REMOTE_FOLDER, 'add', '.');
  git(REMOTE_FOLDER, 'commit', '-qm', 'one');
  git(REMOTE_FOLDER, 'checkout', '-qb', 'dev');
  fs.writeFileSync(path.join(REMOTE_FOLDER, 'a.txt'), 'dev\n');
  git(REMOTE_FOLDER, 'commit', '-qam', 'two');
  git(REMOTE_FOLDER, 'checkout', '-q', 'main');
  sshToSelf();
  remote = await startRemoteHost({ agents: 'claude+codex' });
});
test.afterAll(() => {
  remote?.stop();
  fs.rmSync(REMOTE_FOLDER, { recursive: true, force: true });
  fs.rmSync(WORKTREES, { recursive: true, force: true });
});
test.use({
  harnesses: 'codex',
  acp: { kimi: {} },
  env: { MOPILOT_HOST_DEV: '1', HOME },
  seed: {
    userData: {
      'host-registry.json': {
        version: 1,
        hosts: [
          {
            id: 'ssh:runner@localhost',
            name: 'localhost',
            address: 'runner@localhost',
            // where startRemoteHost puts the Host's socket (fixtures/remoteHost.ts REMOTE_SOCKET)
            socketPath: '/tmp/mm-remote-host/data/host.sock',
            capabilities: { shell: true },
            harnesses: [],
            // read when the seed is written, not when the worker loads this file (hostFixtureHeartbeat.invariant.test.ts)
            get lastHeartbeat() {
              return Date.now();
            },
            setup: '',
          },
        ],
      },
    },
  },
});

test('a new chat on a machine with the Worktree switch on starts in a worktree the machine makes from the picked branch', async ({
  harness,
}) => {
  const page = harness.page;
  await connectRemote(page, remote, 'claude');
  await startRemoteChat(page, 'Kimi Code', 'first-worktree', false, async () => {
    // the chip of a draft on This Mac, for the machine's folder: its checked-out branch, its branches in the picker, the Worktree switch off
    const chip = page.locator('.ctxbar .ctx-wt');
    try {
      await expect(chip.locator('.ctx-wt-branch')).toHaveText('main', { timeout: 60_000 });
    } catch (error) {
      // what the app is asking and what the machine answers, so a missing chip explains itself in the report
      const asked = await page.evaluate(
        ([id, folder]) =>
          window.native.host.gitBranches(id, { path: folder }).then(
            (reply) => JSON.stringify(reply),
            (e) => `rejected: ${String(e)}`,
          ),
        [REMOTE_ID, REMOTE_FOLDER],
      );
      await test.info().attach('host.gitBranches answer', { body: asked, contentType: 'text/plain' });
      await test.info().attach('context bar', { body: await page.locator('.ctxbar').innerHTML(), contentType: 'text/html' });
      throw error;
    }
    await chip.locator('.ctx-wt-branch').click();
    await expect(page.locator('.branch-menu .menu-title')).toHaveText(['dev', 'main']);
    await page.locator('.branch-menu .menu-item', { hasText: 'dev' }).click();
    await expect(chip.locator('.ctx-wt-branch')).toHaveText('dev');
    await chip.locator('.ctx-check').click();
    await expect(chip.locator('.ctx-check input')).toBeChecked();
  });
  await expect(page.getByRole('main')).toContainText('fake-claude: first-worktree', { timeout: 120_000 });
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 90_000 });

  // the machine made one worktree beside its repository, on a new branch that starts from dev
  const made = fs.readdirSync(WORKTREES);
  expect(made).toHaveLength(1);
  expect(made[0]).toMatch(/^mopilot%2f[0-9a-f]{8}$/);
  const worktree = path.join(WORKTREES, made[0]);
  expect(git(worktree, 'branch', '--show-current')).toMatch(/^mopilot\/[0-9a-f]{8}$/);
  expect(git(worktree, 'rev-parse', 'HEAD')).toBe(git(REMOTE_FOLDER, 'rev-parse', 'dev'));
  expect(fs.readFileSync(path.join(worktree, 'a.txt'), 'utf8')).toBe('dev\n');
  // the repository's own folder was not touched: still on main with its own file
  expect(git(REMOTE_FOLDER, 'branch', '--show-current')).toBe('main');
  expect(fs.readFileSync(path.join(REMOTE_FOLDER, 'a.txt'), 'utf8')).toBe('main\n');

  // Both separate checkouts belong to the original repository's sidebar group, including after a reload.
  const project = () =>
    page
      .getByRole('complementary')
      .locator('.project-group')
      .filter({
        has: page.locator(`.project-row[aria-label="${path.basename(REMOTE_FOLDER)}"]`),
      });
  await expect(project()).toHaveCount(1);
  await expect(project().locator('.project-row .lucide-square-terminal')).toBeVisible();
  await expect(project().locator('.project-row')).toHaveAttribute('aria-description', `On ${await machineName(page)}`);
  await expect(project().locator('.thread-row')).toHaveCount(1);
  await startRemoteChat(page, 'Kimi Code', 'second-worktree', true);
  await expect(page.getByRole('main')).toContainText('fake-claude: second-worktree', { timeout: 120_000 });
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 90_000 });
  expect(fs.readdirSync(WORKTREES)).toHaveLength(2);
  await expect(project().locator('.thread-row')).toHaveCount(2);
  await page.reload();
  await expect(project().locator('.thread-row')).toHaveCount(2);
  await expect(project().locator('.project-row .host-mark')).toHaveCount(1);
  await expect(project().locator('.thread-row .host-mark')).toHaveCount(0);
  await expect(page.getByRole('complementary').locator('.project-row[aria-label^="mopilot%2f"]')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('remote-worktrees-grouped.png') });
});
