// e2e-runner: bench
// #4908 on a real Host over real ssh: the machine's Claude Code login is one the provider refuses for its organization (the fake CLI's `ORGBLOCKED` turn: HTTP 403 oauth_not_allowed_for_organization). The Mac app shows which login the agent runs on, then after the refused turn says the agent cannot run (the machine's row, the agent picker), draws the failure once with the way on and no Retry, and keeps the card until the machine's login changes (its sign-in takes the refusal back). One test, one Host.
// The isolated VM only (MOPILOT_ACCEPT_VM=1: it turns on sshd, and its user is `admin`). Named on the command line only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { SYSTEM_THEME, shootBoth } from './fixtures/shoot';
import {
  REMOTE_FOLDER,
  REMOTE_ID,
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
const CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-claude-config-'));
test.beforeAll(async () => {
  fs.mkdirSync(REMOTE_FOLDER, { recursive: true });
  // the CLI's own record of the login on the machine: what the Host reads to say which login the agent runs on (a name and a plan, as the CLI wrote them)
  fs.writeFileSync(
    path.join(CONFIG, '.claude.json'),
    JSON.stringify({
      oauthAccount: { displayName: 'Meggie', planDisplayName: 'Ultra', emailAddress: 'someone@example.test', organizationUuid: 'org-1' },
    }),
  );
  sshToSelf();
  remote = await startRemoteHost({ env: { CLAUDE_CONFIG_DIR: CONFIG } });
});
test.afterAll(() => {
  remote?.stop();
  fs.rmSync(REMOTE_FOLDER, { recursive: true, force: true });
  fs.rmSync(CONFIG, { recursive: true, force: true });
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

/** The machine's agent row as the app lists it now. */
const claudeRow = (page: Page) =>
  page.evaluate(
    (id) =>
      window.native.host.machines().then((r) => (r.machines.find((m) => m.id === id)?.agents ?? []).find((a) => a.id === 'claude') ?? null),
    REMOTE_ID,
  );

/** What a failed wait leaves to read: the page's words, the machine's agent row, the Host's log. */
async function whatIsShown(page: Page, error: unknown) {
  const main = await page
    .getByRole('main')
    .innerText()
    .catch(() => '(no main)');
  const log = fs.existsSync(remote.hostLog) ? fs.readFileSync(remote.hostLog, 'utf8').slice(-1200) : '(none)';
  return `${String(error).slice(0, 160)} / page: ${main.slice(0, 900)} / row: ${JSON.stringify(await claudeRow(page).catch(() => null))} / host: ${log}`;
}

/** The model picker's list of the machine's agents, open (the new chat's composer: This Mac's two-level picker, the machine's agents first). */
async function openList(page: Page) {
  await page
    .getByRole('button', { name: 'Select model' })
    .click({ timeout: 20_000 })
    .catch(async (error) => {
      throw new Error(await whatIsShown(page, error));
    });
  const toList = page.getByRole('button', { name: 'Select harness and model' });
  if (await toList.isVisible().catch(() => false)) await toList.click();
  await expect(page.locator('.hp-harnesses')).toBeVisible();
  return page.locator('.hp-harnesses .hp-row');
}

/** Pick `label`'s first model in the open list, close the picker, and keep the composer's state on record before the send. */
async function pickAgent(page: Page, label: string, shot: string) {
  const rows = page.locator('.hp-harnesses .hp-row');
  await rows.filter({ hasText: label }).first().hover();
  await page.getByRole('menuitemradio').first().click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Select model' })).toBeVisible();
  fs.mkdirSync('test-results', { recursive: true });
  await page.screenshot({ path: path.join('test-results', `${shot}.png`) });
}

test("a login the provider refuses: which login it is, the refusal said once with the way on, the agent not offered as ready, Send waiting, and taken back by the machine's sign-in", async ({
  harness,
}) => {
  const page = harness.page;
  await connectRemote(page, remote, 'claude');

  // 1. before: the agent reads ready on the login its CLI records (a name and a plan, nothing that identifies the account)
  await expect
    .poll(() => claudeRow(page).then((a) => JSON.stringify(a?.loginAccount ?? null)), { timeout: 60_000 })
    .toBe('{"name":"Meggie","plan":"Ultra"}');
  const agents = await claudeRow(page);
  expect(JSON.stringify(agents)).not.toMatch(/someone@example|org-1/);

  // 2. the picker of a new chat on the machine names the login under the ready agent
  await startRemoteChat(page, 'Claude Code', 'ORGBLOCKED hello', false, async () => {
    const rows = await openList(page);
    const claude = rows.filter({ hasText: 'Claude Code' });
    await expect(claude).not.toHaveAttribute('aria-disabled', 'true');
    // the account the line names: the login's own email when the machine lists one (as This Mac does), else the CLI's record of it (name · plan, kept in the unit test)
    await expect(claude).toContainText(/Meggie · Ultra|@example\.test/);
    await shootBoth(page, harness.app, 'refused-1-picker-ready');
    await pickAgent(page, 'Claude Code', 'refused-1-claude-picked');
  });

  // 3. the failed turn: one error naming the agent and the machine, the sign-in on the machine, no Retry, and no second copy of the sentence as a reply
  const card = page.locator('.turn-error');
  await expect(card)
    .toHaveCount(1, { timeout: 60_000 })
    .catch(async (error) => {
      throw new Error(await whatIsShown(page, error));
    });
  const shown = await machineName(page);
  await expect(card).toContainText(`Claude Code on ${shown} can't run: its login is refused`);
  await expect(card.getByRole('button', { name: 'Sign in on machine' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Retry' })).toHaveCount(0);
  await expect(page.locator('.assistant-message').filter({ hasText: 'disabled Claude subscription access' })).toHaveCount(0);
  await shootBoth(page, harness.app, 'refused-2-the-failed-turn');

  // 4. before the next send: the machine's row says the agent cannot run, and why
  const escaped = shown.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await expect
    .poll(async () => JSON.stringify(await claudeRow(page)), { timeout: 90_000 })
    .toMatch(new RegExp(`"state":"signin"[^}]*can't run: its login is refused\\. Sign in again on ${escaped}`));

  // 5. the picker of the chat shows the refused state (disabled, with its words) and the other agent ready
  const rows = await openList(page);
  const claude = rows.filter({ hasText: 'Claude Code' });
  await expect(claude).toContainText("can't run: its login is refused");
  await expect(claude).toHaveAttribute('aria-disabled', 'true');
  await shootBoth(page, harness.app, 'refused-3-picker-refused');
  await page.keyboard.press('Escape');

  // 6. the agent counts as signed out like any other: Send waits and says why, and the card offers the sign-in on the machine
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill('hello again');
  const send = page.getByRole('button', { name: 'Send', exact: true });
  await expect(send).toBeDisabled();
  await page.locator('.tooltip-anchor', { has: send }).hover();
  await expect(page.locator('.tooltip').filter({ hasText: 'Sign in first' })).toBeVisible();
  await shootBoth(page, harness.app, 'refused-4-send-waits');

  // 7. the sign-in finished on the Host (the fake CLI's `auth login`) takes the refusal back; the same chat goes on, with no second error
  await page.locator('.host-signin-card').getByRole('button', { name: 'Sign in', exact: true }).click({ timeout: 30_000 });
  await expect.poll(async () => JSON.stringify(await claudeRow(page)), { timeout: 90_000 }).toMatch(/"id":"claude"[^}]*"state":"ready"/);
  await expect(send).toBeEnabled({ timeout: 30_000 });
  await send.click();
  await expect(page.getByRole('main').getByText('fake-claude: hello again')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.turn-error')).toHaveCount(1);
  await shootBoth(page, harness.app, 'refused-4-taken-back');
});
