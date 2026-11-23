// e2e-runner: bench
// A message refused by the owner's permission ceiling (#5040), in the real app against a real Host: the queue row says the cause and offers "Use Read-only"; one click sets the chat's mode to the most the machine allows and the message goes out and is answered. Photos go to /tmp/refusal-mode.
// VM only (MOPILOT_ACCEPT_VM=1, the machine's own agents signed in, never a developer's Mac): `scripts/vm-exec.sh --vm mopilot-work …` with the VM lock taken first. Named on the command line only.
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

/** A photo of the window for the PR (`/tmp/refusal-mode`, read from the machine the run was on), also attached to the test. */
async function shot(page: import('@playwright/test').Page, name: string) {
  fs.mkdirSync('/tmp/refusal-mode', { recursive: true });
  const body = await page.screenshot({ path: `/tmp/refusal-mode/${name}.png` });
  await test.info().attach(`${name}.png`, { body, contentType: 'image/png' });
}

test('Codex (real): a send above a lowered ceiling is refused with "Use Read-only", and one click sends it under the ceiling', async ({
  harness,
}) => {
  const agent = AGENTS.find((a) => a.id === 'codex');
  test.skip(!agent?.bin, 'no codex on this machine');
  const page = harness.page;
  await startOn(harness, agent as Agent, `Reply with exactly ACK-${nonce} and nothing else.`);
  await expect(main(page)).toContainText(`ACK-${nonce}`, { timeout: 240_000 });
  await untilIdle(page, 'the first turn');
  const owner = await page.evaluate(() => window.native.host.ownerPolicy());
  await page.evaluate((doc) => window.native.host.setOwnerPolicy({ ...doc, permissionMax: 'read-only' }), owner);
  await expect
    .poll(async () => page.evaluate(() => window.native.host.ownerPolicy().then((d) => d.permissionMax)), { timeout: 30_000 })
    .toBe('read-only');
  await send(page, `Reply with exactly USED-${nonce} and nothing else.`);
  const row = page.locator('.queue-row').filter({ hasText: `USED-${nonce}` });
  const fix = row.getByRole('button', { name: 'Use Read-only' });
  await expect(fix, 'the refused message offers the most the machine allows').toBeVisible({ timeout: 60_000 });
  // the chip's own words for the mode, the cause said once (no "Host did not accept it" in front of it, no toast saying it again)
  await expect(row).toContainText('Ask for approval is not allowed');
  await expect(row).not.toContainText('Default is not allowed');
  await expect(row).not.toContainText('Host did not accept it');
  await expect(page.locator('.toasts').filter({ hasText: 'not allowed' })).toHaveCount(0);
  await expect(row.getByRole('button', { name: 'Retry' }), 'Retry would only be refused again').toHaveCount(0);
  await shot(page, 'refused-row');
  await fix.click();
  await expect(main(page)).toContainText(new RegExp(`USED-${nonce}[\\s\\S]*USED-${nonce}`), { timeout: 240_000 });
  await expect(page.locator('.queue-row').filter({ hasText: `USED-${nonce}` })).toHaveCount(0);
  await shot(page, 'after-use-read-only');
  console.log('JR-REFUSAL-MODE :: refused row with "Use Read-only", clicked, answered under the ceiling');
});
