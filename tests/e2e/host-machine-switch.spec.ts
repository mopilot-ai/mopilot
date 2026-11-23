// e2e-runner: bench
// J8 / D13 of the Remote Run plan (#4278): moving a chat that runs on a machine to another agent there, in the real Mac app against a real Host process over real ssh (this runner's sshd and the app's ssh tunnel) that has the repo's fake Claude Code, fake Codex and fake ACP agent. For every direction the machine offers: the machine's other agents are listed, picking one asks the Host and shows "Next message continues on", Undo takes it back at the Host (the next message stays), and the next message settles it (same chat, history kept, a divider in the transcript, the reply comes from the new agent, the picker shows it); then the Host's refusals for an agent that is absent or signed out.
// It turns on sshd and writes the user's ssh config, so it runs only on a CI runner. Named on the command line only: `node scripts/ci-cuj.mjs --spec tests/e2e/host-machine-switch.spec.ts`.
import fs from 'node:fs';
import os from 'node:os';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { send } from './fixtures/mm3Journey';
import { REMOTE_FOLDER, type RemoteHost, connectRemote, sshToSelf, startRemoteChat, startRemoteHost } from './fixtures/remoteHost';

test.skip(process.platform !== 'darwin', 'a basic harness is admitted only with sage-mcp, which builds only on macOS');
test.skip(!process.env.GITHUB_ACTIONS, 'a runner only: it turns on sshd and writes the ssh config');

const HOME = os.homedir();
const ALL = { claude: true, codex: true, acp: 'in', acpModels: true } as const;
let remote: RemoteHost;

test.setTimeout(12 * 60_000);
test.beforeAll(async () => {
  fs.mkdirSync(REMOTE_FOLDER, { recursive: true });
  sshToSelf();
  remote = await startRemoteHost({ agents: ALL });
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

type Agent = 'claude' | 'codex' | 'fake';
/** What each agent is called in the machine's list, and what its fake says first. */
const AGENT: Record<Agent, { label: string; says: string; row: string }> = {
  claude: { label: 'Claude Code', says: 'fake-claude: ', row: 'Kimi Code' },
  codex: { label: 'Codex', says: 'codex: ', row: 'Codex' },
  fake: { label: 'fake', says: 'fake-acp: ', row: 'Kimi Code' },
};
const DIRECTIONS: [Agent, Agent][] = [
  ['claude', 'codex'],
  ['codex', 'claude'],
  // the machine's fake ACP agent is a test agent: the picker never lists it (shared/host/machineLine.mjs TEST_AGENTS), so no direction goes through it
];

const main = (page: Page) => page.getByRole('main');
const idle = (page: Page) => expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 90_000 });
const tailOf = (file: string, n = 5000) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').slice(-n) : '(none)');
/** What every part of the stack knew when a switched turn did not end, for the lane that owns each part (the Host's log, what the agents were asked and said, and the app's view of the machine). */
async function dumpState(page: Page, what: string) {
  const machines = await page
    .evaluate(() => window.native.host.machines().then((r) => JSON.stringify(r.machines).slice(0, 2500)))
    .catch((e) => `(${e})`);
  const parts: Record<string, string> = {
    hostLog: tailOf(remote.hostLog),
    acpLog: tailOf(remote.acpLog, 6000),
    acpState: fs.existsSync(remote.acpState) ? fs.readdirSync(remote.acpState).join(', ') : '(none)',
    codexLog: tailOf(remote.codexLog, 4000),
    machines,
    stop: String(await page.getByRole('button', { name: 'Stop', exact: true }).count()),
  };
  for (const [name, text] of Object.entries(parts)) {
    console.log(`J8-DUMP ${what} :: ${name} :: ${text.replaceAll('\n', ' ⏎ ')}`);
    await test.info().attach(`${what}-${name}.txt`, { body: text, contentType: 'text/plain' });
  }
}

/** Waits for the turn to end, allowing a command or edit the agent asks about (the fakes ask on some words of the handoff block). */
async function idleAllowing(page: Page, what: string) {
  try {
    await expect
      .poll(
        async () => {
          if (
            await page
              .locator('.approval-card')
              .isVisible()
              .catch(() => false)
          ) {
            console.log(`J8-APPROVAL: ${what} asked for an approval; allowed`);
            await page.keyboard.press('1');
          }
          return page.getByRole('button', { name: 'Stop', exact: true }).count();
        },
        { timeout: 120_000 },
      )
      .toBe(0);
  } catch (error) {
    await dumpState(page, what);
    throw new Error(`${what}: the turn did not end: ${(await main(page).innerText()).slice(0, 900)} / ${String(error).slice(0, 100)}`);
  }
}
/** The chats in Recents (a chat in a project is listed there too, by design). */
const chats = (page: Page) => page.locator('[data-shortcut-recents] [data-sidebar-chat^="acp:"]');
const chip = (page: Page) => page.locator('.switch-chip');
/** Whether the fake Claude Code or Codex was asked `text` (their log files). */
const asked = (agent: Agent, text: string) => {
  const log = agent === 'claude' ? remote.claudeLog : remote.codexLog;
  return fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes(text);
};

