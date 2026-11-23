// e2e-runner: bench
// A message sent while a turn runs on a Host chat is steered into the turn (#4916), as on This Mac with the follow-up setting on steer: nothing waits in the queue and the agent answers both in one turn. REAL agents (Codex on the bench VM, Claude Code on mopilot-work).
// VM only (MOPILOT_ACCEPT_VM=1, the machine's own agents signed in, never a developer's Mac): `scripts/vm-exec.sh --vm mopilot-work …` with the VM lock taken first. Named on the command line only.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { test, expect } from './fixtures/app';
import { send } from './fixtures/mm3Journey';
import { AGENTS, REAL_USE, main, nonce, startOn, untilIdle, declareRealHost, type Agent } from './fixtures/realJourney';

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
    uiState: { prefs: { followUp: 'steer' } },
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

for (const id of ['codex', 'claude'] as const) {
  test(`${id} (real): a message sent while a turn runs goes into the turn`, async ({ harness }) => {
    const agent = AGENTS.find((a) => a.id === id);
    test.skip(!agent?.bin, `no ${id} on this machine`);
    const page = harness.page;
    const marker = `steer-${id}-${nonce}`;
    await startOn(
      harness,
      agent as Agent,
      `Run this shell command and wait for it to finish: \`sleep 40; echo ${marker}\`. Then reply with exactly FIRST-${nonce}.`,
    );
    // the turn is running: the second message goes in while the command runs
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible({ timeout: 120_000 });
    await send(page, `While you finish: also end your reply with exactly SECOND-${nonce}.`);
    await expect(page.locator('.queue-row'), 'nothing waits behind the turn').toHaveCount(0, { timeout: 15_000 });
    // the message is shown at once as the person's, in the turn it went into: one bubble, and the row it was kept in is gone (it was once left behind, and Send sent it twice)
    await expect(
      page.locator('.thread-view .user-message').filter({ hasText: `SECOND-${nonce}` }),
      'one bubble for the steered message',
    ).toHaveCount(1, {
      timeout: 15_000,
    });
    await expect(main(page)).toContainText(`FIRST-${nonce}`, { timeout: 240_000 });
    await untilIdle(page, 'the turn with the steered message');
    const glob = id === 'codex' ? '~/.codex/sessions/*/*/*/rollout-*.jsonl' : '~/.claude/projects/*/*.jsonl';
    const count = id === 'codex' ? 'grep -ac "\\"turn_context\\"" "$f"' : `grep -ac "SECOND-${nonce}" "$f"`;
    const turns = execFileSync('bash', ['-c', `f=$(grep -la "${marker}" ${glob} 2>/dev/null | head -1); ${count}; true`], {
      encoding: 'utf8',
    }).trim();
    console.log(
      `JR-STEER ${id} :: ${id === 'codex' ? 'turns in the rollout' : 'records naming the second message'} = ${turns} :: the Mac shows ${(await main(page).innerText()).replace(/\s+/g, ' ').slice(0, 700)}`,
    );
    await expect(page.locator('.queue-row'), 'no row is left after the turn').toHaveCount(0);
    await expect(page.locator('.thread-view .user-message').filter({ hasText: `SECOND-${nonce}` })).toHaveCount(1);
    fs.mkdirSync('/tmp/steer-bubble', { recursive: true });
    await page.screenshot({ path: `/tmp/steer-bubble/${id}.png` });
    if (id === 'codex') expect(turns, 'both messages are one turn of Codex').toBe('1');
    await expect(main(page), 'the agent took the second message into the turn').toContainText(
      new RegExp(`SECOND-${nonce}[\\s\\S]*SECOND-${nonce}`),
    );
  });
}
