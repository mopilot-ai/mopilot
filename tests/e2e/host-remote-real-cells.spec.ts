// e2e-runner: bench
// The cells of the Remote Run acceptance matrix with REAL agents behind a real-ssh Host that the journey spec (host-remote-real-journey.spec.ts) does not cover: the real harness switches (Claude Code with Codex, Claude Code with opencode), Deny on an approval card, a question card where the agent offers one, and a lost connection (the app's ssh tunnel killed). Same rig: the Mac app, a Host process with its own data dir reached through the VM's sshd and the app's ssh tunnel, and the machine's own Claude Code, Codex and opencode (its free models: a real ACP agent that needs no sign-in). Per agent, one chat that goes through: a first message with a code word, a turn that reads a file, edits it (an approval card is answered) and runs a command, a failing command, Stop in the middle of a turn, an agent process killed mid-turn (the turn ends, the chat recovers), the Mac closing mid-turn while the turn finishes on the Host and the transcript is complete on reconnect, and a Host restart between turns with the history intact. Every step checks the disk or the agent's own words, not only that something appeared.
// VM only (MOPILOT_ACCEPT_VM=1, the machine's own agents signed in or needing none, never a developer's Mac): `scripts/vm-exec.sh --vm mopilot-bench …` with the VM lock taken first. Named on the command line only.
import { test, expect } from './fixtures/app';
import { send } from './fixtures/mm3Journey';
import {
  AGENTS,
  HOME,
  REAL_USE,
  agentPids,
  tunnelPids,
  evidence,
  main,
  nonce,
  remote,
  startOn,
  stopButton,
  untilIdle,
  openList,
  declareRealHost,
  type Agent,
} from './fixtures/realJourney';
import { REMOTE_FOLDER } from './fixtures/remoteHost';
import { hostChatId } from '../../shared/host/chatIds.mjs';
import { asOtherClient, otherClient, permissionSets } from './fixtures/secondClient';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

test.skip(process.platform !== 'darwin', 'a basic harness is admitted only with sage-mcp, which builds only on macOS');
test.skip(!process.env.MOPILOT_ACCEPT_VM, 'the isolated VM only: it uses the real agents of the machine it runs on');

