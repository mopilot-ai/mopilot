// The PR inbox and a PR its author holds with do-not-merge (designs/prs-needing-you): checks passed and GitHub could merge
// it, but it is on its way, held, never "Ready to merge" for the user; the sidebar's count and the status line say nothing
// needs the user (#3640, a phone PR held for the batch merge).
// Covers 'src/components/thread/PrInbox.tsx' and 'src/lib/prInbox.ts'.
// e2e-covers: src/components/sidebar/SidebarInboxCount.tsx src/session/chatRowState.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from './fixtures/app';
import { fakeGhBin, PR_URL } from './fixtures/fakeGh';
import { withPath } from './fixtures/nodeCommand';

const ROOT = '019c0000-0000-7000-8000-0000000000b1';
const CHILD = '019c0000-0000-7000-8000-0000000000b2';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-inbox-held-'));
const stateFile = path.join(tmp, 'pr.json');
// passed its checks, mergeable, labelled not to merge yet, with no merge-robot status
fs.writeFileSync(
  stateFile,
  JSON.stringify({
    mergeStateStatus: 'CLEAN',
    labels: [{ name: 'do-not-merge' }],
    statusCheckRollup: [{ __typename: 'StatusContext', context: 'unit-tests', state: 'SUCCESS' }],
  }),
);
const { dir: BIN } = fakeGhBin(path.join(tmp, 'bin'), { FAKE_GH_STATE_FILE: stateFile });

test.use({
  harnesses: 'codex',
  shellPath: [BIN],
  env: { PATH: withPath([BIN]) },
  seed: {
    codexThreads: [
      { id: ROOT, name: 'Release round', turns: ['Start a session'] },
      { id: CHILD, name: 'Stream batching', turns: ['Batch long output'] },
    ],
    files: ({ userData }) => {
      fs.writeFileSync(
        path.join(userData, 'orchestration.json'),
        JSON.stringify({
          schemaVersion: 1,
          children: {
            [CHILD]: {
              parentId: ROOT,
              name: 'stream-batching',
              title: 'stream-batching',
              harness: 'codex',
              useWorktree: false,
              cwd: '',
              createdAt: 1,
              driven: [],
              lastReport: { how: 'finished', report: 'Opened the PR.', at: 1 },
              facts: {
                branch: 'topic',
                base: 'main',
                ahead: 1,
                files: 1,
                added: 3,
                removed: 1,
                uncommitted: 0,
                pr: { number: 7, state: 'OPEN', url: PR_URL },
                at: 1,
              },
            },
          },
          parents: {},
          deliveries: {},
          proposals: {},
          queue: [],
          plans: {},
          wrapUps: {},
          dependants: {},
        }),
      );
    },
  },
});

test("a PR held with do-not-merge is on its way, not the user's to merge", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.getByRole('complementary').locator(`[data-sidebar-chat="${ROOT}"]`).first().click();
  const count = page.getByRole('button', { name: 'Pull requests: 1 open' });
  await expect(count).toBeVisible({ timeout: 45_000 });
  await count.click();
  const tray = page.getByRole('dialog', { name: 'Pull requests' });
  await expect(tray.locator('[data-group="needs"]')).toHaveCount(0);
  const track = tray.getByRole('region', { name: 'Open' }).getByLabel('Held · do-not-merge');
  await expect(track.locator('[data-at]')).toHaveText(['Checks', 'Held · do-not-merge', 'Main']);
  await expect(tray.getByText('Ready to merge')).toHaveCount(0);
  await expect(tray.getByRole('button', { name: 'Review & merge' })).toHaveCount(0);
  // neither the parent nor the held PR's own chat asks the user for input
  for (const id of [ROOT, CHILD]) {
    const row = page.getByRole('complementary').locator(`[data-sidebar-chat="${id}"]`).first();
    await expect(row).toBeVisible();
    await expect(row.getByRole('img', { name: /^\d+ requests? needs? you$/ })).toHaveCount(0);
  }
  await page.screenshot({ path: testInfo.outputPath('held.png') });
});
