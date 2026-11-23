// e2e-runner: bench
// #4915: typing "/" in a chat on a machine lists the commands and skills the agent there offers (the Host reports them), for the new chat a machine is picked for and for the chat that follows, and a row sends what a chat of that agent on this Mac would send. The real Mac app against a real Host process over real ssh (this runner's sshd), with the fake Claude Code and Codex of the Host's own PATH.
// It turns on sshd and writes the user's ssh config, so it runs only on a CI runner. Named on the command line only: `node scripts/ci-cuj.mjs --spec tests/e2e/host-slash-commands.spec.ts`.
import fs from 'node:fs';
import os from 'node:os';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { send } from './fixtures/mm3Journey';
import { tail } from './fixtures/hostQuestion';
import {
  REMOTE_FOLDER,
  REMOTE_ID,
  type RemoteHost,
  connectRemote,
  sshToSelf,
  startRemoteChat,
  startRemoteHost,
} from './fixtures/remoteHost';

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
  harnesses: 'both',
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
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const rows = (page: Page) => page.locator('.slash-panel .add-panel-item');
const row = (page: Page, title: string) =>
  rows(page).filter({ has: page.locator('.add-panel-title', { hasText: new RegExp(`^${title}$`) }) });
const stop = (page: Page) => page.getByRole('button', { name: 'Stop', exact: true });

/** What the app and the machine said when a row did not show: the rows drawn, the Host's answer as the app reads it, and the Host's log. */
async function say(page: Page, harnessId: string, error: unknown) {
  const drawn = await page
    .locator('.slash-panel')
    .innerText()
    .catch(() => '(no menu)');
  const asked = await page
    .evaluate(([id, harnessWire, cwd]) => window.native.host.commands(id, { harness: harnessWire, cwd }), [
      REMOTE_ID,
      harnessId,
      REMOTE_FOLDER,
    ] as const)
    .then((r) => JSON.stringify(r).slice(0, 800))
    .catch((e) => `threw ${String(e).slice(0, 200)}`);
  return new Error(`menu: ${drawn} / the Host answers: ${asked} / host log: ${tail(remote.hostLog)} / ${String(error).slice(0, 160)}`);
}

/** The agent of the new chat, picked in the machine's model picker (the folder picked before it decides which agents the machine offers). */
async function pickMachineAgent(page: Page, label: string) {
  await page.getByRole('button', { name: 'Select model' }).click({ timeout: 20_000 });
  const toList = page.getByRole('button', { name: 'Select harness and model' });
  if (await toList.isVisible().catch(() => false)) await toList.click();
  await page.locator('.hp-harnesses .hp-row').filter({ hasText: label }).first().hover();
  await page.getByRole('menuitemradio').first().click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Select model' })).toBeVisible();
}

/** The `/` menu open on an empty message. */
async function openMenu(page: Page) {
  await composer(page).fill('');
  await composer(page).pressSequentially('/');
  await expect(page.locator('.slash-panel')).toBeVisible();
}

test('Claude Code on the machine: the new chat and the chat list what the machine’s Claude offers, and a skill row sends its /name', async ({
  harness,
}, testInfo) => {
  const page = harness.page;
  await connectRemote(page, remote, 'claude');
  await startRemoteChat(page, 'Claude Code', 'first-words', false, async () => {
    // the new chat the machine is picked for: its agent is picked in the machine's model picker, and its menu is that agent's there, not this Mac's
    await pickMachineAgent(page, 'Claude Code');
    await openMenu(page);
    await expect(row(page, '/fake-skill'))
      .toBeVisible({ timeout: 60_000 })
      .catch(async (e) => {
        throw await say(page, 'claude', e);
      });
    await expect(row(page, '/compact')).toBeVisible();
    // the rows say where they come from
    await expect(row(page, '/fake-skill')).toContainText('on localhost');
    await testInfo.attach('new-chat-menu', { body: await page.screenshot(), contentType: 'image/png' });
    await page.keyboard.press('Escape');
    await composer(page).fill('');
  });
  await expect(main(page)).toContainText('fake-claude: first-words', { timeout: 120_000 });
  await expect(stop(page)).toHaveCount(0, { timeout: 90_000 });

  // the chat that exists: the same list
  await openMenu(page);
  await expect(row(page, '/fake-skill')).toBeVisible({ timeout: 60_000 });
  await expect(row(page, '/compact')).toBeVisible();
  // once a session ran there, the CLI's terminal-only commands are known and left out
  await expect(row(page, '/doctor')).toHaveCount(0);
  await testInfo.attach('chat-menu', { body: await page.screenshot(), contentType: 'image/png' });
  await row(page, '/fake-skill').click();
  await expect(composer(page)).toHaveText('/fake-skill ');
  await send(page, '/fake-skill go');
  // sent as text, as a chat of Claude Code on this Mac sends it: the machine's Claude took it as the message
  await expect(main(page)).toContainText('fake-claude: /fake-skill go', { timeout: 120_000 });
});

test('Codex on the machine: its skills for the folder are listed (the one switched off is not), and a row puts $name in the message', async ({
  harness,
}, testInfo) => {
  const page = harness.page;
  await connectRemote(page, remote, 'codex');
  await startRemoteChat(page, 'Codex', 'first-words');
  await expect(main(page)).toContainText('codex: first-words', { timeout: 120_000 });
  await expect(stop(page)).toHaveCount(0, { timeout: 90_000 });
  await openMenu(page);
  await expect(row(page, 'fake-codex-skill'))
    .toBeVisible({ timeout: 60_000 })
    .catch(async (e) => {
      throw await say(page, 'codex', e);
    });
  await expect(row(page, 'fake-codex-off')).toHaveCount(0);
  // the machine's skills, not the ones of this Mac, and no row for attaching a local skill
  await expect(row(page, 'Skills')).toHaveCount(0);
  await testInfo.attach('codex-menu', { body: await page.screenshot(), contentType: 'image/png' });
  await row(page, 'fake-codex-skill').click();
  await expect(composer(page)).toHaveText('$fake-codex-skill ');
  await send(page, '$fake-codex-skill go');
  await expect(main(page)).toContainText('codex: $fake-codex-skill go', { timeout: 120_000 });
});
