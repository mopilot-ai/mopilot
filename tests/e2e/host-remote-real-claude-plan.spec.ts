// e2e-runner: bench
// Plan for Claude Code on a machine (#4898), real Claude Code against a real Host: Plan is offered, the first message runs in Plan and ends with the plan card, approving it returns the chat to the mode picked and the plan runs (a file is written), and Plan is off again.
// VM only (MOPILOT_ACCEPT_VM=1, the machine's own agents signed in, never a developer's Mac): `scripts/vm-exec.sh --vm mopilot-work …` with the VM lock taken first. Named on the command line only.
import fs from 'node:fs';
import path from 'node:path';
import { connectRemote, startRemoteChat, REMOTE_FOLDER } from './fixtures/remoteHost';
import { cheapModel } from './fixtures/realAgents';
import { test, expect } from './fixtures/app';
import { AGENTS, REAL_USE, main, nonce, remote, stopButton, declareRealHost, type Agent } from './fixtures/realJourney';

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

/** A photo of the window for the PR (`/tmp/claude-plan`, read from the machine the run was on), also attached to the test. */
async function shot(page: import('@playwright/test').Page, name: string) {
  fs.mkdirSync('/tmp/claude-plan', { recursive: true });
  const body = await page.screenshot({ path: `/tmp/claude-plan/${name}.png` });
  await test.info().attach(`${name}.png`, { body, contentType: 'image/png' });
}

test('Claude Code (real): Plan on a machine ends with the plan card, and approving it runs the plan under the mode picked', async ({
  harness,
}) => {
  test.setTimeout(10 * 60_000);
  const agent = AGENTS.find((a) => a.id === 'claude') as Agent | undefined;
  test.skip(!agent?.bin, 'no claude on this machine');
  const page = harness.page;
  const file = path.join(REMOTE_FOLDER, `jr-plan-${nonce}.txt`);
  fs.rmSync(file, { force: true });
  await connectRemote(page, remote, 'claude');
  await startRemoteChat(
    page,
    (agent as Agent).row,
    `Plan how to create the file ${file} containing exactly PLANNED-${nonce}, present the plan to me with your plan tool (ExitPlanMode), and only after I approve it create the file.`,
    false,
    async () => {
      await cheapModel(page, (agent as Agent).model);
      await page.getByRole('button', { name: 'Add files and more' }).click();
      const row = page.locator('.add-panel').getByText('Plan mode', { exact: true });
      await expect(row, 'Plan is offered for Claude Code on a machine').toBeEnabled();
      await row.click();
      await expect(page.locator('.plan-chip'), 'Plan is on before the first message').toBeVisible({ timeout: 15_000 });
    },
  );
  // the plan's card: the agent asks to leave Plan, with the plan in it (Approve plan / Keep planning)
  const approve = page.getByRole('button', { name: /Approve plan/ }).first();
  try {
    await expect(approve, 'the plan card reaches the Mac').toBeVisible({ timeout: 240_000 });
  } catch (error) {
    await shot(page, 'no-plan-card');
    console.log(`JR-PLAN no card :: the Mac shows ${(await main(page).innerText()).replace(/\s+/g, ' ').slice(0, 900)}`);
    throw error;
  }
  console.log(`JR-PLAN card :: ${(await page.locator('main').innerText()).replace(/\s+/g, ' ').slice(-700)}`);
  await shot(page, 'plan-card');
  expect(fs.existsSync(file), 'nothing is written while the plan is only a plan').toBe(false);
  await approve.click();
  // approved: the agent runs the plan (a write may ask once more), and the chat is out of Plan
  const until = Date.now() + 240_000;
  while (Date.now() < until && !fs.existsSync(file)) {
    if (
      await page
        .locator('.approval-card:has(button:enabled)')
        .first()
        .isVisible()
        .catch(() => false)
    )
      await page.keyboard.press('1');
    await page.waitForTimeout(1500);
  }
  expect(fs.existsSync(file), 'the approved plan ran: the file exists').toBe(true);
  expect(fs.readFileSync(file, 'utf8')).toContain(`PLANNED-${nonce}`);
  await expect(stopButton(page)).toHaveCount(0, { timeout: 120_000 });
  await expect(page.locator('.plan-chip'), 'the chat is out of Plan once the plan is approved').toHaveCount(0, { timeout: 30_000 });
  await shot(page, 'plan-approved');
  console.log(`JR-PLAN done :: the Mac shows ${(await main(page).innerText()).replace(/\s+/g, ' ').slice(0, 600)}`);
  fs.rmSync(file, { force: true });
});
