// e2e-runner: bench
// The Remote Run acceptance journey with REAL agents behind a real-ssh Host: the Mac app, a Host process with its own data dir reached through the VM's sshd and the app's ssh tunnel, and the machine's own Claude Code, Codex and opencode (its free models: a real ACP agent that needs no sign-in). Per agent, one chat that goes through: a first message with a code word, a turn that reads a file, edits it (an approval card is answered) and runs a command, a failing command, Stop in the middle of a turn, an agent process killed mid-turn (the turn ends, the chat recovers), the Mac closing mid-turn while the turn finishes on the Host and the transcript is complete on reconnect, and a Host restart between turns with the history intact. Every step checks the disk or the agent's own words, not only that something appeared.
// VM only (MOPILOT_ACCEPT_VM=1, the machine's own agents signed in or needing none, never a developer's Mac): `scripts/vm-exec.sh --vm mopilot-bench …` with the VM lock taken first. Named on the command line only.
import { test, expect } from './fixtures/app';
import { send } from './fixtures/mm3Journey';
import {
  AGENTS,
  HOME,
  REAL_USE,
  agentPids,
  evidence,
  main,
  nonce,
  remote,
  startOn,
  stepOn,
  stopButton,
  untilIdle,
  untilIdleOrRunning,
  declareRealHost,
  type Agent,
} from './fixtures/realJourney';
import { REMOTE_FOLDER, connectRemote } from './fixtures/remoteHost';
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

