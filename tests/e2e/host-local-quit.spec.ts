// e2e-runner: bench
// Remote Run S11 in the real app: a chat on "This Mac · keeps running" outlives the app. A dev build with host.local on installs its background Host as a launch agent (host:addLocal), a chat on the repo's fake ACP agent waits on a permission card there, and the app quits (the exit sheet lists what keeps running) or is killed with SIGKILL; after a wait the app opens again on the same data, the Host is the process it was, the card it waits on is drawn again, and answering it ends the turn with nothing marked interrupted.
// It installs a per-user launch agent, so it runs only where that is safe: a CI runner or an isolated VM (MOPILOT_ACCEPT_VM=1, which `scripts/host-accept.mjs --milestone M5 --app-repo` sets). Named on the command line only: `node scripts/ci-cuj.mjs --spec tests/e2e/host-local-quit.spec.ts`.
import { test, expect } from './fixtures/app';
import { HOME, agentRuns, hostPid, installThisMac, removeHostFiles, showIgnored, startChatOnThisMac } from './fixtures/hostLocal';
import type { Harness } from './fixtures/app';

test.skip(process.platform !== 'darwin', 'the Host runs as a launchd agent on macOS');
test.skip(!process.env.GITHUB_ACTIONS && !process.env.MOPILOT_ACCEPT_VM, 'a runner or an isolated VM only: it installs a launch agent');

const ASK = 'PERMIT outlive the app';
/** How long the app stays gone before it opens again (the plan's acceptance run waits five minutes). */
const AWAY_MS = Number(process.env.S11_AWAY_MS || 20_000);

test.describe.configure({ mode: 'serial' });
test.setTimeout(10 * 60_000);
test.use({
  harnesses: 'codex',
  acp: { kimi: {} },
  env: { MOPILOT_HOST_DEV: '1', MOPILOT_FLAGS: 'host.local=1', HOME },
  seed: { uiState: { prefs: { confirmClose: 'shortcut' } } },
});

/** Install the Host for this user from the app, start a chat on it that waits on a permission card, and return the Host's process. */
async function startWaitingChat(h: Harness) {
  await installThisMac(h);
  await startChatOnThisMac(h, ASK);
  // the turn is running on the Host and waits for an answer
  await expect(h.page.locator('.approval-card')).toBeVisible({ timeout: 60_000 });
  return hostPid()!;
}

/** The app opens again after `AWAY_MS`: the Host is the one that was, the card is back, and Allow ends the turn with nothing interrupted. */
async function reopenAndFinish(h: Harness, pid: string) {
  await new Promise((r) => setTimeout(r, AWAY_MS));
  expect(hostPid(), 'the Host is the process it was while the app was gone').toBe(pid);
  expect(agentRuns(), 'the agent kept its turn while the app was gone').toBe(true);
  await h.relaunch();
  showIgnored(h);
  const page = h.page;
  await page.getByRole('complementary').locator('[data-sidebar-chat^="acp:"]', { hasText: ASK }).first().click();
  // the turn is still running on the Host, the card it waits on is drawn again (#4542), and Allow ends the turn with nothing shown as interrupted
  await expect(page.locator('.approval-card')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/interrupted|host_restarted/i)).toHaveCount(0);
  const waiting = await page.evaluate(() => window.native.host.attentions());
  expect(Object.values(waiting).map((a) => a?.kind)).toContain('approval');
  await page.keyboard.press('1');
  await expect(page.getByRole('main').getByText(/fake-acp: .*PERMIT outlive the app/)).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.approval-card')).toHaveCount(0);
  await expect(page.getByText(/interrupted|host_restarted/i)).toHaveCount(0);
  expect(hostPid(), 'the Host was not replaced while the app came back').toBe(pid);
  await page.evaluate(() => window.native.host.removeLocal());
}

test.afterEach(removeHostFiles);

test('S11: the app quits mid-turn and the exit sheet lists the chat; it runs on and nothing is interrupted', async ({ harness }) => {
  const pid = await startWaitingChat(harness);
  const closed = harness.app.waitForEvent('close');
  await harness.app.evaluate(({ app }) => app.quit());
  const sheet = harness.page.getByRole('alertdialog', { name: 'Quit MoPilot?' });
  await expect(sheet).toContainText('1 chat keeps running on this Mac.');
  await expect(sheet.getByRole('button', { name: 'Quit and stop them' })).toBeVisible();
  await sheet.getByRole('button', { name: 'Quit', exact: true }).click();
  await closed;
  await reopenAndFinish(harness, pid);
});

test('S11: the app is killed with SIGKILL mid-turn; the turn runs on and nothing is interrupted', async ({ harness }) => {
  const pid = await startWaitingChat(harness);
  const closed = harness.app.waitForEvent('close');
  process.kill(harness.app.process().pid!, 'SIGKILL');
  await closed;
  await reopenAndFinish(harness, pid);
});
