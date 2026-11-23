// What a machine chat's state lane tells of a switch (D13, #4278, S2): the agent the chat runs on and the choice held for it (host/src/chatState.mjs, host/src/stream.mjs, host/src/hostSwitch.mjs), and that a message's credential check follows the agent it will run on. A: the patches; B: what is dropped; I: a lane a restart left stale is corrected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chatStateOf } from '../host/src/chatState.mjs';
import { createChatLog } from '../host/src/chatLog.mjs';
import { createEpochStore } from '../host/src/epochs.mjs';
import { createGuard } from '../host/src/guard.mjs';
import { landsOn, laneChoice, readHold, switchRuntime } from '../host/src/hostSwitch.mjs';
import { createLedger } from '../host/src/ledger.mjs';
import { createProtocol } from '../host/src/protocol.mjs';
import { helloParams } from '../shared/host/schema.mjs';

const quiet = { report: () => undefined };
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'host-switch-lane-'));

test('A: the agent a chat runs on and the choice held for it are lane patches; the choice never carries a credential', () => {
  assert.deepEqual(chatStateOf({ kind: 'state', chatId: 'c', patch: { harness: 'codex', pendingSwitch: null } }), {
    chatId: 'c',
    patch: { harness: 'codex', pendingSwitch: null },
  });
  assert.deepEqual(chatStateOf({ kind: 'state', chatId: 'c', patch: { harness: 'acp:gemini' } }), {
    chatId: 'c',
    patch: { harness: 'acp:gemini' },
  });
  assert.deepEqual(chatStateOf({ kind: 'state', chatId: 'c', patch: { pendingSwitch: { harness: 'claude', model: 'opus' } } }), {
    chatId: 'c',
    patch: { pendingSwitch: { harness: 'claude', model: 'opus' } },
  });
  assert.deepEqual(
    chatStateOf({ kind: 'state', chatId: 'c', patch: { pendingSwitch: { harness: 'claude', model: '', credential: { source: 'key' } } } }),
    {
      chatId: 'c',
      patch: { pendingSwitch: { harness: 'claude' } },
    },
  );
  assert.equal(
    (chatStateOf({ kind: 'state', chatId: 'c', patch: { pendingSwitch: { harness: 'claude', model: 'm'.repeat(900) } } })?.patch as any)
      ?.pendingSwitch.model.length,
    500,
  );
});

test("B: a harness or a choice that is not one of the wire's agents is dropped", () => {
  for (const patch of [
    { harness: 'gemini' },
    { harness: 5 },
    { pendingSwitch: 'codex' },
    { pendingSwitch: { harness: 'nope' } },
    { pendingSwitch: { model: 'x' } },
  ])
    assert.equal(chatStateOf({ kind: 'state', chatId: 'c', patch }), null);
});

test('A: the choice as the lane tells it, and the family a message lands on', () => {
  assert.equal(laneChoice(null), null);
  assert.equal(laneChoice(undefined), null);
  assert.deepEqual(laneChoice({ harness: 'codex', model: null }), { harness: 'codex' });
  assert.equal(landsOn(null, 'claude'), 'claude');
  assert.equal(landsOn({ harness: 'acp:fake' }, 'claude'), 'acp');
  assert.equal(landsOn({ harness: 'nonsense' }, 'claude'), 'claude');
});

test('I: a lane the journal restored with a choice no running Host holds is corrected by what this Host holds, and one with none is left as it was', () => {
  const dir = temp();
  const first = createChatLog({ dataDir: dir, epoch: () => 1 });
  first.hub.state('held', { pendingSwitch: { harness: 'codex' }, harness: 'claude' });
  first.hub.state('plain', { harness: 'codex' });
  const helloOf = (log: ReturnType<typeof createChatLog>, chatId: string) => {
    const frames: any[] = [];
    log.hub.subscribe(chatId, { send: (f: any) => (frames.push(f), true), close: () => undefined });
    return frames.find((f) => f.t === 'hello').chatState;
  };
  // a Host that lost the choice: the lane reads empty and keeps what else it knew
  const restarted = createChatLog({ dataDir: dir, epoch: () => 1, live: () => ({ pendingSwitch: null }) });
  assert.deepEqual(helloOf(restarted, 'held'), { pendingSwitch: null, harness: 'claude' });
  // a lane that never carried a choice is not asked about one
  assert.deepEqual(helloOf(restarted, 'plain'), { harness: 'codex' });
  // a choice a Host restored that its journal never heard of is on the lane too
  const restoredAlone = createChatLog({ dataDir: dir, epoch: () => 1, live: () => ({ pendingSwitch: { harness: 'claude' } }) });
  assert.deepEqual(helloOf(restoredAlone, 'plain'), { harness: 'codex', pendingSwitch: { harness: 'claude' } });
  // a Host that still holds it (the chat's lane was evicted and loaded again) tells it as it is
  const keeping = createChatLog({ dataDir: dir, epoch: () => 1, live: () => ({ pendingSwitch: { harness: 'acp:fake' } }) });
  assert.deepEqual(helloOf(keeping, 'held'), { pendingSwitch: { harness: 'acp:fake' }, harness: 'claude' });
});

