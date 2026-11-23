// Who wrote the message each turn on a Host answers, through the Host's real controller queue (host/src/sessions.mjs): a running turn, a queued message nobody said a person wrote, then a queued one a person typed. Each turn's start must say its own, in the order the messages run, for an ACP agent and for Claude Code.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createAcpRuntime } from '../host/src/acp.mjs';
import { createClaudeFamily } from '../host/src/claudeFamily.mjs';
import { installElectronPorts } from '../host/src/electronPorts.mjs';
import { createPaths } from '../host/src/paths.mjs';
import { createHostSessions } from '../host/src/sessions.mjs';
// @ts-ignore: plain ESM without declarations
import { createFakeClaudeSdk } from './support/fakeClaudeSdk.mjs';

const ROOT = path.join(import.meta.dirname, '..');
const AGENT = path.join(ROOT, 'tests/fixtures/fake-acp-agent.mjs');
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-origin-')));
const configDir = path.join(base, 'claude-config');
process.env.CLAUDE_CONFIG_DIR = configDir;
after(() => fs.rmSync(base, { recursive: true, force: true }));
const until = async (fn: () => any, ms = 10000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** What each turn's start said about who wrote its message: [text, human] in the order the turns started. */
const starts = (events: any[]) => events.filter((e) => e.kind === 'turnStart').map((e) => [e.user?.content?.[0]?.text, e.human === true]);

/** The order a Host's queue runs three messages in: the first typed and slow, then a peer's (no `human`), then a typed one. */
async function run(sessions: any, key: string, dir: string) {
  const events: any[] = [];
  sessions.chatRuntime.host.on('event', (e: any) => events.push(e));
  await sessions.chatRuntime.send({ key, text: 'SLOW first', cwd: dir, human: true });
  await until(() => sessions.state.snapshot(key).turn === 'running');
  const peer = await sessions.chatRuntime.send({ key, text: 'from a peer' });
  const typed = await sessions.chatRuntime.send({ key, text: 'typed later', human: true });
  assert.deepEqual([peer.action, typed.action], ['queued', 'queued']);
  // Stop ends the slow turn and the queue waits; the next message sets it going, in order
  await sessions.chatRuntime.host.cancel(key);
  await until(() => events.some((e) => e.kind === 'turnEnd'));
  await sessions.chatRuntime.send({ key, text: 'and then' });
  // a typed message after Switch host carries the handoff as a prefix: still a person's turn
  await sessions.chatRuntime.send({ key, text: 'after the switch', prefix: 'EARLIER', human: true });
  await until(() => starts(events).length >= 5);
  await until(() => sessions.state.snapshot(key).turn === 'idle');
  // each turn says its own message's origin, whichever order the queue runs them in
  return Object.fromEntries(starts(events));
}

test('ACP: a peer’s queued message is not a person’s turn, the typed one after it is, and the first typed one is, and so is one sent after Stop', async () => {
  const dir = fs.mkdtempSync(path.join(base, 'a-'));
  fs.writeFileSync(
    path.join(dir, 'harnesses.json'),
    JSON.stringify({ fake: { label: 'Fake', bin: process.execPath, args: [AGENT], env: { FAKE_ACP_STATE: path.join(dir, 's') } } }),
  );
  const paths = createPaths({ dataDir: dir, env: {} });
  const runtime = createAcpRuntime({ paths, env: {}, hostOptions: { cancelRetryMs: 5, cancelForceMs: 5000 } });
  const sessions = createHostSessions({ paths, env: {}, runtime });
  try {
    assert.deepEqual(await run(sessions, 'acp:fake:o', dir), {
      'SLOW first': true,
      'from a peer': false,
      'typed later': true,
      'and then': false,
      'after the switch': false, // ACP: a handoff-prefixed message is not the user's own, as on this Mac (acpTurns.test.ts)
    });
  } finally {
    sessions.close();
    runtime.close();
  }
});

test('Claude Code: the same order, read from the controller’s own turn state', async () => {
  const dir = fs.mkdtempSync(path.join(base, 'c-'));
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, '#!/bin/sh\n');
  const fake = createFakeClaudeSdk({ configDir });
  const paths = createPaths({ dataDir: dir, env: {} });
  const restore = installElectronPorts({
    paths: { dataDir: dir, configDir: path.join(dir, 'config') },
    openExternal: async () => undefined,
  });
  const runtime = createAcpRuntime({ paths, env: {}, hostOptions: { cancelRetryMs: 5, cancelForceMs: 5000 } });
  let family: any;
  const sessions = createHostSessions({
    paths,
    env: { MOPILOT_CLAUDE_BIN: bin },
    runtime,
    families: { claude: (ctx: any) => (family = createClaudeFamily({ sdk: fake.sdk })(ctx)) },
  });
  try {
    assert.deepEqual(await run(sessions, `claude:${crypto.randomUUID()}`, dir), {
      'SLOW first': true,
      'from a peer': false,
      'typed later': true,
      'and then': false,
      'after the switch': true, // Claude Code: only the CLI's origin drops; the turn stays a person's
    });
  } finally {
    sessions.close();
    runtime.close();
    await family.close();
    restore();
  }
});
