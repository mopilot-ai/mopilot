// The PR inbox's row for a bug fix the merge robot holds unverified (designs/prs-needing-you): on its way, since only
// a question needs the user, it says what the "Verified the fix" section lacks in the gate's own words, and Ask to
// verify sends the request to the PR's session, which shows it in its transcript; Open PR stays for the user.
// Covers 'src/components/thread/PrInbox.tsx' and 'src/lib/prInbox.ts'.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from './fixtures/app';
import { fakeGhBin, PR_URL } from './fixtures/fakeGh';
import { withPath } from './fixtures/nodeCommand';

const ROOT = '019c0000-0000-7000-8000-0000000000b1';
const CHILD = '019c0000-0000-7000-8000-0000000000b2';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-inbox-verify-'));
const stateFile = path.join(tmp, 'pr.json');
// passed its checks; the robot's own status pending, as the train leaves it
fs.writeFileSync(
  stateFile,
  JSON.stringify({
    mergeStateStatus: 'CLEAN',
    labels: [{ name: 'merge-on-green' }],
    statusCheckRollup: [
      { __typename: 'StatusContext', context: 'unit-tests', state: 'SUCCESS' },
      { __typename: 'StatusContext', context: 'merge-on-green', state: 'PENDING' },
    ],
  }),
);
const { dir: BIN } = fakeGhBin(path.join(tmp, 'bin'), {
  FAKE_GH_STATE_FILE: stateFile,
  FAKE_GH_GATE_STATUS: JSON.stringify({
    state: 'pending',
    // the gate's real words for #3614, cut at 140 characters as the robot posts them
    description:
      'Held: its "Verified the fix" section defers the check: check the original repro once in the real environment and record the steps, the resul',
  }),
});

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

test('a fix held unverified says what its section lacks and asks its session to verify', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.getByRole('complementary').locator(`[data-sidebar-chat="${ROOT}"]`).first().click();
  const count = page.getByRole('button', { name: 'Pull requests: 1 open' });
  await expect(count).toBeVisible({ timeout: 45_000 });
  await count.click();
  const tray = page.getByRole('dialog', { name: 'Pull requests' });
  const needs = tray.getByRole('region', { name: 'Open' });
  await expect(needs.getByText('Verify fix', { exact: true })).toBeVisible();
  await expect(needs.getByText('"Verified the fix" reads as not done yet')).toBeVisible();
  await expect(needs.getByRole('button', { name: 'Open PR' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('held.png') });
  await needs.getByRole('button', { name: 'Ask to verify' }).click();
  await expect(needs.getByText('Asked', { exact: true })).toBeVisible();
  await expect(needs.getByRole('button', { name: 'Ask to verify' })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('asked.png') });
  // the request reached the session, as its next turn
  await page.keyboard.press('Escape');
  await page.getByRole('complementary').locator(`[data-sidebar-chat="${CHILD}"]`).first().click();
  await expect(
    page.getByText(/The merge gate holds #7: its "Verified the fix" section reads as if the check was put off/).first(),
  ).toBeVisible({
    timeout: 30_000,
  });
  await page.screenshot({ path: testInfo.outputPath('session.png') });
});
