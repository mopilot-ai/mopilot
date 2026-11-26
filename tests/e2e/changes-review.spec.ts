// The Changes review journey on both harnesses: Viewed/scope ownership, retained GitHub comment drafts and a late post that cannot close a newer editor; GitHub is answered inside the app.
// e2e-covers: src/components/panels/SummaryChanges.tsx src/components/panels/SummaryPanel.tsx src/components/panels/useLocalSummaryRepo.ts src/styles/app/summary-panel.css
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/app';
import { shootBoth, SYSTEM_THEME } from './fixtures/shoot';
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

for (const family of [
  { harnesses: 'codex', reply: 'fake-codex' },
  { harnesses: 'claude', reply: 'fake-claude' },
] as const) {
  test.describe(`Changes review on ${family.harnesses}`, () => {
    test.use({
      harnesses: family.harnesses,
      seed: { uiState: { summaryOpen: true, prefs: { ...SYSTEM_THEME.prefs, fontSize: 24, zoomLevel: 0 } } },
    });
    test('keeps review progress scoped and preserves comment ownership across a pending post', async ({ page, harness }) => {
      const repo = path.join(harness.dir, 'home', 'work', 'review');
      fs.mkdirSync(repo, { recursive: true });
      git(repo, 'init', '-q', '-b', 'main');
      git(repo, 'config', 'user.name', 'e2e');
      git(repo, 'config', 'user.email', 'e2e@example.com');
      fs.writeFileSync(path.join(repo, 'a.ts'), 'const before = 1;\n');
      git(repo, 'add', '.');
      git(repo, 'commit', '-q', '-m', 'Initial');
      git(repo, 'switch', '-q', '-c', 'review');
      fs.writeFileSync(path.join(repo, 'a.ts'), 'const after = 2;\n');
      git(repo, 'commit', '-qam', 'Edit');
      const head = git(repo, 'rev-parse', 'HEAD');
      const patch = git(repo, 'diff', 'main');
      await harness.app.evaluate(
        ({ ipcMain, dialog }, input) => {
          const state = { finish: null as null | ((answer: boolean) => void), calls: [] as string[][] };
          (globalThis as any).__changesReview = state;
          ipcMain.removeHandler('gh:run');
          ipcMain.handle('gh:run', async (_event, _cwd, args: string[]) => {
            state.calls.push(args);
            let output: unknown = {};
            if (args[0] === 'pr' && args[1] === 'diff') return { ok: true, code: 0, stderr: '', stdout: input.patch };
            if (args[0] === 'pr' && args[1] === 'view')
              output = {
                url: 'https://github.com/acme/demo/pull/7',
                number: 7,
                title: 'Review change',
                state: 'OPEN',
                headRefOid: input.head,
              };
            if (args[1] === 'graphql')
              output = {
                data: {
                  repository: {
                    pullRequest: {
                      headRefOid: input.head,
                      reviewThreads: {
                        pageInfo: { hasNextPage: false },
                        nodes: [
                          {
                            id: 'thread1',
                            path: 'a.ts',
                            line: 1,
                            diffSide: 'RIGHT',
                            isResolved: false,
                            isOutdated: false,
                            comments: {
                              pageInfo: { hasNextPage: false },
                              nodes: [
                                {
                                  id: 'c1',
                                  author: { login: 'reviewer' },
                                  body: 'Please check this line',
                                  url: 'https://github.com/acme/demo/pull/7#c1',
                                },
                              ],
                            },
                          },
                        ],
                      },
                    },
                  },
                },
              };
            if (args[1]?.endsWith('/comments')) {
              const accepted = await new Promise<boolean>((resolve) => {
                state.finish = (answer) => {
                  state.finish = null;
                  resolve(answer);
                };
              });
              if (!accepted) return { ok: false, code: 1, stderr: 'Network unavailable', stdout: '' };
            }
            return { ok: true, code: 0, stderr: '', stdout: JSON.stringify(output) };
          });
          dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [input.repo] })) as any;
        },
        { repo, head, patch },
      );
      await page.getByRole('complementary').getByRole('button', { name: 'Add new project' }).click();
      const composer = page.getByRole('textbox', { name: 'Message', exact: true });
      await composer.fill('review this change');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(page.getByRole('main').getByText(`${family.reply}: review this change`, { exact: true })).toBeVisible();
      await page
        .locator('.summary-panel')
        .getByRole('button', { name: /Branch changes/ })
        .click();
      const pane = page.locator('.changes-pane');
      await expect(pane.locator('[data-thread="thread1"]')).toContainText('Please check this line');
      const viewed = pane.getByRole('checkbox', { name: 'Viewed a.ts', exact: true });
      await viewed.check();
      await expect(pane.locator('.idiff')).toHaveCount(0);
      await viewed.uncheck();
      await expect(pane.locator('.idiff')).toBeVisible();
      await pane.locator('.diff-comment-add').first().click();
      const box = pane.getByRole('textbox', { name: 'Diff comment' });
      await box.fill('keep the original comment');
      await page.setViewportSize({ width: 1024, height: 682 });
      await page.screenshot({ path: test.info().outputPath('review-comment-before-post.png') });
      await expect
        .poll(
          async () => {
            const [diff, panel] = await Promise.all([pane.locator('.cp-diffs').boundingBox(), pane.boundingBox()]);
            return !!diff && !!panel && diff.width >= panel.width * 0.9;
          },
          { message: 'A narrow pane stacks its file list so the diff remains usable' },
        )
        .toBe(true);
      const post = pane.getByRole('button', { name: 'Comment on GitHub', exact: true });
      await expect
        .poll(
          async () => {
            const [button, bounds] = await Promise.all([post.boundingBox(), pane.locator('.cp-diffs').boundingBox()]);
            return !!button && !!bounds && button.x >= bounds.x && button.x + button.width <= bounds.x + bounds.width;
          },
          { message: 'Post actions remain inside the diff column' },
        )
        .toBe(true);
      await expect
        .poll(
          () =>
            pane.locator('.diff-comment-actions').evaluate((element) => {
              const buttons = [...element.querySelectorAll('button')];
              return buttons.every((button, index) => {
                const a = button.getBoundingClientRect();
                return (
                  button.scrollHeight <= button.clientHeight + 1 &&
                  button.scrollWidth <= button.clientWidth + 1 &&
                  buttons.slice(index + 1).every((other) => {
                    const b = other.getBoundingClientRect();
                    return a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
                  })
                );
              });
            }),
          { message: 'Wrapped comment labels fit without overlapping other actions' },
        )
        .toBe(true);
      await post.click();
      await expect(pane.getByRole('button', { name: 'Posting…' })).toBeDisabled();
      await box.press('Enter');
      await expect(box).toHaveValue('keep the original comment');
      await expect(pane.locator('.diff-comment-pending')).toHaveCount(0);
      await expect.poll(() => harness.app.evaluate(() => typeof (globalThis as any).__changesReview.finish)).toBe('function');
      await harness.app.evaluate(() => {
        (globalThis as any).__changesReview.finish(false);
      });
      await expect(pane.getByRole('button', { name: 'Comment on GitHub', exact: true })).toBeEnabled();
      await expect(box).toHaveValue('keep the original comment');
      await pane.getByRole('button', { name: 'Comment on GitHub', exact: true }).click();
      await expect(pane.getByRole('button', { name: 'Posting…' })).toBeDisabled();
      await box.press('Escape');
      await pane.locator('.diff-comment-add').last().click();
      await box.fill('newer comment draft');
      await expect.poll(() => harness.app.evaluate(() => typeof (globalThis as any).__changesReview.finish)).toBe('function');
      await harness.app.evaluate(() => {
        (globalThis as any).__changesReview.finish(true);
      });
      await expect(page.getByText('Comment posted on GitHub', { exact: true })).toBeVisible();
      await expect(box).toHaveValue('newer comment draft');
      await box.press('Escape');
      fs.writeFileSync(path.join(repo, 'a.ts'), 'const local = 3;\n');
      await pane.getByRole('button', { name: 'Refresh', exact: true }).click();
      await expect(pane.locator('.cp-diffs')).toContainText('const local = 3;');
      await pane.locator('.cp-scope').click();
      await page.getByRole('menuitemcheckbox', { name: 'Uncommitted changes', exact: true }).click();
      await expect(viewed).not.toBeChecked();
      for (const width of [1440, 1024]) {
        await page.setViewportSize({ width, height: 682 });
        await shootBoth(page, harness.app, `changes-review-${width}`);
      }
    });
  });
}
