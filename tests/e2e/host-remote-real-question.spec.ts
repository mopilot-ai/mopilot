// e2e-runner: bench
// A question from the REAL agent on a Host (Codex's request_user_input in Plan mode, Claude Code's AskUserQuestion): the chat draws the app's own question card (the one This Mac draws, whose chats in this fixture run the fake agents, not these), removes it at once on an answer, and leaves the answered-questions record in the transcript; photos go to /tmp/question-parity.
// VM only (MOPILOT_ACCEPT_VM=1, the machine's own agents signed in, never a developer's Mac): `scripts/vm-exec.sh --vm mopilot-bench …` with the VM lock taken first. Named on the command line only.
import fs from 'node:fs';
import { test, expect } from './fixtures/app';
import { send } from './fixtures/mm3Journey';
import { AGENTS, REAL_USE, evidence, main, nonce, startOn, untilIdle, declareRealHost } from './fixtures/realJourney';

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

const askingClaude = `Use the AskUserQuestion tool to ask me "Which fruit?" with the options apple and pear, then reply with exactly CHOSE-${nonce}-<my choice>.`;
const asking = `Call your request_user_input tool (a real question to me, not text in your reply) to ask "Which fruit?" with the two options apple and pear. Then reply with exactly CHOSE-${nonce}-<my choice>.`;

/** A photo of the window for the PR (`/tmp/question-parity`, read from the machine the run was on), also attached to the test. */
async function shot(page: import('@playwright/test').Page, name: string) {
  fs.mkdirSync('/tmp/question-parity', { recursive: true });
  const body = await page.screenshot({ path: `/tmp/question-parity/${name.replaceAll(' ', '-')}.png` });
  await test.info().attach(`${name}.png`, { body, contentType: 'image/png' });
}

/** In Plan mode, ask the question, answer it from the card by its apple tile; what the card and the transcript show is printed and photographed. */
async function askAndAnswer(page: import('@playwright/test').Page, where: string, plan: boolean) {
  if (plan) {
    await page.getByRole('button', { name: 'Add files and more' }).click();
    const planRow = page.locator('.add-panel').getByText('Plan mode', { exact: true });
    test.skip(await planRow.isDisabled().catch(() => false), `Plan mode isn't available on a ${where} chat`);
    await planRow.click();
    await expect(page.locator('.plan-chip')).toBeVisible({ timeout: 15_000 });
  }
  await send(page, plan ? asking : askingClaude);
  const card = page.locator('.question-card');
  try {
    await expect(card, `a ${where} chat shows the app's question card`).toBeVisible({ timeout: 150_000 });
  } catch (error) {
    await evidence(page, `question-${where}-no-card`);
    await shot(page, `${where}-no-card`);
    console.log(`JR-CARD ${where} :: none :: cards ${await page.locator('.approval-card, .question-card').count()}`);
    throw error;
  }
  console.log(`JR-CARD ${where} :: before the answer :: ${(await card.innerText()).replace(/\s+/g, ' ').slice(0, 300)}`);
  await shot(page, `${where}-card-before`);
  await card.locator('.question-option', { hasText: 'apple' }).click();
  await expect(card, 'the card leaves at once').toHaveCount(0, { timeout: 5_000 });
  await expect(main(page)).toContainText(new RegExp(`CHOSE-${nonce}-apple`, 'i'), { timeout: 180_000 });
  await untilIdle(page, `the turn after the answer on ${where}`);
  await evidence(page, `question-${where}`);
  console.log(
    `JR-CARD ${where} :: after the turn :: cards ${await page.locator('.question-card, .approval-card').count()} :: record ${await page.locator('.answered-card').count()}`,
  );
  await shot(page, `${where}-after`);
  expect(await page.locator('.question-card, .approval-card').count(), 'no card is left').toBe(0);
  await expect(page.locator('.answered-card'), 'the answers stay as the answered-questions record').toContainText('apple');
}

test('Codex (real) on a Host: the question card, answered, leaves and the record stays', async ({ harness }) => {
  const agent = AGENTS.find((a) => a.id === 'codex');
  test.skip(!agent?.bin, 'no codex on this machine');
  const page = harness.page;
  await startOn(harness, agent!, `Reply with exactly ACK-${nonce} and nothing else.`);
  await expect(main(page)).toContainText(`ACK-${nonce}`, { timeout: 240_000 });
  await untilIdle(page, 'the first turn on the Host');
  await askAndAnswer(page, 'Host-Codex', true);
});

test('Claude Code (real) on a Host: AskUserQuestion is the same question card, answered, leaves and the record stays', async ({
  harness,
}) => {
  const agent = AGENTS.find((a) => a.id === 'claude');
  test.skip(!agent?.bin, 'no claude on this machine');
  const page = harness.page;
  await startOn(harness, agent!, `Reply with exactly ACK-${nonce} and nothing else.`);
  await expect(main(page)).toContainText(`ACK-${nonce}`, { timeout: 240_000 });
  await untilIdle(page, 'the first turn on the Host');
  await askAndAnswer(page, 'Host-Claude', false);
});