/** The model picker's list of the machine's agents, open. */
async function openList(page: Page) {
  await page.getByRole('button', { name: 'Select model' }).click();
  const toList = page.getByRole('button', { name: 'Select harness and model' });
  if (await toList.isVisible().catch(() => false)) await toList.click();
  await expect(page.locator('.hp-harnesses')).toBeVisible();
}
/** One agent's row in that list (the picker is This Mac's two-level one: the models of the agent pointed at are beside the list). */
const block = (page: Page, agent: Agent) =>
  page.locator('.hp-row', { has: page.locator('.hp-title', { hasText: new RegExp(`^${AGENT[agent].label}$`, 'i') }) });
/** Pick the first model of `agent` in the open list. */
const pickModel = async (page: Page, agent: Agent) => {
  await block(page, agent).hover();
  await page.getByRole('menuitemradio').first().click();
};

/** A new chat on the machine's `agent` with its first message, and its reply. */
async function startOn(page: Page, agent: Agent, text: string) {
  await connectRemote(page, remote, agent === 'fake' ? 'fake' : agent);
  await startRemoteChat(page, AGENT[agent].row, text, false, async () => {
    // the machine's first ready agent is Claude Code: another one is picked in the new chat's list
    if (agent === 'codex' || agent === 'fake') {
      await openList(page);
      await pickModel(page, agent);
      await page.keyboard.press('Escape');
    }
  });
  await expect(main(page)).toContainText(`${AGENT[agent].says}${text}`, { timeout: 120_000 });
  await idle(page);
}

for (const [from, to] of DIRECTIONS) {
  test(`${AGENT[from].label} → ${AGENT[to].label}: listed, held at the Host, undone, then settled by the next message`, async ({
    harness,
  }) => {
    const page = harness.page;
    await startOn(page, from, `first-${from}`);
    const chat = await chats(page).first().getAttribute('data-sidebar-chat');
    expect(await chats(page).count()).toBe(1);

    // (1) the machine's other agents are in the picker, each under its name
    await openList(page);
    for (const agent of ['claude', 'codex'] as const) await expect(block(page, agent), `${AGENT[agent].label} is listed`).toBeVisible();

    // (2) picking another asks the Host first, then the chip above the composer says where the next message goes
    await pickModel(page, to);
    await expect(chip(page)).toContainText(new RegExp(`Next message continues on\\s*(acp:)?${AGENT[to].label}`, 'i'));

    // (3) Undo takes it back at the Host: the next message stays on the old agent
    await chip(page).getByRole('button', { name: 'Cancel switch' }).click();
    await expect(chip(page)).toHaveCount(0);
    await send(page, `stay-${from}`);
    await expect(main(page)).toContainText(`${AGENT[from].says}stay-${from}`, { timeout: 120_000 });
    await idle(page);
    await expect(main(page)).not.toContainText(`${AGENT[to].says}stay-${from}`);

    // the choice again, and the next message settles it
    await openList(page);
    await pickModel(page, to);
    await expect(chip(page)).toContainText(new RegExp(`Next message continues on\\s*(acp:)?${AGENT[to].label}`, 'i'));
    await send(page, `moved-${to}`);
    // the next turn runs on the new agent: Claude Code and Codex by what their fake was asked, the ACP agent by its echo of the handoff
    await idleAllowing(page, `the first turn on ${AGENT[to].label}`);
    if (to === 'fake') await expect(main(page)).toContainText('fake-acp: <sage-handoff', { timeout: 30_000 });
    else
      await expect
        .poll(() => asked(to, `moved-${to}`), { timeout: 30_000, message: `the next turn did not reach ${AGENT[to].label}` })
        .toBe(true);
    await idle(page);
    // the same chat, its history, and and (soft, so every result is reported) no chip left
    expect(await chats(page).count()).toBe(1);
    expect(await chats(page).first().getAttribute('data-sidebar-chat')).toBe(chat);
    await expect(main(page)).toContainText(`${AGENT[from].says}first-${from}`);
    // the Host journaled the switch and the Mac drew it as the chat's own divider, once (#4775)
    await expect(main(page).locator('.switch-divider'), 'a divider names the switch').toHaveCount(1);
    await expect(main(page).locator('.switch-divider')).toContainText(new RegExp(`→ ${AGENT[to].label}`, 'i'));
    await expect.soft(chip(page), 'the chip is gone once the message settled it').toHaveCount(0);
    // the picker now shows the new agent as the current one (its row holds the check) and lists its models beside it
    await openList(page);
    await expect(block(page, to).locator('.menu-check svg')).toBeVisible();
    await block(page, to).hover();
    await expect(page.getByRole('menuitemradio').first()).toBeVisible();
  });
}

