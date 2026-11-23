// e2e-runner: bench
// The Mac app against the Host it installs as a launch agent on This Mac · keeps running, with the REAL Claude Code and Codex of the machine it runs on (their own sign-ins, the cheapest model at low effort): a chat starts and replies, a command waits for an approval that is allowed, a question card (Claude Code) is answered, Stop ends a long turn, and after quit and reopen the chat is there and the agent still knows what it was told. A real model decides what it asks, so each step's prompt is direct and every answer is checked by a nonce.
// VM only (MOPILOT_ACCEPT_VM=1, the machine's own `claude` and `codex` signed in, never a developer's Mac): `scripts/vm-exec.sh --vm mopilot-bench …` with the VM lock taken first. Named on the command line only.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Harness } from './fixtures/app';
import { HOME, installThisMac, removeHostFiles, startChatOnThisMac, thisMacRow } from './fixtures/hostLocal';
import { send } from './fixtures/mm3Journey';
import { cheapModel, shownIn } from './fixtures/realAgents';

test.skip(process.platform !== 'darwin', 'the Host runs as a launchd agent on macOS');
test.skip(!process.env.MOPILOT_ACCEPT_VM, 'the isolated VM only: it uses the real agents of the machine it runs on');

const where = (name: string) => {
  try {
    return execFileSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};
const claude = where('claude');
const codex = where('codex');
const nonce = `n${Date.now().toString(36)}`;

test.describe.configure({ mode: 'serial' });
test.setTimeout(15 * 60_000);
test.afterEach(removeHostFiles);
test.use({
  harnesses: 'codex',
  acp: { kimi: {} },
  // the Host the app installs takes the app's PATH: the machine's own agents are on it
  shellPath: [claude, codex].filter(Boolean).map((file) => path.dirname(file)),
  env: { MOPILOT_HOST_DEV: '1', MOPILOT_FLAGS: 'host.local=1', HOME },
});

const cheap = (h: Harness, name: RegExp) => cheapModel(h.page, name);
const shown = (h: Harness, what: RegExp, message: string, timeout?: number) => shownIn(h.page, what, message, timeout);

for (const agent of [
  { id: 'claude', row: 'Kimi Code', model: /haiku|sonnet/i, bin: claude },
  { id: 'codex', row: 'Codex', model: /mini|fake|gpt/i, bin: codex },
]) {
  test(`${agent.id} (real) on This Mac · keeps running: a reply, an approved command, Stop, quit and reopen`, async ({ harness }) => {
    test.skip(!agent.bin, `no ${agent.id} on this machine`);
    const page = harness.page;
    await installThisMac(harness);
    await expect
      .poll(async () => JSON.stringify(await thisMacRow(harness)), { timeout: 120_000 })
      .toMatch(new RegExp(`"id":"${agent.id}"[^}]*"state":"ready"`));

    // a reply
    await startChatOnThisMac(harness, `Reply with exactly the word READY-${nonce} and nothing else.`, {
      localRow: agent.row,
      beforeSend: process.env.NO_PICK ? undefined : () => cheap(harness, agent.model),
    });
    await shown(harness, new RegExp(`READY-${nonce}`), 'no reply');
    // the turn is over before the next message goes
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 120_000 });

    // a command that writes waits for an approval (a read-only echo never asks), and Allow runs it
    // outside the chat's folder and /tmp: Codex's sandbox writes there without asking, so only a write beyond them waits for an approval
    const ran = path.join(HOME, `RAN-${nonce}`);
    await send(page, `Run the shell command: touch ${ran}. Then say DONE-${nonce}.`);
    await expect(page.locator('.approval-card')).toBeVisible({ timeout: 180_000 });
    await page.keyboard.press('1');
    await expect.poll(() => fs.existsSync(ran), { timeout: 120_000, message: 'the allowed command ran' }).toBe(true);
    fs.rmSync(ran, { force: true });
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 120_000 });
    await expect(page.getByText(/Unknown harness/)).toHaveCount(0);

    // Stop ends a long turn
    await send(page, 'Run the shell command: sleep 120. Wait for it.');
    const approval = page.locator('.approval-card');
    if (await approval.isVisible({ timeout: 120_000 }).catch(() => false)) await page.keyboard.press('1');
    const stop = page.getByRole('button', { name: 'Stop', exact: true });
    await expect(stop).toBeVisible({ timeout: 120_000 });
    await stop.click();
    await expect(stop).toHaveCount(0, { timeout: 60_000 });

    // quit and open again: the chat is listed with its history, and the agent still knows what it was told
    await harness.relaunch();
    await harness.page.getByRole('complementary').locator('[data-sidebar-chat^="acp:"]').first().click();
    await shown(harness, new RegExp(`READY-${nonce}`), 'the history is not there after the return', 60_000);
    await send(harness.page, `What was the exact word I asked you to reply with first? Answer with it only.`);
    await shown(harness, new RegExp(`READY-${nonce}[\\s\\S]*READY-${nonce}`), 'the agent lost the conversation');
    await harness.page.evaluate(() => window.native.host.removeLocal());
  });
}

test('claude (real): a question card is answered and the answer reaches the agent', async ({ harness }) => {
  test.skip(!claude, 'no claude on this machine');
  const page = harness.page;
  await installThisMac(harness);
  await expect
    .poll(async () => JSON.stringify(await thisMacRow(harness)), { timeout: 120_000 })
    .toMatch(/"id":"claude"[^}]*"state":"ready"/);
  await startChatOnThisMac(
    harness,
    `Use the AskUserQuestion tool to ask me "Which file?" with the options a.ts and b.ts, then reply with exactly CHOSE-${nonce}-<my choice>.`,
    { localRow: 'Kimi Code', beforeSend: () => cheap(harness, /haiku|sonnet/i) },
  );
  const card = page.locator('.question-card');
  await expect(card).toBeVisible({ timeout: 180_000 });
  // the app's own question card: a tile per option
  await card.locator('.question-option', { hasText: 'a.ts' }).click();
  await shown(harness, new RegExp(`CHOSE-${nonce}-a\\.ts`), 'the answer did not reach the agent');
  await harness.page.evaluate(() => window.native.host.removeLocal());
});
