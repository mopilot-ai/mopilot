// e2e-runner: bench
// e2e-covers: src/components/panels/SummaryPanel.tsx
// #5045 on a real Host over real ssh: a chat that runs on a machine added over ssh has its terminal on that machine. The summary's ⋯ menu "Open terminal" opens a bottom tab titled with the machine's name that runs `ssh -t <target>` into the chat's folder there, and `pwd` typed into it answers that folder (the machine's, not a folder of this Mac). One test, one Host.
// The isolated VM only (MOPILOT_ACCEPT_VM=1: it turns on sshd, and its user is `admin`). Named on the command line only.
import fs from 'node:fs';
import os from 'node:os';
import { test, expect } from './fixtures/app';
import { SYSTEM_THEME, shootBoth } from './fixtures/shoot';
import {
  REMOTE_FOLDER,
  type RemoteHost,
  connectRemote,
  machineName,
  sshToSelf,
  startRemoteChat,
  startRemoteHost,
} from './fixtures/remoteHost';

test.skip(process.platform !== 'darwin', 'a basic harness is admitted only with sage-mcp, which builds only on macOS');
test.skip(!process.env.MOPILOT_ACCEPT_VM, 'the isolated VM only (its user is `admin`): it turns on sshd and writes the ssh config');

let remote: RemoteHost;
test.beforeAll(async () => {
  fs.mkdirSync(REMOTE_FOLDER, { recursive: true });
  sshToSelf();
  remote = await startRemoteHost();
});
test.afterAll(() => {
  remote?.stop();
  fs.rmSync(REMOTE_FOLDER, { recursive: true, force: true });
});

test.setTimeout(10 * 60_000);
test.use({
  harnesses: 'both',
  env: { MOPILOT_HOST_DEV: '1', HOME: os.homedir() },
  seed: {
    uiState: SYSTEM_THEME,
    userData: {
      'host-registry.json': {
        version: 1,
        hosts: [
          {
            // the VM's user is `admin`: the seed is read with nothing else defined, so it is spelled out
            id: 'ssh:admin@localhost',
            name: 'localhost',
            address: 'admin@localhost',
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

test("Open terminal on a machine's chat opens a shell on the machine, in the chat's folder", async ({ harness }) => {
  const page = harness.page;
  await connectRemote(page, remote, 'claude');
  await startRemoteChat(page, 'Claude Code', 'hello machine');
  await expect(page.getByRole('main')).toContainText('hello machine', {
    timeout: 120_000,
  });
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 90_000 });

  // the summary's ⋯ menu offers the terminal for a machine reached over ssh
  await page.locator('.summary-panel').getByRole('button', { name: 'Session actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Open terminal', exact: true }).click();

  // one tab, named for the machine
  const panel = page.locator('.bottom-panel');
  await expect(panel.locator('.bottom-tab')).toHaveCount(1, {
    timeout: 30_000,
  });
  await expect(panel.locator('.bottom-tab')).toContainText(await machineName(page));

  // the shell is the machine's: `pwd` answers the chat's folder there (the typed line itself never contains it)
  const rows = panel.locator('.xterm-rows');
  await panel.locator('.xterm').click();
  await page.keyboard.type('pwd');
  await page.keyboard.press('Enter');
  await expect(rows).toContainText(REMOTE_FOLDER, { timeout: 60_000 });
  console.log(`TERMINAL-TEXT ${JSON.stringify(await rows.innerText())}`);
  await shootBoth(page, harness.app, 'host-machine-terminal');
});
