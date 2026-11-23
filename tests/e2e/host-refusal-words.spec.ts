// e2e-runner: bench
// #4906: a queued message the Host refuses says why in words (the machine and the agent named), offers the one action that fixes it, and shows Retry only when sending it again can succeed. The real Mac app against a real Host process over real ssh (this runner's sshd), with the fake Codex of the Host's own PATH; the case restarts the Host without Codex. (A signed-out agent is not here: the composer disables Send then, so the refusal row only appears on a race, which the unit tests cover.)
// It turns on sshd and writes the user's ssh config, so it runs only on a CI runner. Named on the command line only: `node scripts/ci-cuj.mjs --spec tests/e2e/host-refusal-words.spec.ts`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
            // the name this row was given: without it the machine takes its Host's computer name (#4930), and these cases name it "localhost"
            renamed: true,
            address: 'runner@localhost',
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
const machines = (page: Page) => page.evaluate(() => window.native.host.machines()).then((r) => JSON.stringify(r));

/** A chat on the machine with its first turn done, then the Host restarted so Codex stands as `agents` says, and the app has seen it. */
async function refuseWith(page: Page, agents: Parameters<RemoteHost['restart']>[0], seen: RegExp) {
  await connectRemote(page, remote, 'codex');
  await startRemoteChat(page, 'Codex', 'first-words');
  await expect(main(page)).toContainText('codex: first-words', { timeout: 120_000 });
  await expect(stop(page)).toHaveCount(0, { timeout: 90_000 });
  await remote.restart(agents);
  await expect.poll(() => machines(page), { timeout: 90_000 }).toMatch(seen);
  await send(page, 'second-words');
}

test.afterEach(async () => {
  // every case leaves the machine as it found it
  await remote.restart({ agents: 'claude+codex' });
});

test('Codex missing on the machine: the row says it is not installed there, and no Retry', async ({ harness }, testInfo) => {
  const page = harness.page;
  await refuseWith(page, { agents: { claude: true } }, /"id":"codex"[^}]*"state":"missing"/);
  await expect(queue(page)).toContainText("Codex isn't installed on localhost.", { timeout: 90_000 });
  // the fix in place (this Host installs an agent itself), and no Retry: sending again would be refused again
  await expect(queue(page).getByRole('button', { name: 'Install on localhost' })).toBeVisible();
  await expect(queue(page).getByRole('button', { name: 'Retry' })).toHaveCount(0);
  await expect(stop(page)).toHaveCount(0);
  await expect(main(page)).not.toContainText('codex: second-words');
  await testInfo.attach('missing', { body: await page.screenshot(), contentType: 'image/png' });
});

/** The chat deleted from the machine by another client: the Host's own tombstone beside each chat's journal (host/src/sessionRetirement.mjs), which it checks on every call. Test-only: the layout is the Host's, no product code is switched. */
function deleteChatsOnTheMachine() {
  const root = path.join(remote.dataDir, 'sessions');
  for (const name of fs.readdirSync(root).filter((n) => /^[0-9a-f]{64}$/.test(n))) fs.writeFileSync(path.join(root, `${name}.deleted`), '');
}

test('a chat deleted from the machine: the row says so and New chat on it carries the message to a new chat there, unsent, and the row goes', async ({
  harness,
}, testInfo) => {
  const page = harness.page;
  await connectRemote(page, remote, 'codex');
  await startRemoteChat(page, 'Codex', 'first-words');
  await expect(main(page)).toContainText('codex: first-words', { timeout: 120_000 });
  await expect(stop(page)).toHaveCount(0, { timeout: 90_000 });
  deleteChatsOnTheMachine();
  await send(page, 'second-words');
  await expect(queue(page)).toContainText('This chat was deleted from localhost.', { timeout: 90_000 });
  await expect(queue(page).getByRole('button', { name: 'Retry' })).toHaveCount(0);
  await expect(stop(page)).toHaveCount(0);
  await testInfo.attach('deleted', { body: await page.screenshot(), contentType: 'image/png' });

  await queue(page).getByRole('button', { name: 'New chat on localhost' }).click();
  // a new chat on the machine, the words waiting in its composer and not sent
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await expect(composer).toHaveText('second-words', { timeout: 60_000 });
  await expect(page.getByRole('list', { name: 'Queued messages' })).toHaveCount(0);
  await expect(main(page)).not.toContainText('codex: second-words');
  await testInfo.attach('new-chat', { body: await page.screenshot(), contentType: 'image/png' });
  // sent from there, it runs once on the machine
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(main(page)).toContainText('codex: second-words', { timeout: 120_000 });
  expect((await main(page).innerText()).split('codex: second-words').length - 1).toBe(1);
});

