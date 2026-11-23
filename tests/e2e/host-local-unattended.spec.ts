// e2e-runner: bench
// Remote Run S1, its last step, against a real Host (host.unattended on): This Mac's background Host, installed by the app, runs a chat on the repo's fake ACP agent that waits on a permission card. The owner's policy (host:setOwnerPolicy, the real path to the Host) sets the reminder to 1 minute and the pause to 5, the least the policy accepts. The app quits and stays away past the pause; reopened, the chat's row says Paused, the strip above the composer says why and offers Resume once, the card shows as not answered, and Resume continues the run to the end of a turn. A second client answering a card shows "Allowed on <device>" in the chat. Every sentence is read from shared/host/attentionLine.mjs and cardLine.mjs, never restated.
// It installs a per-user launch agent, so it runs only on a CI runner or in an isolated VM (MOPILOT_ACCEPT_VM=1). Named on the command line only: `node scripts/ci-cuj.mjs --spec tests/e2e/host-local-unattended.spec.ts`.
// e2e-covers: src/components/sidebar/ThreadRow.tsx src/components/sidebar/ThreadMachineLine.tsx src/components/ui/HostMark.tsx
// e2e-covers: src/components/sidebar/ProjectGroup.tsx src/components/sidebar/projectRows.ts
import { test, expect } from './fixtures/app';
import type { Harness } from './fixtures/app';
import {
  HOME,
  THIS_MAC,
  answerAsSecondClient,
  hostPid,
  installThisMac,
  removeHostFiles,
  showIgnored,
  startChatOnThisMac,
} from './fixtures/hostLocal';
import { attentionLine } from '../../shared/host/attentionLine.mjs';
import { cardLine } from '../../shared/host/cardLine.mjs';

test.skip(process.platform !== 'darwin', 'the Host runs as a launchd agent on macOS');
test.skip(!process.env.GITHUB_ACTIONS && !process.env.MOPILOT_ACCEPT_VM, 'a runner or an isolated VM only: it installs a launch agent');

const ASK = 'PERMIT leave this unanswered';
/** The least the policy accepts (shared/host/policy.mjs): the reminder after a minute, the pause after five. */
const APPROVALS = { remindMinutes: 1, pauseMinutes: 5 };
const PAUSE_MS = APPROVALS.pauseMinutes * 60_000;

test.describe.configure({ mode: 'serial' });
test.setTimeout(15 * 60_000);
test.use({
  harnesses: 'codex',
  acp: { kimi: {} },
  env: { MOPILOT_HOST_DEV: '1', MOPILOT_FLAGS: 'host.local=1,host.unattended=1', HOME },
  seed: { uiState: { prefs: { confirmClose: 'shortcut' } } },
});
test.afterEach(removeHostFiles);

/**
 * The owner's rules with the short approval times. The policy goes to a machine when the app's connection to it is made, and This Mac has none until a chat is followed there:
 * the document is kept first, a first chat brings the connection up (and the Host takes the document with it), and sending again says whether the Host has it.
 */
async function keepShortTimes(h: Harness) {
  const send = () =>
    h.page.evaluate(async (approvals) => {
      const doc = await window.native.host.ownerPolicy();
      return window.native.host.setOwnerPolicy({ ...doc, approvals });
    }, APPROVALS);
  await send();
  await startChatOnThisMac(h, 'hello');
  await expect(h.page.getByRole('main').getByText('fake-acp: hello')).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(async () => JSON.stringify((await send()).machines.find((m) => m.id === 'this-mac-host')), {
      timeout: 60_000,
      intervals: [1_000, 2_000, 5_000],
    })
    .toContain('"ok":true');
}

