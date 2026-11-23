// A historical PR cited in CI analysis gets no sidebar badge, while a real work report still does, across reloads.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from './fixtures/app';
import { fakeGhBin, PR_URL } from './fixtures/fakeGh';
import { withPath } from './fixtures/nodeCommand';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-pr-citations-'));
const { dir: BIN, log } = fakeGhBin(path.join(root, 'bin'));
const CITED_URL = 'https://github.com/acme/demo/pull/2961';
const cited = `[PR #2961](${CITED_URL}) explicitly says repeated CI retests led to combining slices into a 643-file PR.`;
const opened = `Opened [PR #7](${PR_URL}).`;
const CODEX_CITED = '019c0000-0000-7000-8000-000000002961';
const CODEX_OWNED = '019c0000-0000-7000-8000-000000002962';
const CLAUDE_CITED = '6a1f0c2e-3b4d-4e5f-8a9b-0c1d2e3f2961';
const CLAUDE_OWNED = '6a1f0c2e-3b4d-4e5f-8a9b-0c1d2e3f2962';

test.use({
  harnesses: 'both',
  shellPath: [BIN],
  env: { PATH: withPath([BIN]) },
  seed: {
    codexThreads: [
      { id: CODEX_CITED, name: 'CI analysis citation', cwd: 'pr-project', turns: [cited, 'The PR is not merged yet.'] },
      { id: CODEX_OWNED, name: 'Actual work report', cwd: 'pr-project', turns: [opened] },
    ],
    claudeSessions: [
      { id: CLAUDE_CITED, title: 'Historical CI citation', cwd: 'pr-project', turns: [cited, 'The PR is not merged yet.'] },
      { id: CLAUDE_OWNED, title: 'Actual PR work', cwd: 'pr-project', turns: [opened] },
    ],
  },
});

test('only PR work gets a sidebar badge; cited history stays unrelated after reload', async ({ page, harness }, testInfo) => {
  await page.setViewportSize({ width: 1024, height: 682 });
  const side = page.getByRole('complementary');
  for (const phase of ['first-read', 'saved-replies']) {
    for (const id of [CODEX_OWNED, `claude:${CLAUDE_OWNED}`]) {
      const row = side.locator(`[data-sidebar-chat="${id}"]`).first();
      await expect(row).toBeVisible({ timeout: 30_000 });
      await expect(row.locator('.thread-pr-badge')).toHaveAttribute('aria-label', /PR #7/, { timeout: 30_000 });
    }
    // Wait for each citation's history read to reach the durable replies store before asserting its badge is absent.
    const file = path.join(harness.env.MOPILOT_USER_DATA, 'pull-request-replies.json');
    await expect
      .poll(
        () => {
          if (!fs.existsSync(file)) return false;
          const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
          return [CODEX_CITED, `claude:${CLAUDE_CITED}`].every((id) => saved.chats?.[id]);
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    for (const id of [CODEX_CITED, `claude:${CLAUDE_CITED}`]) {
      const row = side.locator(`[data-sidebar-chat="${id}"]`).first();
      await expect(row).toBeVisible();
      await expect(row.locator('.thread-pr-badge')).toHaveCount(0);
    }
    await page.screenshot({ path: testInfo.outputPath(`${phase}.png`) });
    if (phase === 'first-read') await page.reload();
  }
  const calls = fs.readFileSync(log, 'utf8');
  expect(calls).toContain(PR_URL);
  expect(calls).not.toContain(CITED_URL);
});