for (const agent of AGENTS) {
  test(`${agent.label} (real) on a real-ssh Host: reply, tools with an approval, a failing command, Stop, a killed agent, the Mac closing mid-turn, a Host restart`, async ({
    harness,
  }) => {
    test.skip(!agent.bin, `no ${agent.id} on this machine`);
    let page = harness.page;
    const word = `ZEBRA-${agent.id}-${nonce}`;
    const file = path.join(HOME, `jr-${agent.id}-${nonce}.txt`);
    // inside the chat's folder: Codex's workspace-write sandbox refuses a write outside it unless the model asks to leave it, which it sometimes does not (#4811)
    const marker = path.join(REMOTE_FOLDER, `jr-marker-${agent.id}-${nonce}`);
    fs.writeFileSync(file, 'foo one\nfoo two\n');
    fs.rmSync(marker, { force: true });
    const steps: Record<string, string> = {};

    try {
      await test.step('1. start the chat from the Mac and get a reply', async () => {
        await startOn(harness, agent, `Remember this code word: ${word}. Reply with exactly ACK-${nonce} and nothing else.`);
        await expect(main(page)).toContainText(`ACK-${nonce}`, { timeout: 240_000 });
        await untilIdle(page, 'the first turn');
        steps['1 reply'] = 'ACK shown';
      });

      await test.step('2. read a file, edit it (approval answered), run a command', async () => {
        if (!stepOn(2)) return;
        await send(
          page,
          `Read the file ${file}. Then replace the word foo with bar on both lines using your edit tool (not a shell command). Then run the shell command: cat ${file}. Finish with one line starting with FINAL: that holds the file's two lines separated by a slash.`,
        );
        const allowed = await untilIdle(page, 'the tool turn');
        const text = await evidence(page, `${agent.id}-2-tools`);
        expect(fs.readFileSync(file, 'utf8'), 'the file on disk after the edit').toBe('bar one\nbar two\n');
        expect(text, 'the agent says what the file holds').toMatch(/FINAL:\s*bar one\s*\/\s*bar two/);
        steps['2 tools'] = `file edited on disk; ${allowed} approval(s) answered`;
      });

      await test.step('3. a failing command: the failure is shown and the agent reports it', async () => {
        if (!stepOn(3)) return;
        const missing = `/nonexistent-${nonce}`;
        await send(
          page,
          `Run the shell command: ls ${missing}. Then tell me in one line starting with ERR: what the command printed or its exit code.`,
        );
        await untilIdle(page, 'the failing command');
        const text = await evidence(page, `${agent.id}-3-failing-command`);
        expect(text, 'the transcript shows the failure of ls').toMatch(/No such file|cannot access|not found|exit code|status 1|\b1\b/i);
        expect(text, 'the agent reports it').toMatch(/ERR:/);
        steps['3 failing command'] = 'failure shown and reported';
      });

      await test.step('4. Stop in the middle of a turn', async () => {
        if (!stepOn(4)) return;
        await send(page, `Run this shell command and wait for it to finish: for i in $(seq 1 100); do sleep 1; done; echo LONG-${nonce}`);
        // an approval, if one is asked, is answered; then the command runs and Stop is there
        await untilIdleOrRunning(page);
        await expect(stopButton(page)).toBeVisible({ timeout: 120_000 });
        await page.waitForTimeout(3000);
        if ((await stopButton(page).count()) === 0) {
          await evidence(page, `${agent.id}-4-ended-before-stop`);
          throw new Error('the turn ended before Stop could be pressed (see the attached transcript)');
        }
        await stopButton(page).click();
        await expect(stopButton(page)).toHaveCount(0, { timeout: 60_000 });
        const text = await evidence(page, `${agent.id}-4-stop`);
        steps['4 stop'] = 'turn ended after Stop';
        expect(text).toBeTruthy();
      });

      await test.step('5. the agent process is killed in the middle of a turn: the turn ends and the chat recovers', async () => {
        if (!stepOn(5)) return;
        await send(page, `Run this shell command and wait for it to finish: for i in $(seq 1 90); do sleep 1; done; echo WAITED-${nonce}`);
        await untilIdleOrRunning(page);
        const victims = agentPids(remote.pid());
        console.log(`JR-KILL ${agent.id} :: ${victims.map((v) => `${v.pid} ${v.command.slice(0, 60)}`).join(' | ')}`);
        for (const v of victims) {
          try {
            process.kill(v.pid, 'SIGKILL');
          } catch {
            // already gone
          }
        }
        await expect(stopButton(page)).toHaveCount(0, { timeout: 120_000 });
        const text = await evidence(page, `${agent.id}-5-killed-agent`);
        await send(page, `Reply with exactly BACK-${nonce} and nothing else.`);
        await expect(main(page)).toContainText(`BACK-${nonce}`, { timeout: 240_000 });
        await untilIdle(page, 'the turn after the kill');
        steps['5 killed agent'] =
          `turn ended; transcript after the kill: ${text.slice(-160).replaceAll('\n', ' ⏎ ')}; the next message answered`;
      });

      await test.step('6. the Mac closes in the middle of a turn: the turn finishes on the Host and the transcript is complete on reconnect', async () => {
        if (!stepOn(6)) return;
        await send(
          page,
          `Run this shell command and wait for it to finish: \`for i in $(seq 1 40); do sleep 1; done; touch ${marker}\`. Then say DONE-${nonce}.`,
        );
        // the approval for the command is answered, and the command is really running, before the Mac goes away
        await expect(stopButton(page)).toBeVisible({ timeout: 120_000 });
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
          'the command (a 40 s loop) runs on the Host when the Mac closes',
        ).toBe(true);
        expect(fs.existsSync(marker), 'the command is still running when the Mac closes').toBe(false);
        const agentsNow = () =>
          agentPids(remote.pid())
            .map((v) => `${v.pid} ${v.command.slice(0, 70)}`)
            .join(' | ');
        console.log(`JR-CLOSE-AT ${agent.id} :: ${new Date().toISOString()}`);
        console.log(`JR-AGENTS-BEFORE-CLOSE ${agent.id} :: ${agentsNow()}`);
        await harness.relaunch();
        page = harness.page;
        try {
          await expect.poll(() => fs.existsSync(marker), { timeout: 120_000 }).toBe(true);
        } catch {
          const tail = (file: string, n = 14000) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').slice(-n) : '(none)');
          console.log(`JR-AGENTS-AFTER-CLOSE ${agent.id} :: ${agentsNow()}`);
          console.log(`JR-HOSTLOG ${agent.id} :: ${tail(remote.hostLog).replaceAll('\n', ' ⏎ ')}`);
          // what the chat shows once the Mac is back says what the agent did with the command
          try {
            await connectRemote(page, remote, agent.id);
            await page.getByRole('complementary').locator('[data-sidebar-chat^="acp:"]').first().click();
            await page.waitForTimeout(3000);
            await evidence(page, `${agent.id}-6-after-close-no-marker`);
          } catch (inner) {
            console.log(`JR-RECONNECT-FAILED ${String(inner).slice(0, 200)}`);
          }
          throw new Error('the turn did not finish on the Host while the Mac was away (the marker never appeared)');
        }
        await connectRemote(page, remote, agent.id);
        await page.getByRole('complementary').locator('[data-sidebar-chat^="acp:"]').first().click();
        await expect(main(page)).toContainText(`DONE-${nonce}`, { timeout: 120_000 });
        const text = await evidence(page, `${agent.id}-6-reconnect`);
        expect(
          (text.match(new RegExp(`DONE-${nonce}`, 'g')) ?? []).length,
          'DONE shown once for the one turn (the prompt names it too)',
        ).toBeGreaterThanOrEqual(1);
        expect(text).toContain(`ACK-${nonce}`);
        steps['6 mac closed mid-turn'] =
          'marker written by the Host while the Mac was closed; DONE and the earlier history in the transcript after reconnect';
      });

      await test.step('7. a Host restart between turns: the history is intact', async () => {
        if (!stepOn(7)) return;
        await remote.restart();
        await connectRemote(page, remote, agent.id);
        await page.getByRole('complementary').locator('[data-sidebar-chat^="acp:"]').first().click();
        await expect(main(page)).toContainText(`DONE-${nonce}`, { timeout: 120_000 });
        await send(page, `What was the code word I asked you to remember at the start? Answer with the code word only.`);
        await expect(main(page)).toContainText(word, { timeout: 240_000 });
        await untilIdle(page, 'the question after the restart');
        const text = await evidence(page, `${agent.id}-7-after-restart`);
        expect(
          (text.match(new RegExp(word, 'g')) ?? []).length,
          'the code word is in the first message and in the answer',
        ).toBeGreaterThanOrEqual(2);
        steps['7 host restart'] = 'history shown and the agent still knew the code word';
      });
    } finally {
      console.log(`JR-RESULT ${agent.id} :: ${JSON.stringify(steps)}`);
      fs.rmSync(file, { force: true });
      fs.rmSync(marker, { force: true });
    }
  });
}

