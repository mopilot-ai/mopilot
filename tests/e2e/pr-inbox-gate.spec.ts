// The PR inbox and this repository's merge robot (designs/prs-needing-you): a session's PR that passed its checks and
// waits in the merge train is on its way, not "checks running", and its row shows the robot's four steps with the
// train's other pull requests counted (the gate's own words, read from the commit statuses).
// Covers 'src/components/thread/PrInbox.tsx' and 'src/lib/prInbox.ts'.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from './fixtures/app';
import { fakeGhBin, PR_URL } from './fixtures/fakeGh';
import { withPath } from './fixtures/nodeCommand';

const ROOT = '019c0000-0000-7000-8000-0000000000b1';
const CHILD = '019c0000-0000-7000-8000-0000000000b2';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-inbox-gate-'));
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
    description: "In the merge train 65b9a6e with #7, #9; it lands when main's suites pass on it",
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

test("a PR in the merge train is on its way, on the robot's four steps", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.getByRole('complementary').locator(`[data-sidebar-chat="${ROOT}"]`).first().click();
  const count = page.getByRole('button', { name: 'Pull requests: 1 open' });
  await expect(count).toBeVisible({ timeout: 45_000 });
  await count.click();
  const tray = page.getByRole('dialog', { name: 'Pull requests' });
  const track = tray.getByLabel('In a train with 1 more');
  await expect(track).toBeVisible();
  await expect(track.locator('[data-at]')).toHaveText(['Checks', 'Gate', 'In a train with 1 more', 'Main']);
  await expect(track.locator('[data-at="done"]')).toHaveCount(2);
  await expect(tray.getByText('Checks running')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('train.png') });
});
