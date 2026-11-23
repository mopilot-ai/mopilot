// The sidebar chat menu's Open PR shows as the menu opens, from the PR the row's badge already read, not after GitHub answers again.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from './fixtures/app';
import { fakeGhBin, PR_URL } from './fixtures/fakeGh';
import { withPath } from './fixtures/nodeCommand';

const CHAT = '019c0000-0000-7000-8000-0000000000b1';
/** how long each `gh pr view` takes: the menu waited this long for Open PR before the fix */
const DELAY = 5_000;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-menu-pr-'));
const { dir: BIN } = fakeGhBin(path.join(root, 'bin'));

test.use({
  harnesses: 'codex',
  shellPath: [BIN],
  env: { PATH: withPath([BIN]), FAKE_GH_DELAY_MS: String(DELAY) },
  seed: { codexThreads: [{ id: CHAT, name: 'A pull request', turns: [`Opened pull request ${PR_URL}`] }] },
});

test('Open PR is in the chat menu as it opens, every time, while GitHub is slow', async ({ page }, testInfo) => {
  const row = page.getByRole('complementary').locator(`[data-sidebar-chat="${CHAT}"]`).first();
  // the row's badge reads the PR once, slowly
  await expect(row.locator('.thread-pr-badge')).toHaveAttribute('aria-label', /PR #7/, { timeout: 30_000 });
  for (let opening = 0; opening < 3; opening++) {
    await row.hover();
    const started = Date.now();
    await row.getByRole('button', { name: 'More options' }).click();
    const item = page.getByRole('menuitem', { name: 'Open PR' });
    await expect(item).toBeVisible({ timeout: DELAY * 0.4 });
    const shown = Date.now() - started;
    testInfo.annotations.push({ type: 'open-pr-ms', description: `opening ${opening + 1}: ${shown} ms` });
    console.log(`opening ${opening + 1}: Open PR shown after ${shown} ms`);
    expect(shown).toBeLessThan(DELAY * 0.4);
    if (opening === 0) await page.screenshot({ path: testInfo.outputPath('menu.png') });
    await page.keyboard.press('Escape');
    await expect(item).toBeHidden();
  }
});