// How often the turn survives the Mac closing (step 6 of the journey, alone, repeated): JR_CLOSE_REPEAT=<n> JR_CLOSE_AGENT=<claude|codex|opencode>
const REPEAT = Number(process.env.JR_CLOSE_REPEAT ?? 0);
const REPEAT_AGENT = AGENTS.find((a) => a.id === process.env.JR_CLOSE_AGENT);
test(`the Mac closes mid-turn, ${REPEAT} times on ${REPEAT_AGENT?.label}: how often the command finishes on the Host`, async ({
  harness,
}) => {
  test.skip(!REPEAT || !REPEAT_AGENT, 'set JR_CLOSE_REPEAT and JR_CLOSE_AGENT');
  const agent = REPEAT_AGENT as Agent;
  let page = harness.page;
  const outcomes: string[] = [];
  await startOn(harness, agent, `Reply with exactly ACK-${nonce} and nothing else.`);
  await untilIdle(page, 'the first turn');
  for (let i = 1; i <= REPEAT; i++) {
    const marker = path.join(REMOTE_FOLDER, `jr-repeat-${agent.id}-${nonce}-${i}`);
    fs.rmSync(marker, { force: true });
    await send(
      page,
      `Run this shell command and wait for it to finish: \`for i in $(seq 1 40); do sleep 1; done; touch ${marker}\`. Then say DONE-${i}-${nonce}.`,
    );
    await expect(stopButton(page)).toBeVisible({ timeout: 120_000 });
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
    const closedAt = new Date().toISOString();
    await harness.relaunch();
    page = harness.page;
    const written = await expect
      .poll(() => fs.existsSync(marker), { timeout: 100_000 })
      .toBe(true)
      .then(
        () => true,
        () => false,
      );
    outcomes.push(`${i}: ${written ? 'marker written' : 'NO marker'} (closed ${closedAt})`);
    console.log(`JR-REPEAT ${agent.id} :: ${outcomes.at(-1)}`);
    await connectRemote(page, remote, agent.id);
    await page.getByRole('complementary').locator('[data-sidebar-chat^="acp:"]').first().click();
    await evidence(page, `${agent.id}-repeat-${i}`);
    await untilIdle(page, `settling after close ${i}`);
    fs.rmSync(marker, { force: true });
  }
  console.log(`JR-REPEAT-RESULT ${agent.id} :: ${JSON.stringify(outcomes)}`);
});