test('B: the runtime refuses an agent that is no agent, tells an unknown chat from a known one, and reads a choice only for a chat it holds', () => {
  const patched: any[] = [];
  const kept: any[] = [];
  const known = new Set(['claude:k']);
  const state: any = {
    has: (id: string) => known.has(id),
    get: (id: string) => ({ pendingSwitch: id === 'claude:k' ? { harness: 'codex', model: 'm', credential: { source: 'key' } } : null }),
    patch: (id: string, p: any) => patched.push([id, p]),
  };
  const rt = switchRuntime({
    chats: { records: new Map([['claude:saved', {}]]) },
    state,
    controller: () => ({ ref: () => ({ kind: 'claude' }) }),
    provided: { acp: true, claude: true, codex: false },
    labels: { claude: 'Claude Code', codex: 'Codex' },
    hold: (id: string, pending: any) => void kept.push([id, pending]),
  });
  assert.equal(rt.switching, true);
  assert.equal(rt.switchState('claude:unknown'), null);
  assert.deepEqual(rt.switchState('claude:k'), { harness: 'claude', pending: 'codex' });
  // a chat the Host has saved but holds no session state for has no choice held
  assert.deepEqual(rt.switchState('claude:saved'), { harness: 'claude', pending: null });
  assert.throws(() => rt.choose('claude:k', { harness: 'codex' }), /Codex is not available on this Host/);
  assert.throws(() => rt.choose('claude:k', { harness: 'gemini' }), /That agent is not available on this Host/);
  rt.choose('claude:k', { harness: 'acp:fake' });
  rt.choose('claude:k', null);
  // what is held on disk is what is held in the session, and a refused choice is neither
  assert.deepEqual(kept, [
    ['claude:k', { harness: 'acp:fake' }],
    ['claude:k', null],
  ]);
  assert.deepEqual(patched, [
    ['claude:k', { pendingSwitch: { harness: 'acp:fake' } }],
    ['claude:k', { pendingSwitch: null }],
  ]);
  assert.deepEqual(rt.liveChoice('claude:k'), { pendingSwitch: { harness: 'codex', model: 'm' } });
  assert.deepEqual(rt.liveChoice('claude:unknown'), { pendingSwitch: null });
  // a chat the Host has a record of but no session for yet holds no choice
  const recorded = switchRuntime({
    chats: { records: new Map([['claude:r', {}]]) },
    state,
    controller: () => ({ ref: () => ({ kind: 'claude' }) }),
    provided: { acp: true, claude: true, codex: false },
    labels: { claude: 'Claude Code', codex: 'Codex' },
    hold: () => undefined,
  });
  assert.deepEqual(recorded.switchState('claude:r'), { harness: 'claude', pending: null });
});

test('I: a message is checked against the credential of the agent it will run on: the one a held choice moves the chat to, else the one it is on, else the one its id names', async () => {
  const dir = temp();
  const checked: string[] = [];
  let state: { harness: string; pending: string | null } | null = { harness: 'claude', pending: 'codex' };
  const host: any = new EventEmitter();
  host.cancel = () => undefined;
  const runtime: any = {
    host,
    send: async () => ({ turnId: 't' }),
    permit: () => true,
    familyOf: () => 'claude',
    switchState: () => state,
  };
  const epochs = createEpochStore(path.join(dir, 'e.json'), quiet);
  const guard = createGuard({ epochs, ledger: createLedger(path.join(dir, 'l'), quiet) });
  const ownRuns: any = {
    chatCredentials: {
      ready: async () => undefined,
      check: (_chat: string, harness: string) => void checked.push(harness),
      forget: () => undefined,
    },
  };
  const conn = createProtocol({ runtime, epochs, guard, ownRuns, status: () => ({ running: true }) }).connection(() => undefined);
  await conn.call('host.hello', helloParams());
  let n = 0;
  const send = (chatId: string) => conn.call('chat.send', { chatId, epoch: 1, key: `key-lane-${++n}-000`, text: 'hi' });
  await send('claude:a');
  state = { harness: 'codex', pending: null };
  await send('claude:a');
  state = null;
  await send('acp:fake:b');
  assert.deepEqual(checked, ['codex', 'codex', 'acp:fake']);
});

test('B: a held choice is read back whole or not at all', () => {
  const full = {
    harness: 'acp:gemini',
    model: 'm',
    modelLabel: 'M',
    mode: 'summary',
    effort: 'high',
    credential: { source: 'own', login: 'work' },
  };
  assert.deepEqual(readHold({ ...full, extra: 1, goal: 'x' }), full);
  assert.deepEqual(readHold({ harness: 'codex', model: null, modelLabel: '', mode: 'auto' }), {
    harness: 'codex',
    model: null,
    modelLabel: '',
    mode: 'auto',
  });
  for (const bad of [
    null,
    'codex',
    {},
    { ...full, harness: 'gemini' },
    { ...full, harness: 5 },
    { ...full, model: 5 },
    { ...full, modelLabel: 5 },
    { ...full, mode: 'delta' },
    { ...full, effort: 5 },
    { ...full, credential: 'own' },
    { ...full, credential: null },
    { ...full, credential: { source: 'cloud' } },
    { ...full, credential: { source: 'own', login: 'x'.repeat(65) } },
    { ...full, model: 'm'.repeat(201) },
  ])
    assert.equal(readHold(bad), null, JSON.stringify(bad));
});
