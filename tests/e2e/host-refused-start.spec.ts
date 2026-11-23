// e2e-runner: bench
// #4786: a message whose turn the Host cannot start is refused with its reason and can be sent again, never left on "Thinking…". The real Mac app against a real Host process over real ssh (this runner's sshd), with the fake Codex of the repo, which refuses to start a turn while a flag file exists (as the real app-server does for a model the account cannot use): the chat shows the Host's reason on the queued message and no running turn; once the cause is gone, Retry delivers the same message once.
// It turns on sshd and writes the user's ssh config, so it runs only on a CI runner. Named on the command line only: `node scripts/ci-cuj.mjs --spec tests/e2e/host-refused-start.spec.ts`.
import fs from 'node:fs';
import os from 'node:os';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
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
  remote = await startRemoteHost();
});
test.afterAll(() => {
  remote?.stop();
  fs.rmSync(REMOTE_FOLDER, { recursive: true, force: true });
});
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
const stop = (page: Page) => page.getByRole('button', { name: 'Stop', exact: true });
const queue = (page: Page) => page.getByRole('list', { name: 'Queued messages' });
/** The flag file that makes the fake Codex refuse to start a turn. */
const refuseFlag = () => `${remote.codexLog}.refuse`;

test('a message whose start the Host refuses shows the Host\u2019s reason and no running turn, and Retry delivers it once', async ({
  harness,
}) => {
  const page = harness.page;
  await connectRemote(page, remote, 'codex');
  await startRemoteChat(page, 'Codex', 'first-words');
  await expect(main(page)).toContainText('codex: first-words', { timeout: 120_000 });
  await expect(stop(page)).toHaveCount(0, { timeout: 90_000 });

  // the app-server will not start the next turn: the Host refuses the message with the reason
  fs.writeFileSync(refuseFlag(), '');
  await send(page, 'second-words');
  await expect(queue(page)).toContainText(/Host did not accept it: .*not available to this account/i, { timeout: 90_000 });
  // not "Thinking…": nothing is running, and the message waits where the person can act on it
  await expect(stop(page)).toHaveCount(0);
  await expect(queue(page).getByRole('button', { name: 'Retry' })).toBeVisible();
  await expect(main(page)).not.toContainText('codex: second-words');

  // the cause is gone: Retry sends the same message, once
  fs.rmSync(refuseFlag());
  await queue(page).getByRole('button', { name: 'Retry' }).click();
  await expect(main(page)).toContainText('codex: second-words', { timeout: 120_000 });
  await expect(stop(page)).toHaveCount(0, { timeout: 90_000 });
  await expect(queue(page)).toHaveCount(0);
  expect((await main(page).innerText()).split('codex: second-words').length - 1).toBe(1);
});
