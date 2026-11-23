// Remote PR deliveries, branch-only badges and saved merge reports through the real renderer and preload.
// e2e-covers: src/components/markdown/PullRequestLink.tsx src/components/sidebar/ThreadRow.tsx src/components/sidebar/ThreadPullRequestBadge.tsx src/lib/responsePullRequest.ts src/lib/threadPullRequest.ts src/styles/app/sidebar.css
// e2e-covers: src/components/markdown/Markdown.tsx src/components/markdown/prReferenceTime.ts src/components/thread/view/TurnView.tsx shared/pullRequest.mjs
import { test, expect } from './fixtures/app';

const TABLE = '019c0000-0000-7000-8000-0000000000f1';
const BRANCH = '019c0000-0000-7000-8000-0000000000f2';
const NO_PR = '019c0000-0000-7000-8000-0000000000f3';
const RETIRED = '019c0000-0000-7000-8000-0000000000f4';
const RENAMED = '019c0000-0000-7000-8000-0000000000f5';
const FIRST = 'https://github.com/acme/demo/pull/7';
const SECOND = 'https://github.com/acme/demo/pull/8';
const RETIRED_LINK = 'https://github.com/acme/retired/pull/42';
const RENAMED_OLD_LINK = 'https://github.com/mopilot-ai/mopilot/pull/5390';
const RENAMED_NEW_LINK = 'https://github.com/mopilot-ai/mopilot-internal/pull/5390';
const message = `Both PRs are merged, and I confirmed each merge commit is in remote main.

| PR | What | Merge commit |
| --- | --- | --- |
| [acme/demo#7](${FIRST}) | Codex sign-in on a remote machine | \`fd1256781\` |
| [acme/demo#8](${SECOND}) | One Run on picker | \`a1e675308\` |`;

test.use({
  harnesses: 'codex',
  env: {
    FAKE_CODEX_THREADS: JSON.stringify([
      {
        id: TABLE,
        name: 'Remote PR table',
        cwd: '/remote/work/table',
        turns: [
          { text: 'Report the merged work', items: [{ type: 'agentMessage', id: 'table-reply', phase: 'final_answer', text: message }] },
        ],
      },
      { id: BRANCH, name: 'Remote branch only', cwd: '/remote/work/branch', turns: ['Work complete.'] },
      { id: NO_PR, name: 'Remote chat without a PR', cwd: '/remote/work/table', turns: ['Work complete.'] },
      {
        id: RENAMED,
        name: 'Remote renamed repository PR',
        cwd: '/remote/work/renamed',
        turns: [
          {
            text: 'Open a PR',
            completedAt: Date.parse('2026-11-21T08:21:54Z') / 1_000,
            items: [{ type: 'agentMessage', id: 'before-rename', phase: 'final_answer', text: `Opened [PR #5390](${RENAMED_OLD_LINK}).` }],
          },
        ],
      },
      {
        id: RETIRED,
        name: 'Remote retired PR link',
        cwd: '/remote/work/retired',
        turns: [
          {
            text: 'Open a PR',
            items: [{ type: 'agentMessage', id: 'open-reply', phase: 'final_answer', text: `Opened [PR #42](${RETIRED_LINK}).` }],
          },
          {
            text: 'Merge the PR',
            items: [
              {
                type: 'agentMessage',
                id: 'merge-reply',
                phase: 'final_answer',
                text: `Merged [acme/retired#42](${RETIRED_LINK}) into remote \`main\` and verified that it contains fix commit \`abc123\` and merge commit \`def456\`.`,
              },
            ],
          },
        ],
      },
    ]),
  },
  seed: { uiState: { prefs: { fontSize: 24, zoomLevel: 0 } } },
});

