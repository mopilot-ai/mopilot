// e2e-runner: bench
// Remote Run audit M2: renaming a chat that runs on a machine, in the real Mac app against a real Host process over real ssh (this runner's sshd and the app's ssh tunnel) that has the repo's fake Claude Code. The sidebar row's menu Rename names the chat as for a chat on This Mac; the Host takes the name (`chat.rename`), so a second client of the Host (a phone: a Node process paired with its own code) reads the new name in `host.chats`, and the name is still there after the app is reopened.
// It turns on sshd and writes the user's ssh config, so it runs only on a CI runner. Named on the command line only: `node scripts/ci-cuj.mjs --spec tests/e2e/host-machine-rename.spec.ts`.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from './fixtures/app';
import { send } from './fixtures/mm3Journey';
import { REMOTE_FOLDER, type RemoteHost, connectRemote, sshToSelf, startRemoteChat, startRemoteHost } from './fixtures/remoteHost';

test.skip(process.platform !== 'darwin', 'a basic harness is admitted only with sage-mcp, which builds only on macOS');
test.skip(!process.env.GITHUB_ACTIONS, 'a runner only: it turns on sshd and writes the ssh config');

const HOME = os.homedir();
let remote: RemoteHost;

test.setTimeout(8 * 60_000);
test.beforeAll(async () => {
  fs.mkdirSync(REMOTE_FOLDER, { recursive: true });
  sshToSelf();
  remote = await startRemoteHost({ agents: 'claude+codex' });
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

const NAME = 'Renamed on the machine';

test('a chat on a machine is renamed from the sidebar row menu: the Host and a second client read the name, and it stays after a restart', async ({
  harness,
}) => {
  const page = harness.page;
  await connectRemote(page, remote, 'claude');
  await startRemoteChat(page, 'Kimi Code', 'first-rename');
  await expect(page.getByRole('main')).toContainText('fake-claude: first-rename', { timeout: 120_000 });
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 90_000 });

  // the row's menu, as for a chat on This Mac: Rename, type, Enter
  const sidebar = page.getByRole('complementary');
  const row = sidebar.locator('[data-shortcut-recents] [data-sidebar-chat^="acp:"]').first();
  await expect(row).toBeVisible();
  await row.hover();
  await row.getByRole('button', { name: 'More options', exact: true }).click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeFocused();
  await page.keyboard.press('r');
  const field = row.getByRole('textbox');
  await field.fill(NAME);
  await field.press('Enter');
  await expect(row).toContainText(NAME);
  // (no toast says the machine did not take it)
  await expect(page.locator('.toast', { hasText: /too old|reach the machine/ })).toHaveCount(0);

  // a second client of the Host (a phone, paired with a code of its own) reads the new name in the machine's own chat list
  const client = path.join(__dirname, 'fixtures/hostChatsClient.mjs');
  const listed = JSON.parse(
    execFileSync(
      process.execPath,
      [client, remote.socketPath, path.join(harness.dir, 'second-client-key.json'), 'Pocket iPhone', remote.code(), NAME],
      {
        encoding: 'utf8',
        env: { ...process.env, HOME },
        timeout: 120_000,
      },
    ),
  ) as { chatId: string; title: string }[];
  expect(listed.filter((c) => c.title === NAME)).toHaveLength(1);

  // the machine's chat list kept it, and so does this Mac: reopened, the row has the name and the next message does not take it away
  await harness.relaunch();
  const again = harness.page.getByRole('complementary').locator('[data-sidebar-chat^="acp:"]').first();
  await expect(again).toContainText(NAME);
  await again.click();
  await send(harness.page, 'second-rename');
  await expect(harness.page.getByRole('main')).toContainText('fake-claude: second-rename', { timeout: 120_000 });
  await expect(harness.page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 90_000 });
  await expect(again).toContainText(NAME);
});
