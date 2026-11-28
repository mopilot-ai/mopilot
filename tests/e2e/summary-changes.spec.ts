// Current Changes totals follow Git through a real local merge while the conversation retains its editing history.
// e2e-covers: src/components/panels/SummaryPanel.tsx src/components/panels/SummaryChanges.tsx src/components/panels/useLocalSummaryRepo.ts
// e2e-covers: src/lib/repositoryChanges.ts src/styles/app/summary-panel.css shared/gitComparisonBase.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from './fixtures/app';
import { fakeGhBin } from './fixtures/fakeGh';
import { withPath } from './fixtures/nodeCommand';

const { dir: bin } = fakeGhBin(fs.mkdtempSync(path.join(os.tmpdir(), 'summary-changes-gh-')));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });

for (const family of [
  { label: 'Codex', harnesses: 'codex', reply: 'fake-codex' },
  { label: 'Claude Code', harnesses: 'claude', reply: 'fake-claude' },
] as const) {
  test.describe(`Changes after merge on ${family.label}`, () => {
    test.use({
      harnesses: family.harnesses,
      shellPath: [bin],
      env: { PATH: withPath([bin]) },
      seed: { uiState: { summaryOpen: true, prefs: { fontSize: 24, zoomLevel: 0 } } },
    });

    test('clears the summary without removing the historical Edited card', async ({ page, harness }, testInfo) => {
      await page.setViewportSize({ width: 1024, height: 682 });
      const repo = path.join(harness.dir, 'home', 'work', 'demo');
      const remote = path.join(harness.dir, 'origin.git');
      fs.mkdirSync(repo, { recursive: true });
      git(harness.dir, 'init', '--bare', '-q', remote);
      git(repo, 'init', '-q', '-b', 'main');
      git(repo, 'config', 'user.name', 'e2e');
      git(repo, 'config', 'user.email', 'e2e@example.com');
      fs.writeFileSync(path.join(repo, 'README.md'), 'demo\n');
      git(repo, 'add', '.');
      git(repo, 'commit', '-q', '-m', 'Initial state');
      const oldMain = git(repo, 'rev-parse', 'HEAD').trim();
      git(repo, 'remote', 'add', 'origin', remote);
      git(repo, 'push', '-q', '-u', 'origin', 'main');
      git(repo, 'switch', '-q', '-c', 'edit');
      await harness.app.evaluate(({ dialog }, folder) => {
        dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as any;
      }, repo);
      await page.getByRole('complementary').getByRole('button', { name: 'Add new project' }).click();
      const composer = page.getByRole('textbox', { name: 'Message', exact: true });
      await composer.fill('EDITFILE please');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      const approval = page.locator('.approval-card');
      await expect(approval).toContainText(`Allow ${family.label} to edit`);
      await approval.getByRole('button', { name: /Allow once/ }).click();
      await expect(page.getByRole('main').getByText(`${family.reply}: EDITFILE please [edit: written]`, { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
      const changes = page.locator('.summary-changes');
      const branch = changes.getByRole('button', { name: /Branch changes/ });
      await expect(branch).toContainText('+2 -0');
      await expect(changes.getByText(/Latest edits|Current turn|hello\.txt/)).toHaveCount(0);
      git(repo, 'add', '.');
      git(repo, 'commit', '-q', '-m', 'Add hello');
      await expect(branch).toContainText('+2 -0');
      git(repo, 'switch', '-q', 'main');
      git(repo, 'merge', '-q', '--no-ff', 'edit', '-m', 'Merge edit');
      git(repo, 'push', '-q', 'origin', 'main');
      git(repo, 'switch', '-q', 'edit');
      git(repo, 'fetch', '-q', 'origin');
      await page.getByRole('button', { name: 'Session actions', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Refresh', exact: true }).click();
      await expect(branch).toContainText('No changes');
      await expect(changes.getByText(/Latest edits|Current turn|hello\.txt/)).toHaveCount(0);
      await expect(page.getByRole('main').locator('.edited-card')).toContainText('hello.txt');
      await expect.poll(() => changes.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath('changes-after-merge.png') });
      const chatId = await page.locator('.thread-view[data-thread-id]').getAttribute('data-thread-id');
      expect(chatId).toBeTruthy();
      await page.reload();
      await page
        .locator('[data-shortcut-recents]')
        .locator(`[data-sidebar-chat=${JSON.stringify(chatId)}]`)
        .click();
      await expect(branch).toContainText('No changes');
      await expect(changes.getByText(/Latest edits|Current turn|hello\.txt/)).toHaveCount(0);
      await expect(page.getByRole('main').locator('.edited-card')).toContainText('hello.txt');
      // A repository cutover can leave origin with a history-free snapshot and local main behind the session.
      fs.writeFileSync(path.join(repo, 'upstream-only.txt'), 'upstream\n');
      git(repo, 'add', 'upstream-only.txt');
      git(repo, 'commit', '-q', '-m', 'Advance internal main');
      git(repo, 'update-ref', 'refs/remotes/internal/main', 'HEAD');
      git(repo, 'update-ref', 'refs/heads/main', oldMain);
      git(repo, 'switch', '-q', '--orphan', 'snapshot');
      git(repo, 'commit', '-q', '--allow-empty', '-m', 'Unrelated origin snapshot');
      git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
      git(repo, 'switch', '-q', 'edit');
      fs.appendFileSync(path.join(repo, 'hello.txt'), 'pending\n');
      await page.getByRole('button', { name: 'Session actions', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Refresh', exact: true }).click();
      await expect(branch).toContainText('1 file');
      await expect(branch).toContainText('+1 -0');
      await branch.click();
      const pane = page.locator('.changes-pane');
      await expect(pane.locator('.cp-scope')).toContainText('Branch');
      await expect(pane.locator('[data-path="hello.txt"]').first()).toBeVisible();
      await expect(pane.locator('[data-path="upstream-only.txt"]')).toHaveCount(0);
    });
  });
}
