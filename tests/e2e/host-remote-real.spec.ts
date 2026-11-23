// e2e-runner: bench
// The Mac app against a real Host over real ssh (the VM's own sshd and the app's ssh tunnel), with the REAL Claude Code and Codex of the machine the Host runs on (their own sign-ins, the cheapest model at low effort): a chat starts and replies, a command that writes waits for an approval that is allowed, Stop ends a long turn, and after quit and reopen the chat is there and the agent still knows what it was told; on Claude Code a question card is answered and the answer reaches the agent. A real model decides what it asks, so each step's prompt is direct and every answer is checked by a nonce.
// VM only (MOPILOT_ACCEPT_VM=1, the machine's own `claude` and `codex` signed in, never a developer's Mac): `scripts/vm-exec.sh --vm mopilot-bench …` with the VM lock taken first. Named on the command line only.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from './fixtures/app';
import { send } from './fixtures/mm3Journey';
import { cheapModel, shownIn } from './fixtures/realAgents';
import { REMOTE_FOLDER, type RemoteHost, connectRemote, sshToSelf, startRemoteChat, startRemoteHost } from './fixtures/remoteHost';

test.skip(process.platform !== 'darwin', 'a basic harness is admitted only with sage-mcp, which builds only on macOS');
test.skip(!process.env.MOPILOT_ACCEPT_VM, 'the isolated VM only: it uses the real agents of the machine it runs on');

const where = (name: string) => {
  try {
    return execFileSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};
const claude = where('claude');
const codex = where('codex');
const HOME = os.homedir();
const nonce = `n${Date.now().toString(36)}`;
let remote: RemoteHost;

test.describe.configure({ mode: 'serial' });
test.setTimeout(15 * 60_000);
test.beforeAll(async () => {
  fs.mkdirSync(REMOTE_FOLDER, { recursive: true });
  sshToSelf();
  remote = await startRemoteHost({ agents: 'real' });
});
test.afterAll(() => {
  remote?.stop();
  fs.rmSync(REMOTE_FOLDER, { recursive: true, force: true });
});
test.use({
  harnesses: 'codex',
  acp: { kimi: {} },
  // the machine's own agents are on the PATH of the Host this spec starts and of the app
  shellPath: [claude, codex].filter(Boolean).map((file) => path.dirname(file)),
  env: { MOPILOT_HOST_DEV: '1', HOME },
  seed: {
    userData: {
      'host-registry.json': {
        version: 1,
        hosts: [
          {
            // the VM's user is `admin`: the seed is read with nothing else defined, so it is spelled out
            id: 'ssh:admin@localhost',
            name: 'localhost',
            address: 'admin@localhost',
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

for (const agent of [
  { id: 'claude', row: 'Kimi Code', model: /haiku|sonnet/i, bin: claude },
  { id: 'codex', row: 'Codex', model: /mini|fake|gpt/i, bin: codex },
]) {
  test(`${agent.id} (real) over ssh: a reply, an approved command, Stop, quit and reopen`, async ({ harness }) => {
    test.skip(!agent.bin, `no ${agent.id} on this machine`);
    const page = harness.page;
    await connectRemote(page, remote, agent.id);

    await startRemoteChat(page, agent.row, `Reply with exactly the word READY-${nonce} and nothing else.`, false, () =>
      cheapModel(page, agent.model),
    );
    await shownIn(page, new RegExp(`READY-${nonce}`), 'no reply');
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 120_000 });

    // a write outside the chat's folder and /tmp waits for an approval, and Allow runs it
    const ran = path.join(HOME, `RAN-${nonce}-${agent.id}`);
    await send(page, `Run the shell command: touch ${ran}. Then say DONE-${nonce}.`);
    await expect(page.locator('.approval-card')).toBeVisible({ timeout: 180_000 });
    await page.keyboard.press('1');
    await expect.poll(() => fs.existsSync(ran), { timeout: 120_000, message: 'the allowed command ran' }).toBe(true);
    fs.rmSync(ran, { force: true });
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 120_000 });
    await expect(page.getByText(/Unknown harness/)).toHaveCount(0);

    // Stop ends a long turn
    await send(page, 'Run the shell command: sleep 120. Wait for it.');
    const approval = page.locator('.approval-card');
    if (await approval.isVisible({ timeout: 120_000 }).catch(() => false)) await page.keyboard.press('1');
    const stop = page.getByRole('button', { name: 'Stop', exact: true });
    await expect(stop).toBeVisible({ timeout: 120_000 });
    await stop.click();
    await expect(stop).toHaveCount(0, { timeout: 60_000 });

    // quit and open again: the machine is still there, the chat is listed with its history, and the agent still knows what it was told
    await harness.relaunch();
    await harness.page.getByRole('complementary').locator('[data-sidebar-chat^="acp:"]').first().click();
    await shownIn(harness.page, new RegExp(`READY-${nonce}`), 'the history is not there after the return', 90_000);
    await send(harness.page, 'What was the exact word I asked you to reply with first? Answer with it only.');
    await shownIn(harness.page, new RegExp(`READY-${nonce}[\\s\\S]*READY-${nonce}`), 'the agent lost the conversation');
  });
}

test('claude (real) over ssh: a question card is answered and the answer reaches the agent', async ({ harness }) => {
  test.skip(!claude, 'no claude on this machine');
  const page = harness.page;
  await connectRemote(page, remote, 'claude');
  await startRemoteChat(
    page,
    'Kimi Code',
    `Use the AskUserQuestion tool to ask me "Which file?" with the options a.ts and b.ts, then reply with exactly CHOSE-${nonce}-<my choice>.`,
    false,
    () => cheapModel(page, /haiku|sonnet/i),
  );
  const card = page.locator('.question-card');
  await expect(card).toBeVisible({ timeout: 180_000 });
  // the app's own question card: a tile per option
  await card.locator('.question-option', { hasText: 'a.ts' }).click();
  await shownIn(page, new RegExp(`CHOSE-${nonce}-a\\.ts`), 'the answer did not reach the agent');
});