test('S1: nobody answers past the pause: the row, the strip, the card and one Resume say so, and Resume continues the run', async ({
  harness,
}) => {
  const page = harness.page;
  await installThisMac(harness);
  await keepShortTimes(harness);
  await startChatOnThisMac(harness, ASK, { another: true });
  await expect(page.locator('.approval-card')).toBeVisible({ timeout: 60_000 });
  const pid = hostPid();

  // the app goes, and stays away past the pause
  const closed = harness.app.waitForEvent('close');
  await harness.app.evaluate(({ app }) => app.quit());
  await page.getByRole('alertdialog', { name: 'Quit MoPilot?' }).getByRole('button', { name: 'Quit', exact: true }).click();
  await closed;
  await new Promise((r) => setTimeout(r, PAUSE_MS + 45_000));
  expect(hostPid(), 'the Host kept running while the app was gone').toBe(pid);

  await harness.relaunch();
  showIgnored(harness);
  const back = harness.page;
  const notAnswered = cardLine({ state: 'expired' }, { now: Date.now() }).text!;
  const paused = attentionLine({
    attention: { kind: 'paused' },
    machineName: THIS_MAC,
    pauseMinutes: APPROVALS.pauseMinutes,
    client: 'mac',
  });
  // the sidebar lists a chat in its project (this Mac's folder is a project here) and in Recents, both by design (useProjectGroups): this chat reads Paused in each, once, and no other chat does
  const recents = back.locator('[data-shortcut-recents]');
  const projects = back
    .locator('.sidebar-section:not([data-shortcut-recents])')
    .filter({ has: back.locator('.side-label', { hasText: 'Projects' }) });
  const chatId = await recents.locator('[data-sidebar-chat]', { hasText: ASK }).getAttribute('data-sidebar-chat', { timeout: 60_000 });
  const chatSelector = `[data-sidebar-chat="${chatId}"]`;
  const recentRow = recents.locator(chatSelector);
  const project = projects.locator('.project-group').filter({ has: back.locator(chatSelector) });
  const projectRow = project.locator(chatSelector);
  for (const row of [recentRow, projectRow]) {
    await expect(row.locator('.side-row-sub')).toHaveText(paused.row!, { timeout: 60_000 });
  }
  await expect(recentRow.getByRole('img', { name: `On ${THIS_MAC}` }).locator('.lucide-laptop')).toBeVisible();
  await expect(project.locator('.project-row .lucide-laptop')).toBeVisible();
  await expect(projectRow.locator('.host-mark')).toHaveCount(0);
  const pausedRow = back.locator('[data-sidebar-chat] .side-row-sub', { hasText: paused.row! });
  await expect(pausedRow).toHaveCount(2);
  await back.getByRole('complementary').locator('[data-sidebar-chat^="acp:"]', { hasText: ASK }).first().click();
  const strip = back.locator('.host-away-strip');
  await expect(strip).toContainText(paused.strip!, { timeout: 60_000 });
  // the card the Host closed shows as not answered, and nothing is left to answer
  await expect(back.getByRole('main').getByText(notAnswered)).toBeVisible({ timeout: 30_000 });
  await expect(back.locator('.approval-card')).toHaveCount(0);
  // exactly one way to go on
  await expect(back.getByRole('button', { name: paused.action!.label, exact: true })).toHaveCount(1);
  await strip.getByRole('button', { name: paused.action!.label, exact: true }).click();
  // the run goes on to the end of a turn, and the Host clears what it waited for
  try {
    await expect(back.getByRole('main').getByText(/fake-acp:[\s\S]*Continue\./)).toBeVisible({ timeout: 60_000 });
  } catch (error) {
    const seen = await back.evaluate(async () => ({
      waiting: await window.native.host.attentions(),
      owned: await window.native.host.remoteChats(),
    }));
    throw new Error(
      `No reply to Resume: ${JSON.stringify(seen)} / ${(await back.getByRole('main').innerText()).slice(0, 900)} / ${String(error).slice(0, 120)}`,
    );
  }
  await expect(strip).toHaveCount(0, { timeout: 30_000 });
  await expect(pausedRow).toHaveCount(0);
  await back.evaluate(() => window.native.host.removeLocal());
});

test('S1: a second client answers the card: the chat says "Allowed on" its name', async ({ harness }) => {
  const page = harness.page;
  await installThisMac(harness);
  await startChatOnThisMac(harness, ASK);
  await expect(page.locator('.approval-card')).toBeVisible({ timeout: 60_000 });
  const chatId = (await page.evaluate(() => window.native.host.remoteChats()))[0].chatId;
  answerAsSecondClient(harness, 'Pocket iPhone', chatId, 'allow', 's1-receipt');
  const receipt = cardLine({ state: 'answered', optionKind: 'allow', by: { name: 'Pocket iPhone' } }, { now: Date.now() }).text!;
  await expect(page.getByRole('main').getByText(receipt)).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.approval-card')).toHaveCount(0);
  await expect(page.getByRole('main').getByText(/fake-acp: .*PERMIT leave this unanswered/)).toBeVisible({ timeout: 60_000 });
  await page.evaluate(() => window.native.host.removeLocal());
});