test('remote sidebar badges recover saved merges and refresh live PRs from GitHub', async ({ page, harness }, testInfo) => {
  // Only external I/O is faked. The machine-folder gate, history parser, shared caches, preload and rendered badges are real.
  await harness.app.evaluate(
    ({ ipcMain }, { chatIds, retiredLink, renamedOldLink, renamedNewLink }) => {
      const state = { pr: 'OPEN', hostReads: [] as { machine: string; path: string }[] };
      (globalThis as any).__remotePrRepro = state;
      for (const channel of ['host:access', 'host:remoteChats', 'host:machines', 'host:gitStatus', 'gh:run'])
        ipcMain.removeHandler(channel);
      ipcMain.handle('host:access', () => true);
      ipcMain.handle('host:remoteChats', () => chatIds.map((chatId) => ({ chatId, hostId: 'remote-box' })));
      ipcMain.handle('host:machines', () => ({
        resolved: true,
        machines: [{ id: 'remote-box', name: 'Remote laptop', status: 'online', note: '' }],
      }));
      ipcMain.handle('host:gitStatus', (_event, machine, { path }) => {
        state.hostReads.push({ machine, path });
        return path === '/remote/work/branch'
          ? { value: { isRepo: true, branch: 'fix/remote', remote: 'https://github.com/acme/demo.git' } }
          : { value: { isRepo: false } };
      });
      ipcMain.handle('gh:run', (_event, _cwd, args: string[]) => {
        if (args[0] === 'api') return { ok: true, stdout: args[1] === 'user' ? 'octo' : 'null' };
        const url = args.includes('--') ? args[args.indexOf('--') + 1] : 'https://github.com/acme/demo/pull/9';
        if (url === retiredLink) return { ok: false, stdout: '', stderr: 'Could not resolve to a PullRequest with the number of 42' };
        if (url === renamedOldLink) return { ok: false, stdout: '', stderr: 'Could not resolve to a PullRequest with the number of 5390' };
        if (url === renamedNewLink) return { ok: true, stdout: JSON.stringify({ url, state: 'MERGED' }) };
        const pr = { url, state: state.pr, isDraft: false, title: 'Remote work', statusCheckRollup: [] };
        return { ok: true, stdout: JSON.stringify(args[1] === 'list' ? [pr] : pr) };
      });
    },
    {
      chatIds: [TABLE, BRANCH, NO_PR, RETIRED, RENAMED],
      retiredLink: RETIRED_LINK,
      renamedOldLink: RENAMED_OLD_LINK,
      renamedNewLink: RENAMED_NEW_LINK,
    },
  );
  await page.reload();
  await page.setViewportSize({ width: 1024, height: 682 });
  const sidebar = page.getByRole('complementary');
  const tableRow = sidebar.locator(`[data-sidebar-chat="${TABLE}"]`).first();
  const branchRow = sidebar.locator(`[data-sidebar-chat="${BRANCH}"]`).first();
  const noPrRow = sidebar.locator(`[data-sidebar-chat="${NO_PR}"]`).first();
  const retiredBadge = sidebar.locator(`[data-sidebar-chat="${RETIRED}"]`).first().locator('.thread-pr-badge');
  const renamedRow = sidebar.locator(`[data-sidebar-chat="${RENAMED}"]`).first();
  await expect(tableRow.locator('.thread-pr-badge')).toHaveAttribute('aria-label', /2 pull requests/, { timeout: 30_000 });
  await expect(branchRow.locator('.thread-pr-badge')).toHaveAttribute('aria-label', /PR #9 · open/, { timeout: 30_000 });
  await expect(retiredBadge).toHaveAttribute('aria-label', 'PR #42 · reported merged', { timeout: 30_000 });
  await expect(retiredBadge).toHaveClass(/\bmerged\b/);
  await expect(renamedRow.locator('.thread-pr-badge')).toHaveAttribute('aria-label', 'PR #5390 · merged', { timeout: 30_000 });
  await expect(noPrRow.locator('.host-mark')).toBeVisible();
  await expect(noPrRow.locator('.thread-pr-badge')).toHaveCount(0);
  const locationXs = await Promise.all(
    [tableRow, branchRow, noPrRow].map(async (row) => (await row.locator('.host-mark').boundingBox())!.x),
  );
  expect(locationXs.slice(1)).toEqual([locationXs[0], locationXs[0]]);
  expect(await harness.app.evaluate(() => (globalThis as any).__remotePrRepro.hostReads)).toContainEqual({
    machine: 'remote-box',
    path: '/remote/work/branch',
  });

  await renamedRow.click();
  const renamedChip = page.locator('.assistant-message .md-pr-chip');
  await expect(renamedChip).toHaveAttribute('href', RENAMED_NEW_LINK);
  await expect(renamedChip).toHaveClass(/\bmerged\b/);

  await tableRow.click();
  const chips = page.locator('.assistant-message .md-pr-chip');
  await expect(chips).toHaveCount(2);
  await expect(chips.first()).toHaveClass(/\bopen\b/);
  await expect(chips.last()).toHaveClass(/\bopen\b/);
  await harness.app.evaluate(() => {
    (globalThis as any).__remotePrRepro.pr = 'MERGED';
  });
  // Keep the cache clock inside its minute: taking focus must itself obtain the current status.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(chips.first()).toHaveClass(/\bmerged\b/, { timeout: 10_000 });
  await expect(chips.last()).toHaveClass(/\bmerged\b/, { timeout: 10_000 });
  await expect(tableRow.locator('.thread-pr-badge')).toHaveClass(/\bmerged\b/);
  await expect(branchRow.locator('.thread-pr-badge')).toHaveClass(/\bmerged\b/);
  await page.screenshot({ path: testInfo.outputPath('remote-pr-merged.png') });
});
