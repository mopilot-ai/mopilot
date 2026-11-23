// Invariant (#2326, #2139): MoMo's isolation predicate reaches every adapter before any chat can start, and a Codex start
// marked as a MoMo chat's on an adapter that was never told which chats are MoMo's is refused, never sent to the main server.
// `isolateMomoChats` uses optional chaining (live.codex?.setIsolated), which silently does nothing when an adapter is not
// there yet, so the startup order is pinned here and the adapter fails closed when the predicate is missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fakeCodexSpawn } from './support/codex-harness/fakeCodexProcess.ts';

const require = createRequire(import.meta.url);
const { AppServer, CodexAdapter } = require('../electron/harness/codex.cjs');
const { ISOLATED_THREAD } = require('../electron/harness/codexIsolation.cjs');
const { isolateMomoChats } = require('../electron/app/momo.cjs');
const { SessionStore } = require('../electron/session/state.cjs');

const root = path.resolve(import.meta.dirname, '..');

test('startup opens the Codex, Claude Code and ACP sessions, and the switch runner, before MoMo registers its isolation', () => {
  const startup = fs.readFileSync(path.join(root, 'electron/app/startup.cjs'), 'utf8');
  const at = (needle: string) => {
    const i = startup.indexOf(needle);
    assert.ok(i >= 0, needle);
    return i;
  };
  assert.ok(at('chatSessions.openAcp()') < at('automations.registerMomo('));
  assert.ok(at('chatSessions.openSessions()') < at('automations.registerMomo('));
});

test('an adapter made once, never replaced: no later code builds a second Codex adapter, switch runner or ACP host', () => {
  const sessions = fs.readFileSync(path.join(root, 'electron/app/sessions.cjs'), 'utf8');
  for (const make of ['new CodexAdapter(', 'new SwitchRunner(', 'new acp.AcpHost(']) {
    assert.equal(sessions.split(make).length - 1, 1, make);
  }
});

function rig(isolated?: (chat: string) => boolean) {
  const spawned = fakeCodexSpawn('main', {
    initialize: () => ({ userAgent: 'codex_cli_rs/0.162.1' }),
    'thread/start': () => ({ thread: { id: 't1' } }),
  });
  const server = new AppServer({ spawn: spawned.spawn, findBin: () => '/bin/codex', env: () => ({}) });
  const adapter = new CodexAdapter({ server, state: new SessionStore(), probe: null, now: () => 1, ...(isolated ? { isolated } : {}) });
  return { adapter, spawned, server };
}

test('a start marked as a MoMo chat’s is refused, and nothing reaches any server, until the adapter is told which chats are MoMo’s', async () => {
  const r = rig();
  await assert.rejects(r.adapter.startThread({ [ISOLATED_THREAD]: true, cwd: '/momo' }), /isn't set up to keep MoMo's chats apart/);
  assert.equal(r.spawned.calls.length, 0);
  // an ordinary start is not affected
  assert.equal((await r.adapter.startThread({ cwd: '/code' })).thread.id, 't1');
  // MoMo opens: isolateMomoChats tells it, and the marked start goes
  isolateMomoChats({ codex: r.adapter }, { setIsolated: () => {} }, () => false);
  assert.equal((await r.adapter.startThread({ [ISOLATED_THREAD]: true, cwd: '/momo' })).thread.id, 't1');
  r.server.stop();
});

test('an adapter given its predicate at construction starts marked threads', async () => {
  const r = rig(() => true);
  assert.equal((await r.adapter.startThread({ [ISOLATED_THREAD]: true, cwd: '/momo' })).thread.id, 't1');
  r.server.stop();
});