test('the Host refuses an agent that is not installed or is signed out, and holds nothing', async ({ harness }) => {
  const page = harness.page;
  await startOn(page, 'claude', 'first-refusal');
  const chat = (await chats(page).first().getAttribute('data-sidebar-chat'))!;
  const ask = (harnessKind: string) =>
    page.evaluate(
      ([id, kind]) =>
        window.native.host.switchChat(id, { harness: kind, model: 'x' }).then(
          () => 'accepted',
          (e: { message?: string }) => String(e?.message ?? e),
        ),
      [chat, harnessKind] as const,
    );

  // Codex is not installed on the machine
  await remote.restart({ agents: { claude: true, acp: 'in', acpModels: true } });
  await expect
    .poll(async () => JSON.stringify(await page.evaluate(() => window.native.host.machines())), { timeout: 90_000 })
    .toMatch(/"id":"codex"[^}]*"state":"missing"/);
  expect(await ask('codex')).toMatch(/not installed/i);
  await expect(chip(page)).toHaveCount(0);
  // the picker lists the agent the machine lacks with its state, and offers no model of it
  await openList(page);
  await expect(block(page, 'codex')).toContainText(/Not installed/);
  await expect(block(page, 'codex').getByRole('menuitemradio')).toHaveCount(0);
  await page.keyboard.press('Escape');

  // the ACP agent is signed out
  await remote.restart({ agents: { claude: true, codex: true, acp: 'out', acpModels: true } });
  await expect
    .poll(async () => JSON.stringify(await page.evaluate(() => window.native.host.machines())), { timeout: 90_000 })
    .toMatch(/"id":"fake"[^}]*"state":"signin"/);
  expect(await ask('acp:fake')).toMatch(/sign in/i);
  await expect(chip(page)).toHaveCount(0);

  await remote.restart({ agents: ALL });
});

test('the Host is killed between choosing another agent and the message that settles it: the choice is still held (S2b)', async ({
  harness,
}) => {
  const page = harness.page;
  await startOn(page, 'claude', 'first-kill');
  await openList(page);
  await pickModel(page, 'codex');
  await expect(chip(page)).toContainText(/Next message continues on\s*Codex/i);
  // hard kill, then the same Host data comes back
  await remote.restart({ kill: true });
  await expect
    .poll(async () => JSON.stringify(await page.evaluate(() => window.native.host.machines())), {
      timeout: 120_000,
      message: 'the machine is back online',
    })
    .toMatch(/"status":"online"[\s\S]*"id":"codex"[^}]*"state":"ready"/);
  await expect.soft(chip(page), 'the chip survives the Host restart').toContainText(/Next message continues on\s*Codex/i);
  await send(page, 'moved-after-kill');
  await idleAllowing(page, 'the first turn on Codex after a Host kill');
  await expect
    .poll(() => asked('codex', 'moved-after-kill'), { timeout: 30_000, message: 'the next message did not reach Codex after the kill' })
    .toBe(true);
  expect(await chats(page).count()).toBe(1);
  await expect.soft(chip(page)).toHaveCount(0);
});

test('a machine whose agents are signed out and run only on keys the app lends: Claude Code → Codex, the next message runs on the Codex key', async ({
  harness,
}) => {
  const page = harness.page;
  // the machine has both agents installed and signed out; the app holds a key for each and lends it with a message
  await remote.restart({ agents: { claude: true, codex: true, claudeOut: true, codexOut: true, acp: 'in', acpModels: true } });
  await page.evaluate(() => window.native.host.setApiKey('anthropic', 'sk-ant-api03-fake-lent-key-0000000000000000'));
  await page.evaluate(() => window.native.host.setApiKey('openai', 'sk-proj-fake-lent-key-0000000000000000'));
  try {
    await startOn(page, 'claude', 'first-lent');
    // the machine reports no models for Codex until a key is lent with a message on it, so the picker offers the agent alone (its default model)
    await openList(page);
    await block(page, 'codex').hover();
    await page.getByRole('menuitem', { name: /^Switch to Codex/ }).click();
    await expect(chip(page)).toContainText(/Next message continues on\s*Codex/i);
    await send(page, 'moved-lent');
    await idleAllowing(page, 'the first turn on Codex with a lent key');
    await expect.poll(() => asked('codex', 'moved-lent'), { timeout: 30_000, message: 'the next message did not reach Codex' }).toBe(true);
    // the Host logged Codex in with the lent key (the key itself is never printed)
    expect(tailOf(remote.codexLog, 200_000), 'Codex was logged in with the lent key').toContain('account/login/start');
  } finally {
    await page.evaluate(() => window.native.host.removeApiKey('anthropic')).catch(() => undefined);
    await page.evaluate(() => window.native.host.removeApiKey('openai')).catch(() => undefined);
    await remote.restart({ agents: ALL });
  }
});

// Not covered here, and why: the picker offers no model row for an agent the machine does not have or has signed out (it lists the agent with the machine's reason, and no row to click), so the Host's refusal text cannot be reached through the picker; the refusal test above asks the Host directly (window.native.host.switchChat) and checks the picker's reason line instead.
