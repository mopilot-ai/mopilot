// e2e-runner: bench
// The owner's permission ceiling on a REAL Claude Code chat on a Host (#5034): a chat set to full access, the ceiling then dropped to read-only, another client sends a message asking for a write: the turn is held to the ceiling and the write does not happen.
// VM only (MOPILOT_ACCEPT_VM=1, the machine's own agents signed in, never a developer's Mac): `scripts/vm-exec.sh --vm mopilot-work …` with the VM lock taken first. Named on the command line only.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test, expect } from './fixtures/app';
import { AGENTS, REAL_USE, HOME, main, nonce, remote, startOn, untilIdle, declareRealHost, type Agent } from './fixtures/realJourney';
import { REMOTE_FOLDER } from './fixtures/remoteHost';
import { asOtherClient } from './fixtures/secondClient';
import { hostChatId } from '../../shared/host/chatIds.mjs';

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

test('Claude Code (real): a chat set to full access is held to a ceiling lowered to read-only, and a write it is asked for does not happen', async ({
  harness,
}) => {
  const agent = AGENTS.find((a) => a.id === 'claude');
  test.skip(!agent?.bin, 'no claude on this machine');
  const page = harness.page;
  const marker = path.join(REMOTE_FOLDER, `jr-claude-ceiling-${nonce}`);
  fs.rmSync(marker, { force: true });
  await startOn(harness, agent as Agent, `Reply with exactly ACK-${nonce} and nothing else.`);
  await expect(main(page)).toContainText(`ACK-${nonce}`, { timeout: 240_000 });
  await untilIdle(page, 'the first turn');
  const chatId = hostChatId(
    (await page.locator('[data-shortcut-recents] [data-sidebar-chat]').first().getAttribute('data-sidebar-chat')) ?? '',
  );
  expect(chatId).not.toBe('');
  const as = (n: number) => `phone-like-${n}-${Date.now()}`;
  // the chat is set to full access while the ceiling allows it, then the owner lowers the ceiling to read-only
  asOtherClient(remote, [['chat.permit', { chatId, epoch: 1, key: as(1), value: 'full-access' }]]);
  const owner = await page.evaluate(() => window.native.host.ownerPolicy());
  await page.evaluate((doc) => window.native.host.setOwnerPolicy({ ...doc, permissionMax: 'read-only' }), owner);
  await expect
    .poll(async () => page.evaluate(() => window.native.host.ownerPolicy().then((d) => d.permissionMax)), { timeout: 30_000 })
    .toBe('read-only');
  asOtherClient(remote, [
    [
      'chat.send',
      {
        chatId,
        epoch: 1,
        key: as(2),
        text: `Run this shell command now, it is allowed: \`touch ${marker}\`. Then reply with exactly DONE-${nonce}.`,
      },
    ],
  ]);
  // Claude Code's own record of the chat, once it has answered and gone quiet
  const record = () =>
    execFileSync(
      'bash',
      [
        '-c',
        `f=$(grep -la "jr-claude-ceiling-${nonce}" ${HOME}/.claude/projects/*/*.jsonl 2>/dev/null | head -1); [ -n "$f" ] && [ "$(grep -ac "DONE-${nonce}" "$f")" -ge 2 ] && [ $(( $(date +%s) - $(stat -f %m "$f") )) -ge 8 ] && echo "$f"; true`,
      ],
      { encoding: 'utf8' },
    );
  await expect.poll(record, { timeout: 240_000 }).not.toBe('');
  const modes = execFileSync('bash', ['-c', `grep -ao '"permissionMode":"[a-zA-Z]*"' "${record().trim()}" | tail -3; true`], {
    encoding: 'utf8',
  });
  console.log(`JR-CLAUDE-CEILING :: permission modes in the chat's record: ${modes.replaceAll('\n', ' ')}`);
  expect(modes, 'the turn ran under the ceiling (read-only is dontAsk), not bypass').toMatch(/dontAsk/);
  expect(modes).not.toMatch(/bypassPermissions"\s*$/);
  expect(fs.existsSync(marker), 'the write did not happen').toBe(false);
  fs.rmSync(marker, { force: true });
});
