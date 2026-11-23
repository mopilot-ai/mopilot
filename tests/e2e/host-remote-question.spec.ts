// e2e-runner: bench
// J4 on a real Host over real ssh: the Mac app, a second real Host process on this runner (its own data dir) reached through the runner's sshd and the app's ssh tunnel, and the repo's fake Claude CLI and fake Codex app-server as that Host's agents. The agent asks a question (Claude Code's AskUserQuestion, Codex's requestUserInput), the card shows in the chat, the answer reaches the agent (its log), and the turn goes on to its reply; and the chat's picker offers only its own agent (J8 on a machine).
// It turns on sshd and writes the user's ssh config, so it runs only on a CI runner. Named on the command line only: `node scripts/ci-cuj.mjs --spec tests/e2e/host-remote-question.spec.ts`.
// e2e-covers: src/components/thread/SelectionToolbar.tsx src/store/sideChat.ts src/session/composerAttach.ts electron/host/machineSideChat.cjs electron/host/remoteSendDelivery.cjs
import fs from 'node:fs';
import os from 'node:os';
import { test, expect } from './fixtures/app';
import { answerTheQuestion, logged, pickerOffersOnly } from './fixtures/hostQuestion';
import { REMOTE_FOLDER, type RemoteHost, connectRemote, sshToSelf, startRemoteChat, startRemoteHost } from './fixtures/remoteHost';
import { selectCompletedReply } from './fixtures/replySelection';

test.skip(process.platform !== 'darwin', 'a basic harness is admitted only with sage-mcp, which builds only on macOS');
test.skip(!process.env.GITHUB_ACTIONS, 'a runner only: it turns on sshd and writes the ssh config');

const HOME = os.homedir();
const ID = 'ssh:runner@localhost';
let remote: RemoteHost;

test.beforeAll(async () => {
  fs.mkdirSync(REMOTE_FOLDER, { recursive: true });
  sshToSelf();
  remote = await startRemoteHost({ env: { FAKE_CODEX_FORKS: '1' } });
});
test.afterAll(() => {
  remote?.stop();
  fs.rmSync(REMOTE_FOLDER, { recursive: true, force: true });
});

test.setTimeout(10 * 60_000);
test.use({
  harnesses: 'codex',
  acp: { kimi: {} },
  env: { MOPILOT_HOST_DEV: '1', HOME },
  seed: {
    userData: {
      'host-registry.json': {
        version: 1,
        hosts: [
          {
            id: ID,
            name: 'localhost',
            address: 'runner@localhost',
            // where startRemoteHost puts the Host's socket (fixtures/remoteHost.ts REMOTE_SOCKET)
            socketPath: '/tmp/mm-remote-host/data/host.sock',
            capabilities: { shell: true },
            harnesses: [],
            // read when the seed is written, not when the worker loads this file (hostFixtureHeartbeat.invariant.test.ts)
            get lastHeartbeat() {
              return Date.now();
            },
            setup: '',
          },
        ],
      },
    },
  },
});

test('J4 on Claude Code: the agent asks a question, the card shows, the answer reaches the agent and the turn goes on', async ({
  harness,
}) => {
  const page = harness.page;
  await connectRemote(page, remote, 'claude');
  await startRemoteChat(page, 'Kimi Code', 'ASKMULTI now');
  await answerTheQuestion(page, remote.claudeLog, remote.hostLog);
  await expect(page.getByRole('main').getByText(/\[answers: /)).toBeVisible({ timeout: 60_000 });
  expect(JSON.stringify(logged(remote.claudeLog).filter((e) => e.kind === 'question')), 'the agent got the answer').toContain('a.ts');
  await pickerOffersOnly(page, 'Claude Code', /Kimi Code|Codex|opencode/);
});

test('J4 on Codex: the agent asks a question, the card shows, the answer reaches the agent and the turn goes on', async ({ harness }) => {
  const page = harness.page;
  await connectRemote(page, remote, 'codex');
  await startRemoteChat(page, 'Codex', 'askfiles now');
  await answerTheQuestion(page, remote.codexLog, remote.hostLog);
  // the agent's reply carries the answers it got
  await expect(page.getByRole('main').getByText(/files: .*a\.ts/)).toBeVisible({ timeout: 60_000 });
  await pickerOffersOnly(page, 'Codex', /Kimi Code|Claude Code|opencode/);
});

for (const { agent, row, speaker } of [
  { agent: 'claude', row: 'Kimi Code', speaker: 'fake-claude' },
  { agent: 'codex', row: 'Codex', speaker: 'codex' },
]) {
  test(`${agent} on a machine: Reply and Start a side chat send their quotes to the right conversations`, async ({ page }) => {
    const proof = `parent words for ${agent}`;
    const reply = `${speaker}: ${proof}`;
    await connectRemote(page, remote, agent);
    await startRemoteChat(page, row, proof);
    const toolbar = page.locator('.selection-toolbar');
    await selectCompletedReply(page, reply);
    await toolbar.getByRole('button', { name: 'Reply', exact: true }).click();
    await expect(page.locator('.selection-chip')).toContainText('1 annotation');
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Why this reply?');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(
      page.locator('.main-content .assistant-message', { hasText: new RegExp(`${speaker}:[\\s\\S]*${proof}[\\s\\S]*Why this reply`) }),
    ).toBeVisible();

    await selectCompletedReply(page, reply);
    await toolbar.getByRole('button', { name: 'Start a side chat' }).click();
    const pane = page.locator('.side-pane');
    await expect(pane.locator('.selection-chip')).toContainText('1 selection');
    const nativeLog = agent === 'codex' ? remote.codexLog : remote.claudeLog;
    const previous = logged(nativeLog).length;
    await pane.getByRole('textbox', { name: 'Message', exact: true }).fill('Where does this go?');
    await pane.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(
      pane.locator('.assistant-message', { hasText: new RegExp(`${speaker}:[\\s\\S]*${proof}[\\s\\S]*Where does this go`) }),
    ).toBeVisible();
    await expect(page.locator('.main-content').getByText('Where does this go?', { exact: true })).toHaveCount(0);
    const native = logged(nativeLog).slice(previous);
    if (agent === 'codex') {
      expect(native.some((event) => event.method === 'thread/fork' && event.params.ephemeral === false)).toBe(true);
    } else {
      const input = native.find((event) => event.kind === 'turn' && event.text.includes('Where does this go?'));
      const args = native.find((event) => event.kind === 'argv' && event.pid === input?.pid)?.argv as string[] | undefined;
      expect(args?.find((arg) => arg.startsWith('--resume='))).toMatch(/^--resume=[0-9a-f-]{36}$/i);
    }
  });
}
