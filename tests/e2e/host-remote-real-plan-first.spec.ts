// e2e-runner: bench
// The FIRST message of a machine chat, sent with Plan on after Read-only was picked: the Host runs it in Plan with Read-only as the mode its tools run under (planBase, #4899/#4901 claimed this on a fake host; the app dropped planBase before the wire until #4916's sweep). REAL Codex on the bench VM, read from Codex's own record of the turn: a Plan-mode turn in a read-only sandbox, and the write it is asked for does not happen.
// VM only (MOPILOT_ACCEPT_VM=1, never a developer's Mac): `scripts/vm-exec.sh --vm bench …` with the VM lock taken first. Named on the command line only.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/app';
import { cheapModel } from './fixtures/realAgents';
import { connectRemote, startRemoteChat, REMOTE_FOLDER } from './fixtures/remoteHost';
import { AGENTS, REAL_USE, main, nonce, remote, untilIdle, declareRealHost, type Agent } from './fixtures/realJourney';

test.skip(process.platform !== 'darwin', 'a basic harness is admitted only with sage-mcp, which builds only on macOS');
test.skip(!process.env.MOPILOT_ACCEPT_VM, 'the isolated VM only: it uses the real agents of the machine it runs on');

declareRealHost();
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

test('Codex (real): a first message sent in Plan after Read-only was picked runs in Plan under a read-only sandbox', async ({
  harness,
}) => {
  const agent = AGENTS.find((a) => a.id === 'codex') as Agent | undefined;
  test.skip(!agent?.bin, 'no codex on this machine');
  const page = harness.page;
  const marker = path.join(REMOTE_FOLDER, `jr-planfirst-${nonce}`);
  fs.rmSync(marker, { force: true });
  await connectRemote(page, remote, 'codex');
  await startRemoteChat(
    page,
    (agent as Agent).row,
    `Run this shell command now, it is allowed: \`touch ${marker}\`. Then reply with exactly DONE-${nonce}.`,
    false,
    async () => {
      await cheapModel(page, (agent as Agent).model);
      await page.getByRole('button', { name: 'Change permissions' }).click();
      await page.getByRole('menuitemradio', { name: /Read-only/ }).click();
      await page.getByRole('button', { name: 'Add files and more' }).click();
      await page.locator('.add-panel').getByText('Plan mode', { exact: true }).click();
      await expect(page.locator('.plan-chip'), 'Plan is on before the first message').toBeVisible({ timeout: 15_000 });
    },
  );
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible({ timeout: 120_000 });
  await untilIdle(page, 'the first turn');
  const turn = execFileSync(
    'bash',
    [
      '-c',
      `f=$(grep -la "jr-planfirst-${nonce}" ~/.codex/sessions/*/*/*/rollout-*.jsonl 2>/dev/null | head -1); [ -n "$f" ] && grep -a '"turn_context"' "$f" | tail -1; true`,
    ],
    { encoding: 'utf8' },
  );
  console.log(
    `JR-PLANFIRST codex :: turn_context :: ${turn.slice(0, 700)} :: the Mac shows :: ${(await main(page).innerText()).replace(/\s+/g, ' ').slice(0, 500)}`,
  );
  expect(turn, 'Codex ran the first turn in a read-only sandbox').toMatch(/"sandbox_policy":\{"type":"read-only"/);
  expect(turn, 'and in its Plan mode').toMatch(/"mode":"plan"/);
  expect(fs.existsSync(marker), 'the write did not happen').toBe(false);
  fs.rmSync(marker, { force: true });
});
