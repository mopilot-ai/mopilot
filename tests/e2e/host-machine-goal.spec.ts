// e2e-runner: bench
// M58 and M34 of the Remote Run audit: a chat on a machine has the same goal bar and /init as a chat on this Mac, in the real Mac app against a real Host process over real ssh (this runner's sshd), with the Host's fake Codex. The goal is set from the composer, paused and resumed from the goal card, edited and cleared by typed commands, and /init sends the same prompt after reading the machine's folder, with nothing written on this Mac.
// It turns on sshd and writes the user's ssh config, so it runs only on a CI runner. Named on the command line only: `node scripts/ci-cuj.mjs --spec tests/e2e/host-machine-goal.spec.ts`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { expectGoalRunning, goalCard, goalPill } from './fixtures/goal';
import { send } from './fixtures/mm3Journey';
import { REMOTE_FOLDER, type RemoteHost, connectRemote, sshToSelf, startRemoteChat, startRemoteHost } from './fixtures/remoteHost';

test.skip(process.platform !== 'darwin', 'a basic harness is admitted only with sage-mcp, which builds only on macOS');
test.skip(!process.env.GITHUB_ACTIONS, 'a runner only: it turns on sshd and writes the ssh config');

const HOME = os.homedir();
let remote: RemoteHost;

test.setTimeout(10 * 60_000);
test.beforeAll(async () => {
  fs.mkdirSync(REMOTE_FOLDER, { recursive: true });
  sshToSelf();
  remote = await startRemoteHost({ agents: { claude: true, codex: true, acp: 'in', acpModels: true } });
});
test.afterAll(() => {
  remote?.stop();
  fs.rmSync(REMOTE_FOLDER, { recursive: true, force: true });
});
test.use({
  harnesses: 'codex',
  env: { MOPILOT_HOST_DEV: '1', HOME },
  seed: {
    userData: {
      'host-registry.json': {
        version: 1,
        hosts: [
          {
            id: 'ssh:runner@localhost',
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

const main = (page: Page) => page.getByRole('main');
const idle = (page: Page) => expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 90_000 });
/** What the Host's fake Codex was asked (its log file). */
const codexAsked = () => (fs.existsSync(remote.codexLog) ? fs.readFileSync(remote.codexLog, 'utf8') : '');

/** A new Codex chat on the machine with its first message, and its reply. */
async function startCodexChat(page: Page, text: string) {
  await connectRemote(page, remote, 'codex');
  // the local row picked names the agent the machine starts the chat on
  await startRemoteChat(page, 'Codex', text);
  await expect(main(page)).toContainText(`codex: ${text}`, { timeout: 120_000 });
  await idle(page);
}

test('a goal on a machine chat is set from the composer, paused and resumed from the card, edited and cleared by typed commands', async ({
  harness,
}) => {
  const page = harness.page;
  await startCodexChat(page, 'first-goal');

  // set: the machine's Codex takes the goal through its app-server, and the pill is the one a chat here has
  await send(page, '/goal make it SLOW');
  await expect(goalPill(page)).toHaveAttribute('title', 'make it SLOW', { timeout: 60_000 });
  await expectGoalRunning(page);
  await expect.poll(() => codexAsked(), { message: 'the goal reached the machine’s Codex' }).toContain('thread/goal/set');

  // Pause is Stop: the goal is paused on the machine first, then the running turn is interrupted
  await (await goalCard(page)).getByRole('button', { name: 'Pause' }).click();
  await expect(goalPill(page)).toContainText('Paused', { timeout: 60_000 });
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  expect(codexAsked()).toContain('turn/interrupt');

  // Resume from the card, then pause and edit by the typed commands, as on this Mac
  await (await goalCard(page)).getByRole('button', { name: 'Resume' }).click();
  await expectGoalRunning(page);
  await send(page, '/goal pause');
  await expect(goalPill(page)).toContainText('Paused', { timeout: 60_000 });
  await send(page, '/goal edit finish it SLOW');
  await expect(await goalCard(page)).toContainText('finish it SLOW');

  // Clear removes the goal on the machine and from the chat
  await (await goalCard(page)).getByRole('button', { name: 'Clear' }).click();
  await expect(goalPill(page)).toHaveCount(0, { timeout: 60_000 });
  expect(codexAsked()).toContain('thread/goal/clear');
});

test('/init in a machine chat reads the machine’s folder and sends the prompt; nothing is read or written on this Mac', async ({
  harness,
}) => {
  const page = harness.page;
  await startCodexChat(page, 'first-init');
  // an AGENTS.md on the machine is there to be asked about: the app asks before replacing it, as it does here
  fs.writeFileSync(path.join(REMOTE_FOLDER, 'AGENTS.md'), '# Agents\n');
  page.on('dialog', (dialog) => void dialog.dismiss());
  await send(page, '/init');
  await idle(page);
  // Cancel keeps the machine's file and sends nothing
  expect(codexAsked()).not.toContain('Analyze this codebase');
  fs.rmSync(path.join(REMOTE_FOLDER, 'AGENTS.md'));
  await send(page, '/init');
  await expect
    .poll(() => codexAsked(), { timeout: 60_000, message: 'the init prompt reached the machine’s Codex' })
    .toContain('Analyze this codebase');
  await idle(page);
  // the machine chat did not get this Mac's refusal, and nothing was written into a folder of this Mac
  await expect(main(page)).not.toContainText('Not available for a chat on a machine.');
  expect(fs.existsSync(path.join(HOME, 'AGENTS.md'))).toBe(false);
});