declareRealHost();
// a bench: it takes the VM to itself and outlasts an e2e shard: it runs alone, in the VM
test.beforeEach(() => {
  test.skip(test.info().config.shard !== null, 'a bench: run it alone');
});
test.use({
  ...REAL_USE,
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

// A chat moves to the other agent with REAL agents (the Mac's picker, the Host's handoff): the second agent has to know what the first was told, and has to work with tools. Both directions, one chat each.
for (const [first, second] of [
  [AGENTS[0], AGENTS[1]],
  [AGENTS[0], AGENTS[2]],
] as [Agent, Agent][]) {
  test(`real ${first.label} ↔ ${second.label} over a real-ssh Host: the chat moves to the other agent and that agent knows what the first was told`, async ({
    harness,
  }) => {
    test.skip(!first.bin || !second.bin, `needs both ${first.id} and ${second.id} on this machine`);
    const page = harness.page;
    const results: Record<string, string> = {};
    const directions: [Agent, Agent][] = [
      [first, second],
      [second, first],
    ];
    try {
      for (const [index, [from, to]] of directions.entries()) {
        const tag = `${from.id}-to-${to.id}`;
        const word = `QUOKKA-${tag}-${nonce}`;
        const file = path.join(HOME, `jr-switch-${tag}-${nonce}.txt`);
        fs.writeFileSync(file, `first line ${tag}\nsecond line\n`);
        await startOn(
          harness,
          from,
          `Remember this code word: ${word}. Reply with exactly ACK-${tag}-${nonce} and nothing else.`,
          index > 0,
        );
        await expect(main(page)).toContainText(`ACK-${tag}-${nonce}`, {
          timeout: 240_000,
        });
        await untilIdle(page, `the first turn on ${from.label}`);
        const chats = page.locator('[data-shortcut-recents] [data-sidebar-chat^="acp:"]');
        const chatId = await chats.first().getAttribute('data-sidebar-chat');
        // pick the other agent's cheap model from the machine's list
        await openList(page);
        const block = page.locator('.hp-harnesses > div', {
          has: page.locator('.hp-head', {
            hasText: new RegExp(`^${to.label}$`, 'i'),
          }),
        });
        await block.getByRole('menuitemradio', { name: to.model }).first().click();
        await expect(page.locator('.switch-chip')).toContainText(new RegExp(`Next message continues on\\s*${to.label}`, 'i'));
        await page.keyboard.press('Escape');
        // the next message settles the switch; the new agent has to answer from the handoff and then use a tool
        await send(
          page,
          `What code word did I ask you to remember earlier? Then read the file ${file} and reply with one line: WORD: <the code word> FILE: <its first line>.`,
        );
        const allowed = await untilIdle(page, `the first turn on ${to.label}`);
        const text = await evidence(page, `${tag}-after-switch`);
        expect(text, `${to.label} knew the code word and read the file`).toMatch(
          new RegExp(`WORD:\\s*${word}\\s*FILE:\\s*first line ${tag}`),
        );
        expect(await chats.count(), 'one chat').toBe(index + 1);
        expect(await chats.first().getAttribute('data-sidebar-chat'), 'the same chat id').toBe(chatId);
        await expect(page.locator('.switch-chip')).toHaveCount(0);
        results[tag] = `${to.label} answered with the code word and read the file (${allowed} approval(s)); same chat; chip gone`;
        fs.rmSync(file, { force: true });
      }
    } finally {
      console.log(`JR-SWITCH-RESULT :: ${JSON.stringify(results)}`);
    }
  });
}

// Deny on an approval card (Escape / the Deny button): the command must not run and the agent must say so. A card that never comes (Codex sometimes does not ask) fails the test with that message.
for (const agent of AGENTS) {
  test(`${agent.label} (real): Deny on an approval card keeps the command from running`, async ({ harness }) => {
    test.skip(!agent.bin, `no ${agent.id} on this machine`);
    const page = harness.page;
    const target = path.join(HOME, `jr-deny-${agent.id}-${nonce}`);
    fs.rmSync(target, { force: true });
    try {
      await startOn(harness, agent, `Reply with exactly ACK-${nonce} and nothing else.`);
      await expect(main(page)).toContainText(`ACK-${nonce}`, {
        timeout: 240_000,
      });
      await untilIdle(page, 'the first turn');
      // Codex's modes never ask for every command: "Ask for approval" is workspace-write on-request (the model decides whether to ask before it leaves the folder), so a Codex chat is put in the closest mode, Read-only (a read-only sandbox that can still ask to go beyond it)
      if (agent.id === 'codex') {
        await page.getByRole('button', { name: 'Change permissions' }).click();
        await page.getByRole('menuitemradio', { name: /Read-only/ }).click();
      }
      await send(page, `Run the shell command: touch ${target}. If it is refused, do not try another way and say REFUSED-${nonce}.`);
      const card = page.locator('.approval-card').first();
      await expect(card, 'the agent asked for an approval').toBeVisible({
        timeout: 180_000,
      });
      let denied = 0;
      const end = Date.now() + 180_000;
      for (;;) {
        if (await card.isVisible().catch(() => false)) {
          denied += 1;
          await card.getByRole('button', { name: /^Deny/ }).click();
          await page.waitForTimeout(800);
          continue;
        }
        if ((await stopButton(page).count()) === 0) {
          await page.waitForTimeout(1500);
          if (!(await card.isVisible().catch(() => false)) && (await stopButton(page).count()) === 0) break;
        }
        if (Date.now() > end) throw new Error(`the turn did not end after Deny: ${(await main(page).innerText()).slice(0, 600)}`);
        await page.waitForTimeout(600);
      }
      const text = await evidence(page, `${agent.id}-deny`);
      expect(fs.existsSync(target), 'the denied command did not run').toBe(false);
      console.log(
        `JR-DENY ${agent.id} :: denied ${denied} card(s); file not written; transcript tail: ${text.slice(-200).replaceAll('\n', ' ⏎ ')}`,
      );
    } finally {
      fs.rmSync(target, { force: true });
    }
  });
}

/** A renderer that no longer answers: the app's processes by CPU, and the stack the debugger pauses it in (Debugger.pause works while a script loops). */
async function whereItHangs(app: import('@playwright/test').ElectronApplication) {
  return app.evaluate(async ({ app: electron, webContents }) => {
    const all = webContents.getAllWebContents();
    const wc = all.find((w) => !w.isDestroyed() && /index\.html|localhost/.test(w.getURL())) ?? all[0];
    const metrics = electron.getAppMetrics().map((m) => `${m.type}:${Math.round(m.cpu.percentCPUUsage)}%`);
    let frames: string[] = [];
    try {
      wc.debugger.attach('1.3');
      await wc.debugger.sendCommand('Debugger.enable');
      frames = await new Promise<string[]>((resolve) => {
        const timer = setTimeout(() => resolve(['(the debugger did not pause the page in 8 s)']), 8000);
        wc.debugger.on('message', (_event, method, params: any) => {
          if (method !== 'Debugger.paused') return;
          clearTimeout(timer);
          resolve(
            params.callFrames
              .slice(0, 14)
              .map(
                (f: any) => `${f.functionName || '(anonymous)'} ${String(f.url).split('/').slice(-2).join('/')}:${f.location.lineNumber}`,
              ),
          );
        });
        void wc.debugger.sendCommand('Debugger.pause').catch(() => undefined);
      });
    } catch (error) {
      frames = [String(error)];
    }
    return { metrics, frames, url: wc?.getURL() };
  });
}

/** The tool each agent asks a person a question with. */
const QUESTION_TOOL = {
  claude: 'AskUserQuestion',
  codex: 'request_user_input',
  opencode: 'question',
} as const;

// A question card: asked for once per agent. The result is a pass only when the agent offered a card and the answer reached it; an agent that offered none (Codex outside Plan mode, opencode without a question tool) makes the test skip, never pass.
for (const agent of AGENTS) {
  test(`${agent.label} (real): a question card, if the agent offers one, is answered and the answer reaches the agent`, async ({
    harness,
  }) => {
    test.skip(!agent.bin, `no ${agent.id} on this machine`);
    const page = harness.page;
    await startOn(
      harness,
      agent,
      `Call your ${QUESTION_TOOL[agent.id]} tool (a real question to me, not text in your reply) to ask "Which fruit?" with the two options apple and pear. Then reply with exactly CHOSE-${nonce}-<my choice>.`,
    );
    // whether the agent the Host started carries opencode's flag for its question tool (a process's environment is on its `ps eww` line)
    if (agent.id === 'opencode') {
      const until = Date.now() + 30_000;
      let line = '';
      while (!line && Date.now() < until) {
        const pid = agentPids(remote.pid()).find((v) => /opencode/.test(v.command))?.pid;
        if (pid) line = execFileSync('ps', ['eww', '-p', String(pid)], { encoding: 'utf8' });
        else await page.waitForTimeout(500);
      }
      console.log(
        `JR-ENV opencode :: OPENCODE_ENABLE_QUESTION_TOOL=${/OPENCODE_ENABLE_QUESTION_TOOL=(\S*)/.exec(line)?.[1] ?? 'unset'}${line ? '' : ' (no opencode process found)'}`,
      );
    }
    const card = page.locator('.question-card');
    const offered = await card
      .waitFor({ state: 'visible', timeout: 150_000 })
      .then(() => true)
      .catch(() => false);
    if (!offered) {
      await evidence(page, `${agent.id}-no-question`);
      console.log(`JR-QUESTION ${agent.id} :: not offered (no card within 150 s)`);
      // not a pass: nothing was asked, so nothing was shown to work
      test.skip(true, `${agent.label} showed no question card`);
      return;
    }
    await card.locator('.question-option', { hasText: 'apple' }).click();
    await expect(main(page)).toContainText(new RegExp(`CHOSE-${nonce}-apple`, 'i'), { timeout: 180_000 });
    await untilIdle(page, 'the turn after the answer');
    await evidence(page, `${agent.id}-question`);
    console.log(`JR-QUESTION ${agent.id} :: offered, answered, reached the agent`);
  });
}

// Codex's Read-only mode is a sandbox and approval mode, not Plan: does a question card come in it? (The Host's `chat.permit` takes the mode; the Mac's menu sends it.)
test('Codex (real): a question card in Read-only mode', async ({ harness }) => {
  const agent = AGENTS.find((a) => a.id === 'codex');
  test.skip(!agent?.bin, 'no codex on this machine');
  const page = harness.page;
  await startOn(harness, agent as Agent, `Reply with exactly ACK-${nonce} and nothing else.`);
  await expect(main(page)).toContainText(`ACK-${nonce}`, { timeout: 240_000 });
  await untilIdle(page, 'the first turn');
  await page.getByRole('button', { name: 'Change permissions' }).click();
  await page.getByRole('menuitemradio', { name: /Read-only/ }).click();
  await send(
    page,
    `Call your request_user_input tool (a real question to me, not text in your reply) to ask "Which fruit?" with the two options apple and pear. Then reply with exactly CHOSE-${nonce}-<my choice>.`,
  );
  const card = page.locator('.question-card');
  const offered = await card
    .waitFor({ state: 'visible', timeout: 120_000 })
    .then(() => true)
    .catch(() => false);
  const text = await evidence(page, 'codex-readonly-question');
  console.log(
    `JR-QUESTION codex-readonly :: ${offered ? 'card offered' : 'not offered'} :: ${/unavailable in \w+ mode/i.exec(text)?.[0] ?? ''}`,
  );
  test.skip(!offered, 'Codex showed no question card in Read-only mode');
});

// Codex asks a question only in Plan mode: the chat is put in Plan mode from the composer's add panel (the way a local chat is), on a chat that runs on the Host, then the card is answered from the Mac app.
test('Codex (real): a question card in Plan mode is answered and the answer reaches the agent', async ({ harness }) => {
  test.setTimeout(9 * 60_000);
  const agent = AGENTS.find((a) => a.id === 'codex');
  test.skip(!agent?.bin, 'no codex on this machine');
  const page = harness.page;
  console.log('JR-STEP plan 1 start');
  await startOn(harness, agent as Agent, `Reply with exactly ACK-${nonce} and nothing else.`);
  await expect(main(page)).toContainText(`ACK-${nonce}`, { timeout: 240_000 });
  console.log('JR-STEP plan 2 first turn answered');
  await untilIdle(page, 'the first turn');
  console.log('JR-STEP plan 3 first turn idle, opening the add panel');
  await page.getByRole('button', { name: 'Add files and more' }).click();
  const planRow = page.locator('.add-panel').getByText('Plan mode', { exact: true });
  // the Mac refuses Plan mode on a chat that runs on a machine (#4895): then there is no card to answer, and the test says so, never passes
  test.skip(await planRow.isDisabled().catch(() => false), "Plan mode isn't available on a Host chat (#4895)");
  await planRow.click();
  await expect(page.locator('.plan-chip'), 'a chat on a Host can be put in Plan mode from the composer').toBeVisible({ timeout: 15_000 });
  console.log('JR-STEP plan 4 Plan is on, asking');
  await send(
    page,
    `Call your request_user_input tool (a real question to me, not text in your reply) to ask "Which fruit?" with the two options apple and pear. Then reply with exactly CHOSE-${nonce}-<my choice>.`,
  );
  const card = page.locator('.question-card');
  await expect(card, 'Codex in Plan mode shows its question card on the Mac').toBeVisible({ timeout: 150_000 });
  console.log('JR-STEP plan 5 card is up, answering');
  await card.locator('.question-option', { hasText: 'apple' }).click();
  // what the chat shows each 20 s after the answer, so a turn that does not go on says where it stands (card still there, Stop, the words so far)
  const reply = new RegExp(`CHOSE-${nonce}-apple`, 'i');
  for (let waited = 0; waited <= 140; waited += 20) {
    // the reads together must come back in 15 s: a page that does not answer is the hang, and this says where it stands
    const read = await Promise.race([
      (async () => ({
        text: (
          (await main(page)
            .innerText()
            .catch(() => '')) as string
        ).replace(/\s+/g, ' '),
        stop: await stopButton(page).count(),
        cardLeft: await card.count(),
      }))(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 15_000)),
    ]);
    if (read === null) {
      console.log(`JR-HANG plan after +${waited}s :: ${JSON.stringify(await whereItHangs(harness.app))}`);
      throw new Error('the page stopped answering after the question was answered');
    }
    const { text: shown, stop, cardLeft } = read;
    console.log(`JR-STEP plan 5b +${waited}s :: stop=${stop} card=${cardLeft} :: ${shown.slice(-240)}`);
    if (reply.test(shown)) break;
    await page.waitForTimeout(20_000);
  }
  await expect(main(page)).toContainText(reply, { timeout: 10_000 });
  await untilIdle(page, 'the turn after the answer');
  await evidence(page, 'codex-plan-question');
  console.log('JR-QUESTION codex-plan :: offered, answered, reached the agent');
  console.log('JR-STEP plan 6 leaving Plan');
  // Plan is left by the switch: the Host is told the mode the chat is in, and Codex no longer has its question tool
  await page.getByRole('button', { name: 'Add files and more' }).click();
  await page.locator('.add-panel').getByText('Plan mode', { exact: true }).click();
  await expect(page.locator('.plan-chip'), 'turning Plan off clears the chip').toHaveCount(0);
  await send(
    page,
    `Call your request_user_input tool (a real question to me, not text in your reply) to ask "Which drink?" with the two options tea and milk. Then reply with exactly BACK-${nonce}.`,
  );
  await untilIdle(page, 'the turn after Plan was left');
  await expect(card, 'no question card once Plan is left').toHaveCount(0);
  const after = await evidence(page, 'codex-plan-left');
  expect(after, 'Codex says the tool is not available outside Plan').toMatch(/can.t call|unavailable|not available|isn.t available/i);
  console.log('JR-QUESTION codex-plan :: left Plan, no card');
});

// The owner's ceiling holds Plan too (#4899): under a read-only ceiling a chat in Plan runs Codex's tools in a read-only sandbox (read from Codex's own record of the turn), and a write it is asked for does not happen.
test('Codex (real): under a read-only ceiling a chat in Plan cannot write', async ({ harness }) => {
  const agent = AGENTS.find((a) => a.id === 'codex');
  test.skip(!agent?.bin, 'no codex on this machine');
  const page = harness.page;
  const marker = path.join(REMOTE_FOLDER, `jr-ceiling-${nonce}`);
  fs.rmSync(marker, { force: true });
  await startOn(harness, agent as Agent, `Reply with exactly ACK-${nonce} and nothing else.`);
  await expect(main(page)).toContainText(`ACK-${nonce}`, { timeout: 240_000 });
  await untilIdle(page, 'the first turn');
  const owner = await page.evaluate(() => window.native.host.ownerPolicy());
  await page.evaluate((doc) => window.native.host.setOwnerPolicy({ ...doc, permissionMax: 'read-only' }), owner);
  await expect
    .poll(async () => page.evaluate(() => window.native.host.ownerPolicy().then((d) => d.permissionMax)), { timeout: 30_000 })
    .toBe('read-only');
  // The Mac holds its own pick (Ask first) and would be refused under the ceiling; another client (the phone) puts the chat in Plan and sends without a mode of its own, so only the Host's clamp stands between the turn and the base the chat kept
  const chatId = (await page.locator('[data-shortcut-recents] [data-sidebar-chat]').first().getAttribute('data-sidebar-chat')) ?? '';
  expect(chatId).not.toBe('');
  const hostChat = hostChatId(chatId);
  const as = (n: number) => `phone-like-${n}-${Date.now()}`;
  asOtherClient(remote, [
    ['chat.permit', { chatId: hostChat, epoch: 1, key: as(1), value: 'plan' }],
    [
      'chat.send',
      {
        chatId: hostChat,
        epoch: 1,
        key: as(2),
        text: `Run this shell command now, it is allowed: \`touch ${marker}\`. Then reply with exactly DONE-${nonce}.`,
      },
    ],
  ]);
  const lastTurn = () =>
    execFileSync(
      'bash',
      [
        '-c',
        `f=$(grep -la "jr-ceiling-${nonce}" ~/.codex/sessions/*/*/*/rollout-*.jsonl 2>/dev/null | head -1); [ -n "$f" ] && [ "$(grep -ac "\"turn_context\"" "$f")" -ge 2 ] && [ $(( $(date +%s) - $(stat -f %m "$f") )) -ge 8 ] && grep -a "\"turn_context\"" "$f" | tail -1; true`,
      ],
      { encoding: 'utf8' },
    );
  await expect.poll(lastTurn, { timeout: 240_000 }).not.toBe('');
  const rollout = lastTurn();
  console.log(
    `JR-CEILING codex :: last turn_context :: ${rollout.slice(0, 700)} :: the Mac shows :: ${(await main(page).innerText()).replace(/\s+/g, ' ').slice(0, 600)}`,
  );
  expect(rollout, 'Codex ran the Plan turn in a read-only sandbox').toMatch(/"sandbox_policy":\{"type":"read-only"/);
  expect(rollout, 'and in its Plan mode').toMatch(/"mode":"plan"/);
  expect(fs.existsSync(marker), 'the write did not happen').toBe(false);
  fs.rmSync(marker, { force: true });
});

// Two clients of one chat: the Mac picked a mode once, another client then set another; the Mac's next message must not undo it. Written as the behaviour we want, and marked as the failure it is today (the Mac sends its own pick with every message): see the issue it names.
test('Codex (real): a mode another client sets is not undone by the Mac’s earlier pick on its next message', async ({ harness }) => {
  test.fail(true, 'known: the Mac’s pick wins over the Host’s mode, so the other client’s mode is replaced by the next message');
  const agent = AGENTS.find((a) => a.id === 'codex');
  test.skip(!agent?.bin, 'no codex on this machine');
  const page = harness.page;
  await startOn(harness, agent as Agent, `Reply with exactly ACK-${nonce} and nothing else.`);
  await expect(main(page)).toContainText(`ACK-${nonce}`, { timeout: 240_000 });
  await untilIdle(page, 'the first turn');
  const chatId = (await page.locator('[data-shortcut-recents] [data-sidebar-chat]').first().getAttribute('data-sidebar-chat')) ?? '';
  expect(chatId).not.toBe('');
  // the Mac's pick, sent with its next message
  await page.getByRole('button', { name: 'Change permissions' }).click();
  await page.getByRole('menuitemradio', { name: /Read-only/ }).click();
  await send(page, `Reply with exactly TWO-${nonce} and nothing else.`);
  await expect(main(page)).toContainText(`TWO-${nonce}`, { timeout: 240_000 });
  await untilIdle(page, 'the second turn');
  // another client sets another mode
  const other = await otherClient(remote, 'phone-like');
  try {
    await other.permit(chatId, 'auto-review');
  } finally {
    other.close();
  }
  await send(page, `Reply with exactly THREE-${nonce} and nothing else.`);
  await expect(main(page)).toContainText(`THREE-${nonce}`, { timeout: 240_000 });
  await untilIdle(page, 'the third turn');
  const modes = permissionSets(remote);
  console.log(`JR-MODES codex :: the Host's audit record, oldest first: ${modes.join(' → ')}`);
  expect(modes.at(-1), 'the mode the Host holds after the Mac’s next message is the one the other client set').toBe('auto-review');
});

// A network loss, not a quit: the app's ssh tunnel to the Host is killed while a command runs. The Host finishes the turn; the app reconnects by itself and the open chat shows the whole turn with no reopening and nothing marked interrupted.
for (const agent of AGENTS) {
  test(`${agent.label} (real): the connection is lost mid-turn, the Host finishes it and the app shows it after it reconnects`, async ({
    harness,
  }) => {
    test.skip(!agent.bin, `no ${agent.id} on this machine`);
    const page = harness.page;
    const marker = path.join(REMOTE_FOLDER, `jr-net-${agent.id}-${nonce}`);
    fs.rmSync(marker, { force: true });
    await startOn(harness, agent, `Reply with exactly ACK-${nonce} and nothing else.`);
    await expect(main(page)).toContainText(`ACK-${nonce}`, {
      timeout: 240_000,
    });
    await untilIdle(page, 'the first turn');
    await send(
      page,
      `Run this shell command and wait for it to finish: \`for i in $(seq 1 40); do sleep 1; done; touch ${marker}\`. Then say DONE-${nonce}.`,
    );
    const until = Date.now() + 150_000;
    while (Date.now() < until && !agentPids(remote.pid()).some((v) => /seq 1 40/.test(v.command))) {
      if (
        await page
          .locator('.approval-card')
          .first()
          .isVisible()
          .catch(() => false)
      )
        await page.keyboard.press('1');
      await page.waitForTimeout(500);
    }
    expect(
      agentPids(remote.pid()).some((v) => /seq 1 40/.test(v.command)),
      'the command runs on the Host when the connection goes',
    ).toBe(true);
    const pids = tunnelPids();
    console.log(`JR-NET ${agent.id} :: killing the app's ssh tunnel(s) ${pids.join(',')} at ${new Date().toISOString()}`);
    expect(pids.length, 'the app has an ssh tunnel to kill').toBeGreaterThan(0);
    for (const pid of pids) process.kill(pid, 'SIGKILL');
    await expect
      .poll(() => fs.existsSync(marker), {
        timeout: 120_000,
        message: 'the Host finished the command while the app had no connection',
      })
      .toBe(true);
    // the app comes back by itself; the open chat shows the end of the turn without reopening
    await expect(main(page)).toContainText(`DONE-${nonce}`, {
      timeout: 240_000,
    });
    await untilIdle(page, 'the turn after the connection came back');
    const text = await evidence(page, `${agent.id}-network-loss`);
    expect(text, 'nothing is marked interrupted').not.toMatch(/quit while working|interrupted/i);
    console.log(`JR-NET ${agent.id} :: the Host wrote the marker, the app showed DONE after reconnecting, no reopen`);
  });
}
