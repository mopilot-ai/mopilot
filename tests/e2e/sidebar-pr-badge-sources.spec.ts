// A Claude Code chat's sidebar PR badge: from a reply that links the PR in parentheses, and from the chat's PR monitor
// binding when nothing else names it (#3041's chat showed no badge for either).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from './fixtures/app';
import { fakeGhBin, PR_URL } from './fixtures/fakeGh';
import { withPath } from './fixtures/nodeCommand';

const LINKED = '6a1f0c2e-3b4d-4e5f-8a9b-0c1d2e3f4a51';
const BOUND = '6a1f0c2e-3b4d-4e5f-8a9b-0c1d2e3f4a52';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-pr-badge-sources-'));
const { dir: BIN } = fakeGhBin(path.join(root, 'bin'));

test.use({
  harnesses: 'claude',
  shellPath: [BIN],
  env: { PATH: withPath([BIN]) },
  seed: {
    claudeSessions: [
      // the fake replies "fake-claude: <text>": the reply links the PR in parentheses, as #3041's chat did
      {
        id: LINKED,
        cwd: 'pr-project',
        title: 'Linked in parentheses',
        turns: [`The change is up as PR #7 (${PR_URL}), but it is not merged yet.`],
      },
      { id: BOUND, cwd: 'pr-project', title: 'Bound by its monitor', turns: ['hello'] },
    ],
    // the PR monitor's store: the second chat is bound to the PR, which no reply of it names
    userData: {
      'pr-monitors.json': [{ chatId: `claude:${BOUND}`, url: PR_URL, autoFix: false, addressComments: false, seen: [], claim: null }],
    },
  },
});

test('a Claude Code chat shows its PR badge from a parenthesized link and from its PR monitor binding', async ({ page }, testInfo) => {
  const side = page.getByRole('complementary');
  for (const [id, title] of [
    [LINKED, 'Linked in parentheses'],
    [BOUND, 'Bound by its monitor'],
  ]) {
    await expect(side.getByText(title, { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    const row = side.locator(`[data-sidebar-chat="claude:${id}"]`).first();
    await expect(row.locator('.thread-pr-badge')).toHaveAttribute('aria-label', /PR #7/, { timeout: 30_000 });
  }
  await page.screenshot({ path: testInfo.outputPath('sidebar.png') });
});