test('the chat’s folder is gone from the machine: the row offers Choose a folder (and Retry), and the folder picked starts a new chat there with the message', async ({
  harness,
}, testInfo) => {
  const page = harness.page;
  await connectRemote(page, remote, 'codex');
  await startRemoteChat(page, 'Codex', 'first-words');
  await expect(main(page)).toContainText('codex: first-words', { timeout: 120_000 });
  await expect(stop(page)).toHaveCount(0, { timeout: 90_000 });
  // the folder is removed on the machine (this runner is the machine); the Host refuses the message before the agent starts (#5037)
  fs.rmSync(REMOTE_FOLDER, { recursive: true, force: true });
  await send(page, 'second-words');
  await expect(queue(page).getByRole('button', { name: 'Choose a folder' })).toBeVisible({ timeout: 90_000 });
  // the folder may come back, so sending the same message again can work
  await expect(queue(page).getByRole('button', { name: 'Retry' })).toBeVisible();
  await expect(stop(page)).toHaveCount(0);
  await testInfo.attach('folder-gone', { body: await page.screenshot(), contentType: 'image/png' });

  // a folder on the machine to move to; the picker is the one new chats use
  fs.mkdirSync(REMOTE_FOLDER, { recursive: true });
  await queue(page).getByRole('button', { name: 'Choose a folder' }).click();
  const dialog = page.locator('.dialog');
  await expect(dialog.locator('.host-picker-path')).toBeVisible({ timeout: 45_000 });
  if ((await dialog.locator('.host-picker-path').textContent()) !== REMOTE_FOLDER)
    await dialog.getByRole('button', { name: path.basename(REMOTE_FOLDER), exact: true }).click();
  await expect(dialog.locator('.host-picker-path')).toHaveText(REMOTE_FOLDER);
  await dialog.getByRole('button', { name: 'Use this folder' }).click();
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await expect(composer).toHaveText('second-words', { timeout: 60_000 });
  await expect(page.getByRole('list', { name: 'Queued messages' })).toHaveCount(0);
  await testInfo.attach('folder-chosen', { body: await page.screenshot(), contentType: 'image/png' });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(main(page)).toContainText('codex: second-words', { timeout: 120_000 });
  expect((await main(page).innerText()).split('codex: second-words').length - 1).toBe(1);
});

test('the chat\u2019s folder comes back: Retry sends the same message once, and the row goes', async ({ harness }, testInfo) => {
  const page = harness.page;
  await connectRemote(page, remote, 'codex');
  await startRemoteChat(page, 'Codex', 'first-words');
  await expect(main(page)).toContainText('codex: first-words', { timeout: 120_000 });
  await expect(stop(page)).toHaveCount(0, { timeout: 90_000 });
  fs.rmSync(REMOTE_FOLDER, { recursive: true, force: true });
  await send(page, 'second-words');
  await expect(queue(page)).toContainText(/no longer exists/, { timeout: 90_000 });
  await expect(main(page)).not.toContainText('codex: second-words');
  await testInfo.attach('folder-gone-words', { body: await page.screenshot(), contentType: 'image/png' });
  fs.mkdirSync(REMOTE_FOLDER, { recursive: true });
  await queue(page).getByRole('button', { name: 'Retry' }).click();
  await expect(main(page)).toContainText('codex: second-words', { timeout: 120_000 });
  await expect(queue(page)).toHaveCount(0);
  expect((await main(page).innerText()).split('codex: second-words').length - 1).toBe(1);
});
