// e2e-runner: bench
// #5037, with a REAL Codex behind a real-ssh Host: the chat's own folder is deleted on the machine and a message is sent. Records what happens (the transcript, the queue row), and asserts what a chat on This Mac does: the message is refused before the agent starts, saying the folder no longer exists, and goes once the folder is back.
// VM only (MOPILOT_ACCEPT_VM=1, the machine's own agents signed in, never a developer's Mac): `scripts/vm-exec.sh --vm mopilot-work …` with the VM lock taken first. Named on the command line only.
import { test, expect } from './fixtures/app';
import { send } from './fixtures/mm3Journey';
import { AGENTS, REAL_USE, declareRealHost, evidence, main, nonce, startOn, stopButton, untilIdle } from './fixtures/realJourney';
import { REMOTE_FOLDER } from './fixtures/remoteHost';
import fs from 'node:fs';

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
            // the VM's user is `admin`
            id: 'ssh:admin@localhost',
            name: 'localhost',
            address: 'admin@localhost',
            // where startRemoteHost puts the Host's socket (fixtures/remoteHost.ts REMOTE_SOCKET)
            socketPath: '/tmp/mm-remote-host/data/host.sock',
            capabilities: { shell: true },
            // the name this row was given: without it the machine takes its Host's computer name (#4930)
            renamed: true,
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

const codex = AGENTS.find((a) => a.id === 'codex')!;

test('Codex (real) on a real-ssh Host: the chat folder is deleted on the machine, then a message is sent', async ({ harness }) => {
  test.skip(!codex.bin, 'no codex on this machine');
  const page = harness.page;
  const queue = page.getByRole('list', { name: 'Queued messages' });
  await startOn(harness, codex, `Reply with exactly ACK-${nonce} and nothing else.`);
  await expect(main(page)).toContainText(`ACK-${nonce}`, { timeout: 240_000 });
  await untilIdle(page, 'the first turn');

  fs.rmSync(REMOTE_FOLDER, { recursive: true, force: true });
  await send(page, `Reply with exactly SECOND-${nonce} and nothing else.`);
  // either the Host refuses it (a queue row) or the agent runs it: give both time, and record what is on screen
  await page.waitForTimeout(45_000);
  const rows = await queue.count();
  await evidence(page, `codex-folder-gone-${rows ? 'refused' : 'sent'}`);
  console.log(`FG-RESULT queueRows=${rows} stop=${await stopButton(page).count()}`);
  if (rows) console.log(`FG-ROW ${(await queue.innerText()).replaceAll('\n', ' | ')}`);
  await page.screenshot({ path: test.info().outputPath('folder-gone.png') });
  await test.info().attach('folder-gone', { path: test.info().outputPath('folder-gone.png'), contentType: 'image/png' });

  // what a chat on This Mac does: refused before the agent starts, with the cause in words
  await expect.soft(queue, 'the message waits as a refusal row').toContainText(/no longer exists/i);
  // the queued row holds the words once, and the agent has not answered them
  expect.soft((await main(page).innerText()).split(`SECOND-${nonce}`).length - 1, 'only the queued message mentions it').toBe(1);

  // the folder is back: the same message goes
  fs.mkdirSync(REMOTE_FOLDER, { recursive: true });
  if (rows) await queue.getByRole('button', { name: 'Retry' }).click();
  await expect(main(page)).toContainText(`SECOND-${nonce}`, { timeout: 240_000 });
  await untilIdle(page, 'the second turn');
  // the message once, and the agent's answer once
  const back = await evidence(page, 'codex-folder-back');
  expect(back.split(`SECOND-${nonce}`).length - 1).toBe(2);
});
